import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  transactionConflictMessage,
  isRolledBackTransaction,
  transactionContentionException,
  transactionUnconfirmedMessage,
} from './transaction-errors';

const prismaError = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError(`${code} from the database`, {
    code,
    clientVersion: 'test',
    meta,
  });

// The shape Prisma 6 produces when PostgreSQL aborts a raw query.
const rawQueryFailure = (sqlState: unknown) =>
  prismaError('P2010', {
    code: sqlState,
    message: `ERROR: ${String(sqlState)} raised by the server`,
  });

describe('transactionContentionException', () => {
  it.each([
    ['deadlock_detected', '40P01'],
    ['serialization_failure', '40001'],
  ])(
    'maps a raw-query %s (P2010, %s) to 409 without database details',
    (_name, sqlState) => {
      const mapped = transactionContentionException(rawQueryFailure(sqlState));
      expect(mapped).toBeInstanceOf(ConflictException);
      expect(mapped?.message).toBe(transactionConflictMessage);
      expect(JSON.stringify(mapped?.getResponse())).not.toContain(sqlState);
      expect(JSON.stringify(mapped?.getResponse())).not.toContain('ERROR');
    },
  );

  it.each([
    ['a unique violation SQLSTATE', rawQueryFailure('23505')],
    ['an undefined-table SQLSTATE', rawQueryFailure('42P01')],
    ['a numeric code', rawQueryFailure(40001)],
    ['no meta.code', prismaError('P2010', { message: 'raw query failed' })],
    ['no meta at all', prismaError('P2010')],
  ])('leaves P2010 with %s unmapped', (_case, error) => {
    expect(transactionContentionException(error)).toBeNull();
  });

  it('keeps the P2034 and P2028 mappings', () => {
    const conflict = transactionContentionException(prismaError('P2034'));
    expect(conflict).toBeInstanceOf(ConflictException);
    expect(conflict?.message).toBe(transactionConflictMessage);
    const unconfirmed = transactionContentionException(prismaError('P2028'));
    expect(unconfirmed).toBeInstanceOf(ServiceUnavailableException);
    expect(unconfirmed?.message).toBe(transactionUnconfirmedMessage);
  });

  it('ignores the rollback SQLSTATEs on other Prisma codes', () => {
    expect(
      transactionContentionException(prismaError('P2002', { code: '40P01' })),
    ).toBeNull();
  });

  it.each([
    ['P2002', prismaError('P2002', { target: ['organizationId', 'code'] })],
    ['P2025', prismaError('P2025')],
    ['a plain Error', new Error('connection lost')],
    ['a non-error value', '40P01'],
  ])('returns null for %s', (_case, error) => {
    expect(transactionContentionException(error)).toBeNull();
  });

  // Regression (Stage 10 PostgreSQL run): a review decision and a
  // cancellation deadlocked; Prisma reported the aborted updateMany as an
  // unknown request error, which became a 500 instead of a retryable 409.
  describe('unknown request errors from aborted model queries', () => {
    const modelQueryFailure = (sqlState: string, message: string) =>
      new Prisma.PrismaClientUnknownRequestError(
        '\nInvalid `tx.workflowTask.updateMany()` invocation:\n\n' +
          'Error occurred during query execution:\n' +
          `ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${sqlState}", message: "${message}", severity: "ERROR" }), transient: false })`,
        { clientVersion: 'test' },
      );

    it.each([
      ['a deadlock', '40P01', 'deadlock detected'],
      [
        'a serialization failure',
        '40001',
        'could not serialize access due to concurrent update',
      ],
    ])('maps %s to 409 without database details', (_case, state, text) => {
      const error = modelQueryFailure(state, text);
      expect(isRolledBackTransaction(error)).toBe(true);
      const mapped = transactionContentionException(error);
      expect(mapped).toBeInstanceOf(ConflictException);
      expect(mapped?.message).toBe(transactionConflictMessage);
      expect(JSON.stringify(mapped?.getResponse())).not.toContain(state);
    });

    it('leaves other unknown request errors unmapped', () => {
      const error = modelQueryFailure('23505', 'duplicate key value');
      expect(isRolledBackTransaction(error)).toBe(false);
      expect(transactionContentionException(error)).toBeNull();
      expect(
        isRolledBackTransaction(
          new Prisma.PrismaClientUnknownRequestError('connection reset', {
            clientVersion: 'test',
          }),
        ),
      ).toBe(false);
    });

    it('does not trust the SQLSTATE text in a plain Error', () => {
      expect(
        isRolledBackTransaction(new Error('code: "40P01" deadlock detected')),
      ).toBe(false);
    });
  });
});
