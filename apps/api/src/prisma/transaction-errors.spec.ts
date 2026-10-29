import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  transactionConflictMessage,
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
});
