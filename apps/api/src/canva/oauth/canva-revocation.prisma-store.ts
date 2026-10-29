import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  type CanvaExhaustedRevocation,
  type CanvaRevocationDecision,
  type CanvaRevocationInspection,
  type CanvaRevocationQueueStore,
  type CanvaRevocationReason,
  type CanvaRevocationRecord,
  type ClaimedCanvaRevocation,
} from './canva-oauth.stores';
import {
  CLOCK_UTC,
  NOW_UTC,
  lockAccount,
  lockConnection,
  milliseconds,
  runCanvaTransaction,
  type CanvaTransactionRunner,
  type CanvaTx,
} from './canva-prisma.transaction';
import { expireCandidatesInTransaction } from './canva-credential.prisma-store';
import { REVOCATION_MAX_ATTEMPTS } from './canva-revocation';

const CLAIM_MS = 60_000;
// §2.7 step 2: send deadline (5 s) + request timeout (10 s) + allowance
// for Canva applying an abandoned request (120 s, assumption A-R2).
const CRASHED_CALL_WINDOW = Prisma.sql`interval '135 seconds'`;
const AMBIGUOUS_TIMEOUT = Prisma.sql`interval '15 seconds'`;
const AMBIGUOUS_ALLOWANCE = Prisma.sql`interval '120 seconds'`;
const ABANDON_AFTER = Prisma.sql`interval '30 days'`;
const PURGE_AFTER = Prisma.sql`interval '90 days'`;
const SWEEP_BATCH = 100;
const EXHAUSTED_LIST_LIMIT = 50;

type QueueRow = {
  id: string;
  organizationId: string;
  canvaUserId: string;
  reason: CanvaRevocationReason;
  state: string;
  attempts: number;
  keyVersion: number | null;
  refreshTokenIv: string | null;
  refreshTokenCiphertext: string | null;
  refreshTokenTag: string | null;
};

// Clears the ciphertext whenever a row finishes.
const FINISHED_COLUMNS = Prisma.sql`
  "state" = 'finished', "finishedAt" = ${NOW_UTC}, "claimedUntil" = NULL,
  "keyVersion" = NULL, "refreshTokenIv" = NULL,
  "refreshTokenCiphertext" = NULL, "refreshTokenTag" = NULL`;

// §5.10 and §5.13 of the persistence proposal.
@Injectable()
export class PrismaCanvaRevocationQueue implements CanvaRevocationQueueStore {
  private readonly logger = new Logger('CanvaRevocationQueue');

  constructor(
    @Inject(PrismaService) private readonly prisma: CanvaTransactionRunner,
    private readonly audit: AuditService,
  ) {}

  async claim(
    claimToken: string,
    limit: number,
    canvaUserId?: string,
  ): Promise<ClaimedCanvaRevocation[]> {
    const forUser = canvaUserId
      ? Prisma.sql`AND "canvaUserId" = ${canvaUserId}`
      : Prisma.empty;
    return this.prisma.$queryRaw<ClaimedCanvaRevocation[]>`
      UPDATE "canva_pending_revocations"
      SET "claimToken" = ${claimToken}, "claimedUntil" = ${CLOCK_UTC} + ${milliseconds(CLAIM_MS)}
      WHERE "id" IN (
        SELECT "id" FROM "canva_pending_revocations"
        WHERE (("state" = 'queued' AND "nextAttemptAt" <= ${NOW_UTC}
                AND ("claimedUntil" IS NULL OR "claimedUntil" < ${NOW_UTC}))
            OR ("state" = 'in_flight' AND "claimedUntil" < ${NOW_UTC}))
          ${forUser}
        ORDER BY "nextAttemptAt" LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
      RETURNING "id", "canvaUserId"`;
  }

