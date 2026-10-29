import { PrismaClient } from '@prisma/client';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFailed,
} from 'vitest';
import { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { PrismaCanvaCredentialStore } from '../canva/oauth/canva-credential.prisma-store';
import { PrismaCanvaOAuthAttemptStore } from '../canva/oauth/canva-oauth-attempt.prisma-store';
import type { NewCanvaCandidate } from '../canva/oauth/canva-oauth.stores';
import type { CanvaTransactionRunner } from '../canva/oauth/canva-prisma.transaction';
import { PrismaCanvaRevocationQueue } from '../canva/oauth/canva-revocation.prisma-store';
import {
  GateSchema,
  assertGateEnvironment,
  assertIsolatedServer,
  assertIsolatedUrl,
  checkInvariants,
  holdTransaction,
  isolated,
  seedConsumedAttempt,
  seedOwner,
  type GateOwner,
} from './canva-gate-harness';
import { checkExtendedInvariants } from './canva-gate-actors';

// Canva OAuth PostgreSQL gates (§10 of the persistence proposal). These run
// only in the `pg` Vitest project (ADFLOW_PG_TEST_URL set and
// ADFLOW_PG_GATES=run) against the
// guarded isolated test cluster, each gate in its own fresh schema with the
// reviewed migrations applied, using independent connections.
//
// Executable here: the first gates that need only database interleaving.
// The rest, and the ones still blocked on infrastructure, are in
// canva-oauth-gates.pg.spec.ts. None has been run.

const sealed = (label: string) => ({
  keyVersion: 1,
  iv: `${label}-iv`,
  ciphertext: `${label}-ciphertext`,
  tag: `${label}-tag`,
});

function candidateInput(
  owner: GateOwner,
  attemptId: string,
  canvaUserId: string,
): NewCanvaCandidate {
  return {
    attempt: {
      attemptId,
      organizationId: owner.organizationId,
      userId: owner.userId,
      sessionId: owner.sessionId,
      baseGeneration: 0,
      redirectUri: 'redirect',
      codeVerifier: sealed('verifier'),
    },
    chainId: `chain-${attemptId}`,
    writeId: `write-${attemptId}`,
    accessToken: sealed(`access-${attemptId}`),
    refreshToken: sealed(`refresh-${attemptId}`),
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    scopes: ['profile:read'],
    canvaUserId,
    canvaTeamId: 'team',
    canvaDisplayName: 'Gate',
    capabilities: { autofill: true, brandTemplate: true },
  };
}

const stores = (client: PrismaClient) => {
  const runner = client as unknown as CanvaTransactionRunner;
  const audit = new AuditService(client as unknown as PrismaService);
  return {
    attempts: new PrismaCanvaOAuthAttemptStore(runner, audit),
    credentials: new PrismaCanvaCredentialStore(runner, audit),
    queue: new PrismaCanvaRevocationQueue(runner, audit),
  };
};

describe('Canva OAuth PostgreSQL gates (isolated test database)', () => {
  let admin: PrismaClient;

  beforeAll(async () => {
    assertGateEnvironment(process.env);
    assertIsolatedUrl(isolated.url);
    admin = new PrismaClient({ datasourceUrl: isolated.url });
    await assertIsolatedServer(admin);
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  // Creates the gate schema, runs the body, checks the invariants, and
  // always drops the schema (kept on failure with ADFLOW_GATE_KEEP=1).
  async function gate(
    name: string,
    body: (schema: GateSchema) => Promise<void>,
  ): Promise<void> {
    const schema = await GateSchema.create(admin, name);
    let failed = false;
    onTestFailed(() => {
      failed = true;
    });
    try {
      await body(schema);
      const observer = schema.actor('invariants');
      await schema.prepare(observer);
      expect(await checkInvariants(observer)).toEqual([]);
      // INV-2 (reported), INV-4, INV-6 (database part), and INV-7. These
      // gates use fixed fake ciphertext, so only Canva IDs are scanned for.
      const extended = await checkExtendedInvariants(observer, ['canva-u']);
      expect(extended.violations).toEqual([]);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await schema.drop(failed);
    }
  }

  it('Gate 1: one-time state consumption; a wrong cookie cannot burn the attempt', () =>
    gate('1', async (schema) => {
      const setup = schema.actor('setup');
      const holder = schema.actor('holder');
      const a = schema.actor('a');
      const c = schema.actor('c');
      for (const client of [setup, holder, a, c]) await schema.prepare(client);
      const owner = await seedOwner(setup, 'one');
      await setup.$executeRaw`
        INSERT INTO "canva_oauth_attempts" ("id", "launchTokenHash", "stateHash",
          "browserBindingHash", "organizationId", "userId", "sessionId", "baseGeneration",
          "codeVerifierKeyVersion", "codeVerifierIv", "codeVerifierCiphertext", "codeVerifierTag",
          "redirectUri", "launchExpiresAt", "launchedAt", "expiresAt")
        VALUES ('attempt-1', 'launch', 'state', 'binding', ${owner.organizationId},
          ${owner.userId}, ${owner.sessionId}, 0, 1, 'iv', 'ct', 'tag', 'redirect',
          (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'),
          (now() AT TIME ZONE 'UTC') + interval '10 minutes')`;
      // The holder stands in for a consumer paused before commit.
      const held = holdTransaction(holder, async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "canva_oauth_attempts" WHERE "id" = 'attempt-1' FOR UPDATE`;
      });
      await held.ready;
      const first = stores(a).attempts.consume('state', 'binding');
      const second = stores(c).attempts.consume('state', 'binding');
      await schema.waitUntilBlocked('a');
      await schema.waitUntilBlocked('c');
      // A wrong cookie matches nothing and does not wait.
      await expect(
        stores(setup).attempts.consume('state', 'wrong'),
      ).resolves.toBeNull();
      held.release();
      await held.done;
      const results = await Promise.all([first, second]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const [row] = await setup.$queryRaw<
        Array<{ codeVerifierCiphertext: string | null }>
      >`
        SELECT "codeVerifierCiphertext" FROM "canva_oauth_attempts" WHERE "id" = 'attempt-1'`;
      expect(row.codeVerifierCiphertext).toBeNull();
    }));

  it('Gate 9: ownership constraints reject bypassing inserts and updates', () =>
    gate('9', async (schema) => {
      const db = schema.actor('raw');
      await schema.prepare(db);
      const a = await seedOwner(db, 'a');
      const b = await seedOwner(db, 'b');
      await seedConsumedAttempt(db, b, 'attempt-b');
      await db.$executeRaw`
        INSERT INTO "canva_accounts" ("canvaUserId", "organizationId", "updatedAt")
        VALUES ('canva-u', ${a.organizationId}, now())`;
      await seedConsumedAttempt(db, a, 'attempt-a');
      const insertCandidate = (
        owner: GateOwner,
        id: string,
        user: string,
        attemptId = 'attempt-b',
      ) =>
        db.$executeRaw`
          INSERT INTO "canva_connection_candidates" ("id", "organizationId", "attemptId",
            "userId", "sessionId", "baseGeneration", "chainId", "writeId", "keyVersion",
            "accessTokenIv", "accessTokenCiphertext", "accessTokenTag", "refreshTokenIv",
            "refreshTokenCiphertext", "refreshTokenTag", "accessTokenExpiresAt", "scopes",
            "canvaUserId", "canvaTeamId", "hasAutofill", "hasBrandTemplates", "expiresAt")
          VALUES (${id}, ${owner.organizationId}, ${attemptId}, ${owner.userId}, ${owner.sessionId},
            0, ${`chain-${id}`}, ${`write-${id}`}, 1, 'i', 'c', 't', 'i', 'c', 't', now(),
            '{}', ${user}, 'team', true, true, now() + interval '10 minutes')`;
      const OWNERSHIP_FK =
        /canva_connection_candidates_canvaUserId_organizationId_fkey/;
      // A candidate (U, B) while U is held by A.
      await expect(insertCandidate(b, 'cand-1', 'canva-u')).rejects.toThrow(
        OWNERSHIP_FK,
      );
      // A candidate for a user with no account row.
      await expect(insertCandidate(b, 'cand-2', 'canva-none')).rejects.toThrow(
        OWNERSHIP_FK,
      );
      // A session that belongs to another user.
      await expect(db.$executeRaw`
        INSERT INTO "canva_oauth_attempts" ("id", "launchTokenHash", "organizationId",
          "userId", "sessionId", "baseGeneration", "redirectUri", "launchExpiresAt")
        VALUES ('x', 'x', ${a.organizationId}, ${a.userId}, ${b.sessionId}, 0, 'r', now())`).rejects.toThrow(
        /canva_oauth_attempts_sessionId_userId_fkey/,
      );
      // A user from another organization.
      await expect(db.$executeRaw`
        INSERT INTO "canva_oauth_attempts" ("id", "launchTokenHash", "organizationId",
          "userId", "sessionId", "baseGeneration", "redirectUri", "launchExpiresAt")
        VALUES ('y', 'y', ${a.organizationId}, ${b.userId}, ${b.sessionId}, 0, 'r', now())`).rejects.toThrow(
        /canva_oauth_attempts_userId_organizationId_fkey/,
      );
      // Release while referenced is refused (ON UPDATE RESTRICT).
      await db.$executeRaw`
        UPDATE "canva_accounts" SET "organizationId" = ${b.organizationId} WHERE "canvaUserId" = 'canva-u'`;
      await insertCandidate(b, 'cand-3', 'canva-u');
      await expect(db.$executeRaw`
        UPDATE "canva_accounts" SET "organizationId" = NULL WHERE "canvaUserId" = 'canva-u'`).rejects.toThrow(
        OWNERSHIP_FK,
      );
      await expect(db.$executeRaw`
        UPDATE "users" SET "organizationId" = ${a.organizationId} WHERE "id" = ${b.userId}`).rejects.toThrow(
        /_userId_organizationId_fkey/,
      );
      // One candidate per Canva user, across organizations, with an attempt
      // of A's own: refused by the unique index on canvaUserId, which
      // PostgreSQL checks during the insert, before the ownership key's
      // end-of-statement foreign-key check (first Stage 2.5 run: an earlier
      // version of this check reused B's attempt and was refused by the
      // attemptId key instead, proving nothing about this invariant).
      await expect(
        insertCandidate(a, 'cand-4', 'canva-u', 'attempt-a'),
      ).rejects.toThrow(/`23505`[\s\S]*Key \("canvaUserId"\)=\(canva-u\)/);
    }));

  it('Gate H(a): a candidate created while T1 waits makes T1 skip without a call', () =>
    gate('ha', async (schema) => {
      const setup = schema.actor('setup');
      const callback = schema.actor('callback');
      const worker = schema.actor('worker');
      for (const client of [setup, callback, worker])
        await schema.prepare(client);
      const owner = await seedOwner(setup, 'a');
      await seedConsumedAttempt(setup, owner, 'attempt-a');
      await stores(setup).credentials.enqueueRevocation({
        organizationId: owner.organizationId,
        chainId: 'chain-old',
        canvaUserId: 'canva-u',
        reason: 'disconnect',
        refreshToken: sealed('old'),
      });
      const [claimed] = await stores(worker).queue.claim('claim-1', 10);
      // The callback holds U's account lock (paused after-account-lock).
      const held = holdTransaction(callback, async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "canva_accounts" WHERE "canvaUserId" = 'canva-u' FOR UPDATE`;
        await tx.$executeRaw`
          UPDATE "canva_accounts" SET "organizationId" = ${owner.organizationId} WHERE "canvaUserId" = 'canva-u'`;
        await tx.$executeRaw`
          INSERT INTO "canva_connection_candidates" ("id", "organizationId", "attemptId",
            "userId", "sessionId", "baseGeneration", "chainId", "writeId", "keyVersion",
            "accessTokenIv", "accessTokenCiphertext", "accessTokenTag", "refreshTokenIv",
            "refreshTokenCiphertext", "refreshTokenTag", "accessTokenExpiresAt", "scopes",
            "canvaUserId", "canvaTeamId", "hasAutofill", "hasBrandTemplates", "expiresAt")
          VALUES ('cand', ${owner.organizationId}, 'attempt-a', ${owner.userId}, ${owner.sessionId},
            0, 'chain-new', 'write-new', 1, 'i', 'c', 't', 'i', 'c', 't', now(), '{}',
            'canva-u', 'team', true, true, now() + interval '10 minutes')`;
      });
      await held.ready;
      const decision = stores(worker).queue.decide(claimed.id, 'claim-1');
      await schema.waitUntilBlocked('worker');
      held.release();
      await held.done;
      await expect(decision).resolves.toEqual({ kind: 'skipped' });
      const [row] = await setup.$queryRaw<
        Array<{ state: string; outcome: string }>
      >`
        SELECT "state", "outcome" FROM "canva_pending_revocations" WHERE "id" = ${claimed.id}`;
      expect(row).toEqual({
        state: 'finished',
        outcome: 'skipped_shared_consent',
      });
    }));

  it('Gate H(b): a T1 that commits while the callback waits makes it retry_connect', () =>
    gate('hb', async (schema) => {
      const setup = schema.actor('setup');
      const callback = schema.actor('callback');
      const worker = schema.actor('worker');
      for (const client of [setup, callback, worker])
        await schema.prepare(client);
      const owner = await seedOwner(setup, 'b');
      await seedConsumedAttempt(setup, owner, 'attempt-b');
      await stores(setup).credentials.enqueueRevocation({
        organizationId: 'org-b',
        chainId: 'chain-old',
        canvaUserId: 'canva-u',
        reason: 'disconnect',
        refreshToken: sealed('old'),
      });
      // The worker's T1, paused before commit: account lock, then in_flight.
      const held = holdTransaction(worker, async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "canva_accounts" WHERE "canvaUserId" = 'canva-u' FOR UPDATE`;
        await tx.$executeRaw`
          UPDATE "canva_pending_revocations"
          SET "state" = 'in_flight', "attempts" = 1, "claimToken" = 'claim',
              "callStartedAt" = (clock_timestamp() AT TIME ZONE 'UTC'),
              "claimedUntil" = (clock_timestamp() AT TIME ZONE 'UTC') + interval '60 seconds'
          WHERE "canvaUserId" = 'canva-u'`;
      });
      await held.ready;
      const created = stores(callback).credentials.createCandidate(
        candidateInput(owner, 'attempt-b', 'canva-u'),
      );
      await schema.waitUntilBlocked('callback');
      held.release();
      await held.done;
      // Read-after-lock: the fence statement sees the commit made while the
      // callback waited.
      await expect(created).resolves.toEqual({ outcome: 'retry_connect' });
      const [count] = await setup.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS "n" FROM "canva_connection_candidates"`;
      expect(count.n).toBe(0);
      const queued = await setup.$queryRaw<Array<{ chainId: string }>>`
        SELECT "chainId" FROM "canva_pending_revocations"`;
      // The discarded grant is not queued.
      expect(queued).toEqual([{ chainId: 'chain-old' }]);
    }));

  it('Gate J: concurrent callbacks for one Canva user in two organizations', () =>
    gate('j', async (schema) => {
      const setup = schema.actor('setup');
      const holder = schema.actor('holder');
      const first = schema.actor('first');
      const second = schema.actor('second');
      for (const client of [setup, holder, first, second])
        await schema.prepare(client);
      const a = await seedOwner(setup, 'a');
      const b = await seedOwner(setup, 'b');
      await seedConsumedAttempt(setup, a, 'attempt-a');
      await seedConsumedAttempt(setup, b, 'attempt-b');
      await setup.$executeRaw`
        INSERT INTO "canva_accounts" ("canvaUserId", "updatedAt") VALUES ('canva-u', now())`;
      // Both callbacks reach the account lock together.
      const held = holdTransaction(holder, async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "canva_accounts" WHERE "canvaUserId" = 'canva-u' FOR UPDATE`;
      });
      await held.ready;
      const results = Promise.all([
        stores(first).credentials.createCandidate(
          candidateInput(a, 'attempt-a', 'canva-u'),
        ),
        stores(second).credentials.createCandidate(
          candidateInput(b, 'attempt-b', 'canva-u'),
        ),
      ]);
      await schema.waitUntilBlocked('first');
      await schema.waitUntilBlocked('second');
      held.release();
      await held.done;
      const outcomes = (await results).map((result) => result.outcome).sort();
      expect(outcomes).toEqual(['account_unavailable', 'pending_confirmation']);
      const [count] = await setup.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS "n" FROM "canva_connection_candidates"`;
      expect(count.n).toBe(1);
      // account_unavailable discards; nothing is queued.
      const [queued] = await setup.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS "n" FROM "canva_pending_revocations"`;
      expect(queued.n).toBe(0);
    }));

  it('Gate M(c): a disconnect queues the credential and a same-user candidate (D14)', () =>
    gate('mc', async (schema) => {
      const setup = schema.actor('setup');
      await schema.prepare(setup);
      const owner = await seedOwner(setup, 'm');
      await seedConsumedAttempt(setup, owner, 'attempt-m');
      const { credentials } = stores(setup);
      await expect(
        credentials.createCandidate(
          candidateInput(owner, 'attempt-m', 'canva-u'),
        ),
      ).resolves.toMatchObject({ outcome: 'pending_confirmation' });
      const activated = await credentials.activateCandidate(
        owner,
        (await credentials.readCandidate(owner))!.id,
      );
      expect(activated.outcome).toBe('connected');
      await seedConsumedAttempt(setup, owner, 'attempt-m2');
      await setup.$executeRaw`
        UPDATE "canva_oauth_attempts" SET "baseGeneration" = 1 WHERE "id" = 'attempt-m2'`;
      await expect(
        credentials.createCandidate({
          ...candidateInput(owner, 'attempt-m2', 'canva-u'),
          attempt: {
            ...candidateInput(owner, 'attempt-m2', 'canva-u').attempt,
            baseGeneration: 1,
          },
        }),
      ).resolves.toMatchObject({ outcome: 'pending_confirmation' });
      await expect(
        credentials.disconnect(owner.organizationId, owner.userId),
      ).resolves.toEqual({ removed: true, queued: 2 });
      const reasons = await setup.$queryRaw<Array<{ reason: string }>>`
        SELECT "reason" FROM "canva_pending_revocations" ORDER BY "reason"`;
      expect(reasons.map((row) => row.reason)).toEqual([
        'candidate_superseded',
        'disconnect',
      ]);
      const [account] = await setup.$queryRaw<
        Array<{ organizationId: string | null }>
      >`
        SELECT "organizationId" FROM "canva_accounts" WHERE "canvaUserId" = 'canva-u'`;
      expect(account.organizationId).toBeNull();
    }));

  it('Gate R(b): an account row deleted by an uncommitted sweep is recreated', () =>
    gate('rb', async (schema) => {
      const setup = schema.actor('setup');
      const sweep = schema.actor('sweep');
      const callback = schema.actor('callback');
      for (const client of [setup, sweep, callback])
        await schema.prepare(client);
      const owner = await seedOwner(setup, 'r');
      await seedConsumedAttempt(setup, owner, 'attempt-r');
      await setup.$executeRaw`
        INSERT INTO "canva_accounts" ("canvaUserId", "updatedAt") VALUES ('canva-u', now())`;
      const held = holdTransaction(sweep, async (tx) => {
        await tx.$executeRaw`DELETE FROM "canva_accounts" WHERE "canvaUserId" = 'canva-u'`;
      });
      await held.ready;
      const created = stores(callback).credentials.createCandidate(
        candidateInput(owner, 'attempt-r', 'canva-u'),
      );
      await schema.waitUntilBlocked('callback');
      held.release();
      await held.done;
      await expect(created).resolves.toMatchObject({
        outcome: 'pending_confirmation',
      });
    }));

  it('Gate 7 (part): a failed audit write rolls back candidate creation and disconnect', () =>
    gate('7', async (schema) => {
      const setup = schema.actor('setup');
      await schema.prepare(setup);
      const owner = await seedOwner(setup, 's');
      await seedConsumedAttempt(setup, owner, 'attempt-s');
      const failingAudit = {
        write: async () => {
          throw new Error('audit failed');
        },
      } as unknown as AuditService;
      const runner = setup as unknown as CanvaTransactionRunner;
      const failing = new PrismaCanvaCredentialStore(runner, failingAudit);
      await expect(
        failing.createCandidate(candidateInput(owner, 'attempt-s', 'canva-u')),
      ).rejects.toThrow();
      const [state] = await setup.$queryRaw<
        Array<{ candidates: number; held: number }>
      >`
        SELECT (SELECT count(*)::int FROM "canva_connection_candidates") AS "candidates",
               (SELECT count(*)::int FROM "canva_accounts" WHERE "organizationId" IS NOT NULL) AS "held"`;
      expect(state).toEqual({ candidates: 0, held: 0 });
    }));

  // Every other gate is in canva-oauth-gates.pg.spec.ts, executable or
  // marked todo with the infrastructure it still needs.
});
