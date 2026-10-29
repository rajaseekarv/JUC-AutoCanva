import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CANVA_LAUNCH_TOKEN_TTL_MS,
  CANVA_MAX_OPEN_ATTEMPTS,
  CanvaAttemptLimitError,
  CanvaPersistenceError,
  type CanvaLaunchSecrets,
  type CanvaOAuthAttemptStore,
  type ConsumedCanvaAttempt,
  type NewCanvaOAuthAttempt,
} from './canva-oauth.stores';
import {
  NOW_UTC,
  lockConnection,
  milliseconds,
  runCanvaTransaction,
  type CanvaTransactionRunner,
} from './canva-prisma.transaction';
import { expireCandidatesInTransaction } from './canva-credential.prisma-store';

type ConsumedRow = {
  id: string;
  organizationId: string;
  userId: string;
  sessionId: string;
  baseGeneration: number;
  redirectUri: string;
  codeVerifierKeyVersion: number | null;
  codeVerifierIv: string | null;
  codeVerifierCiphertext: string | null;
  codeVerifierTag: string | null;
};

// §5.1-5.3 of the persistence proposal.
@Injectable()
export class PrismaCanvaOAuthAttemptStore implements CanvaOAuthAttemptStore {
  constructor(
    @Inject(PrismaService) private readonly prisma: CanvaTransactionRunner,
    private readonly audit: AuditService,
  ) {}

