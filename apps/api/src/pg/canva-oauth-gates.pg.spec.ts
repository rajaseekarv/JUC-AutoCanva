import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFailed,
  vi,
} from 'vitest';
import { CANVA_OAUTH_SCOPES } from '../canva/oauth/canva-oauth.config';
import type { NewCanvaCandidate } from '../canva/oauth/canva-oauth.stores';
import {
  REVOCATION_CONFIGURATION_PAUSE_LIMIT_MS,
  REVOCATION_CONFIGURATION_PAUSE_MS,
  REVOCATION_MAX_ATTEMPTS,
} from '../canva/oauth/canva-revocation';
import {
  CanvaTokenKeyring,
  sealContext,
} from '../canva/oauth/canva-token-cipher';
import {
  FakeCanva,
  PausePoints,
  checkExtendedInvariants,
  failingAudit,
  gateConfig,
  gateServices,
  revokeTimeGuard,
  seededRandom,
} from './canva-gate-actors';
import {
  GateSchema,
  assertGateEnvironment,
  assertIsolatedServer,
  assertIsolatedUrl,
  checkInvariants,
  holdTransaction,
  isolated,
  migrationNames,
  seedOwner,
  type GateOwner,
} from './canva-gate-harness';
import { CommitDropProxy } from './commit-drop-proxy';
import { runCanvaTransaction } from '../canva/oauth/canva-prisma.transaction';

// Canva OAuth PostgreSQL gates (§10 of the persistence proposal) that need
// the fake Canva, store pause points, or several actors running real
// services. canva-oauth.pg.spec.ts holds the first database-only gates.
//
// Like every *.pg.spec.ts file, this runs only in the `pg` Vitest project,
// which exists only when ADFLOW_PG_TEST_URL is set and ADFLOW_PG_GATES=run,
// and it refuses any database but the guarded isolated test cluster.
//
// STATUS: written, typechecked, and NOT RUN. No gate below has executed
// against PostgreSQL. Expect to debug them on their first run; a failure is
// evidence to investigate, never something to relax.

type Config = ReturnType<typeof gateConfig>;
type Services = ReturnType<typeof gateServices>;
type Actor = Services & { client: PrismaClient; label: string };

type GateContext = {
  schema: GateSchema;
  fake: FakeCanva;
  config: Config;
  observer: PrismaClient;
  actor: (
    label: string,
    options?: Partial<Parameters<typeof gateServices>[1]> & {
      via?: CommitDropProxy;
    },
  ) => Promise<Actor>;
};

