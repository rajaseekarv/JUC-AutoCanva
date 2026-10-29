import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CanvaPersistenceError,
  type CanvaKeyInventory,
  type CanvaResealStore,
  type CanvaResealedValues,
  type CanvaSealedKind,
  type StaleCanvaSeal,
} from './canva-oauth.stores';
import {
  CLOCK_UTC,
  NOW_UTC,
  runCanvaTransaction,
  type CanvaTransactionRunner,
} from './canva-prisma.transaction';
import type { SealedValue } from './canva-token-cipher';

type SealedPair = {
  accessTokenIv: string;
  accessTokenCiphertext: string;
  accessTokenTag: string;
  refreshTokenIv: string;
  refreshTokenCiphertext: string;
  refreshTokenTag: string;
};

const sealed = (
  keyVersion: number,
  iv: string,
  ciphertext: string,
  tag: string,
): SealedValue => ({ keyVersion, iv, ciphertext, tag });

// Every resealed value must carry the row's single new key version.
function requireValue(
  value: SealedValue | undefined,
  keyVersion: number,
): SealedValue {
  if (!value || value.keyVersion !== keyVersion)
    throw new CanvaPersistenceError();
  return value;
}

// §5.11 of the persistence proposal. Each reseal is one conditional write
// that changes only ciphertext, IV, tag, and key version: never version,
// writeId, chainId, or anything a protocol decision reads. It takes no lock
// besides the row it updates, so it cannot join a lock-order cycle. A row
// that changed since it was listed simply does not match.
@Injectable()
export class PrismaCanvaResealStore implements CanvaResealStore {
  constructor(
    @Inject(PrismaService) private readonly prisma: CanvaTransactionRunner,
    private readonly audit: AuditService,
  ) {}

  async inventory(): Promise<CanvaKeyInventory> {
    // A missing key version is reported as 0, which is never configured,
    // so such a row always shows as stale.
    return this.prisma.$queryRaw<CanvaKeyInventory>`
      SELECT 'credential' AS "kind", "keyVersion", count(*)::int AS "rows"
        FROM "canva_credentials" GROUP BY "keyVersion"
      UNION ALL
      SELECT 'candidate', "keyVersion", count(*)::int
        FROM "canva_connection_candidates" GROUP BY "keyVersion"
      UNION ALL
      SELECT 'revocation', COALESCE("keyVersion", 0), count(*)::int
        FROM "canva_pending_revocations" WHERE "refreshTokenCiphertext" IS NOT NULL
        GROUP BY COALESCE("keyVersion", 0)
      UNION ALL
      SELECT 'attempt', COALESCE("codeVerifierKeyVersion", 0), count(*)::int
        FROM "canva_oauth_attempts" WHERE "codeVerifierCiphertext" IS NOT NULL
        GROUP BY COALESCE("codeVerifierKeyVersion", 0)`;
  }

  async listStale(
    kind: CanvaSealedKind,
    currentKeyVersion: number,
    afterId: string | null,
    limit: number,
  ): Promise<StaleCanvaSeal[]> {
    const after =
      afterId === null ? Prisma.empty : Prisma.sql`AND "id" > ${afterId}`;
    switch (kind) {
      case 'credential': {
        const rows = await this.prisma.$queryRaw<
          Array<
            SealedPair & {
              id: string;
              organizationId: string;
              version: number;
              writeId: string;
              keyVersion: number;
            }
          >
        >`
          SELECT "id", "organizationId", "version", "writeId", "keyVersion",
            "accessTokenIv", "accessTokenCiphertext", "accessTokenTag",
            "refreshTokenIv", "refreshTokenCiphertext", "refreshTokenTag"
          FROM "canva_credentials"
          WHERE "keyVersion" <> ${currentKeyVersion} ${after}
          ORDER BY "id" LIMIT ${limit}`;
        return rows.map((row) => ({
          kind,
          id: row.id,
          organizationId: row.organizationId,
          version: row.version,
          writeId: row.writeId,
          keyVersion: row.keyVersion,
          ...this.pair(row.keyVersion, row),
        }));
      }
      case 'candidate': {
        const rows = await this.prisma.$queryRaw<
          Array<
            SealedPair & {
              id: string;
              organizationId: string;
              keyVersion: number;
            }
          >
        >`
          SELECT "id", "organizationId", "keyVersion",
            "accessTokenIv", "accessTokenCiphertext", "accessTokenTag",
            "refreshTokenIv", "refreshTokenCiphertext", "refreshTokenTag"
          FROM "canva_connection_candidates"
          WHERE "keyVersion" <> ${currentKeyVersion} ${after}
          ORDER BY "id" LIMIT ${limit}`;
        return rows.map((row) => ({
          kind,
          id: row.id,
          organizationId: row.organizationId,
          keyVersion: row.keyVersion,
          ...this.pair(row.keyVersion, row),
        }));
      }
      case 'revocation': {
        const rows = await this.prisma.$queryRaw<
          Array<{
            id: string;
            organizationId: string;
            keyVersion: number;
            iv: string;
            ciphertext: string;
            tag: string;
          }>
        >`
          SELECT "id", "organizationId", COALESCE("keyVersion", 0) AS "keyVersion",
            "refreshTokenIv" AS "iv", "refreshTokenCiphertext" AS "ciphertext",
            "refreshTokenTag" AS "tag"
          FROM "canva_pending_revocations"
          WHERE "refreshTokenCiphertext" IS NOT NULL AND "state" <> 'finished'
            AND COALESCE("keyVersion", 0) <> ${currentKeyVersion} ${after}
          ORDER BY "id" LIMIT ${limit}`;
        return rows.map((row) => ({
          kind,
          id: row.id,
          organizationId: row.organizationId,
          keyVersion: row.keyVersion,
          refreshToken: sealed(row.keyVersion, row.iv, row.ciphertext, row.tag),
        }));
      }
      case 'attempt': {
        const rows = await this.prisma.$queryRaw<
          Array<{
            id: string;
            organizationId: string;
            keyVersion: number;
            iv: string;
            ciphertext: string;
            tag: string;
          }>
        >`
          SELECT "id", "organizationId",
            COALESCE("codeVerifierKeyVersion", 0) AS "keyVersion",
            "codeVerifierIv" AS "iv", "codeVerifierCiphertext" AS "ciphertext",
            "codeVerifierTag" AS "tag"
          FROM "canva_oauth_attempts"
          WHERE "codeVerifierCiphertext" IS NOT NULL AND "consumedAt" IS NULL
            AND COALESCE("codeVerifierKeyVersion", 0) <> ${currentKeyVersion} ${after}
          ORDER BY "id" LIMIT ${limit}`;
        return rows.map((row) => ({
          kind,
          id: row.id,
          organizationId: row.organizationId,
          keyVersion: row.keyVersion,
          codeVerifier: sealed(row.keyVersion, row.iv, row.ciphertext, row.tag),
        }));
      }
    }
  }

