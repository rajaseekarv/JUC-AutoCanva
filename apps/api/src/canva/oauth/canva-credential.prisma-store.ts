import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CanvaPersistenceError,
  CanvaRefreshBusyError,
  CanvaStaleCredentialError,
  type CanvaActivation,
  type CanvaCandidateCreation,
  type CanvaCandidateOwner,
  type CanvaConnectionDetails,
  type CanvaCredentialStore,
  type CanvaReauthorizationReason,
  type CanvaRefreshLease,
  type CanvaRevocationReason,
  type NewCanvaCandidate,
  type NewCanvaCredential,
  type NewCanvaRevocation,
  type PendingCanvaCandidate,
  type StoredCanvaCredential,
} from './canva-oauth.stores';
import {
  CLOCK_UTC,
  NOW_UTC,
  RollbackWith,
  enqueueInTransaction,
  lockAccount,
  lockAccounts,
  lockConnection,
  milliseconds,
  realSleep,
  releaseAccountIfUnreferenced,
  runCanvaTransaction,
  utcTimestamp,
  type CanvaTransactionRunner,
  type CanvaTx,
  type SleepFn,
} from './canva-prisma.transaction';
import type { SealedValue } from './canva-token-cipher';

export const CANVA_CANDIDATE_TTL_MS = 10 * 60_000;
export const CANVA_REFRESH_LEASE_MS = 60_000;
const LEASE_POLL_MS = 250;
const LEASE_WAIT_MS = 15_000;
// Before calling Canva the lease must have at least this long left (§5.7).
const LEASE_MIN_REMAINING_SECONDS = 20;
const CONFIGURATION_ERROR_THROTTLE_MS = 5 * 60_000;

type SealedColumns = {
  keyVersion: number;
  accessTokenIv: string;
  accessTokenCiphertext: string;
  accessTokenTag: string;
  refreshTokenIv: string;
  refreshTokenCiphertext: string;
  refreshTokenTag: string;
};

type CredentialRow = SealedColumns & {
  organizationId: string;
  connectedById: string;
  chainId: string;
  writeId: string;
  version: number;
  accessTokenExpiresAt: Date;
  scopes: string[];
  canvaUserId: string;
  canvaTeamId: string;
};

type CandidateRow = SealedColumns & {
  id: string;
  organizationId: string;
  attemptId: string;
  userId: string;
  sessionId: string;
  baseGeneration: number;
  chainId: string;
  writeId: string;
  accessTokenExpiresAt: Date;
  scopes: string[];
  canvaUserId: string;
  canvaTeamId: string;
  canvaDisplayName: string | null;
  hasAutofill: boolean;
  hasBrandTemplates: boolean;
  createdAt: Date;
  expiresAt: Date;
};

function refreshTokenOf(row: SealedColumns): SealedValue {
  return {
    keyVersion: row.keyVersion,
    iv: row.refreshTokenIv,
    ciphertext: row.refreshTokenCiphertext,
    tag: row.refreshTokenTag,
  };
}

function toCredential(row: CredentialRow): StoredCanvaCredential {
  return {
    organizationId: row.organizationId,
    connectedById: row.connectedById,
    accessToken: {
      keyVersion: row.keyVersion,
      iv: row.accessTokenIv,
      ciphertext: row.accessTokenCiphertext,
      tag: row.accessTokenTag,
    },
    refreshToken: refreshTokenOf(row),
    accessTokenExpiresAt: row.accessTokenExpiresAt,
    scopes: row.scopes,
    canvaUserId: row.canvaUserId,
    canvaTeamId: row.canvaTeamId,
    chainId: row.chainId,
    writeId: row.writeId,
    version: row.version,
  };
}

// Access and refresh tokens are sealed separately but must share a key
// version, because one column records it.
function sameKeyVersion(access: SealedValue, refresh: SealedValue): number {
  if (access.keyVersion !== refresh.keyVersion)
    throw new CanvaPersistenceError();
  return access.keyVersion;
}