// Polls a condition (a request arriving at the fake, a row changing). Used
// only to observe progress, never to create an ordering.
async function until(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// A launched and consumed attempt, as the callback holds it after §5.3,
// based on the connection's current generation.
async function consumedAttempt(
  client: PrismaClient,
  owner: GateOwner,
  id = `attempt-${randomUUID()}`,
): Promise<{ id: string; baseGeneration: number }> {
  const [connection] = await client.$queryRaw<
    Array<{ connectionGeneration: number }>
  >`
    SELECT "connectionGeneration" FROM "canva_connections"
    WHERE "organizationId" = ${owner.organizationId}`;
  const baseGeneration = connection?.connectionGeneration ?? 0;
  await client.$executeRaw`
    INSERT INTO "canva_oauth_attempts" ("id", "launchTokenHash", "stateHash",
      "browserBindingHash", "organizationId", "userId", "sessionId", "baseGeneration",
      "redirectUri", "launchExpiresAt", "launchedAt", "expiresAt", "consumedAt")
    VALUES (${id}, ${`launch-${id}`}, ${`state-${id}`}, ${`binding-${id}`},
      ${owner.organizationId}, ${owner.userId}, ${owner.sessionId}, ${baseGeneration},
      'redirect', (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'),
      (now() AT TIME ZONE 'UTC') + interval '10 minutes', (now() AT TIME ZONE 'UTC'))`;
  return { id, baseGeneration };
}

function candidateFor(
  config: Config,
  fake: FakeCanva,
  owner: GateOwner,
  attempt: { id: string; baseGeneration: number },
  canvaUserId: string,
): NewCanvaCandidate {
  const issued = fake.issue(canvaUserId);
  const org = owner.organizationId;
  return {
    attempt: {
      attemptId: attempt.id,
      organizationId: org,
      userId: owner.userId,
      sessionId: owner.sessionId,
      baseGeneration: attempt.baseGeneration,
      redirectUri: 'redirect',
      codeVerifier: config.keyring.seal(
        'verifier',
        sealContext.codeVerifier(org),
      ),
    },
    chainId: randomUUID(),
    writeId: randomUUID(),
    accessToken: config.keyring.seal(
      issued.accessToken,
      sealContext.accessToken(org),
    ),
    refreshToken: config.keyring.seal(
      issued.refreshToken,
      sealContext.refreshToken(org),
    ),
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    scopes: [...CANVA_OAUTH_SCOPES],
    canvaUserId,
    canvaTeamId: `team-${canvaUserId}`,
    canvaDisplayName: `Gate ${canvaUserId}`,
    capabilities: { autofill: true, brandTemplate: true },
  };
}

// Callback (§5.4) then confirmation (§5.5) for a Canva user.
async function connectUser(
  context: GateContext,
  services: Actor,
  owner: GateOwner,
  canvaUserId: string,
): Promise<void> {
  const attempt = await consumedAttempt(services.client, owner);
  const created = await services.credentials.createCandidate(
    candidateFor(context.config, context.fake, owner, attempt, canvaUserId),
  );
  expect(created.outcome).toBe('pending_confirmation');
  const pending = await services.credentials.readCandidate(owner);
  const activated = await services.credentials.activateCandidate(
    owner,
    pending!.id,
  );
  expect(activated.outcome).toBe('connected');
}

const expireAccessToken = (client: PrismaClient, organizationId: string) =>
  client.$executeRaw`
    UPDATE "canva_credentials"
    SET "accessTokenExpiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 hour'
    WHERE "organizationId" = ${organizationId}`;

async function queueRows(client: PrismaClient) {
  return client.$queryRaw<
    Array<{
      id: string;
      canvaUserId: string;
      reason: string;
      state: string;
      outcome: string | null;
      attempts: number;
      hasCiphertext: boolean;
      possibleEffectUntil: Date | null;
      callStartedAt: Date | null;
      nextAttemptAt: Date;
      lastErrorKind: string | null;
    }>
  >`
    SELECT "id", "canvaUserId", "reason", "state", "outcome", "attempts",
      "refreshTokenCiphertext" IS NOT NULL AS "hasCiphertext",
      "possibleEffectUntil", "callStartedAt", "nextAttemptAt", "lastErrorKind"
    FROM "canva_pending_revocations" ORDER BY "createdAt", "id"`;
}

async function auditActions(client: PrismaClient): Promise<string[]> {
  const rows = await client.$queryRaw<Array<{ action: string }>>`
    SELECT "action" FROM "audit_logs" ORDER BY "createdAt", "id"`;
  return rows.map((row) => row.action);
}

// Everything a protocol transaction may change, minus the refresh lease
// (claimed and released in single statements outside the transaction).
async function snapshot(client: PrismaClient): Promise<string> {
  const [state] = await client.$queryRaw<Array<{ state: unknown }>>`
    SELECT json_build_object(
      'connections', (SELECT json_agg(json_build_array("organizationId", "status",
        "connectionGeneration", "credentialVersion", "reauthorizationReason")
        ORDER BY "organizationId") FROM "canva_connections"),
      'credentials', (SELECT json_agg(json_build_array("organizationId", "chainId",
        "writeId", "version", "keyVersion", "refreshTokenCiphertext")
        ORDER BY "organizationId") FROM "canva_credentials"),
      'candidates', (SELECT json_agg(json_build_array("id", "canvaUserId")
        ORDER BY "id") FROM "canva_connection_candidates"),
      'accounts', (SELECT json_agg(json_build_array("canvaUserId", "organizationId")
        ORDER BY "canvaUserId") FROM "canva_accounts"),
      'queue', (SELECT json_agg(json_build_array("id", "state", "attempts", "outcome",
        "refreshTokenCiphertext") ORDER BY "id") FROM "canva_pending_revocations"),
      'audit', (SELECT count(*) FROM "audit_logs")
    ) AS "state"`;
  return JSON.stringify(state.state);
}

describe('Canva OAuth PostgreSQL gates with actors (isolated test database)', () => {
  let admin: PrismaClient;

  beforeAll(async () => {
    assertGateEnvironment(process.env);
    assertIsolatedUrl(isolated.url);
    // Nothing in these gates may reach the network.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Network access is not allowed in the gates');
      }),
    );
    admin = new PrismaClient({ datasourceUrl: isolated.url });
    await assertIsolatedServer(admin);
  });

  afterAll(async () => {
    await admin?.$disconnect();
    vi.unstubAllGlobals();
  });

  // Creates the gate schema and its observer, wires the fake Canva's
  // revoke-time INV-6 check, runs the body, checks every invariant, and
  // always drops the schema (kept on failure with ADFLOW_GATE_KEEP=1).
  async function gate(
    name: string,
    body: (context: GateContext) => Promise<void>,
  ): Promise<void> {
    const schema = await GateSchema.create(admin, name);
    let failed = false;
    onTestFailed(() => {
      failed = true;
    });
    const fake = new FakeCanva();
    const config = gateConfig();
    const revokeViolations: string[] = [];
    try {
      const observer = schema.actor('observer');
      await schema.prepare(observer);
      revokeTimeGuard(fake, observer, revokeViolations);
      const actor: GateContext['actor'] = async (label, options = {}) => {
        const { via, ...serviceOptions } = options;
        const client = schema.actor(label, { via });
        await schema.prepare(client);
        return {
          client,
          label,
          ...gateServices(client, { fake, config, ...serviceOptions }),
        };
      };
      await body({ schema, fake, config, observer, actor });
      expect(await checkInvariants(observer)).toEqual([]);
      const extended = await checkExtendedInvariants(observer, [
        ...fake.issuedSecrets,
        'Gate canva-',
        'canva-u',
      ]);
      expect(extended.violations).toEqual([]);
      expect(revokeViolations).toEqual([]);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await schema.drop(failed);
    }
  }

  it('Gate 2: two processes refresh at once; Canva sees one refresh', () =>
    gate('2', async (context) => {
      const setup = await context.actor('setup');
      const a = await context.actor('a');
      const b = await context.actor('b');
      const owner = await seedOwner(setup.client, 'two');
      await connectUser(context, setup, owner, 'canva-u2');
      await expireAccessToken(setup.client, owner.organizationId);
      const held = context.fake.hold('token');
      const first = a.accessTokens.accessTokenFor(owner.organizationId);
      await held.arrived;
      // B finds the lease taken and polls; it must not call Canva.
      const second = b.accessTokens.accessTokenFor(owner.organizationId);
      held.release();
      const [tokenA, tokenB] = await Promise.all([first, second]);
      expect(tokenA).toBe(tokenB);
      expect(context.fake.count('token')).toBe(1);
      const [credential] = await setup.client.$queryRaw<
        Array<{ version: number; refreshLeaseOwner: string | null }>
      >`SELECT "version", "refreshLeaseOwner" FROM "canva_credentials"`;
      expect(credential).toEqual({ version: 2, refreshLeaseOwner: null });
      expect(
        (await auditActions(setup.client)).filter(
          (action) => action === 'canva.credential.refreshed',
        ),
      ).toHaveLength(1);
    }));

  it('Gate 3: a late writer lands its rotation after a lease takeover; the taker’s mark is refused', () =>
    gate('3', async (context) => {
      const setup = await context.actor('setup');
      const a = await context.actor('a');
      const b = await context.actor('b');
      const owner = await seedOwner(setup.client, 'three');
      await connectUser(context, setup, owner, 'canva-u3');
      await expireAccessToken(setup.client, owner.organizationId);
      const heldA = context.fake.hold('token');
      // The taker reuses the spent refresh token and is told invalid_grant.
      context.fake.respond('token', {
        kind: 'status',
        status: 400,
        body: { error: 'invalid_grant' },
      });
      const late = a.accessTokens.accessTokenFor(owner.organizationId);
      await heldA.arrived;
      // A's lease is backdated with SQL instead of waiting 60 seconds.
      await setup.client.$executeRaw`
        UPDATE "canva_credentials"
        SET "refreshLeaseUntil" = (now() AT TIME ZONE 'UTC') - interval '1 second'`;
      const taker = b.accessTokens.accessTokenFor(owner.organizationId);
      await until(
        () => context.fake.count('token') === 2,
        "the taker's refresh",
      );
      // A resumes within B's 15-second grace period.
      heldA.release();
      const [lateToken, takerToken] = await Promise.all([late, taker]);
      expect(takerToken).toBe(lateToken);
      const [connection] = await setup.client.$queryRaw<
        Array<{ status: string }>
      >`SELECT "status"::text AS "status" FROM "canva_connections"`;
      expect(connection.status).toBe('CONNECTED');
      expect(await queueRows(setup.client)).toEqual([]);
    }));

  it('Gate 4: a refresh overtaken by a different-user reconnect is queued for the old user only', () =>
    gate('4', async (context) => {
      const setup = await context.actor('setup');
      const refresher = await context.actor('refresh');
      const confirmer = await context.actor('confirm');
      const worker = await context.actor('worker');
      const owner = await seedOwner(setup.client, 'four');
      await connectUser(context, setup, owner, 'canva-u0');
      await expireAccessToken(setup.client, owner.organizationId);
      const held = context.fake.hold('token');
      const refresh = refresher.accessTokens.accessTokenFor(
        owner.organizationId,
      );
      await held.arrived;
      await connectUser(context, confirmer, owner, 'canva-u1');
      held.release();
      // The stale write is refused; the re-read returns the new grant.
      await refresh;
      const rows = await queueRows(setup.client);
      expect(rows.map((row) => [row.canvaUserId, row.reason]).sort()).toEqual([
        ['canva-u0', 'orphaned_rotation'],
        ['canva-u0', 'replaced_other_user'],
      ]);
      await worker.worker.runOnce();
      expect(context.fake.count('revoke', 'canva-u1')).toBe(0);
      expect(context.fake.count('revoke', 'canva-u0')).toBeGreaterThan(0);
      const [credential] = await setup.client.$queryRaw<
        Array<{ canvaUserId: string }>
      >`SELECT "canvaUserId" FROM "canva_credentials"`;
      expect(credential.canvaUserId).toBe('canva-u1');
    }));

  it('Gate 5: reseal versus refresh, in both orders, and for queue rows', () =>
    gate('5', async (context) => {
      const setup = await context.actor('setup');
      // Before rotation: key 1. After: key 2 current, key 1 kept to decrypt.
      // Test keys only, generated for this gate.
      const previousKey = Buffer.alloc(32, 4);
      const v1 = new CanvaTokenKeyring({ version: 1, key: previousKey });
      const v2 = new CanvaTokenKeyring(
        { version: 2, key: Buffer.alloc(32, 5) },
        new Map([[1, previousKey]]),
      );
      const before = { ...context.config, keyring: v1 };
      const after = { ...context.config, keyring: v2 };
      const second = await seedOwner(setup.client, 'five-b');
      const v1Setup = {
        ...(await context.actor('v1-setup', { config: before })),
      };
      await connectUser(
        { ...context, config: before },
        v1Setup,
        second,
        'canva-u5b',
      );

      // (a) The refresh commits first: the reseal matches no row.
      const points = new PausePoints().after(
        'listed',
        /FROM "canva_credentials" WHERE "keyVersion" <>/,
      );
      const resealer = await context.actor('reseal', { config: after, points });
      const refresher = await context.actor('refresh', { config: after });
      await expireAccessToken(setup.client, second.organizationId);
      const resealing = resealer.reseal.run();
      await points.reached('listed');
      await refresher.accessTokens.accessTokenFor(second.organizationId);
      points.release('listed');
      const summary = await resealing;
      expect(summary.skipped).toBeGreaterThanOrEqual(1);
      const [afterRefresh] = await setup.client.$queryRaw<
        Array<{ keyVersion: number; version: number }>
      >`SELECT "keyVersion", "version" FROM "canva_credentials"
        WHERE "organizationId" = ${second.organizationId}`;
      expect(afterRefresh).toEqual({ keyVersion: 2, version: 2 });

      // Queue rows under key 1, one of them exhausted, are resealed too.
      for (const label of ['queued', 'exhausted'])
        await v1Setup.credentials.enqueueRevocation({
          organizationId: second.organizationId,
          chainId: `chain-five-${label}`,
          canvaUserId: `canva-five-${label}`,
          reason: 'disconnect',
          refreshToken: v1.seal(
            context.fake.issue(`canva-five-${label}`).refreshToken,
            sealContext.refreshToken(second.organizationId),
          ),
        });
      await setup.client.$executeRaw`
        UPDATE "canva_pending_revocations" SET "state" = 'exhausted'
        WHERE "chainId" = 'chain-five-exhausted'`;

      // (b) The reseal lands first: the refresh still passes its version
      // check and writes under the current key.
      const third = await seedOwner(setup.client, 'five-c');
      await connectUser(
        { ...context, config: before },
        v1Setup,
        third,
        'canva-u5c',
      );
      const plain = await context.actor('reseal-b', { config: after });
      await plain.reseal.run();
      await expireAccessToken(setup.client, third.organizationId);
      await refresher.accessTokens.accessTokenFor(third.organizationId);
      const [resealedFirst] = await setup.client.$queryRaw<
        Array<{ keyVersion: number; version: number }>
      >`SELECT "keyVersion", "version" FROM "canva_credentials"
        WHERE "organizationId" = ${third.organizationId}`;
      expect(resealedFirst).toEqual({ keyVersion: 2, version: 2 });

      // (c) A refresh in progress holds the lease: the reseal skips it.
      const fourth = await seedOwner(setup.client, 'five-d');
      await connectUser(
        { ...context, config: before },
        v1Setup,
        fourth,
        'canva-u5d',
      );
      await expireAccessToken(setup.client, fourth.organizationId);
      const held = context.fake.hold('token');
      const inFlight = refresher.accessTokens.accessTokenFor(
        fourth.organizationId,
      );
      await held.arrived;
      const during = await plain.reseal.run();
      expect(during.skipped).toBe(1);
      held.release();
      await inFlight;

      await plain.reseal.run();
      const report = await plain.reseal.inventory();
      expect(report.retirement).toEqual([
        { keyVersion: 1, rows: 0, safeToRetire: true },
      ]);
      expect(
        (await queueRows(setup.client))
          .filter((row) => row.state !== 'finished')
          .every((row) => row.hasCiphertext),
      ).toBe(true);
    }));

  it('Gate 6: a disconnect that commits during a refresh is never undone', () =>
    gate('6', async (context) => {
      const setup = await context.actor('setup');
      const refresher = await context.actor('refresh');
      const disconnecter = await context.actor('disconnect');
      const owner = await seedOwner(setup.client, 'six');
      await connectUser(context, setup, owner, 'canva-u6');
      await expireAccessToken(setup.client, owner.organizationId);
      const held = context.fake.hold('token');
      const refresh = refresher.accessTokens.accessTokenFor(
        owner.organizationId,
      );
      await held.arrived;
      await disconnecter.credentials.disconnect(
        owner.organizationId,
        owner.userId,
      );
      held.release();
      await expect(refresh).rejects.toMatchObject({ reason: 'not_connected' });
      const [state] = await setup.client.$queryRaw<
        Array<{ credentials: number; status: string; held: string | null }>
      >`
        SELECT (SELECT count(*)::int FROM "canva_credentials") AS "credentials",
          (SELECT "status"::text FROM "canva_connections") AS "status",
          (SELECT "organizationId" FROM "canva_accounts" WHERE "canvaUserId" = 'canva-u6') AS "held"`;
      expect(state).toEqual({
        credentials: 0,
        status: 'DISCONNECTED',
        held: null,
      });
      expect(
        (await queueRows(setup.client)).map((row) => row.reason).sort(),
      ).toEqual(['disconnect', 'orphaned_rotation']);
    }));

  it('Gate 7 (rest): a failed audit write rolls back activation, mark, disconnect, refresh, reject, T1, and T2', () =>
    gate('7r', async (context) => {
      const setup = await context.actor('setup');
      const failing = await context.actor('failing', { audit: failingAudit() });
      const owner = await seedOwner(setup.client, 'seven');
      const pending = async (canvaUserId: string) => {
        const attempt = await consumedAttempt(setup.client, owner);
        await setup.credentials.createCandidate(
          candidateFor(
            context.config,
            context.fake,
            owner,
            attempt,
            canvaUserId,
          ),
        );
        return (await setup.credentials.readCandidate(owner))!;
      };
      const unchanged = async (operation: () => Promise<unknown>) => {
        const before = await snapshot(setup.client);
        await expect(operation()).rejects.toThrow();
        expect(await snapshot(setup.client)).toBe(before);
      };

      const candidate = await pending('canva-u7');
      await unchanged(() =>
        failing.credentials.activateCandidate(owner, candidate.id),
      );
      await unchanged(() =>
        failing.credentials.rejectCandidate(owner, candidate.id),
      );
      await setup.credentials.activateCandidate(owner, candidate.id);
      const [{ version }] = await setup.client.$queryRaw<
        Array<{ version: number }>
      >`
        SELECT "version" FROM "canva_credentials"`;
      await unchanged(() =>
        failing.credentials.markReauthorizationRequired(
          owner.organizationId,
          version,
          'invalid_grant',
        ),
      );
      await unchanged(() =>
        failing.credentials.disconnect(owner.organizationId, owner.userId),
      );
      await expireAccessToken(setup.client, owner.organizationId);
      await unchanged(() =>
        failing.accessTokens.accessTokenFor(owner.organizationId),
      );

      // T1 deciding a skip, and T2 recording a result.
      await setup.credentials.enqueueRevocation({
        organizationId: owner.organizationId,
        chainId: 'chain-shared',
        canvaUserId: 'canva-u7',
        reason: 'disconnect',
        refreshToken: context.config.keyring.seal(
          'x',
          sealContext.refreshToken(owner.organizationId),
        ),
      });
      const [claimed] = await setup.queue.claim('claim-7', 10);
      await unchanged(() => failing.queue.decide(claimed.id, 'claim-7'));
      await setup.credentials.disconnect(owner.organizationId, owner.userId);
      const [other] = await setup.queue.claim('claim-7b', 10, 'canva-u7');
      const decision = await setup.queue.decide(other.id, 'claim-7b');
      expect(decision.kind).toBe('send');
      await unchanged(() =>
        failing.queue.record(other.id, 'claim-7b', {
          next: 'finished',
          outcome: 'revoked',
          lastErrorKind: null,
          delayMs: 0,
          refund: false,
          ambiguous: false,
        }),
      );
    }));

  it('Gate 8: first-connect conflict under the connection lock, and a stale-generation confirmation', () =>
    gate('8', async (context) => {
      const setup = await context.actor('setup');
      const owner = await seedOwner(setup.client, 'eight');
      const second: GateOwner = {
        organizationId: owner.organizationId,
        userId: 'user-eight-2',
        sessionId: 'session-eight-2',
      };
      await setup.client.$executeRaw`
        INSERT INTO "users" ("id", "organizationId", "name", "email", "updatedAt")
        VALUES (${second.userId}, ${owner.organizationId}, 'second', 'second@example.test', now())`;
      await setup.client.$executeRaw`
        INSERT INTO "auth_sessions" ("id", "userId", "expiresAt")
        VALUES (${second.sessionId}, ${second.userId}, now() + interval '1 hour')`;
      const points = new PausePoints().after(
        'a-locked',
        /FROM "canva_connections" WHERE "organizationId" = \$1 FOR UPDATE/,
      );
      const a = await context.actor('a', { points });
      const b = await context.actor('b');
      const attemptA = await consumedAttempt(setup.client, owner);
      const attemptB = await consumedAttempt(setup.client, second);
      const first = a.credentials.createCandidate(
        candidateFor(
          context.config,
          context.fake,
          owner,
          attemptA,
          'canva-u8a',
        ),
      );
      await points.reached('a-locked');
      const conflicting = b.credentials.createCandidate(
        candidateFor(
          context.config,
          context.fake,
          second,
          attemptB,
          'canva-u8b',
        ),
      );
      await context.schema.waitUntilBlocked('b');
      points.release('a-locked');
      expect((await first).outcome).toBe('pending_confirmation');
      expect((await conflicting).outcome).toBe('conflict');
      expect((await queueRows(setup.client)).map((row) => row.reason)).toEqual([
        'connect_conflict',
      ]);
      // A mark advances the generation but keeps the candidate.
      await setup.credentials.activateCandidate(
        owner,
        (await setup.credentials.readCandidate(owner))!.id,
      );
      const attemptC = await consumedAttempt(setup.client, owner);
      await setup.credentials.createCandidate(
        candidateFor(
          context.config,
          context.fake,
          owner,
          attemptC,
          'canva-u8a',
        ),
      );
      const [{ version }] = await setup.client.$queryRaw<
        Array<{ version: number }>
      >`
        SELECT "version" FROM "canva_credentials"`;
      await setup.credentials.markReauthorizationRequired(
        owner.organizationId,
        version,
        'invalid_grant',
      );
      const stale = await setup.credentials.activateCandidate(
        owner,
        (await setup.credentials.readCandidate(owner))!.id,
      );
      expect(stale.outcome).toBe('stale');
    }));

  it('Gate C: response policy, crash recovery with two workers, and exhaustion', () =>
    gate('c', async (context) => {
      const setup = await context.actor('setup');
      const w1 = await context.actor('w1');
      const w2 = await context.actor('w2');
      const owner = await seedOwner(setup.client, 'c');
      const enqueue = async (canvaUserId: string) => {
        const issued = context.fake.issue(canvaUserId);
        await setup.credentials.enqueueRevocation({
          organizationId: owner.organizationId,
          chainId: `chain-${canvaUserId}`,
          canvaUserId,
          reason: 'disconnect',
          refreshToken: context.config.keyring.seal(
            issued.refreshToken,
            sealContext.refreshToken(owner.organizationId),
          ),
        });
      };
      for (const user of [
        'c-503',
        'c-429',
        'c-401',
        'c-401-documented',
        'c-400',
        'c-200',
      ])
        await enqueue(user);
      // The sealed refresh token as stored, to prove it is never changed.
      const sealedOf = async (canvaUserId: string) =>
        (
          await setup.client.$queryRaw<
            Array<{
              keyVersion: number | null;
              iv: string | null;
              ciphertext: string | null;
              tag: string | null;
            }>
          >`
            SELECT "keyVersion", "refreshTokenIv" AS "iv",
              "refreshTokenCiphertext" AS "ciphertext", "refreshTokenTag" AS "tag"
            FROM "canva_pending_revocations" WHERE "canvaUserId" = ${canvaUserId}`
        )[0];
      const documentedSealed = await sealedOf('c-401-documented');
      expect(documentedSealed.ciphertext).not.toBeNull();
      // Canva's documented revoke response for an invalid client secret
      // (https://www.canva.dev/docs/connect/api-reference/authentication/revoke-token/;
      // Stage 2.9). The real token client classifies it; the PostgreSQL
      // worker records it.
      const documented401 = {
        kind: 'status' as const,
        status: 401,
        body: {
          code: 'invalid_access_token',
          message: 'Client secret is invalid for OC-gate-client',
        },
      };
      context.fake.respondFor('revoke', 'c-401-documented', documented401);
      // Keyed by user: the batch's processing order is not guaranteed.
      context.fake.respondFor('revoke', 'c-503', {
        kind: 'status',
        status: 503,
      });
      context.fake.respondFor('revoke', 'c-429', {
        kind: 'status',
        status: 429,
        retryAfter: 600,
      });
      context.fake.respondFor('revoke', 'c-401', {
        kind: 'status',
        status: 401,
        body: { error: 'invalid_client' },
      });
      context.fake.respondFor('revoke', 'c-400', {
        kind: 'status',
        status: 400,
        body: { error: 'bad_request_params' },
      });
      // Both client-credential refusals count as configuration errors.
      await expect(w1.worker.runOnce()).resolves.toMatchObject({
        claimed: 6,
        sent: 6,
        exhausted: 0,
        configurationErrors: 2,
      });
      const byUser = Object.fromEntries(
        (await queueRows(setup.client)).map((row) => [row.canvaUserId, row]),
      );
      expect(byUser['c-503']).toMatchObject({ state: 'queued', attempts: 1 });
      expect(byUser['c-503'].possibleEffectUntil).not.toBeNull();
      expect(byUser['c-429']).toMatchObject({ state: 'queued', attempts: 1 });
      // Configuration pause: no attempt used, ciphertext kept, retried after
      // the 15-minute pause, not finished or exhausted.
      for (const user of ['c-401', 'c-401-documented']) {
        expect(byUser[user]).toMatchObject({
          state: 'queued',
          attempts: 0,
          outcome: null,
          lastErrorKind: 'configuration',
          hasCiphertext: true,
        });
        expect(byUser[user].nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
          byUser[user].callStartedAt!.getTime() +
            REVOCATION_CONFIGURATION_PAUSE_MS,
        );
      }
      expect(await sealedOf('c-401-documented')).toEqual(documentedSealed);
      // inspect reports both as configuration errors (Stage 2.8.1 SQL).
      expect((await setup.queue.inspect(20)).health).toEqual({
        revocationConfigurationErrors: 2,
        revocationKeyUnavailable: 0,
        connectionConfigurationErrors: 0,
      });

      // Repeated refusals, past the attempt limit, never use an attempt or
      // exhaust the row early.
      const makeDue = (canvaUserId: string) => setup.client.$executeRaw`
        UPDATE "canva_pending_revocations"
        SET "nextAttemptAt" = (now() AT TIME ZONE 'UTC') - interval '1 second'
        WHERE "canvaUserId" = ${canvaUserId}`;
      for (let run = 0; run < REVOCATION_MAX_ATTEMPTS + 1; run += 1) {
        context.fake.respondFor('revoke', 'c-401-documented', documented401);
        await makeDue('c-401-documented');
        await expect(
          w1.worker.runOnce({ canvaUserId: 'c-401-documented' }),
        ).resolves.toMatchObject({
          claimed: 1,
          sent: 1,
          exhausted: 0,
          configurationErrors: 1,
        });
      }
      expect(context.fake.count('revoke', 'c-401-documented')).toBe(
        REVOCATION_MAX_ATTEMPTS + 2,
      );
      const [paused] = (await queueRows(setup.client)).filter(
        (row) => row.canvaUserId === 'c-401-documented',
      );
      expect(paused).toMatchObject({
        state: 'queued',
        attempts: 0,
        lastErrorKind: 'configuration',
        hasCiphertext: true,
      });
      expect(await sealedOf('c-401-documented')).toEqual(documentedSealed);

      // Only past the 7-day pause limit is it exhausted, for an
      // administrator to retry or dismiss, with its ciphertext and unused
      // attempts kept.
      await setup.client.$executeRaw`
        UPDATE "canva_pending_revocations"
        SET "createdAt" = (now() AT TIME ZONE 'UTC')
          - ${REVOCATION_CONFIGURATION_PAUSE_LIMIT_MS / 1000}::float8 * interval '1 second'
          - interval '1 minute'
        WHERE "canvaUserId" = 'c-401-documented'`;
      context.fake.respondFor('revoke', 'c-401-documented', documented401);
      await makeDue('c-401-documented');
      await expect(
        w1.worker.runOnce({ canvaUserId: 'c-401-documented' }),
      ).resolves.toMatchObject({ exhausted: 1, configurationErrors: 1 });
      const [limit] = (await queueRows(setup.client)).filter(
        (row) => row.canvaUserId === 'c-401-documented',
      );
      expect(limit).toMatchObject({
        state: 'exhausted',
        attempts: 0,
        lastErrorKind: 'configuration',
        hasCiphertext: true,
      });
      expect(await sealedOf('c-401-documented')).toEqual(documentedSealed);
      expect(byUser['c-400']).toMatchObject({
        state: 'finished',
        outcome: 'not_revocable',
        hasCiphertext: false,
      });
      expect(byUser['c-200']).toMatchObject({
        state: 'finished',
        outcome: 'revoked',
      });

      // A worker stalls mid-call; its claim expires; a second worker
      // recovers the row. Each T1 leads to at most one call.
      await enqueue('c-crash');
      const held = context.fake.hold('revoke');
      const stalled = w1.worker.runOnce({ canvaUserId: 'c-crash' });
      await held.arrived;
      await setup.client.$executeRaw`
        UPDATE "canva_pending_revocations"
        SET "claimedUntil" = (now() AT TIME ZONE 'UTC') - interval '1 second'
        WHERE "canvaUserId" = 'c-crash'`;
      await w2.worker.runOnce({ canvaUserId: 'c-crash' });
      held.release();
      await stalled;
      const [crashed] = (await queueRows(setup.client)).filter(
        (row) => row.canvaUserId === 'c-crash',
      );
      expect(crashed).toMatchObject({ state: 'finished', attempts: 2 });
      expect(context.fake.count('revoke', 'c-crash')).toBe(2);

      // Exhaustion keeps the ciphertext and is audited.
      await enqueue('c-exhaust');
      await setup.client.$executeRaw`
        UPDATE "canva_pending_revocations" SET "attempts" = 8
        WHERE "canvaUserId" = 'c-exhaust'`;
      await w1.worker.runOnce({ canvaUserId: 'c-exhaust' });
      const [exhausted] = (await queueRows(setup.client)).filter(
        (row) => row.canvaUserId === 'c-exhaust',
      );
      expect(exhausted).toMatchObject({
        state: 'exhausted',
        hasCiphertext: true,
      });
      expect(await auditActions(setup.client)).toContain(
        'canva.connection.revocation_exhausted',
      );
    }));

  it('Gate D: the same-user guard, end to end', () =>
    gate('d', async (context) => {
      const setup = await context.actor('setup');
      const worker = await context.actor('worker');
      const a = await seedOwner(setup.client, 'd-a');
      const b = await seedOwner(setup.client, 'd-b');
      // Same Canva user reconnects in one organization: nothing is queued.
      await connectUser(context, setup, a, 'canva-ud');
      await connectUser(context, setup, a, 'canva-ud');
      expect(await queueRows(setup.client)).toEqual([]);
      // A disconnect queued for U, then U's candidate in another
      // organization before T1.
      await setup.credentials.disconnect(a.organizationId, a.userId);
      const attempt = await consumedAttempt(setup.client, b);
      await setup.credentials.createCandidate(
        candidateFor(context.config, context.fake, b, attempt, 'canva-ud'),
      );
      await worker.worker.runOnce();
      expect((await queueRows(setup.client)).map((row) => row.outcome)).toEqual(
        ['skipped_shared_consent'],
      );
      expect(context.fake.count('revoke')).toBe(0);
    }));

  it('Gate I: a revocation in flight or inside its window refuses a new connection', () =>
    gate('i', async (context) => {
      const setup = await context.actor('setup');
      const worker = await context.actor('worker');
      const callback = await context.actor('callback');
      const a = await seedOwner(setup.client, 'i-a');
      const b = await seedOwner(setup.client, 'i-b');
      await connectUser(context, setup, a, 'canva-ui');
      await setup.credentials.disconnect(a.organizationId, a.userId);
      const tryConnect = async () => {
        const attempt = await consumedAttempt(setup.client, b);
        return (
          await callback.credentials.createCandidate(
            candidateFor(context.config, context.fake, b, attempt, 'canva-ui'),
          )
        ).outcome;
      };
      // (a) The response is held: in_flight refuses; after T2, a later
      // launch succeeds.
      const held = context.fake.hold('revoke');
      const running = worker.worker.runOnce();
      await held.arrived;
      expect(await tryConnect()).toBe('retry_connect');
      held.release();
      await running;
      expect(await tryConnect()).toBe('pending_confirmation');
      await callback.credentials.rejectCandidate(
        b,
        (await callback.credentials.readCandidate(b))!.id,
      );
      // (b) An ambiguous call: the window is open, then moved with SQL.
      await connectUser(context, setup, a, 'canva-ui2');
      await setup.credentials.disconnect(a.organizationId, a.userId);
      context.fake.respond('revoke', { kind: 'drop' });
      await worker.worker.runOnce({ canvaUserId: 'canva-ui2' });
      const inside = await consumedAttempt(setup.client, b);
      expect(
        (
          await callback.credentials.createCandidate(
            candidateFor(context.config, context.fake, b, inside, 'canva-ui2'),
          )
        ).outcome,
      ).toBe('retry_connect');
      await setup.client.$executeRaw`
        UPDATE "canva_pending_revocations"
        SET "possibleEffectUntil" = (now() AT TIME ZONE 'UTC') - interval '1 second'
        WHERE "canvaUserId" = 'canva-ui2'`;
      const outside = await consumedAttempt(setup.client, b);
      expect(
        (
          await callback.credentials.createCandidate(
            candidateFor(context.config, context.fake, b, outside, 'canva-ui2'),
          )
        ).outcome,
      ).toBe('pending_confirmation');
    }));

  it('Gate J (variants): a Canva user held through a credential or a candidate is unavailable elsewhere', () =>
    gate('jv', async (context) => {
      const setup = await context.actor('setup');
      const a = await seedOwner(setup.client, 'jv-a');
      const b = await seedOwner(setup.client, 'jv-b');
      const tryB = async (canvaUserId: string) => {
        const attempt = await consumedAttempt(setup.client, b);
        return (
          await setup.credentials.createCandidate(
            candidateFor(context.config, context.fake, b, attempt, canvaUserId),
          )
        ).outcome;
      };
      await connectUser(context, setup, a, 'canva-held-credential');
      expect(await tryB('canva-held-credential')).toBe('account_unavailable');
      const attempt = await consumedAttempt(setup.client, a);
      await setup.credentials.createCandidate(
        candidateFor(
          context.config,
          context.fake,
          a,
          attempt,
          'canva-held-candidate',
        ),
      );
      expect(await tryB('canva-held-candidate')).toBe('account_unavailable');
      expect(await queueRows(setup.client)).toEqual([]);
    }));

  it('Gate K: activation with replacement versus the released user connecting elsewhere', () =>
    gate('k', async (context) => {
      const setup = await context.actor('setup');
      const worker = await context.actor('worker');
      const a = await seedOwner(setup.client, 'k-a');
      const b = await seedOwner(setup.client, 'k-b');
      const c = await seedOwner(setup.client, 'k-c');
      // An earlier disconnect elsewhere left a queued row for U1.
      await connectUser(context, setup, c, 'canva-k1');
      await setup.credentials.disconnect(c.organizationId, c.userId);
      await connectUser(context, setup, a, 'canva-k0');
      const attempt = await consumedAttempt(setup.client, a);
      await setup.credentials.createCandidate(
        candidateFor(context.config, context.fake, a, attempt, 'canva-k1'),
      );
      const points = new PausePoints().beforeCommit(
        'confirm-before-commit',
        /INSERT INTO "canva_credentials"/,
      );
      const confirmer = await context.actor('confirm', { points });
      const callback = await context.actor('callback');
      const confirming = confirmer.credentials.activateCandidate(
        a,
        (await setup.credentials.readCandidate(a))!.id,
      );
      await points.reached('confirm-before-commit');
      const attemptB = await consumedAttempt(setup.client, b);
      const elsewhere = callback.credentials.createCandidate(
        candidateFor(context.config, context.fake, b, attemptB, 'canva-k0'),
      );
      await context.schema.waitUntilBlocked('callback');
      points.release('confirm-before-commit');
      expect((await confirming).outcome).toBe('connected');
      expect((await elsewhere).outcome).toBe('pending_confirmation');
      await worker.worker.runOnce();
      const outcomes = Object.fromEntries(
        (await queueRows(setup.client)).map((row) => [
          `${row.canvaUserId}:${row.reason}`,
          row.outcome,
        ]),
      );
      expect(outcomes).toMatchObject({
        'canva-k1:disconnect': 'skipped_shared_consent',
        'canva-k0:replaced_other_user': 'skipped_shared_consent',
      });
      expect(context.fake.count('revoke')).toBe(0);
    }));

  it('Gate L: refresh versus a same-user reconnect versus the orphan revocation', () =>
    gate('l', async (context) => {
      const setup = await context.actor('setup');
      const refresher = await context.actor('refresh');
      const worker = await context.actor('worker');
      const owner = await seedOwner(setup.client, 'l');
      await connectUser(context, setup, owner, 'canva-ul');
      await expireAccessToken(setup.client, owner.organizationId);
      const held = context.fake.hold('token');
      const refresh = refresher.accessTokens.accessTokenFor(
        owner.organizationId,
      );
      await held.arrived;
      await connectUser(context, setup, owner, 'canva-ul');
      held.release();
      await refresh;
      expect((await queueRows(setup.client)).map((row) => row.reason)).toEqual([
        'orphaned_rotation',
      ]);
      await worker.worker.runOnce();
      expect((await queueRows(setup.client))[0].outcome).toBe(
        'skipped_shared_consent',
      );
      expect(context.fake.count('revoke')).toBe(0);
      await expireAccessToken(setup.client, owner.organizationId);
      await expect(
        refresher.accessTokens.accessTokenFor(owner.organizationId),
      ).resolves.toMatch(/^fake-access-/);
    }));

  it('Gate M(a, b): disconnect versus the worker versus a reconnect, both orders', () =>
    gate('mab', async (context) => {
      const setup = await context.actor('setup');
      const worker = await context.actor('worker');
      const a = await seedOwner(setup.client, 'm-a');
      const b = await seedOwner(setup.client, 'm-b');
      // (a) The callback in B wins before T1.
      await connectUser(context, setup, a, 'canva-um');
      await setup.credentials.disconnect(a.organizationId, a.userId);
      const attempt = await consumedAttempt(setup.client, b);
      expect(
        (
          await setup.credentials.createCandidate(
            candidateFor(context.config, context.fake, b, attempt, 'canva-um'),
          )
        ).outcome,
      ).toBe('pending_confirmation');
      await worker.worker.runOnce();
      expect(context.fake.count('revoke')).toBe(0);
      // (b) T1 commits first.
      await connectUser(context, setup, a, 'canva-um2');
      await setup.credentials.disconnect(a.organizationId, a.userId);
      const held = context.fake.hold('revoke');
      const running = worker.worker.runOnce({ canvaUserId: 'canva-um2' });
      await held.arrived;
      const late = await consumedAttempt(setup.client, b);
      await setup.credentials.rejectCandidate(
        b,
        (await setup.credentials.readCandidate(b))!.id,
      );
      expect(
        (
          await setup.credentials.createCandidate(
            candidateFor(context.config, context.fake, b, late, 'canva-um2'),
          )
        ).outcome,
      ).toBe('retry_connect');
      held.release();
      await running;
      const disconnects = await setup.client.$queryRaw<
        Array<{ metadata: unknown }>
      >`
        SELECT "metadata" FROM "audit_logs" WHERE "action" = 'canva.connection.disconnected'`;
      expect(disconnects.map((row) => row.metadata)).toEqual([
        { mode: 'CANVA', revocation: 'queued' },
        { mode: 'CANVA', revocation: 'queued' },
      ]);
    }));

  it('Gate N: claim expiry, fencing, the send deadline, a lock wait (F20), and crash recovery (F21)', () =>
    gate('n', async (context) => {
      const setup = await context.actor('setup');
      const owner = await seedOwner(setup.client, 'n');
      const enqueue = async (canvaUserId: string) => {
        const issued = context.fake.issue(canvaUserId);
        await setup.credentials.enqueueRevocation({
          organizationId: owner.organizationId,
          chainId: `chain-${canvaUserId}`,
          canvaUserId,
          reason: 'disconnect',
          refreshToken: context.config.keyring.seal(
            issued.refreshToken,
            sealContext.refreshToken(owner.organizationId),
          ),
        });
      };
      const expireClaim = (canvaUserId: string) =>
        setup.client.$executeRaw`
          UPDATE "canva_pending_revocations"
          SET "claimedUntil" = (now() AT TIME ZONE 'UTC') - interval '1 second'
          WHERE "canvaUserId" = ${canvaUserId}`;
      const row = async (canvaUserId: string) =>
        (await queueRows(setup.client)).find(
          (entry) => entry.canvaUserId === canvaUserId,
        )!;

      // W1 resumes after its send deadline: it never sends.
      let tick = 0;
      const w1 = await context.actor('w1', {
        clock: { monotonic: () => (tick += 6_000) },
      });
      const w2 = await context.actor('w2');
      await enqueue('n-deadline');
      await expect(
        w1.worker.runOnce({ canvaUserId: 'n-deadline' }),
      ).resolves.toMatchObject({ abandoned: 1, sent: 0 });
      const abandonedCall = (await row('n-deadline')).callStartedAt!;
      await expireClaim('n-deadline');
      await w2.worker.runOnce({ canvaUserId: 'n-deadline' });
      const recovered = await row('n-deadline');
      expect(recovered).toMatchObject({ state: 'finished', attempts: 2 });
      expect(context.fake.count('revoke', 'n-deadline')).toBe(1);
      // The crashed call's window: send deadline + timeout + allowance.
      expect(recovered.possibleEffectUntil!.getTime()).toBeGreaterThanOrEqual(
        abandonedCall.getTime() + 135_000,
      );

      // W1 resumes after sending, before T2: its T2 matches nothing.
      const w3 = await context.actor('w3');
      await enqueue('n-fenced');
      const held = context.fake.hold('revoke');
      const paused = w3.worker.runOnce({ canvaUserId: 'n-fenced' });
      await held.arrived;
      await expireClaim('n-fenced');
      await w2.worker.runOnce({ canvaUserId: 'n-fenced' });
      held.release();
      await paused;
      expect(await row('n-fenced')).toMatchObject({
        state: 'finished',
        attempts: 2,
      });
      expect(context.fake.count('revoke', 'n-fenced')).toBe(2);

      // F20: T1 waits on the account lock; its claim still starts at the
      // statement, not the transaction start.
      await enqueue('n-wait');
      const holder = context.schema.actor('holder');
      await context.schema.prepare(holder);
      const lock = holdTransaction(holder, async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "canva_accounts" WHERE "canvaUserId" = 'n-wait' FOR UPDATE`;
      });
      await lock.ready;
      const [claimed] = await w2.queue.claim('claim-n', 1, 'n-wait');
      const deciding = w2.queue.decide(claimed.id, 'claim-n');
      await context.schema.waitUntilBlocked('w2');
      // A deliberate 3-second lock wait (the scenario), not an ordering.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      lock.release();
      await lock.done;
      expect((await deciding).kind).toBe('send');
      const [fence] = await setup.client.$queryRaw<Array<{ seconds: number }>>`
        SELECT EXTRACT(EPOCH FROM ("claimedUntil" - "callStartedAt"))::float8 AS "seconds"
        FROM "canva_pending_revocations" WHERE "canvaUserId" = 'n-wait'`;
      expect(fence.seconds).toBeGreaterThan(59.9);

      // A lock held past T1's 5-second lock_timeout: a definite rollback,
      // no attempt counted, nothing sent.
      await enqueue('n-timeout');
      const longHolder = context.schema.actor('long-holder');
      await context.schema.prepare(longHolder);
      const longLock = holdTransaction(longHolder, async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "canva_accounts" WHERE "canvaUserId" = 'n-timeout' FOR UPDATE`;
      });
      await longLock.ready;
      await expect(
        w2.worker.runOnce({ canvaUserId: 'n-timeout' }),
      ).resolves.toMatchObject({ claimed: 1, sent: 0 });
      longLock.release();
      await longLock.done;
      expect(await row('n-timeout')).toMatchObject({
        state: 'queued',
        attempts: 0,
      });
      expect(context.fake.count('revoke', 'n-timeout')).toBe(0);

      // F21: a crash after T1 blocks reconnection until a worker recovers
      // the row with its 135-second window.
      await enqueue('n-crash');
      const [crashClaim] = await w2.queue.claim('claim-crash', 1, 'n-crash');
      await w2.queue.decide(crashClaim.id, 'claim-crash');
      await expireClaim('n-crash');
      const other = await seedOwner(setup.client, 'n-b');
      const blocked = await consumedAttempt(setup.client, other);
      expect(
        (
          await setup.credentials.createCandidate(
            candidateFor(
              context.config,
              context.fake,
              other,
              blocked,
              'n-crash',
            ),
          )
        ).outcome,
      ).toBe('retry_connect');
      await w2.worker.runOnce({ canvaUserId: 'n-crash' });
      const crashed = await row('n-crash');
      expect(crashed.state).toBe('finished');
      await setup.client.$executeRaw`
        UPDATE "canva_pending_revocations"
        SET "possibleEffectUntil" = (now() AT TIME ZONE 'UTC') - interval '1 second'
        WHERE "canvaUserId" = 'n-crash'`;
      const afterWindow = await consumedAttempt(setup.client, other);
      expect(
        (
          await setup.credentials.createCandidate(
            candidateFor(
              context.config,
              context.fake,
              other,
              afterWindow,
              'n-crash',
            ),
          )
        ).outcome,
      ).toBe('pending_confirmation');
    }));

  it('Gate Q: exhausted retention, administrator retry and dismiss, and the 30-day abandon', () =>
    gate('q', async (context) => {
      const setup = await context.actor('setup');
      const worker = await context.actor('worker');
      const owner = await seedOwner(setup.client, 'q');
      for (const user of ['q-1', 'q-3']) {
        const issued = context.fake.issue(user);
        await setup.credentials.enqueueRevocation({
          organizationId: owner.organizationId,
          chainId: `chain-${user}`,
          canvaUserId: user,
          reason: 'disconnect',
          refreshToken: context.config.keyring.seal(
            issued.refreshToken,
            sealContext.refreshToken(owner.organizationId),
          ),
        });
      }
      const due = () => setup.client.$executeRaw`
        UPDATE "canva_pending_revocations"
        SET "nextAttemptAt" = (now() AT TIME ZONE 'UTC') WHERE "state" = 'queued'`;
      for (let failure = 0; failure < 8; failure += 1) {
        context.fake.respond('revoke', { kind: 'status', status: 503 });
        await due();
        await worker.worker.runOnce({ canvaUserId: 'q-1' });
      }
      const [exhausted] = (await queueRows(setup.client)).filter(
        (row) => row.canvaUserId === 'q-1',
      );
      expect(exhausted).toMatchObject({
        state: 'exhausted',
        attempts: 8,
        hasCiphertext: true,
      });
      const windowBefore = exhausted.possibleEffectUntil;
      expect(
        await setup.queue.retryExhausted(
          owner.organizationId,
          exhausted.id,
          owner.userId,
        ),
      ).toBe(true);
      const [retried] = (await queueRows(setup.client)).filter(
        (row) => row.canvaUserId === 'q-1',
      );
      expect(retried).toMatchObject({ state: 'queued', attempts: 0 });
      expect(retried.possibleEffectUntil).toEqual(windowBefore);
      await setup.client.$executeRaw`
        UPDATE "canva_pending_revocations" SET "attempts" = 8 WHERE "canvaUserId" = 'q-1'`;
      await worker.worker.runOnce({ canvaUserId: 'q-1' });
      expect(
        await setup.queue.dismissExhausted(
          owner.organizationId,
          exhausted.id,
          owner.userId,
        ),
      ).toBe(true);
      // The third row: exhausted 31 days ago, abandoned by maintenance.
      await setup.client.$executeRaw`
        UPDATE "canva_pending_revocations"
        SET "state" = 'exhausted', "nextAttemptAt" = (now() AT TIME ZONE 'UTC') - interval '31 days'
        WHERE "canvaUserId" = 'q-3'`;
      await worker.worker.maintain();
      const outcomes = (await queueRows(setup.client)).map((row) => [
        row.canvaUserId,
        row.outcome,
        row.hasCiphertext,
      ]);
      expect(outcomes).toEqual([
        ['q-1', 'dismissed', false],
        ['q-3', 'abandoned', false],
      ]);
      const actions = await auditActions(setup.client);
      for (const action of [
        'canva.connection.revocation_exhausted',
        'canva.connection.revocation_retried',
        'canva.connection.revocation_dismissed',
      ])
        expect(actions).toContain(action);
    }));

  it('Gate R(a, c): the sweep deletes the account row between the insert and its lock', () =>
    gate('rac', async (context) => {
      const setup = await context.actor('setup');
      const sweeper = await context.actor('sweep');
      const owner = await seedOwner(setup.client, 'r');
      const oldUnheld = (canvaUserId: string) =>
        setup.client.$executeRaw`
          INSERT INTO "canva_accounts" ("canvaUserId", "createdAt", "updatedAt")
          VALUES (${canvaUserId}, (now() AT TIME ZONE 'UTC') - interval '91 days', now())`;
      // (a) The callback.
      await oldUnheld('canva-ra');
      const pointsA = new PausePoints().after(
        'after-account-insert',
        /INSERT INTO "canva_accounts"/,
      );
      const callback = await context.actor('callback', { points: pointsA });
      const attempt = await consumedAttempt(setup.client, owner);
      const created = callback.credentials.createCandidate(
        candidateFor(context.config, context.fake, owner, attempt, 'canva-ra'),
      );
      await pointsA.reached('after-account-insert');
      expect((await sweeper.queue.maintain()).deletedAccounts).toBe(1);
      pointsA.release('after-account-insert');
      expect((await created).outcome).toBe('pending_confirmation');
      // (c) E in its own transaction (it locks the row too, deviation I4).
      await oldUnheld('canva-rc');
      const pointsC = new PausePoints().after(
        'after-account-insert',
        /INSERT INTO "canva_accounts"/,
      );
      const enqueuer = await context.actor('enqueue', { points: pointsC });
      const queued = enqueuer.credentials.enqueueRevocation({
        organizationId: owner.organizationId,
        chainId: 'chain-rc',
        canvaUserId: 'canva-rc',
        reason: 'connect_failed',
        refreshToken: context.config.keyring.seal(
          context.fake.issue('canva-rc').refreshToken,
          sealContext.refreshToken(owner.organizationId),
        ),
      });
      await pointsC.reached('after-account-insert');
      expect((await sweeper.queue.maintain()).deletedAccounts).toBe(1);
      pointsC.release('after-account-insert');
      await queued;
      expect(
        (await queueRows(setup.client)).filter(
          (row) => row.canvaUserId === 'canva-rc',
        ),
      ).toHaveLength(1);
    }));

  // Gates E and P: seeded random mixes run concurrently, with every
  // invariant checked after each step. The seed is printed for replay.
  async function randomizedMix(
    context: GateContext,
    seed: number,
    steps: number,
    operations: ReadonlyArray<
      (actor: Actor, pick: <T>(values: T[]) => T) => Promise<unknown>
    >,
    actors: Actor[],
    // Tally entries that must occur at least once, so the mix provably
    // exercised the paths the gate is about (first Stage 2.5 run: gate E's
    // refreshes never found a credential, so no refresh write took part).
    required: string[] = [],
  ): Promise<void> {
    console.info(`Gate randomized mix seed: ${seed}`);
    const random = seededRandom(seed);
    const pick = <T>(values: T[]): T =>
      values[Math.floor(random() * values.length)];
    // Outcome tally per operation, so a mix that "passes" because its
    // operations failed for the wrong reason is visible and refused.
    const tally = new Map<string, number>();
    const count = (key: string) => tally.set(key, (tally.get(key) ?? 0) + 1);
    let fulfilled = 0;
    let total = 0;
    for (let step = 0; step < steps; step += 1) {
      const chosen = actors.map(() => pick([...operations]));
      const results = await Promise.allSettled(
        actors.map((actor, index) => chosen[index](actor, pick)),
      );
      results.forEach((result, index) => {
        const name = chosen[index].name || 'operation';
        total += 1;
        if (result.status === 'fulfilled') {
          fulfilled += 1;
          const value = result.value as { outcome?: unknown } | null;
          const outcome =
            value && typeof value === 'object' && 'outcome' in value
              ? `(${String(value.outcome)})`
              : value === null
                ? '(nothing to do)'
                : '';
          count(`${name}: ok${outcome}`);
          return;
        }
        const reason = result.reason as Error;
        const kind = reason?.name || typeof reason;
        const detail = (reason as { reason?: unknown })?.reason;
        count(
          `${name}: ${kind}${typeof detail === 'string' ? `(${detail})` : ''}`,
        );
        if (/40P01|deadlock/i.test(String(reason)))
          throw new Error(`Unhandled deadlock at step ${step} (seed ${seed})`);
        // A programming error or a guard refusal is never an acceptable
        // outcome of a concurrent mix.
        if (
          /^(TypeError|ReferenceError|RangeError|SyntaxError|PrismaClientValidationError)$/.test(
            kind,
          ) ||
          /Refusing to run|Proxy assumption not met/.test(String(reason))
        )
          throw new Error(
            `Unexpected ${kind} in ${name} at step ${step} (seed ${seed}): ${reason?.message}`,
          );
      });
      expect(await checkInvariants(context.observer)).toEqual([]);
      const extended = await checkExtendedInvariants(
        context.observer,
        context.fake.issuedSecrets,
      );
      expect(extended.violations).toEqual([]);
    }
    console.info(
      `Gate randomized mix outcomes (seed ${seed}): ${fulfilled}/${total} completed; ${[
        ...tally,
      ]
        .sort()
        .map(([key, value]) => `${key}=${value}`)
        .join(', ')}`,
    );
    // Most operations must complete; definite refusals (a stale write, a
    // missing credential, a lock timeout) are expected, but not as the norm.
    expect(fulfilled / total).toBeGreaterThanOrEqual(0.5);
    for (const entry of required)
      expect(tally.get(entry) ?? 0, `${entry} never happened`).toBeGreaterThan(
        0,
      );
  }

  function mixOperations(context: GateContext, owners: GateOwner[]) {
    const users = ['mix-u1', 'mix-u2', 'mix-u3'];
    const createFor = async (
      actor: Actor,
      owner: GateOwner,
      pick: <T>(values: T[]) => T,
    ) => {
      const attempt = await consumedAttempt(actor.client, owner);
      return actor.credentials.createCandidate(
        candidateFor(context.config, context.fake, owner, attempt, pick(users)),
      );
    };
    const candidate = (actor: Actor, pick: <T>(values: T[]) => T) =>
      createFor(actor, pick(owners), pick);
    // Creates a candidate first when none is pending, so activations (and
    // the credentials later operations need) actually happen.
    const activateFor = async (
      actor: Actor,
      owner: GateOwner,
      pick: <T>(values: T[]) => T,
    ) => {
      let pending = await actor.credentials.readCandidate(owner);
      if (!pending) {
        await createFor(actor, owner, pick);
        pending = await actor.credentials.readCandidate(owner);
      }
      return pending && actor.credentials.activateCandidate(owner, pending.id);
    };
    const activate = (actor: Actor, pick: <T>(values: T[]) => T) =>
      activateFor(actor, pick(owners), pick);
    const reject = async (actor: Actor, pick: <T>(values: T[]) => T) => {
      const owner = pick(owners);
      const pending = await actor.credentials.readCandidate(owner);
      return pending && actor.credentials.rejectCandidate(owner, pending.id);
    };
    const expire = async (actor: Actor) => {
      await actor.client.$executeRaw`
        UPDATE "canva_connection_candidates"
        SET "expiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 second'
        WHERE "id" IN (SELECT "id" FROM "canva_connection_candidates" LIMIT 1)`;
      return actor.queue.maintain();
    };
    const disconnect = (actor: Actor, pick: <T>(values: T[]) => T) => {
      const owner = pick(owners);
      return actor.credentials.disconnect(owner.organizationId, owner.userId);
    };
    const mark = async (actor: Actor, pick: <T>(values: T[]) => T) => {
      const owner = pick(owners);
      const current = await actor.credentials.read(owner.organizationId);
      return (
        current &&
        actor.credentials.markReauthorizationRequired(
          owner.organizationId,
          current.version,
          'invalid_grant',
        )
      );
    };
    const sweep = (actor: Actor) => actor.queue.maintain();
    return {
      operations: {
        candidate,
        activate,
        reject,
        expire,
        disconnect,
        mark,
        sweep,
      },
      activateFor,
    };
  }

  it('Gate P: randomized hold, release, and sweep consistency', () =>
    gate('p', async (context) => {
      const setup = await context.actor('setup');
      const owners = [
        await seedOwner(setup.client, 'p-a'),
        await seedOwner(setup.client, 'p-b'),
        await seedOwner(setup.client, 'p-c'),
      ];
      const actors = await Promise.all(
        ['p1', 'p2', 'p3', 'p4'].map((label) => context.actor(label)),
      );
      const { operations } = mixOperations(context, owners);
      await randomizedMix(
        context,
        Number(process.env.ADFLOW_GATE_SEED ?? Date.now() % 1_000_000),
        25,
        Object.values(operations),
        actors,
        ['activate: ok(connected)'],
      );
    }));

  it('Gate E: randomized lock order across every protocol transaction', () =>
    gate('e', async (context) => {
      const setup = await context.actor('setup');
      const owners = [
        await seedOwner(setup.client, 'e-a'),
        await seedOwner(setup.client, 'e-b'),
        await seedOwner(setup.client, 'e-c'),
      ];
      const actors = await Promise.all(
        ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'].map((label) =>
          context.actor(label),
        ),
      );
      const { operations, activateFor } = mixOperations(context, owners);
      // Refreshes an organization that has a credential, connecting one
      // first when none does, so refresh writes take part in the mix.
      const refresh = async (actor: Actor, pick: <T>(values: T[]) => T) => {
        const connected: GateOwner[] = [];
        for (const owner of owners)
          if (await actor.credentials.read(owner.organizationId))
            connected.push(owner);
        const owner = connected.length ? pick(connected) : pick(owners);
        if (!connected.length) await activateFor(actor, owner, pick);
        await expireAccessToken(actor.client, owner.organizationId);
        return actor.accessTokens.accessTokenFor(owner.organizationId);
      };
      const work = (actor: Actor) => actor.worker.runOnce();
      const reseal = (actor: Actor) => actor.reseal.run({ limit: 10 });
      await randomizedMix(
        context,
        Number(process.env.ADFLOW_GATE_SEED ?? Date.now() % 1_000_000),
        30,
        [...Object.values(operations), refresh, work, reseal],
        actors,
        ['activate: ok(connected)', 'refresh: ok'],
      );
    }));

  it('Gate F (part): applying the Canva migrations keeps existing connection rows with the new defaults', async () => {
    // Applies the earlier migrations, writes a connection row, then the two
    // Canva migrations, inside one gate schema.
    const schema = await GateSchema.create(admin, 'f', {
      exclude: [
        '20261027120000_canva_reauthorization_status',
        '20261027120100_canva_oauth_persistence',
      ],
    });
    let failed = false;
    try {
      const db = schema.actor('migrator-f');
      await schema.prepare(db);
      const owner = await seedOwner(db, 'f');
      await db.$executeRaw`
        UPDATE "canva_connections" SET "status" = 'CONNECTED', "mode" = 'MOCK'
        WHERE "organizationId" = ${owner.organizationId}`;
      await schema.applyMigrations([
        '20261027120000_canva_reauthorization_status',
        '20261027120100_canva_oauth_persistence',
      ]);
      const [row] = await db.$queryRaw<
        Array<{
          status: string;
          mode: string;
          credentialVersion: number;
          connectionGeneration: number;
        }>
      >`
        SELECT "status"::text AS "status", "mode", "credentialVersion", "connectionGeneration"
        FROM "canva_connections" WHERE "organizationId" = ${owner.organizationId}`;
      expect(row).toEqual({
        status: 'CONNECTED',
        mode: 'MOCK',
        credentialVersion: 0,
        connectionGeneration: 0,
      });
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await schema.drop(failed);
    }
  });

  // Still blocked on infrastructure that does not exist yet.
  // Gates A, B, and O route one actor through the commit-dropping proxy
  // (commit-drop-proxy.ts). The proxy is closed in a finally block, so a
  // failed gate never leaves a listener behind.
  async function withProxy(
    body: (proxy: CommitDropProxy) => Promise<void>,
  ): Promise<void> {
    const target = new URL(isolated.url);
    const proxy = await CommitDropProxy.start({
      host: target.hostname,
      port: Number(target.port),
    });
    try {
      await body(proxy);
    } finally {
      await proxy.close();
    }
  }

  // The SQL that identifies each protocol transaction to the proxy, so a
  // drop is armed by what a transaction does, never by counting COMMITs.
  const TX = {
    candidate: /INSERT\s+INTO\s+"canva_connection_candidates"/,
    activation: /INSERT\s+INTO\s+"canva_credentials"/,
    rotation: /UPDATE\s+"canva_credentials"\s+SET\s+"keyVersion"/,
    enqueue: /INSERT\s+INTO\s+"canva_pending_revocations"/,
    t1: /"state"\s*=\s*'in_flight',\s*"attempts"\s*=\s*"attempts"\s*\+\s*1/,
    t2: /UPDATE\s+"canva_pending_revocations"\s+SET\s+"state"\s*=\s*\$1/,
  };

  // Gates A, B, and O rest on three assumptions about how Prisma frames
  // transactions on the wire. None is documented, and inspecting Prisma's
  // compiled engine cannot settle them, so each gate checks them against
  // the real server first and fails with an explicit message otherwise.
  // 1. A raw query outside $transaction sends no BEGIN or COMMIT.
  // 2. A protocol transaction sends exactly one BEGIN and one COMMIT.
  // 3. After the proxy cuts a connection, the client reconnects for the next
  //    query (the verification re-read depends on it).
  async function calibrate(proxy: CommitDropProxy, actor: Actor) {
    proxy.clearTranscript();
    await actor.client.$queryRaw`SELECT 1`;
    const autocommit = proxy.controlKinds();
    if (autocommit.length)
      throw new Error(
        `Proxy assumption not met: an autocommitted raw query sent [${autocommit.join(', ')}]`,
      );
    proxy.clearTranscript();
    await runCanvaTransaction(actor.runner, async (tx) => {
      await tx.$queryRaw`SELECT 1`;
    });
    const transaction = proxy.controlKinds();
    if (transaction.join(',') !== 'BEGIN,COMMIT')
      throw new Error(
        `Proxy assumption not met: a protocol transaction sent [${transaction.join(', ')}] instead of [BEGIN, COMMIT]`,
      );
    proxy.clearTranscript();
  }

  // Runs one armed operation and proves the drop happened; a gate whose drop
  // never fired would otherwise pass for the wrong reason.
  async function dropped<T>(
    proxy: CommitDropProxy,
    what: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const before = proxy.dropped;
    try {
      return await operation();
    } finally {
      if (proxy.dropped !== before + 1) {
        proxy.disarm();
        // eslint-disable-next-line no-unsafe-finally
        throw new Error(
          `Proxy assumption not met: ${what} sent no matching COMMIT, so nothing was dropped`,
        );
      }
    }
  }

  async function expectReconnects(actor: Actor) {
    try {
      await actor.client.$queryRaw`SELECT 1`;
    } catch {
      throw new Error(
        'Proxy assumption not met: the client did not reconnect after the dropped connection',
      );
    }
  }

  it('Gate A: an ambiguous commit that committed is verified by writeId and given nothing up', () =>
    gate('a', (context) =>
      withProxy(async (proxy) => {
        const setup = await context.actor('setup');
        const proxied = await context.actor('proxied', { via: proxy });
        await calibrate(proxy, proxied);
        const owner = await seedOwner(setup.client, 'a');

        // Candidate creation: committed, then the client was cut off.
        const attempt = await consumedAttempt(setup.client, owner);
        const input = candidateFor(
          context.config,
          context.fake,
          owner,
          attempt,
          'canva-ua',
        );
        proxy.arm('after-ack', { within: TX.candidate });
        await dropped(proxy, 'candidate creation', () =>
          expect(
            proxied.credentials.createCandidate(input),
          ).rejects.toMatchObject({ name: 'CanvaWriteOutcomeUnknownError' }),
        );
        await expectReconnects(proxied);
        await expect(
          proxied.credentials.candidateExists(input.writeId),
        ).resolves.toBe(true);

        // Activation: committed, then cut off; the credential is usable.
        const pending = (await setup.credentials.readCandidate(owner))!;
        proxy.arm('after-ack', { within: TX.activation });
        await dropped(proxy, 'activation', () =>
          expect(
            proxied.credentials.activateCandidate(owner, pending.id),
          ).rejects.toMatchObject({ name: 'CanvaWriteOutcomeUnknownError' }),
        );
        await expectReconnects(proxied);
        const [activated] = await setup.client.$queryRaw<
          Array<{ writeId: string }>
        >`SELECT "writeId" FROM "canva_credentials"`;
        expect(activated.writeId).toBe(input.writeId);

        // Refresh: the rotation committed; the re-read finds our writeId.
        // The service re-reads on the same proxied client right after the
        // drop, so assumption 3 is checked here by the outcome itself.
        await expireAccessToken(setup.client, owner.organizationId);
        proxy.arm('after-ack', { within: TX.rotation });
        const token = await dropped(proxy, 'the rotation write', () =>
          proxied.accessTokens.accessTokenFor(owner.organizationId),
        ).catch(async (error: unknown) => {
          await expectReconnects(proxied);
          throw error;
        });
        expect(token).toMatch(/^fake-access-/);
        const [refreshed] = await setup.client.$queryRaw<
          Array<{ version: number }>
        >`SELECT "version" FROM "canva_credentials"`;
        expect(refreshed.version).toBe(2);
        expect(await queueRows(setup.client)).toEqual([]);
        expect(context.fake.count('revoke')).toBe(0);
      }),
    ));

  it('Gate B: an ambiguous commit that did not commit and cannot be verified gives nothing up', () =>
    gate('b', (context) =>
      withProxy(async (proxy) => {
        const setup = await context.actor('setup');
        const proxied = await context.actor('proxied', { via: proxy });
        await calibrate(proxy, proxied);
        const owner = await seedOwner(setup.client, 'b');

        // Candidate creation: COMMIT withheld (rolled back), re-read refused.
        const attempt = await consumedAttempt(setup.client, owner);
        const input = candidateFor(
          context.config,
          context.fake,
          owner,
          attempt,
          'canva-ub',
        );
        proxy.arm('before-forward', {
          within: TX.candidate,
          refuseAfterDrop: true,
        });
        await dropped(proxy, 'candidate creation', () =>
          expect(
            proxied.credentials.createCandidate(input),
          ).rejects.toMatchObject({ name: 'CanvaWriteOutcomeUnknownError' }),
        );
        await expect(
          proxied.credentials.candidateExists(input.writeId),
        ).rejects.toThrow();
        proxy.refuse(false);
        const [state] = await setup.client.$queryRaw<
          Array<{ candidates: number; queued: number }>
        >`
          SELECT (SELECT count(*)::int FROM "canva_connection_candidates") AS "candidates",
                 (SELECT count(*)::int FROM "canva_pending_revocations") AS "queued"`;
        expect(state).toEqual({ candidates: 0, queued: 0 });

        // Refresh: the rotation rolled back and the re-read fails. Retryable,
        // outcome unknown; nothing queued; the stored credential unchanged.
        await connectUser(context, setup, owner, 'canva-ub');
        const [before] = await setup.client.$queryRaw<
          Array<{ version: number; writeId: string }>
        >`SELECT "version", "writeId" FROM "canva_credentials"`;
        await expireAccessToken(setup.client, owner.organizationId);
        proxy.arm('before-forward', {
          within: TX.rotation,
          refuseAfterDrop: true,
        });
        await dropped(proxy, 'the rotation write', () =>
          expect(
            proxied.accessTokens.accessTokenFor(owner.organizationId),
          ).rejects.toMatchObject({
            name: 'CanvaTemporarilyUnavailableError',
            outcomeUnknown: true,
          }),
        );
        proxy.refuse(false);
        const [after] = await setup.client.$queryRaw<
          Array<{ version: number; writeId: string }>
        >`SELECT "version", "writeId" FROM "canva_credentials"`;
        expect(after).toEqual(before);
        expect(await queueRows(setup.client)).toEqual([]);
        expect(context.fake.count('revoke')).toBe(0);
      }),
    ));

  it('Gate O: ambiguous commits in E, T1, and T2', () =>
    gate('o', (context) =>
      withProxy(async (proxy) => {
        const setup = await context.actor('setup');
        const proxied = await context.actor('proxied', { via: proxy });
        const recoverer = await context.actor('recover');
        await calibrate(proxy, proxied);
        const owner = await seedOwner(setup.client, 'o');
        const revocation = (canvaUserId: string) => ({
          organizationId: owner.organizationId,
          chainId: `chain-${canvaUserId}`,
          canvaUserId,
          reason: 'disconnect' as const,
          refreshToken: context.config.keyring.seal(
            context.fake.issue(canvaUserId).refreshToken,
            sealContext.refreshToken(owner.organizationId),
          ),
        });
        const rowFor = async (canvaUserId: string) =>
          (await queueRows(setup.client)).filter(
            (row) => row.canvaUserId === canvaUserId,
          );
        const expireClaim = (canvaUserId: string) =>
          setup.client.$executeRaw`
            UPDATE "canva_pending_revocations"
            SET "claimedUntil" = (now() AT TIME ZONE 'UTC') - interval '1 second'
            WHERE "canvaUserId" = ${canvaUserId}`;

        // E committed but unconfirmed: retrying it leaves exactly one row.
        const e = revocation('o-e');
        proxy.arm('after-ack', { within: TX.enqueue });
        await dropped(proxy, 'E', () =>
          expect(
            proxied.credentials.enqueueRevocation(e),
          ).rejects.toMatchObject({ name: 'CanvaWriteOutcomeUnknownError' }),
        );
        await expectReconnects(proxied);
        await proxied.credentials.enqueueRevocation(e);
        expect(await rowFor('o-e')).toHaveLength(1);

        // T1 committed but unconfirmed: no call; recovered as a crash.
        await setup.credentials.enqueueRevocation(revocation('o-t1'));
        proxy.arm('after-ack', { within: TX.t1 });
        await dropped(proxy, 'T1', () =>
          expect(
            proxied.worker.runOnce({ canvaUserId: 'o-t1' }),
          ).resolves.toMatchObject({ claimed: 1, sent: 0 }),
        );
        expect(context.fake.count('revoke', 'o-t1')).toBe(0);
        expect((await rowFor('o-t1'))[0]).toMatchObject({
          state: 'in_flight',
          attempts: 1,
        });
        await expireClaim('o-t1');
        await recoverer.worker.runOnce({ canvaUserId: 'o-t1' });
        expect((await rowFor('o-t1'))[0]).toMatchObject({
          state: 'finished',
          attempts: 2,
        });
        expect(context.fake.count('revoke', 'o-t1')).toBe(1);

        // T2 rolled back: the row stays in_flight, is recovered as a crash,
        // and the repeat call is answered (assumption A-R3).
        await setup.credentials.enqueueRevocation(revocation('o-t2'));
        proxy.arm('before-forward', { within: TX.t2 });
        await dropped(proxy, 'T2', () =>
          proxied.worker.runOnce({ canvaUserId: 'o-t2' }),
        );
        expect((await rowFor('o-t2'))[0].state).toBe('in_flight');
        await expireClaim('o-t2');
        await recoverer.worker.runOnce({ canvaUserId: 'o-t2' });
        expect((await rowFor('o-t2'))[0].state).toBe('finished');
        expect(context.fake.count('revoke', 'o-t2')).toBe(2);

        // T2 committed but unconfirmed: the row is finished regardless.
        await setup.credentials.enqueueRevocation(revocation('o-t3'));
        proxy.arm('after-ack', { within: TX.t2 });
        await dropped(proxy, 'T2', () =>
          proxied.worker.runOnce({ canvaUserId: 'o-t3' }),
        );
        expect((await rowFor('o-t3'))[0]).toMatchObject({
          state: 'finished',
          outcome: 'revoked',
          hasCiphertext: false,
        });
        expect(context.fake.count('revoke', 'o-t3')).toBe(1);
      }),
    ));

  // Gate F's recovery part needs the Prisma CLI against a gate schema, so it
  // has its own explicit opt-in on top of the gate run.
  const migrateRunnerOptedIn = process.env.ADFLOW_PG_MIGRATE_RUNNER === 'run';
  const PERSISTENCE_MIGRATION = '20261027120100_canva_oauth_persistence';

  // Tables, columns, constraints, and indexes of one schema, with the
  // schema's own name replaced so two schemas compare equal.
  async function catalog(client: PrismaClient, schemaName: string) {
    const [snapshot] = await client.$queryRaw<Array<{ catalog: unknown }>>`
      SELECT json_build_object(
        'columns', (SELECT json_agg(json_build_array(table_name, column_name, data_type,
            is_nullable, column_default) ORDER BY table_name, column_name)
          FROM information_schema.columns
          WHERE table_schema = ${schemaName} AND table_name <> '_prisma_migrations'),
        'constraints', (SELECT json_agg(json_build_array(c.conname, c.contype,
            pg_get_constraintdef(c.oid)) ORDER BY c.conname)
          FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE n.nspname = ${schemaName} AND c.conrelid <> 0
            AND c.conrelid::regclass::text NOT LIKE '%_prisma_migrations%'),
        'indexes', (SELECT json_agg(json_build_array(indexname, indexdef) ORDER BY indexname)
          FROM pg_indexes WHERE schemaname = ${schemaName}
            AND tablename <> '_prisma_migrations')
      ) AS "catalog"`;
    return JSON.stringify(snapshot.catalog).split(schemaName).join('<schema>');
  }

  it.runIf(migrateRunnerOptedIn)(
    'Gate F (rest): a migration failing halfway is recovered with migrate resolve, and the schema matches',
    async () => {
      const { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } =
        await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join, resolve } = await import('node:path');
      const { nodeSpawn, runGuardedMigration } =
        await import('./prisma-migrate-runner');
      // The CLI's own schema (gf_*), and a reference built from the same
      // reviewed SQL by the harness.
      const target = await GateSchema.create(admin, 'f', {
        exclude: migrationNames(),
      });
      const reference = await GateSchema.create(admin, 'fref');
      const workspace = mkdtempSync(join(tmpdir(), 'adflow-gate-f-'));
      let failed = false;
      onTestFailed(() => {
        failed = true;
      });
      try {
        const repository = resolve(__dirname, '../../../..');
        cpSync(
          join(repository, 'prisma', 'schema.prisma'),
          join(workspace, 'schema.prisma'),
        );
        cpSync(
          join(repository, 'prisma', 'migrations'),
          join(workspace, 'migrations'),
          { recursive: true },
        );
        const file = join(
          workspace,
          'migrations',
          PERSISTENCE_MIGRATION,
          'migration.sql',
        );
        const original = readFileSync(file, 'utf8');
        // Inject a failing statement halfway through the migration.
        const statements = original.split(/;\s*$/m);
        const half = Math.floor(statements.length / 2);
        writeFileSync(
          file,
          [
            ...statements.slice(0, half),
            '\nSELECT 1 / 0',
            ...statements.slice(half),
          ].join(';\n'),
        );
        const run = (
          action: Parameters<typeof runGuardedMigration>[0]['action'],
        ) =>
          runGuardedMigration(
            { action, schema: target.schema, workspace },
            process.env,
            {
              spawn: nodeSpawn,
              verifyServer: () => assertIsolatedServer(admin),
            },
          );

        const failing = await run({ kind: 'deploy' });
        expect(failing.code).not.toBe(0);
        // Whether Prisma 6.19 applies a migration atomically is what this
        // gate settles (§9). A partial application is a finding, reported
        // as such: recovery would then need manual cleanup first.
        const [partial] = await admin.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS "n" FROM information_schema.tables
          WHERE table_schema = ${target.schema}
            AND table_name IN ('canva_accounts', 'canva_oauth_attempts',
              'canva_connection_candidates', 'canva_credentials',
              'canva_pending_revocations')`;
        if (partial.n > 0)
          throw new Error(
            `Gate F finding: Prisma applied ${partial.n} table(s) of the failed migration; migrate resolve alone cannot recover it`,
          );

        const resolved = await run({
          kind: 'resolve-rolled-back',
          migration: PERSISTENCE_MIGRATION,
        });
        expect(resolved.code).toBe(0);
        writeFileSync(file, original);
        const recovered = await run({ kind: 'deploy' });
        expect(recovered.code).toBe(0);
        expect(await catalog(admin, target.schema)).toBe(
          await catalog(admin, reference.schema),
        );
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        rmSync(workspace, { recursive: true, force: true });
        await target.drop(failed);
        await reference.drop(failed);
      }
    },
  );
  it.skipIf(migrateRunnerOptedIn)(
    'Gate F recovery part: skipped without ADFLOW_PG_MIGRATE_RUNNER=run (it runs the Prisma CLI against a gate schema)',
    () => undefined,
  );
});