  async reseal(
    row: StaleCanvaSeal,
    values: CanvaResealedValues,
  ): Promise<boolean> {
    const to = values.keyVersion;
    switch (row.kind) {
      case 'credential': {
        const access = requireValue(values.accessToken, to);
        const refresh = requireValue(values.refreshToken, to);
        // Conditioned on version and writeId (so a refresh, reconnect, or
        // disconnect that landed first wins) and on no active refresh lease
        // (so a refresh in progress is never raced). The audit event shares
        // the transaction.
        return runCanvaTransaction(this.prisma, async (tx) => {
          const updated = await tx.$executeRaw`
            UPDATE "canva_credentials"
            SET "keyVersion" = ${to}, "accessTokenIv" = ${access.iv},
                "accessTokenCiphertext" = ${access.ciphertext},
                "accessTokenTag" = ${access.tag}, "refreshTokenIv" = ${refresh.iv},
                "refreshTokenCiphertext" = ${refresh.ciphertext},
                "refreshTokenTag" = ${refresh.tag}, "updatedAt" = ${NOW_UTC}
            WHERE "id" = ${row.id} AND "organizationId" = ${row.organizationId}
              AND "version" = ${row.version} AND "writeId" = ${row.writeId}
              AND "keyVersion" = ${row.keyVersion}
              AND ("refreshLeaseUntil" IS NULL OR "refreshLeaseUntil" < ${CLOCK_UTC})`;
          if (updated !== 1) return false;
          await this.audit.write(tx, {
            organizationId: row.organizationId,
            actorUserId: null,
            action: 'canva.credential.resealed',
            entityType: 'canva_connection',
            entityId: row.organizationId,
            metadata: { fromKeyVersion: row.keyVersion, toKeyVersion: to },
          });
          return true;
        });
      }
      case 'candidate': {
        const access = requireValue(values.accessToken, to);
        const refresh = requireValue(values.refreshToken, to);
        const updated = await this.prisma.$executeRaw`
          UPDATE "canva_connection_candidates"
          SET "keyVersion" = ${to}, "accessTokenIv" = ${access.iv},
              "accessTokenCiphertext" = ${access.ciphertext},
              "accessTokenTag" = ${access.tag}, "refreshTokenIv" = ${refresh.iv},
              "refreshTokenCiphertext" = ${refresh.ciphertext},
              "refreshTokenTag" = ${refresh.tag}
          WHERE "id" = ${row.id} AND "keyVersion" = ${row.keyVersion}`;
        return updated === 1;
      }
      case 'revocation': {
        const refresh = requireValue(values.refreshToken, to);
        // Exhausted rows are resealed too: they keep their ciphertext for
        // an administrator retry (§2.4). A finished row has none.
        const updated = await this.prisma.$executeRaw`
          UPDATE "canva_pending_revocations"
          SET "keyVersion" = ${to}, "refreshTokenIv" = ${refresh.iv},
              "refreshTokenCiphertext" = ${refresh.ciphertext},
              "refreshTokenTag" = ${refresh.tag}
          WHERE "id" = ${row.id} AND COALESCE("keyVersion", 0) = ${row.keyVersion}
            AND "state" <> 'finished' AND "refreshTokenCiphertext" IS NOT NULL`;
        return updated === 1;
      }
      case 'attempt': {
        const verifier = requireValue(values.codeVerifier, to);
        const updated = await this.prisma.$executeRaw`
          UPDATE "canva_oauth_attempts"
          SET "codeVerifierKeyVersion" = ${to}, "codeVerifierIv" = ${verifier.iv},
              "codeVerifierCiphertext" = ${verifier.ciphertext},
              "codeVerifierTag" = ${verifier.tag}
          WHERE "id" = ${row.id}
            AND COALESCE("codeVerifierKeyVersion", 0) = ${row.keyVersion}
            AND "consumedAt" IS NULL AND "codeVerifierCiphertext" IS NOT NULL`;
        return updated === 1;
      }
    }
  }

  private pair(keyVersion: number, row: SealedPair) {
    return {
      accessToken: sealed(
        keyVersion,
        row.accessTokenIv,
        row.accessTokenCiphertext,
        row.accessTokenTag,
      ),
      refreshToken: sealed(
        keyVersion,
        row.refreshTokenIv,
        row.refreshTokenCiphertext,
        row.refreshTokenTag,
      ),
    };
  }
}