  // T1. Lock order: the account row, then the queue row.
  async decide(
    id: string,
    claimToken: string,
  ): Promise<CanvaRevocationDecision> {
    return runCanvaTransaction(this.prisma, async (tx) => {
      const [target] = await tx.$queryRaw<Array<{ canvaUserId: string }>>`
        SELECT "canvaUserId" FROM "canva_pending_revocations" WHERE "id" = ${id}`;
      if (!target) return { kind: 'lost' } as const;
      // Always exists: the queue row references it (ON DELETE RESTRICT).
      await lockAccount(tx, target.canvaUserId);
      const [row] = await tx.$queryRaw<QueueRow[]>`
        SELECT "id", "organizationId", "canvaUserId", "reason", "state", "attempts",
          "keyVersion", "refreshTokenIv", "refreshTokenCiphertext", "refreshTokenTag"
        FROM "canva_pending_revocations"
        WHERE "id" = ${id} AND "claimToken" = ${claimToken} FOR UPDATE`;
      if (!row || (row.state !== 'queued' && row.state !== 'in_flight'))
        return { kind: 'lost' } as const;
      if (row.state === 'in_flight')
        // A crashed or paused call: its window is bounded by the send
        // deadline, the timeout, and the allowance.
        await tx.$executeRaw`
          UPDATE "canva_pending_revocations"
          SET "state" = 'queued', "possibleEffectUntil" = GREATEST(
            COALESCE("possibleEffectUntil", '-infinity'::timestamp),
            "callStartedAt" + ${CRASHED_CALL_WINDOW})
          WHERE "id" = ${id} AND "state" = 'in_flight'`;
      // The same-user guard: a separate statement after the account lock.
      const shared = await tx.$queryRaw<Array<{ found: number }>>`
        SELECT 1 AS "found" FROM "canva_credentials" WHERE "canvaUserId" = ${row.canvaUserId}
        UNION ALL
        SELECT 1 AS "found" FROM "canva_connection_candidates" WHERE "canvaUserId" = ${row.canvaUserId}
        LIMIT 1`;
      if (shared.length) {
        await tx.$executeRaw`
          UPDATE "canva_pending_revocations"
          SET ${FINISHED_COLUMNS}, "outcome" = 'skipped_shared_consent'
          WHERE "id" = ${id}`;
        await this.auditFinished(
          tx,
          row,
          'skipped_shared_consent',
          row.attempts,
        );
        return { kind: 'skipped' } as const;
      }
      if (
        row.keyVersion === null ||
        !row.refreshTokenIv ||
        !row.refreshTokenCiphertext ||
        !row.refreshTokenTag
      ) {
        await tx.$executeRaw`
          UPDATE "canva_pending_revocations"
          SET ${FINISHED_COLUMNS}, "outcome" = 'undecryptable'
          WHERE "id" = ${id}`;
        await this.auditFinished(tx, row, 'undecryptable', row.attempts);
        return { kind: 'skipped' } as const;
      }
      if (row.attempts >= REVOCATION_MAX_ATTEMPTS) {
        await this.markExhausted(tx, row);
        return { kind: 'exhausted' } as const;
      }
      const [started] = await tx.$queryRaw<
        Array<{ attempts: number; ageMs: number }>
      >`
        UPDATE "canva_pending_revocations"
        SET "state" = 'in_flight', "attempts" = "attempts" + 1,
            "callStartedAt" = ${CLOCK_UTC},
            "claimedUntil" = ${CLOCK_UTC} + ${milliseconds(CLAIM_MS)}
        WHERE "id" = ${id}
        RETURNING "attempts",
          (EXTRACT(EPOCH FROM (${CLOCK_UTC} - "createdAt")) * 1000)::float8 AS "ageMs"`;
      return {
        kind: 'send',
        organizationId: row.organizationId,
        reason: row.reason,
        attempts: started.attempts,
        ageMs: started.ageMs,
        refreshToken: {
          keyVersion: row.keyVersion,
          iv: row.refreshTokenIv,
          ciphertext: row.refreshTokenCiphertext,
          tag: row.refreshTokenTag,
        },
      } as const;
    });
  }