async function candidateFor(
  tx: CanvaTx,
  organizationId: string,
): Promise<(CandidateRow & { expired: boolean }) | null> {
  const rows = await tx.$queryRaw<Array<CandidateRow & { expired: boolean }>>`
    SELECT *, "expiresAt" <= ${NOW_UTC} AS "expired"
    FROM "canva_connection_candidates" WHERE "organizationId" = ${organizationId}`;
  return rows[0] ?? null;
}

// §5.6 inside a transaction that already holds the connection lock and the
// candidate user's account lock. A same-user reconnect's candidate tokens
// are discarded (the credential still holds the user, so a revocation would
// end its consent); otherwise they are queued.
async function removeCandidate(
  tx: CanvaTx,
  audit: AuditService,
  candidate: CandidateRow,
  reason: Extract<
    CanvaRevocationReason,
    | 'candidate_rejected'
    | 'candidate_expired'
    | 'candidate_superseded'
    | 'connect_conflict'
  >,
  actorUserId: string | null,
): Promise<void> {
  const [sameUser] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "canva_credentials"
    WHERE "organizationId" = ${candidate.organizationId}
      AND "canvaUserId" = ${candidate.canvaUserId}`;
  if (!sameUser || reason === 'candidate_superseded')
    await enqueueInTransaction(
      tx,
      {
        organizationId: candidate.organizationId,
        chainId: candidate.chainId,
        canvaUserId: candidate.canvaUserId,
        reason,
        refreshToken: refreshTokenOf(candidate),
      },
      randomUUID,
    );
  await tx.$executeRaw`
    DELETE FROM "canva_connection_candidates" WHERE "id" = ${candidate.id}`;
  await releaseAccountIfUnreferenced(tx, candidate.canvaUserId);
  await audit.write(tx, {
    organizationId: candidate.organizationId,
    actorUserId,
    action: 'canva.oauth.candidate_rejected',
    entityType: 'canva_connection',
    entityId: candidate.organizationId,
    metadata: { reason },
  });
}

// Lazy expiry (§5.6 with candidate_expired), inside a transaction that
// holds the organization's connection lock.
export async function expireCandidatesInTransaction(
  tx: CanvaTx,
  audit: AuditService,
  organizationId: string,
): Promise<number> {
  const candidate = await candidateFor(tx, organizationId);
  if (!candidate?.expired) return 0;
  await lockAccount(tx, candidate.canvaUserId);
  await removeCandidate(tx, audit, candidate, 'candidate_expired', null);
  return 1;
}

export type PrismaCredentialStoreOptions = { sleep?: SleepFn };
export const CANVA_CREDENTIAL_STORE_OPTIONS = Symbol(
  'CANVA_CREDENTIAL_STORE_OPTIONS',
);

// §5.4-5.9 and §5.12 of the persistence proposal. Lock order: connection
// row, account rows (ascending), credential, candidate, attempt, queue.
@Injectable()
export class PrismaCanvaCredentialStore implements CanvaCredentialStore {
  private readonly sleep: SleepFn;

  constructor(
    @Inject(PrismaService) private readonly prisma: CanvaTransactionRunner,
    private readonly audit: AuditService,
    @Optional()
    @Inject(CANVA_CREDENTIAL_STORE_OPTIONS)
    options: PrismaCredentialStoreOptions = {},
  ) {
    this.sleep = options?.sleep ?? realSleep;
  }

  async read(organizationId: string): Promise<StoredCanvaCredential | null> {
    const rows = await this.prisma.$queryRaw<CredentialRow[]>`
      SELECT * FROM "canva_credentials" WHERE "organizationId" = ${organizationId}`;
    return rows[0] ? toCredential(rows[0]) : null;
  }

  async createCandidate(
    candidate: NewCanvaCandidate,
  ): Promise<CanvaCandidateCreation> {
    const { attempt } = candidate;
    const organizationId = attempt.organizationId;
    const keyVersion = sameKeyVersion(
      candidate.accessToken,
      candidate.refreshToken,
    );
    // An expired candidate is removed in its own transaction first (§5.4
    // step 5) and the creation is retried once.
    for (let pass = 0; pass < 2; pass += 1) {
      const result = await runCanvaTransaction(this.prisma, async (tx) => {
        if (!(await lockConnection(tx, organizationId)))
          throw new CanvaPersistenceError();
        const existing = await candidateFor(tx, organizationId);
        if (existing?.expired) return 'expired_candidate' as const;
        if (existing) {
          await enqueueInTransaction(
            tx,
            {
              organizationId,
              chainId: candidate.chainId,
              canvaUserId: candidate.canvaUserId,
              reason: 'connect_conflict',
              refreshToken: candidate.refreshToken,
            },
            randomUUID,
          );
          await this.audit.write(tx, {
            organizationId,
            actorUserId: attempt.userId,
            action: 'canva.oauth.failed',
            entityType: 'canva_connection',
            entityId: organizationId,
            metadata: { outcome: 'conflict' },
          });
          return { outcome: 'conflict' } as const;
        }
        const holder = await lockAccount(tx, candidate.canvaUserId);
        if (holder !== null && holder !== organizationId)
          throw new RollbackWith<CanvaCandidateCreation>({
            outcome: 'account_unavailable',
          });
        // §2.7 step 4: a separate statement after the account lock, so it
        // sees any T1 that committed before the lock was granted.
        const fence = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "canva_pending_revocations"
          WHERE "canvaUserId" = ${candidate.canvaUserId}
            AND ("state" = 'in_flight' OR "possibleEffectUntil" > (
              SELECT "launchedAt" FROM "canva_oauth_attempts" WHERE "id" = ${attempt.attemptId}))
          LIMIT 1`;
        if (fence.length)
          throw new RollbackWith<CanvaCandidateCreation>({
            outcome: 'retry_connect',
          });
        await tx.$executeRaw`
          UPDATE "canva_accounts" SET "organizationId" = ${organizationId}, "updatedAt" = ${NOW_UTC}
          WHERE "canvaUserId" = ${candidate.canvaUserId} AND "organizationId" IS NULL`;
        const candidateId = randomUUID();
        const access = candidate.accessToken;
        const refresh = candidate.refreshToken;
        const [created] = await tx.$queryRaw<Array<{ expiresAt: Date }>>`
          INSERT INTO "canva_connection_candidates" ("id", "organizationId", "attemptId",
            "userId", "sessionId", "baseGeneration", "chainId", "writeId", "keyVersion",
            "accessTokenIv", "accessTokenCiphertext", "accessTokenTag",
            "refreshTokenIv", "refreshTokenCiphertext", "refreshTokenTag",
            "accessTokenExpiresAt", "scopes", "canvaUserId", "canvaTeamId",
            "canvaDisplayName", "hasAutofill", "hasBrandTemplates", "createdAt", "expiresAt")
          VALUES (${candidateId}, ${organizationId}, ${attempt.attemptId},
            ${attempt.userId}, ${attempt.sessionId}, ${attempt.baseGeneration},
            ${candidate.chainId}, ${candidate.writeId}, ${keyVersion},
            ${access.iv}, ${access.ciphertext}, ${access.tag},
            ${refresh.iv}, ${refresh.ciphertext}, ${refresh.tag},
            ${utcTimestamp(candidate.accessTokenExpiresAt)}, ${candidate.scopes}::text[],
            ${candidate.canvaUserId}, ${candidate.canvaTeamId}, ${candidate.canvaDisplayName},
            ${candidate.capabilities.autofill}, ${candidate.capabilities.brandTemplate},
            ${NOW_UTC}, ${NOW_UTC} + ${milliseconds(CANVA_CANDIDATE_TTL_MS)})
          RETURNING "expiresAt"`;
        await this.audit.write(tx, {
          organizationId,
          actorUserId: attempt.userId,
          action: 'canva.oauth.pending_confirmation',
          entityType: 'canva_connection',
          entityId: organizationId,
          metadata: {
            mode: 'CANVA',
            expiresAt: created.expiresAt.toISOString(),
            hasAutofill: candidate.capabilities.autofill,
            hasBrandTemplates: candidate.capabilities.brandTemplate,
          },
        });
        return {
          outcome: 'pending_confirmation',
          candidateId,
          expiresAt: created.expiresAt,
        } as const;
      });
      if (result !== 'expired_candidate') return result;
      await this.expireCandidates(organizationId);
    }
    throw new CanvaPersistenceError();
  }

  async candidateExists(writeId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "canva_connection_candidates" WHERE "writeId" = ${writeId}`;
    return rows.length > 0;
  }

  async readCandidate(
    owner: CanvaCandidateOwner,
  ): Promise<PendingCanvaCandidate | null> {
    await this.expireCandidates(owner.organizationId);
    const rows = await this.prisma.$queryRaw<
      Array<CandidateRow & { currentCanvaUserId: string | null }>
    >`
      SELECT c.*, cr."canvaUserId" AS "currentCanvaUserId"
      FROM "canva_connection_candidates" c
      LEFT JOIN "canva_credentials" cr ON cr."organizationId" = c."organizationId"
      WHERE c."organizationId" = ${owner.organizationId} AND c."userId" = ${owner.userId}
        AND c."sessionId" = ${owner.sessionId} AND c."expiresAt" > ${NOW_UTC}`;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      organizationId: row.organizationId,
      userId: row.userId,
      sessionId: row.sessionId,
      canvaUserId: row.canvaUserId,
      canvaTeamId: row.canvaTeamId,
      canvaDisplayName: row.canvaDisplayName,
      scopes: row.scopes,
      capabilities: {
        autofill: row.hasAutofill,
        brandTemplate: row.hasBrandTemplates,
      },
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      currentCanvaUserId: row.currentCanvaUserId,
    };
  }

  async activateCandidate(
    owner: CanvaCandidateOwner,
    candidateId: string,
  ): Promise<CanvaActivation> {
    const organizationId = owner.organizationId;
    return runCanvaTransaction(this.prisma, async (tx) => {
      const connection = await lockConnection(tx, organizationId);
      if (!connection) return { outcome: 'not_found' } as const;
      const [candidate] = await tx.$queryRaw<CandidateRow[]>`
        SELECT * FROM "canva_connection_candidates"
        WHERE "id" = ${candidateId} AND "organizationId" = ${organizationId}
          AND "userId" = ${owner.userId} AND "sessionId" = ${owner.sessionId}
          AND "expiresAt" > ${NOW_UTC}`;
      if (!candidate) return { outcome: 'not_found' } as const;
      // A plain read is safe: every credential write takes the connection
      // lock first, so canvaUserId cannot change before the lock below.
      const [previousUser] = await tx.$queryRaw<Array<{ canvaUserId: string }>>`
        SELECT "canvaUserId" FROM "canva_credentials" WHERE "organizationId" = ${organizationId}`;
      const previousCanvaUserId = previousUser?.canvaUserId ?? null;
      await lockAccounts(tx, [candidate.canvaUserId, previousCanvaUserId]);
      if (connection.connectionGeneration !== candidate.baseGeneration) {
        await removeCandidate(
          tx,
          this.audit,
          candidate,
          'connect_conflict',
          owner.userId,
        );
        return { outcome: 'stale' } as const;
      }
      const [previous] = await tx.$queryRaw<CredentialRow[]>`
        SELECT * FROM "canva_credentials" WHERE "organizationId" = ${organizationId} FOR UPDATE`;
      const sameCanvaUser = previous?.canvaUserId === candidate.canvaUserId;
      if (previous && !sameCanvaUser)
        await enqueueInTransaction(
          tx,
          {
            organizationId,
            chainId: previous.chainId,
            canvaUserId: previous.canvaUserId,
            reason: 'replaced_other_user',
            refreshToken: refreshTokenOf(previous),
          },
          randomUUID,
        );
      // Deleted before the old user is released: a release while referenced
      // would be rejected by ON UPDATE RESTRICT.
      await tx.$executeRaw`
        DELETE FROM "canva_credentials" WHERE "organizationId" = ${organizationId}`;
      if (previous && !sameCanvaUser)
        await releaseAccountIfUnreferenced(tx, previous.canvaUserId);
      const version = connection.credentialVersion + 1;
      const [inserted] = await tx.$queryRaw<CredentialRow[]>`
        INSERT INTO "canva_credentials" ("id", "organizationId", "connectedById", "chainId",
          "writeId", "version", "keyVersion", "accessTokenIv", "accessTokenCiphertext",
          "accessTokenTag", "refreshTokenIv", "refreshTokenCiphertext", "refreshTokenTag",
          "accessTokenExpiresAt", "scopes", "canvaUserId", "canvaTeamId", "createdAt", "updatedAt")
        VALUES (${randomUUID()}, ${organizationId}, ${candidate.userId}, ${candidate.chainId},
          ${candidate.writeId}, ${version}, ${candidate.keyVersion},
          ${candidate.accessTokenIv}, ${candidate.accessTokenCiphertext}, ${candidate.accessTokenTag},
          ${candidate.refreshTokenIv}, ${candidate.refreshTokenCiphertext}, ${candidate.refreshTokenTag},
          ${utcTimestamp(candidate.accessTokenExpiresAt)}, ${candidate.scopes}::text[],
          ${candidate.canvaUserId}, ${candidate.canvaTeamId}, ${NOW_UTC}, ${NOW_UTC})
        RETURNING *`;
      await tx.$executeRaw`
        UPDATE "canva_connections"
        SET "status" = 'CONNECTED'::"CanvaConnectionStatus", "mode" = 'CANVA',
            "connectionGeneration" = "connectionGeneration" + 1,
            "credentialVersion" = ${version}, "connectedById" = ${candidate.userId},
            "connectedAt" = ${NOW_UTC}, "reauthorizationReason" = NULL,
            "reauthorizationRequiredAt" = NULL, "lastProviderErrorKind" = NULL,
            "lastProviderErrorAt" = NULL, "updatedAt" = ${NOW_UTC}
        WHERE "organizationId" = ${organizationId}`;
      await tx.$executeRaw`
        DELETE FROM "canva_connection_candidates" WHERE "id" = ${candidate.id}`;
      await this.audit.write(tx, {
        organizationId,
        actorUserId: owner.userId,
        action: 'canva.connection.connected',
        entityType: 'canva_connection',
        entityId: organizationId,
        metadata: {
          mode: 'CANVA',
          scopes: candidate.scopes,
          replacedPrevious: !!previous,
          sameCanvaUser,
        },
      });
      return {
        outcome: 'connected',
        credential: toCredential(inserted),
        replacedPrevious: !!previous,
        sameCanvaUser,
      } as const;
    });
  }

  async rejectCandidate(
    owner: CanvaCandidateOwner,
    candidateId: string,
  ): Promise<boolean> {
    return runCanvaTransaction(this.prisma, async (tx) => {
      if (!(await lockConnection(tx, owner.organizationId))) return false;
      const [candidate] = await tx.$queryRaw<CandidateRow[]>`
        SELECT * FROM "canva_connection_candidates"
        WHERE "id" = ${candidateId} AND "organizationId" = ${owner.organizationId}
          AND "userId" = ${owner.userId} AND "sessionId" = ${owner.sessionId}`;
      if (!candidate) return false;
      await lockAccount(tx, candidate.canvaUserId);
      await removeCandidate(
        tx,
        this.audit,
        candidate,
        'candidate_rejected',
        owner.userId,
      );
      return true;
    });
  }

  async withRefreshLock<T>(
    organizationId: string,
    work: (
      current: StoredCanvaCredential | null,
      lease: CanvaRefreshLease,
    ) => Promise<{ result: T; replace?: NewCanvaCredential }>,
  ): Promise<T> {
    const owner = randomUUID();
    const claimed = await this.claimLease(organizationId, owner);
    if (claimed === 'none')
      return (await work(null, { tookOver: false })).result;
    let released = false;
    try {
      const { result, replace } = await work(toCredential(claimed.row), {
        tookOver: claimed.tookOver,
      });
      if (replace) {
        // The write clears the lease (on success); on a definite failure the
        // finally block releases it.
        await this.writeRotation(claimed.row, replace);
        released = true;
      }
      return result;
    } finally {
      if (!released) await this.releaseLease(organizationId, owner);
    }
  }

  // §5.7 step 2, polled for up to 15 seconds.
  private async claimLease(
    organizationId: string,
    owner: string,
  ): Promise<'none' | { row: CredentialRow; tookOver: boolean }> {
    const deadline = Date.now() + LEASE_WAIT_MS;
    for (;;) {
      const rows = await this.prisma.$queryRaw<
        Array<CredentialRow & { tookOver: boolean; secondsLeft: number }>
      >`
        WITH prior AS (
          SELECT "refreshLeaseOwner" AS "previousOwner", "refreshLeaseUntil" AS "previousUntil"
          FROM "canva_credentials" WHERE "organizationId" = ${organizationId} FOR UPDATE
        )
        UPDATE "canva_credentials" c
        SET "refreshLeaseOwner" = ${owner},
            "refreshLeaseUntil" = ${CLOCK_UTC} + ${milliseconds(CANVA_REFRESH_LEASE_MS)}
        FROM prior
        WHERE c."organizationId" = ${organizationId}
          AND (prior."previousUntil" IS NULL OR prior."previousUntil" < ${CLOCK_UTC})
        RETURNING c.*, prior."previousOwner" IS NOT NULL AS "tookOver",
          EXTRACT(EPOCH FROM (c."refreshLeaseUntil" - ${CLOCK_UTC}))::float8 AS "secondsLeft"`;
      const row = rows[0];
      if (row) {
        if (row.secondsLeft >= LEASE_MIN_REMAINING_SECONDS)
          return { row, tookOver: row.tookOver };
        // The process paused after claiming: let it go and claim again.
        await this.releaseLease(organizationId, owner);
      } else {
        const [exists] = await this.prisma.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "canva_credentials" WHERE "organizationId" = ${organizationId}`;
        if (!exists) return 'none';
      }
      if (Date.now() >= deadline) throw new CanvaRefreshBusyError();
      await this.sleep(LEASE_POLL_MS);
    }
  }

  private async releaseLease(
    organizationId: string,
    owner: string,
  ): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        UPDATE "canva_credentials" SET "refreshLeaseOwner" = NULL, "refreshLeaseUntil" = NULL
        WHERE "organizationId" = ${organizationId} AND "refreshLeaseOwner" = ${owner}`;
    } catch {
      // The lease expires on its own after 60 seconds.
    }
  }

  // §5.7 step 5: conditioned on version and chain, never on the lease owner,
  // so a late holder whose version is still current may land its rotation.
  private async writeRotation(
    current: CredentialRow,
    replace: NewCanvaCredential,
  ): Promise<void> {
    const organizationId = current.organizationId;
    const keyVersion = sameKeyVersion(
      replace.accessToken,
      replace.refreshToken,
    );
    const toVersion = current.version + 1;
    await runCanvaTransaction(this.prisma, async (tx) => {
      await lockConnection(tx, organizationId);
      const access = replace.accessToken;
      const refresh = replace.refreshToken;
      const updated = await tx.$executeRaw`
        UPDATE "canva_credentials"
        SET "keyVersion" = ${keyVersion}, "accessTokenIv" = ${access.iv},
            "accessTokenCiphertext" = ${access.ciphertext}, "accessTokenTag" = ${access.tag},
            "refreshTokenIv" = ${refresh.iv}, "refreshTokenCiphertext" = ${refresh.ciphertext},
            "refreshTokenTag" = ${refresh.tag}, "writeId" = ${replace.writeId},
            "version" = ${toVersion},
            "accessTokenExpiresAt" = ${utcTimestamp(replace.accessTokenExpiresAt)},
            "scopes" = ${replace.scopes}::text[], "refreshLeaseOwner" = NULL,
            "refreshLeaseUntil" = NULL, "updatedAt" = ${NOW_UTC}
        WHERE "organizationId" = ${organizationId} AND "version" = ${current.version}
          AND "chainId" = ${current.chainId}`;
      if (updated !== 1) throw new CanvaStaleCredentialError();
      await tx.$executeRaw`
        UPDATE "canva_connections"
        SET "credentialVersion" = ${toVersion}, "lastProviderErrorKind" = NULL,
            "lastProviderErrorAt" = NULL, "updatedAt" = ${NOW_UTC}
        WHERE "organizationId" = ${organizationId}`;
      await this.audit.write(tx, {
        organizationId,
        actorUserId: null,
        action: 'canva.credential.refreshed',
        entityType: 'canva_connection',
        entityId: organizationId,
        metadata: {
          fromVersion: current.version,
          toVersion,
          scopesChanged:
            [...current.scopes].sort().join(' ') !==
            [...replace.scopes].sort().join(' '),
        },
      });
    });
  }

  async markReauthorizationRequired(
    organizationId: string,
    expectedVersion: number,
    reason: CanvaReauthorizationReason,
  ): Promise<boolean> {
    return runCanvaTransaction(this.prisma, async (tx) => {
      if (!(await lockConnection(tx, organizationId))) return false;
      const [current] = await tx.$queryRaw<Array<{ canvaUserId: string }>>`
        SELECT "canvaUserId" FROM "canva_credentials"
        WHERE "organizationId" = ${organizationId} AND "version" = ${expectedVersion}`;
      if (!current) return false;
      await lockAccount(tx, current.canvaUserId);
      const deleted = await tx.$executeRaw`
        DELETE FROM "canva_credentials"
        WHERE "organizationId" = ${organizationId} AND "version" = ${expectedVersion}`;
      if (deleted !== 1) throw new RollbackWith(false);
      // Released unless this organization's pending candidate is the same
      // Canva user (a reconnect awaiting confirmation keeps the hold).
      await releaseAccountIfUnreferenced(tx, current.canvaUserId);
      await tx.$executeRaw`
        UPDATE "canva_connections"
        SET "status" = 'REAUTHORIZATION_REQUIRED'::"CanvaConnectionStatus",
            "reauthorizationReason" = ${reason}, "reauthorizationRequiredAt" = ${NOW_UTC},
            "connectionGeneration" = "connectionGeneration" + 1,
            "credentialVersion" = "credentialVersion" + 1, "updatedAt" = ${NOW_UTC}
        WHERE "organizationId" = ${organizationId}`;
      await this.audit.write(tx, {
        organizationId,
        actorUserId: null,
        action: 'canva.connection.reauthorization_required',
        entityType: 'canva_connection',
        entityId: organizationId,
        metadata: { reason },
      });
      return true;
    });
  }

  async disconnect(
    organizationId: string,
    actorUserId: string,
  ): Promise<{ removed: boolean; queued: number }> {
    return runCanvaTransaction(this.prisma, async (tx) => {
      if (!(await lockConnection(tx, organizationId)))
        return { removed: false, queued: 0 };
      const [credentialUser] = await tx.$queryRaw<
        Array<{ canvaUserId: string }>
      >`
        SELECT "canvaUserId" FROM "canva_credentials" WHERE "organizationId" = ${organizationId}`;
      const candidate = await candidateFor(tx, organizationId);
      await lockAccounts(tx, [
        credentialUser?.canvaUserId,
        candidate?.canvaUserId,
      ]);
      let queued = 0;
      const [credential] = await tx.$queryRaw<CredentialRow[]>`
        SELECT * FROM "canva_credentials" WHERE "organizationId" = ${organizationId} FOR UPDATE`;
      if (credential) {
        await enqueueInTransaction(
          tx,
          {
            organizationId,
            chainId: credential.chainId,
            canvaUserId: credential.canvaUserId,
            reason: 'disconnect',
            refreshToken: refreshTokenOf(credential),
          },
          randomUUID,
        );
        queued += 1;
        await tx.$executeRaw`
          DELETE FROM "canva_credentials" WHERE "organizationId" = ${organizationId}`;
      }
      // D14: a superseded candidate is queued even for the same Canva user.
      if (candidate) {
        await removeCandidate(
          tx,
          this.audit,
          candidate,
          'candidate_superseded',
          actorUserId,
        );
        queued += 1;
      }
      if (credential)
        await releaseAccountIfUnreferenced(tx, credential.canvaUserId);
      await tx.$executeRaw`
        UPDATE "canva_connections"
        SET "status" = 'DISCONNECTED'::"CanvaConnectionStatus", "mode" = 'CANVA',
            "connectedById" = NULL, "connectedAt" = NULL,
            "connectionGeneration" = "connectionGeneration" + 1,
            "credentialVersion" = "credentialVersion" + 1,
            "reauthorizationReason" = NULL, "reauthorizationRequiredAt" = NULL,
            "updatedAt" = ${NOW_UTC}
        WHERE "organizationId" = ${organizationId}`;
      await this.audit.write(tx, {
        organizationId,
        actorUserId,
        action: 'canva.connection.disconnected',
        entityType: 'canva_connection',
        entityId: organizationId,
        metadata: { mode: 'CANVA', revocation: queued ? 'queued' : 'none' },
      });
      return { removed: !!credential, queued };
    });
  }

  async enqueueRevocation(revocation: NewCanvaRevocation): Promise<void> {
    await runCanvaTransaction(this.prisma, (tx) =>
      enqueueInTransaction(tx, revocation, randomUUID),
    );
  }

  async recordConfigurationError(organizationId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "canva_connections"
      SET "lastProviderErrorKind" = 'configuration', "lastProviderErrorAt" = ${NOW_UTC}
      WHERE "organizationId" = ${organizationId}
        AND ("lastProviderErrorAt" IS NULL
          OR "lastProviderErrorAt" < ${NOW_UTC} - ${milliseconds(CONFIGURATION_ERROR_THROTTLE_MS)})`;
  }

  async details(
    organizationId: string,
  ): Promise<CanvaConnectionDetails | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        status: CanvaConnectionDetails['status'];
        mode: string;
        connectedAt: Date | null;
        reauthorizationReason: string | null;
        lastProviderErrorKind: string | null;
        pendingRevocations: number;
        exhaustedRevocations: number;
      }>
    >`
      SELECT c."status"::text AS "status", c."mode", c."connectedAt",
        c."reauthorizationReason", c."lastProviderErrorKind",
        (SELECT count(*)::int FROM "canva_pending_revocations" r
          WHERE r."organizationId" = c."organizationId" AND r."state" IN ('queued', 'in_flight')) AS "pendingRevocations",
        (SELECT count(*)::int FROM "canva_pending_revocations" r
          WHERE r."organizationId" = c."organizationId" AND r."state" = 'exhausted') AS "exhaustedRevocations"
      FROM "canva_connections" c WHERE c."organizationId" = ${organizationId}`;
    const row = rows[0];
    if (!row) return null;
    return {
      status: row.status,
      mode: row.mode,
      connectedAt: row.connectedAt,
      reauthorizationReason: row.reauthorizationReason,
      configurationError: row.lastProviderErrorKind === 'configuration',
      pendingRevocations: row.pendingRevocations,
      exhaustedRevocations: row.exhaustedRevocations,
    };
  }

  // Lazy expiry in its own transaction.
  async expireCandidates(organizationId: string): Promise<number> {
    return runCanvaTransaction(this.prisma, async (tx) => {
      if (!(await lockConnection(tx, organizationId))) return 0;
      return expireCandidatesInTransaction(tx, this.audit, organizationId);
    });
  }
}