  async create(
    attempt: NewCanvaOAuthAttempt,
  ): Promise<{ launchExpiresAt: Date }> {
    const organizationId = attempt.organizationId;
    return runCanvaTransaction(this.prisma, async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "canva_connections" ("id", "organizationId", "status", "mode", "updatedAt")
        VALUES (${randomUUID()}, ${organizationId}, 'DISCONNECTED', 'CANVA', ${NOW_UTC})
        ON CONFLICT ("organizationId") DO NOTHING`;
      const connection = await lockConnection(tx, organizationId);
      if (!connection) throw new CanvaPersistenceError();
      // Expired candidates are queued before their attempts can be deleted
      // (the attempt relation cascades; F17).
      await expireCandidatesInTransaction(tx, this.audit, organizationId);
      await tx.$executeRaw`
        DELETE FROM "canva_oauth_attempts" a
        WHERE a."organizationId" = ${organizationId}
          AND COALESCE(a."expiresAt", a."launchExpiresAt") < ${NOW_UTC} - interval '1 day'
          AND NOT EXISTS (SELECT 1 FROM "canva_connection_candidates" c WHERE c."attemptId" = a."id")`;
      const [{ open }] = await tx.$queryRaw<Array<{ open: number }>>`
        SELECT count(*)::int AS "open" FROM "canva_oauth_attempts"
        WHERE "organizationId" = ${organizationId} AND "consumedAt" IS NULL
          AND COALESCE("expiresAt", "launchExpiresAt") > ${NOW_UTC}`;
      if (open >= CANVA_MAX_OPEN_ATTEMPTS) throw new CanvaAttemptLimitError();
      const [created] = await tx.$queryRaw<Array<{ launchExpiresAt: Date }>>`
        INSERT INTO "canva_oauth_attempts" ("id", "launchTokenHash", "organizationId",
          "userId", "sessionId", "baseGeneration", "redirectUri", "createdAt", "launchExpiresAt")
        VALUES (${randomUUID()}, ${attempt.launchTokenHash}, ${organizationId},
          ${attempt.userId}, ${attempt.sessionId}, ${connection.connectionGeneration},
          ${attempt.redirectUri}, ${NOW_UTC}, ${NOW_UTC} + ${milliseconds(CANVA_LAUNCH_TOKEN_TTL_MS)})
        RETURNING "launchExpiresAt"`;
      await this.audit.write(tx, {
        organizationId,
        actorUserId: attempt.userId,
        action: 'canva.oauth.started',
        entityType: 'canva_connection',
        entityId: organizationId,
        metadata: {
          mode: 'CANVA',
          expiresAt: created.launchExpiresAt.toISOString(),
        },
      });
      return { launchExpiresAt: created.launchExpiresAt };
    });
  }

  async launch(
    launchTokenHash: string,
    secrets: (organizationId: string) => CanvaLaunchSecrets,
    stateLifetimeMs: number,
  ): Promise<{ redirectUri: string; expiresAt: Date } | null> {
    return runCanvaTransaction(this.prisma, async (tx) => {
      const [target] = await tx.$queryRaw<
        Array<{ id: string; organizationId: string }>
      >`
        SELECT "id", "organizationId" FROM "canva_oauth_attempts"
        WHERE "launchTokenHash" = ${launchTokenHash} AND "launchedAt" IS NULL
          AND "launchExpiresAt" > ${NOW_UTC}
        FOR UPDATE`;
      if (!target) return null;
      const built = secrets(target.organizationId);
      const sealed = built.codeVerifier;
      const [launched] = await tx.$queryRaw<
        Array<{ redirectUri: string; expiresAt: Date }>
      >`
        UPDATE "canva_oauth_attempts"
        SET "launchedAt" = ${NOW_UTC}, "stateHash" = ${built.stateHash},
            "browserBindingHash" = ${built.browserBindingHash},
            "codeVerifierKeyVersion" = ${sealed.keyVersion}, "codeVerifierIv" = ${sealed.iv},
            "codeVerifierCiphertext" = ${sealed.ciphertext}, "codeVerifierTag" = ${sealed.tag},
            "expiresAt" = ${NOW_UTC} + ${milliseconds(stateLifetimeMs)}
        WHERE "id" = ${target.id} AND "launchedAt" IS NULL
        RETURNING "redirectUri", "expiresAt"`;
      return launched ?? null;
    });
  }

  async consume(
    stateHash: string,
    browserBindingHash: string,
  ): Promise<ConsumedCanvaAttempt | null> {
    // One statement: a concurrent duplicate waits on the row lock, then
    // re-evaluates the predicate and matches nothing.
    const rows = await runCanvaTransaction(this.prisma, (tx) =>
      tx.$queryRaw<ConsumedRow[]>(Prisma.sql`
        WITH target AS (
          SELECT * FROM "canva_oauth_attempts"
          WHERE "stateHash" = ${stateHash} AND "consumedAt" IS NULL
            AND "expiresAt" > ${NOW_UTC} AND "launchedAt" IS NOT NULL
            AND "browserBindingHash" = ${browserBindingHash}
          FOR UPDATE
        )
        UPDATE "canva_oauth_attempts" a
        SET "consumedAt" = ${NOW_UTC}, "codeVerifierKeyVersion" = NULL,
            "codeVerifierIv" = NULL, "codeVerifierCiphertext" = NULL, "codeVerifierTag" = NULL
        FROM target WHERE a."id" = target."id"
        RETURNING target."id", target."organizationId", target."userId",
          target."sessionId", target."baseGeneration", target."redirectUri",
          target."codeVerifierKeyVersion", target."codeVerifierIv",
          target."codeVerifierCiphertext", target."codeVerifierTag"`),
    );
    const row = rows[0];
    if (
      !row ||
      row.codeVerifierKeyVersion === null ||
      !row.codeVerifierIv ||
      !row.codeVerifierCiphertext ||
      !row.codeVerifierTag
    )
      return null;
    return {
      attemptId: row.id,
      organizationId: row.organizationId,
      userId: row.userId,
      sessionId: row.sessionId,
      baseGeneration: row.baseGeneration,
      redirectUri: row.redirectUri,
      codeVerifier: {
        keyVersion: row.codeVerifierKeyVersion,
        iv: row.codeVerifierIv,
        ciphertext: row.codeVerifierCiphertext,
        tag: row.codeVerifierTag,
      },
    };
  }
}