  // T2. Conditioned on the claim and on in_flight, so a recovered row is
  // never overwritten by a late worker.
  async record(
    id: string,
    claimToken: string,
    record: CanvaRevocationRecord,
  ): Promise<boolean> {
    const effectEnd = record.ambiguous
      ? Prisma.sql`GREATEST(${CLOCK_UTC}, "callStartedAt" + ${AMBIGUOUS_TIMEOUT}) + ${AMBIGUOUS_ALLOWANCE}`
      : CLOCK_UTC;
    // No request sent: nothing can take effect, so the window is unchanged.
    const window =
      record.called === false
        ? Prisma.sql`"possibleEffectUntil"`
        : Prisma.sql`GREATEST(COALESCE("possibleEffectUntil", '-infinity'::timestamp), ${effectEnd})`;
    const finished = record.next === 'finished';
    // An exhausted row records when it was exhausted (the 30-day abandon
    // timer); a queued row when it is next due.
    const delayMs = record.next === 'queued' ? record.delayMs : 0;
    return runCanvaTransaction(this.prisma, async (tx) => {
      const [row] = await tx.$queryRaw<
        Array<
          Pick<
            QueueRow,
            'organizationId' | 'canvaUserId' | 'reason' | 'attempts'
          >
        >
      >`
        UPDATE "canva_pending_revocations"
        SET "state" = ${record.next}, "outcome" = ${record.outcome},
            "lastErrorKind" = ${record.lastErrorKind},
            "attempts" = "attempts" - ${record.refund ? 1 : 0},
            "nextAttemptAt" = ${CLOCK_UTC} + ${milliseconds(delayMs)},
            "possibleEffectUntil" = ${window},
            "claimedUntil" = NULL,
            "finishedAt" = CASE WHEN ${finished}::boolean THEN ${NOW_UTC} ELSE NULL END,
            "keyVersion" = CASE WHEN ${finished}::boolean THEN NULL ELSE "keyVersion" END,
            "refreshTokenIv" = CASE WHEN ${finished}::boolean THEN NULL ELSE "refreshTokenIv" END,
            "refreshTokenCiphertext" = CASE WHEN ${finished}::boolean THEN NULL ELSE "refreshTokenCiphertext" END,
            "refreshTokenTag" = CASE WHEN ${finished}::boolean THEN NULL ELSE "refreshTokenTag" END
        WHERE "id" = ${id} AND "claimToken" = ${claimToken} AND "state" = 'in_flight'
        RETURNING "organizationId", "canvaUserId", "reason", "attempts"`;
      if (!row) return false;
      if (finished && record.outcome)
        await this.auditFinished(tx, row, record.outcome, row.attempts);
      if (record.next === 'exhausted') await this.auditExhausted(tx, row);
      return true;
    });
  }

  async retryExhausted(
    organizationId: string,
    id: string,
    actorUserId: string,
  ): Promise<boolean> {
    return runCanvaTransaction(this.prisma, async (tx) => {
      const [row] = await tx.$queryRaw<
        Array<{ reason: string; attempts: number }>
      >`
        UPDATE "canva_pending_revocations" r
        SET "state" = 'queued', "attempts" = 0, "nextAttemptAt" = ${NOW_UTC},
            "claimToken" = NULL, "claimedUntil" = NULL
        FROM (SELECT "attempts" AS "previousAttempts" FROM "canva_pending_revocations"
              WHERE "id" = ${id} FOR UPDATE) prior
        WHERE r."id" = ${id} AND r."organizationId" = ${organizationId} AND r."state" = 'exhausted'
        RETURNING r."reason", prior."previousAttempts" AS "attempts"`;
      if (!row) return false;
      await this.audit.write(tx, {
        organizationId,
        actorUserId,
        action: 'canva.connection.revocation_retried',
        entityType: 'canva_pending_revocation',
        entityId: id,
        metadata: { reason: row.reason, previousAttempts: row.attempts },
      });
      return true;
    });
  }

