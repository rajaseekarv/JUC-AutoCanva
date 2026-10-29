import {
  ConflictException,
  ServiceUnavailableException,
  type HttpException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

export const transactionConflictMessage =
  'The change conflicted with a concurrent update and was not applied; reload and retry';
export const transactionUnconfirmedMessage =
  'The database could not confirm this change in time; reload to check the current state before retrying';

// PostgreSQL SQLSTATEs for a transaction the server aborted and rolled back:
// deadlock_detected and serialization_failure.
const rolledBackSqlStates = new Set(['40P01', '40001']);

// Inside $queryRaw/$executeRaw (such as the template row locks), Prisma
// reports these as P2010 "raw query failed" with the SQLSTATE in meta.code
// instead of P2034.
function isRolledBackRawQuery(
  error: Prisma.PrismaClientKnownRequestError,
): boolean {
  const sqlState = error.meta?.code;
  return (
    error.code === 'P2010' &&
    typeof sqlState === 'string' &&
    rolledBackSqlStates.has(sqlState)
  );
}

// Maps interactive-transaction failures caused by contention rather than by
// the request. Nothing is retried automatically.
// - P2034, or P2010 carrying 40P01/40001: PostgreSQL rolled the transaction
//   back (deadlock or serialization failure), so nothing was applied and the
//   client may retry.
// - P2028: the transaction could not start in time or expired. Prisma cannot
//   always tell whether a commit already reached the database, so the
//   response claims neither success nor failure.
// Any other error, including other P2010 failures, returns null and must be
// rethrown unchanged.
export function transactionContentionException(
  error: unknown,
): HttpException | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  if (error.code === 'P2034' || isRolledBackRawQuery(error))
    return new ConflictException(transactionConflictMessage);
  if (error.code === 'P2028')
    return new ServiceUnavailableException(transactionUnconfirmedMessage);
  return null;
}
