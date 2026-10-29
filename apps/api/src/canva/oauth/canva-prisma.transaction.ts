import { Prisma } from '@prisma/client';
import {
  CanvaPersistenceError,
  CanvaWriteOutcomeUnknownError,
  isDefiniteWriteFailure,
  type NewCanvaRevocation,
} from './canva-oauth.stores';

// Shared machinery for the Canva PostgreSQL stores (§4 of the persistence
// proposal). Every Canva transaction runs at READ COMMITTED; conflicts are
// serialized by explicit row locks, and every check that depends on another
// transaction's writes is a separate statement issued after its lock
// (read-after-lock), so it sees everything committed before the lock was
// granted.
//
// The new tables are accessed with parameterized raw SQL only. That keeps
// the statements identical to the reviewed protocol and does not depend on a
// regenerated Prisma client.

export type CanvaTx = Prisma.TransactionClient;
export type CanvaTransactionRunner = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | '$executeRaw'
> & {
  $transaction<T>(
    body: (tx: CanvaTx) => Promise<T>,
    options?: {
      isolationLevel?: Prisma.TransactionIsolationLevel;
      maxWait?: number;
      timeout?: number;
    },
  ): Promise<T>;
};

// Timestamps are stored as UTC `timestamp(3)`. Every comparison and
// assignment converts explicitly, so the session time zone never matters.
// - NOW_UTC is the transaction start: used for expiries, where an earlier
//   value only shortens a lifetime.
// - CLOCK_UTC is the time the statement runs: used for every time that
//   bounds an external call or a claim (§4 clock rule, F20).
export const NOW_UTC = Prisma.sql`(now() AT TIME ZONE 'UTC')`;
export const CLOCK_UTC = Prisma.sql`(clock_timestamp() AT TIME ZONE 'UTC')`;
export function utcTimestamp(value: Date): Prisma.Sql {
  return Prisma.sql`(${value.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}
export function milliseconds(value: number): Prisma.Sql {
  return Prisma.sql`(${Math.max(0, Math.round(value))}::int * interval '1 millisecond')`;
}

// Thrown inside a transaction body to roll back and return a value: the
// "ROLLBACK; outcome …" branches of the protocol.
export class RollbackWith<T> extends Error {
  constructor(readonly value: T) {
    super('rollback');
  }
}

// Thrown inside a transaction body to roll back and run the whole
// transaction again (an account row deleted by the sweep, F19).
export class RetryTransaction extends Error {
  constructor() {
    super('retry');
  }
}

const RETRIES = 3;
// deadlock_detected, serialization_failure: PostgreSQL rolled back.
const ROLLED_BACK_SQLSTATES = new Set(['40P01', '40001']);

function sqlState(error: unknown): string | undefined {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return;
  const meta = error.meta?.code;
  return typeof meta === 'string' ? meta : undefined;
}

function rolledBack(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2034') return true;
  const state = sqlState(error);
  return state !== undefined && ROLLED_BACK_SQLSTATES.has(state);
}

// A foreign-key violation on canva_accounts: the sweep deleted the row
// between our insert and our use of it (F19).
function missingAccountRow(error: unknown): boolean {
  if (sqlState(error) !== '23503') return false;
  const message = error instanceof Error ? error.message : '';
  return message.includes('canva_accounts');
}

export type RunOptions = { random?: () => number; sleep?: SleepFn };
export type SleepFn = (ms: number) => Promise<void>;
export const realSleep: SleepFn = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Runs one protocol transaction. The outcome is:
// - the body's value, after COMMIT;
// - a RollbackWith value, after ROLLBACK;
// - a definite failure when the body failed before COMMIT was sent (the
//   database rolls back), after at most 3 retries of deadlocks,
//   serialization failures, and missing account rows;
// - CanvaWriteOutcomeUnknownError when the body finished and the commit
//   itself failed (connection loss, Prisma timeout): it may have committed.
export async function runCanvaTransaction<T>(
  prisma: CanvaTransactionRunner,
  body: (tx: CanvaTx) => Promise<T>,
  options: RunOptions = {},
): Promise<T> {
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? realSleep;
  for (let attempt = 0; ; attempt += 1) {
    let bodyFinished = false;
    try {
      return await prisma.$transaction(
        async (tx) => {
          // A lock-order bug fails fast instead of hanging.
          await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
          const value = await body(tx);
          bodyFinished = true;
          return value;
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait: 5_000,
          timeout: 15_000,
        },
      );
    } catch (error: unknown) {
      if (error instanceof RollbackWith) return error.value as T;
      if (bodyFinished) throw new CanvaWriteOutcomeUnknownError();
      const retryable =
        error instanceof RetryTransaction ||
        rolledBack(error) ||
        missingAccountRow(error);
      if (retryable && attempt < RETRIES) {
        await sleep(Math.round(20 + 80 * random()));
        continue;
      }
      if (isDefiniteWriteFailure(error)) throw error;
      // Anything else failed before COMMIT was sent, so nothing committed.
      throw new CanvaPersistenceError();
    }
  }
}

// Locks the Canva connection row. Lock order step 1.
export async function lockConnection(
  tx: CanvaTx,
  organizationId: string,
): Promise<{ connectionGeneration: number; credentialVersion: number } | null> {
  const rows = await tx.$queryRaw<
    Array<{ connectionGeneration: number; credentialVersion: number }>
  >`
    SELECT "connectionGeneration", "credentialVersion" FROM "canva_connections"
    WHERE "organizationId" = ${organizationId} FOR UPDATE`;
  return rows[0] ?? null;
}

// Creates the account row if needed and locks it. Lock order step 2. When
// the sweep deleted the row between the insert and the lock, the whole
// transaction is retried (F19). Returns the holding organization.
export async function lockAccount(
  tx: CanvaTx,
  canvaUserId: string,
): Promise<string | null> {
  await tx.$executeRaw`
    INSERT INTO "canva_accounts" ("canvaUserId", "updatedAt")
    VALUES (${canvaUserId}, ${NOW_UTC})
    ON CONFLICT ("canvaUserId") DO NOTHING`;
  const rows = await tx.$queryRaw<Array<{ organizationId: string | null }>>`
    SELECT "organizationId" FROM "canva_accounts"
    WHERE "canvaUserId" = ${canvaUserId} FOR UPDATE`;
  if (!rows.length) throw new RetryTransaction();
  return rows[0].organizationId;
}

// Locks several account rows in ascending canvaUserId order (lock order
// step 2 when two are needed).
export async function lockAccounts(
  tx: CanvaTx,
  canvaUserIds: Array<string | null | undefined>,
): Promise<void> {
  const ids = [...new Set(canvaUserIds.filter((id): id is string => !!id))];
  ids.sort();
  for (const id of ids) await lockAccount(tx, id);
}

// Releases a hold when nothing references it any more. A credential or
// candidate that still references it would make the update fail (ON UPDATE
// RESTRICT); the NOT EXISTS keeps that from aborting the transaction.
export async function releaseAccountIfUnreferenced(
  tx: CanvaTx,
  canvaUserId: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "canva_accounts" SET "organizationId" = NULL, "updatedAt" = ${NOW_UTC}
    WHERE "canvaUserId" = ${canvaUserId} AND "organizationId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "canva_credentials" WHERE "canvaUserId" = ${canvaUserId})
      AND NOT EXISTS (SELECT 1 FROM "canva_connection_candidates" WHERE "canvaUserId" = ${canvaUserId})`;
}

// `E`: queue a token AdFlow gives up, inside the caller's transaction. The
// account row is created and locked first, so the queue row's foreign key
// cannot race the sweep; idempotent per (chainId, reason).
export async function enqueueInTransaction(
  tx: CanvaTx,
  revocation: NewCanvaRevocation,
  newId: () => string,
): Promise<void> {
  await lockAccount(tx, revocation.canvaUserId);
  const sealed = revocation.refreshToken;
  await tx.$executeRaw`
    INSERT INTO "canva_pending_revocations" ("id", "organizationId", "chainId",
      "canvaUserId", "reason", "keyVersion", "refreshTokenIv",
      "refreshTokenCiphertext", "refreshTokenTag", "nextAttemptAt", "createdAt")
    VALUES (${newId()}, ${revocation.organizationId}, ${revocation.chainId},
      ${revocation.canvaUserId}, ${revocation.reason}, ${sealed.keyVersion},
      ${sealed.iv}, ${sealed.ciphertext}, ${sealed.tag}, ${NOW_UTC}, ${NOW_UTC})
    ON CONFLICT ("chainId", "reason") DO NOTHING`;
}