  async dismissExhausted(
    organizationId: string,
    id: string,
    actorUserId: string,
  ): Promise<boolean> {
    return runCanvaTransaction(this.prisma, async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ reason: string }>>`
        UPDATE "canva_pending_revocations"
        SET ${FINISHED_COLUMNS}, "outcome" = 'dismissed'
        WHERE "id" = ${id} AND "organizationId" = ${organizationId} AND "state" = 'exhausted'
        RETURNING "reason"`;
      if (!row) return false;
      await this.audit.write(tx, {
        organizationId,
        actorUserId,
        action: 'canva.connection.revocation_dismissed',
        entityType: 'canva_pending_revocation',
        entityId: id,
        metadata: { reason: row.reason, outcome: 'dismissed' },
      });
      return true;
    });
  }

  async listExhausted(
    organizationId: string,
  ): Promise<CanvaExhaustedRevocation[]> {
    // Exhausted rows record the time they were exhausted in nextAttemptAt.
    return this.prisma.$queryRaw<CanvaExhaustedRevocation[]>`
      SELECT "id", "reason", "attempts", "lastErrorKind", "createdAt",
        "nextAttemptAt" AS "exhaustedAt"
      FROM "canva_pending_revocations"
      WHERE "organizationId" = ${organizationId} AND "state" = 'exhausted'
      ORDER BY "nextAttemptAt" LIMIT ${EXHAUSTED_LIST_LIMIT}`;
  }

  // Plain reads with no locks and no writes: the operator's dry run. The
  // preview mirrors T1's order (guard, then the attempt limit) but is only
  // a snapshot; T1 re-decides under the account lock.
  async inspect(limit: number): Promise<CanvaRevocationInspection> {
    const states = await this.prisma.$queryRaw<
      Array<{ state: string; rows: number }>
    >`
      SELECT "state", count(*)::int AS "rows" FROM "canva_pending_revocations"
      GROUP BY "state"`;
    const counts = { queued: 0, in_flight: 0, exhausted: 0, finished: 0 };
    for (const { state, rows } of states)
      if (state in counts) counts[state as keyof typeof counts] = rows;
    const [pending] = await this.prisma.$queryRaw<
      Array<{
        due: number;
        crashed: number;
        configuration: number;
        keyUnavailable: number;
      }>
    >`
      SELECT
        count(*) FILTER (WHERE "state" = 'queued' AND "nextAttemptAt" <= ${NOW_UTC}
          AND ("claimedUntil" IS NULL OR "claimedUntil" < ${NOW_UTC}))::int AS "due",
        count(*) FILTER (WHERE "state" = 'in_flight' AND "claimedUntil" < ${NOW_UTC})::int AS "crashed",
        count(*) FILTER (WHERE "state" <> 'finished'
          AND "lastErrorKind" = 'configuration')::int AS "configuration",
        count(*) FILTER (WHERE "state" <> 'finished'
          AND "lastErrorKind" = 'key_unavailable')::int AS "keyUnavailable"
      FROM "canva_pending_revocations"`;
    const [connections] = await this.prisma.$queryRaw<
      Array<{ configuration: number }>
    >`
      SELECT count(*)::int AS "configuration" FROM "canva_connections"
      WHERE "lastProviderErrorKind" = 'configuration'`;
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        organizationId: string;
        reason: CanvaRevocationReason;
        state: 'queued' | 'in_flight';
        attempts: number;
        shared: boolean;
      }>
    >`
      SELECT r."id", r."organizationId", r."reason", r."state", r."attempts",
        (EXISTS (SELECT 1 FROM "canva_credentials" c WHERE c."canvaUserId" = r."canvaUserId")
          OR EXISTS (SELECT 1 FROM "canva_connection_candidates" d
                     WHERE d."canvaUserId" = r."canvaUserId")) AS "shared"
      FROM "canva_pending_revocations" r
      WHERE (r."state" = 'queued' AND r."nextAttemptAt" <= ${NOW_UTC}
             AND (r."claimedUntil" IS NULL OR r."claimedUntil" < ${NOW_UTC}))
         OR (r."state" = 'in_flight' AND r."claimedUntil" < ${NOW_UTC})
      ORDER BY r."nextAttemptAt" LIMIT ${limit}`;
    return {
      counts,
      due: pending?.due ?? 0,
      crashed: pending?.crashed ?? 0,
      preview: rows.map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        reason: row.reason,
        state: row.state,
        attempts: row.attempts,
        recovering: row.state === 'in_flight',
        wouldDo: row.shared
          ? 'skip_shared_consent'
          : row.attempts >= REVOCATION_MAX_ATTEMPTS
            ? 'exhaust'
            : 'send',
      })),
      health: {
        revocationConfigurationErrors: pending?.configuration ?? 0,
        revocationKeyUnavailable: pending?.keyUnavailable ?? 0,
        connectionConfigurationErrors: connections?.configuration ?? 0,
      },
    };
  }

  async maintain() {
    let expiredCandidates = 0;
    const organizations = await this.prisma.$queryRaw<
      Array<{ organizationId: string }>
    >`
      SELECT "organizationId" FROM "canva_connection_candidates"
      WHERE "expiresAt" <= ${NOW_UTC} LIMIT ${SWEEP_BATCH}`;
    for (const { organizationId } of organizations)
      expiredCandidates += await runCanvaTransaction(
        this.prisma,
        async (tx) => {
          if (!(await lockConnection(tx, organizationId))) return 0;
          return expireCandidatesInTransaction(tx, this.audit, organizationId);
        },
      );

    // Exhausted rows record the time they were exhausted in nextAttemptAt.
    const abandoned = await runCanvaTransaction(this.prisma, async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ id: string; organizationId: string; reason: string }>
      >`
        UPDATE "canva_pending_revocations"
        SET ${FINISHED_COLUMNS}, "outcome" = 'abandoned'
        WHERE "state" = 'exhausted' AND "nextAttemptAt" < ${NOW_UTC} - ${ABANDON_AFTER}
        RETURNING "id", "organizationId", "reason"`;
      for (const row of rows)
        await this.audit.write(tx, {
          organizationId: row.organizationId,
          actorUserId: null,
          action: 'canva.connection.revocation_dismissed',
          entityType: 'canva_pending_revocation',
          entityId: row.id,
          metadata: { reason: row.reason, outcome: 'abandoned' },
        });
      return rows.length;
    });

    const purged = await this.prisma.$executeRaw`
      DELETE FROM "canva_pending_revocations"
      WHERE "state" = 'finished' AND "finishedAt" < ${NOW_UTC} - ${PURGE_AFTER}`;

    // §5.13: lock, then re-check in a separate statement (read-after-lock).
    const releasedHolds = await runCanvaTransaction(this.prisma, async (tx) => {
      const candidates = await tx.$queryRaw<Array<{ canvaUserId: string }>>`
        SELECT "canvaUserId" FROM "canva_accounts" a
        WHERE a."organizationId" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "canva_credentials" c WHERE c."canvaUserId" = a."canvaUserId")
          AND NOT EXISTS (SELECT 1 FROM "canva_connection_candidates" d WHERE d."canvaUserId" = a."canvaUserId")
        LIMIT ${SWEEP_BATCH} FOR UPDATE SKIP LOCKED`;
      if (!candidates.length) return 0;
      const ids = candidates.map((row) => row.canvaUserId);
      return tx.$executeRaw`
        UPDATE "canva_accounts" a SET "organizationId" = NULL, "updatedAt" = ${NOW_UTC}
        WHERE a."canvaUserId" IN (${Prisma.join(ids)})
          AND NOT EXISTS (SELECT 1 FROM "canva_credentials" c WHERE c."canvaUserId" = a."canvaUserId")
          AND NOT EXISTS (SELECT 1 FROM "canva_connection_candidates" d WHERE d."canvaUserId" = a."canvaUserId")`;
    });

    const deletedAccounts = await runCanvaTransaction(
      this.prisma,
      async (tx) => {
        const stale = await tx.$queryRaw<Array<{ canvaUserId: string }>>`
        SELECT "canvaUserId" FROM "canva_accounts" a
        WHERE a."organizationId" IS NULL AND a."createdAt" < ${NOW_UTC} - ${PURGE_AFTER}
          AND NOT EXISTS (SELECT 1 FROM "canva_pending_revocations" r WHERE r."canvaUserId" = a."canvaUserId")
        LIMIT ${SWEEP_BATCH} FOR UPDATE SKIP LOCKED`;
        if (!stale.length) return 0;
        const ids = stale.map((row) => row.canvaUserId);
        return tx.$executeRaw`
        DELETE FROM "canva_accounts" a
        WHERE a."canvaUserId" IN (${Prisma.join(ids)}) AND a."organizationId" IS NULL
          AND NOT EXISTS (SELECT 1 FROM "canva_pending_revocations" r WHERE r."canvaUserId" = a."canvaUserId")
          AND NOT EXISTS (SELECT 1 FROM "canva_credentials" c WHERE c."canvaUserId" = a."canvaUserId")
          AND NOT EXISTS (SELECT 1 FROM "canva_connection_candidates" d WHERE d."canvaUserId" = a."canvaUserId")`;
      },
    );

    return {
      expiredCandidates,
      abandoned,
      purged,
      releasedHolds,
      deletedAccounts,
    };
  }

  private async markExhausted(tx: CanvaTx, row: QueueRow): Promise<void> {
    await tx.$executeRaw`
      UPDATE "canva_pending_revocations"
      SET "state" = 'exhausted', "claimedUntil" = NULL, "nextAttemptAt" = ${NOW_UTC}
      WHERE "id" = ${row.id}`;
    await this.auditExhausted(tx, row);
  }

  private async auditExhausted(
    tx: CanvaTx,
    row: Pick<QueueRow, 'organizationId' | 'reason' | 'attempts'>,
  ): Promise<void> {
    // Operational signal; the ciphertext is kept for an administrator retry.
    this.logger.error(
      `Canva revocation exhausted after ${row.attempts} attempts (${row.reason})`,
    );
    await this.audit.write(tx, {
      organizationId: row.organizationId,
      actorUserId: null,
      action: 'canva.connection.revocation_exhausted',
      entityType: 'canva_connection',
      entityId: row.organizationId,
      metadata: { reason: row.reason, attempts: row.attempts },
    });
  }

  private async auditFinished(
    tx: CanvaTx,
    row: Pick<QueueRow, 'organizationId' | 'reason'>,
    outcome: string,
    attempts: number,
  ): Promise<void> {
    await this.audit.write(tx, {
      organizationId: row.organizationId,
      actorUserId: null,
      action: 'canva.connection.revocation_finished',
      entityType: 'canva_connection',
      entityId: row.organizationId,
      metadata: { reason: row.reason, outcome, attempts },
    });
  }
}
