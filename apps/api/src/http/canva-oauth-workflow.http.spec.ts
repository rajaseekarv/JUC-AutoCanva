import type {
  CanvaOAuthOutcome as SharedCanvaOAuthOutcome,
  CanvaPendingCandidate,
} from '@adflow/shared-types';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest';
import { AppModule } from '../app.module';
import { PERMISSIONS } from '../auth/permissions';
import { PrismaService } from '../prisma/prisma.service';
import {
  CANVA_CLOCK,
  type CanvaOAuthOutcome,
} from '../canva/oauth/canva-oauth.config';
import {
  CANVA_CREDENTIAL_STORE,
  CANVA_OAUTH_ATTEMPT_STORE,
  CANVA_REVOCATION_QUEUE,
  CanvaPersistenceError,
} from '../canva/oauth/canva-oauth.stores';
import {
  MemoryAttemptStore,
  MemoryCanvaDatabase,
  MemoryCredentialStore,
  MemoryRevocationQueue,
} from '../canva/oauth/canva-oauth.test-doubles';
import { CANVA_PRINCIPAL_CHECK } from '../canva/oauth/canva-principal-check';
import { CANVA_FETCH } from '../canva/oauth/canva-token.client';

// Mocked end-to-end workflow: the real Nest application, routes, guards,
// services, and Canva clients, over HTTP, in real Canva mode with durable
// storage switched on. Only the edges are doubles: in-memory stores instead
// of PostgreSQL, a fake Canva behind the injected fetch, and a Prisma mock
// that answers the session lookup. The global fetch throws, so nothing can
// reach Canva. This is not evidence of PostgreSQL behavior (the gates are).

const env = vi.hoisted(() => {
  const values: Record<string, string> = {
    DATABASE_URL:
      'postgresql://workflow-tests-must-not-connect@127.0.0.1:1/blocked',
    JWT_ACCESS_SECRET: 'workflow-test-only-secret-value-at-least-32-chars',
    CANVA_PROVIDER_MODE: 'canva',
    CANVA_CLIENT_ID: 'OC-test-client-id',
    CANVA_CLIENT_SECRET: 'test-only-client-secret-value',
    CANVA_REDIRECT_URI:
      'http://127.0.0.1:3000/api/v1/integrations/canva/oauth/callback',
    CANVA_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    CANVA_OAUTH_PERSISTENCE_ENABLED: 'true',
    CANVA_REVOCATION_WORKER_ENABLED: 'false',
  };
  const saved: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(values)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  return { values, saved };
});

// Sessions the mocked guard accepts: an administrator in two browser
// sessions, and a read-only user.
const sessions: Record<
  string,
  { userId: string; organizationId: string; permissions: string[] }
> = {
  'session-1': {
    userId: 'user-1',
    organizationId: 'org-1',
    permissions: [
      PERMISSIONS.CANVA_INTEGRATION_READ,
      PERMISSIONS.CANVA_INTEGRATION_MANAGE,
    ],
  },
  'session-2': {
    userId: 'user-1',
    organizationId: 'org-1',
    permissions: [
      PERMISSIONS.CANVA_INTEGRATION_READ,
      PERMISSIONS.CANVA_INTEGRATION_MANAGE,
    ],
  },
  'session-3': {
    userId: 'user-3',
    organizationId: 'org-1',
    permissions: [PERMISSIONS.CANVA_INTEGRATION_READ],
  },
};

const prismaMock = {
  authSession: {
    findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
      const session = sessions[where.id];
      if (!session) return null;
      return {
        id: where.id,
        user: {
          id: session.userId,
          organizationId: session.organizationId,
          name: 'Admin',
          email: 'admin@example.local',
          status: 'ACTIVE',
          branchAccess: [],
          roleAssignments: [
            {
              role: {
                organizationId: session.organizationId,
                permissions: session.permissions.map((code) => ({
                  permission: { code },
                })),
              },
            },
          ],
        },
      };
    }),
  },
};

// The fake Canva account behind the injected fetch.
type FakeAccount = {
  userId: string;
  teamId: string;
  displayName: string | null;
  capabilities: string[];
  scope: string | undefined;
  identityStatus: number;
};
const fullScope =
  'brandtemplate:meta:read brandtemplate:content:read design:content:write profile:read';
const defaultAccount = (): FakeAccount => ({
  userId: 'UAFcanvaUserAlpha01',
  teamId: 'UAFcanvaTeamBeta02',
  displayName: 'Brand Studio',
  capabilities: ['autofill', 'brand_template'],
  scope: fullScope,
  identityStatus: 200,
});

let account = defaultAccount();
let issued = 0;
const issuedTokens: string[] = [];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const canvaFetch = vi.fn(async (url: string, init: RequestInit) => {
  const target = new URL(url);
  if (target.hostname !== 'api.canva.com')
    throw new Error(`Unexpected host ${target.hostname}`);
  switch (target.pathname) {
    case '/rest/v1/oauth/token': {
      const body = new URLSearchParams(String(init.body));
      if (body.get('grant_type') !== 'authorization_code')
        throw new Error('Only the code exchange is expected');
      issued += 1;
      const tokens = {
        access_token: `fake-access-${issued}`,
        refresh_token: `fake-refresh-${issued}`,
      };
      issuedTokens.push(tokens.access_token, tokens.refresh_token);
      return json(200, {
        ...tokens,
        token_type: 'Bearer',
        expires_in: 14_400,
        ...(account.scope === undefined ? {} : { scope: account.scope }),
      });
    }
    case '/rest/v1/users/me':
      return account.identityStatus === 200
        ? json(200, {
            team_user: { user_id: account.userId, team_id: account.teamId },
          })
        : json(account.identityStatus, { code: 'internal_error' });
    case '/rest/v1/users/me/capabilities':
      return json(200, { capabilities: account.capabilities });
    case '/rest/v1/users/me/profile':
      return account.displayName === null
        ? json(500, { code: 'internal_error' })
        : json(200, { profile: { display_name: account.displayName } });
    default:
      // The revoke endpoint included: the worker is off and nothing on a
      // request path may revoke.
      throw new Error(`Unexpected Canva call ${target.pathname}`);
  }
});

const BASE = '/api/v1/integrations/canva';

describe('Canva OAuth confirmation workflow over HTTP (mocked edges)', () => {
  let app: INestApplication;
  let db: MemoryCanvaDatabase;
  let credentials: MemoryCredentialStore;
  let queue: MemoryRevocationQueue;
  const principal = { stillAuthorized: vi.fn(async () => true) };
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Network access is not allowed in tests');
      }),
    );
    db = new MemoryCanvaDatabase();
    credentials = new MemoryCredentialStore(db);
    queue = new MemoryRevocationQueue(db);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .overrideProvider(CANVA_OAUTH_ATTEMPT_STORE)
      .useValue(new MemoryAttemptStore(db))
      .overrideProvider(CANVA_CREDENTIAL_STORE)
      .useValue(credentials)
      .overrideProvider(CANVA_REVOCATION_QUEUE)
      .useValue(queue)
      .overrideProvider(CANVA_PRINCIPAL_CHECK)
      .useValue(principal)
      .overrideProvider(CANVA_FETCH)
      .useValue(canvaFetch)
      .overrideProvider(CANVA_CLOCK)
      .useValue(() => db.now())
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    const jwt = app.get(JwtService);
    for (const [sid, session] of Object.entries(sessions))
      tokens[sid] = await jwt.signAsync({ sub: session.userId, sid });
  });

  afterAll(async () => {
    await app?.close();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    for (const [name, value] of Object.entries(env.saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  beforeEach(() => {
    // A fresh organization state for every test.
    db.connections.clear();
    db.attempts.clear();
    db.candidates.clear();
    db.credentials.clear();
    db.accounts.clear();
    db.queue.length = 0;
    db.audit.length = 0;
    account = defaultAccount();
    canvaFetch.mockClear();
    principal.stillAuthorized.mockClear();
  });

  const server = () => app.getHttpServer();
  const as = (sid: string) => ({ Authorization: `Bearer ${tokens[sid]}` });

  // authorize (JWT) → launch (form POST) → what the browser holds.
  async function launched(sid = 'session-1') {
    const started = await request(server())
      .post(`${BASE}/oauth/authorize`)
      .set(as(sid))
      .expect(200);
    expect(Object.keys(started.body).sort()).toEqual([
      'expiresAt',
      'launchToken',
      'launchUrl',
    ]);
    const launch = await request(server())
      .post(`${BASE}/oauth/launch`)
      .type('form')
      .send({ launch_token: started.body.launchToken })
      .expect(303);
    const location = new URL(launch.headers.location);
    expect(location.origin + location.pathname).toBe(
      'https://www.canva.com/api/oauth/authorize',
    );
    const cookie = /adflow_canva_oauth_binding=([^;]+)/.exec(
      String(launch.headers['set-cookie']),
    )![1];
    return { state: location.searchParams.get('state')!, cookie };
  }

  // Canva's redirect back, in the same browser.
  async function callback(
    flow: { state: string; cookie: string },
    query: Record<string, string> = { code: 'fake-authorization-code' },
  ): Promise<string | null> {
    const response = await request(server())
      .get(`${BASE}/oauth/callback`)
      .set('Cookie', `adflow_canva_oauth_binding=${flow.cookie}`)
      .query({ state: flow.state, ...query })
      .expect(303);
    const destination = new URL(response.headers.location);
    expect(destination.origin).toBe('http://localhost:5173');
    return destination.searchParams.get('canva');
  }

  const status = async () =>
    (
      await request(server())
        .get(`${BASE}/status`)
        .set(as('session-1'))
        .expect(200)
    ).body;
  const candidate = (sid = 'session-1') =>
    request(server()).get(`${BASE}/oauth/candidate`).set(as(sid));
  const confirm = (body: unknown, sid = 'session-1') =>
    request(server())
      .post(`${BASE}/oauth/candidate/confirm`)
      .set(as(sid))
      .send(body as object);

  // Nothing the web app receives may carry a token, code, or verifier.
  function expectNoSecrets(body: unknown) {
    const text = JSON.stringify(body);
    for (const secret of [
      ...issuedTokens,
      'fake-authorization-code',
      'test-only-client-secret-value',
      env.values.CANVA_TOKEN_ENCRYPTION_KEY,
      'UAFcanvaUserAlpha01',
      'UAFcanvaTeamBeta02',
    ])
      expect(text).not.toContain(secret);
    expect(text).not.toMatch(/refresh|ciphertext|verifier|accessToken/i);
  }

  it('keeps the shared outcome type identical to the API’s', () => {
    expectTypeOf<SharedCanvaOAuthOutcome>().toEqualTypeOf<CanvaOAuthOutcome>();
  });

  it('stores a candidate at the callback, activates only on explicit confirmation, and never exposes tokens', async () => {
    const outcome = await callback(await launched());
    expect(outcome).toBe('pending_confirmation');
    // The callback alone never connects.
    expect(db.credentials.size).toBe(0);
    expect(await status()).toMatchObject({
      mode: 'CANVA',
      status: 'DISCONNECTED',
      isRealConnection: false,
    });

    const pending = await candidate().expect(200);
    const body = pending.body as CanvaPendingCandidate;
    expect(body).toMatchObject({
      canvaDisplayName: 'Brand Studio',
      canvaUserId: '…lpha01',
      canvaTeamId: '…Beta02',
      capabilities: { autofill: true, brandTemplate: true },
      scopes: { reported: true, missing: [] },
      warnings: [],
    });
    expectNoSecrets(body);

    const confirmed = await confirm({ candidateId: body.id }).expect(200);
    expect(confirmed.body).toEqual({
      status: 'CONNECTED',
      replacedPrevious: false,
      sameCanvaUser: false,
    });
    expectNoSecrets(confirmed.body);
    const connected = await status();
    expect(connected).toMatchObject({
      status: 'CONNECTED',
      isRealConnection: true,
      canva: { pendingRevocations: 0, exhaustedRevocations: 0 },
    });
    expectNoSecrets(connected);
    expect(db.actions()).toEqual([
      'canva.oauth.started',
      'canva.oauth.pending_confirmation',
      'canva.connection.connected',
    ]);
    // No revocation was requested anywhere in the flow.
    expect(
      canvaFetch.mock.calls.some(([url]) => String(url).includes('revoke')),
    ).toBe(false);
  });

  it('never lets request input choose a redirect destination', async () => {
    const started = await request(server())
      .post(`${BASE}/oauth/authorize`)
      .set(as('session-1'))
      .set('Host', 'evil.example')
      .set('X-Forwarded-Host', 'evil.example')
      .expect(200);
    // The launch URL comes from CANVA_REDIRECT_URI, not request headers.
    expect(started.body.launchUrl).toBe(
      'http://127.0.0.1:3000/api/v1/integrations/canva/oauth/launch',
    );
    const launch = await request(server())
      .post(`${BASE}/oauth/launch`)
      .set('Host', 'evil.example')
      .set('X-Forwarded-Host', 'evil.example')
      .type('form')
      .send({
        launch_token: started.body.launchToken,
        redirect_uri: 'https://evil.example/steal',
        return_to: 'https://evil.example/',
      })
      .expect(303);
    const canva = new URL(launch.headers.location);
    expect(canva.origin).toBe('https://www.canva.com');
    expect(canva.searchParams.get('redirect_uri')).toBe(
      env.values.CANVA_REDIRECT_URI,
    );
    // Host-only cookie: no Domain attribute a header could have widened.
    expect(String(launch.headers['set-cookie'])).not.toMatch(/Domain=/i);
    const cookie = /adflow_canva_oauth_binding=([^;]+)/.exec(
      String(launch.headers['set-cookie']),
    )![1];
    const response = await request(server())
      .get(`${BASE}/oauth/callback`)
      .set('Host', 'evil.example')
      .set('Cookie', `adflow_canva_oauth_binding=${cookie}`)
      .query({
        state: canva.searchParams.get('state')!,
        error: 'access_denied',
        redirect_uri: 'https://evil.example/',
        return_to: '//evil.example',
        next: 'https://evil.example/',
      })
      .expect(303);
    expect(response.headers.location).toBe(
      'http://localhost:5173/?canva=denied#canva-integration',
    );
    // A forged state without the cookie also lands on the fixed origin.
    const forged = await request(server())
      .get(`${BASE}/oauth/callback`)
      .query({
        state: 'S'.repeat(43),
        code: 'x',
        return_to: 'https://evil.example/',
      })
      .expect(303);
    expect(new URL(forged.headers.location).origin).toBe(
      'http://localhost:5173',
    );
  });

  it('keeps the candidate private to the administrator’s session', async () => {
    await callback(await launched('session-1'));
    const { id } = (await candidate().expect(200))
      .body as CanvaPendingCandidate;
    // Same administrator, another browser session.
    await candidate('session-2').expect(404);
    await confirm({ candidateId: id }, 'session-2').expect(404);
    await request(server())
      .post(`${BASE}/oauth/candidate/reject`)
      .set(as('session-2'))
      .send({ candidateId: id })
      .expect(404);
    // A user who can read the status but not manage the integration.
    await candidate('session-3').expect(403);
    await confirm({ candidateId: id }, 'session-3').expect(403);
    expect(db.candidates.size).toBe(1);
    expect(db.credentials.size).toBe(0);
  });

  it('requires an acknowledgement for a different Canva account, and queues the replaced grant', async () => {
    db.seedCredential({
      organizationId: 'org-1',
      connectedById: 'user-1',
      accessToken: { keyVersion: 1, iv: 'a', ciphertext: 'b', tag: 'c' },
      refreshToken: { keyVersion: 1, iv: 'd', ciphertext: 'e', tag: 'f' },
      accessTokenExpiresAt: db.now(),
      scopes: [],
      canvaUserId: 'UAFpreviousUser01',
      canvaTeamId: 'UAFpreviousTeam01',
      chainId: 'chain-previous',
      writeId: 'write-previous',
    });
    expect(await callback(await launched())).toBe('pending_confirmation');
    const body = (await candidate().expect(200)).body as CanvaPendingCandidate;
    expect(body.warnings).toEqual(['differentAccount']);
    const refused = await confirm({ candidateId: body.id }).expect(400);
    expect(refused.body.message).toBe(
      'Confirm each warning before connecting this Canva account',
    );
    // The candidate is kept, and the old credential is untouched.
    expect(db.candidates.size).toBe(1);
    expect(db.credentials.get('org-1')?.chainId).toBe('chain-previous');
    await confirm({
      candidateId: body.id,
      acknowledgements: { differentAccount: true },
    }).expect(200);
    expect(db.queue).toMatchObject([
      { reason: 'replaced_other_user', canvaUserId: 'UAFpreviousUser01' },
    ]);
  });

  it('requires acknowledgements when the display name and scopes are missing', async () => {
    account.displayName = null;
    account.scope = undefined;
    expect(await callback(await launched())).toBe('pending_confirmation');
    const body = (await candidate().expect(200)).body as CanvaPendingCandidate;
    expect(body).toMatchObject({
      canvaDisplayName: null,
      scopes: { reported: false },
      warnings: ['missingDisplayName', 'scopesNotReported'],
    });
    await confirm({
      candidateId: body.id,
      acknowledgements: { missingDisplayName: true },
    }).expect(400);
    await confirm({
      candidateId: body.id,
      acknowledgements: { missingDisplayName: true, scopesNotReported: true },
    }).expect(200);
  });

  it('expires an unconfirmed candidate after 10 minutes and queues its tokens', async () => {
    await callback(await launched());
    const { id } = (await candidate().expect(200))
      .body as CanvaPendingCandidate;
    db.advance(10 * 60_000 + 1);
    await candidate().expect(404);
    await confirm({ candidateId: id }).expect(404);
    expect(db.credentials.size).toBe(0);
    expect(db.queue).toMatchObject([{ reason: 'candidate_expired' }]);
  });

  it('expires an attempt whose callback arrives too late, before any token exchange', async () => {
    const flow = await launched();
    db.advance(10 * 60_000 + 1);
    expect(await callback(flow)).toBe('expired_or_used');
    expect(canvaFetch).not.toHaveBeenCalled();
    // A replay of the same state is also refused.
    expect(await callback(flow)).toBe('expired_or_used');
  });

  it('reports denied consent without exchanging anything', async () => {
    expect(await callback(await launched(), { error: 'access_denied' })).toBe(
      'denied',
    );
    expect(canvaFetch).not.toHaveBeenCalled();
    await candidate().expect(404);
  });

  it('refuses an account held by another organization and discards its tokens', async () => {
    db.accounts.set('UAFcanvaUserAlpha01', 'org-elsewhere');
    expect(await callback(await launched())).toBe('account_unavailable');
    expect(db.candidates.size).toBe(0);
    expect(db.queue).toHaveLength(0);
    await candidate().expect(404);
  });

  it('refuses an account without the required capabilities and queues its tokens', async () => {
    account.capabilities = ['brand_template'];
    expect(await callback(await launched())).toBe('account_ineligible');
    expect(db.candidates.size).toBe(0);
    expect(db.queue).toMatchObject([{ reason: 'connect_ineligible' }]);
  });

  it('reports a Canva identity outage as unavailable and keeps nothing', async () => {
    account.identityStatus = 503;
    expect(await callback(await launched())).toBe('unavailable');
    expect(db.candidates.size).toBe(0);
    // Identity unknown: never queued, because the guard cannot apply.
    expect(db.queue).toHaveLength(0);
  });

  it('refuses a callback whose administrator lost access before the exchange', async () => {
    principal.stillAuthorized.mockResolvedValueOnce(false);
    expect(await callback(await launched())).toBe('not_authorized');
    expect(canvaFetch).not.toHaveBeenCalled();
  });

  it('answers 409 when the connection changed while the candidate was pending, and queues its tokens', async () => {
    await callback(await launched());
    const { id } = (await candidate().expect(200))
      .body as CanvaPendingCandidate;
    db.connection('org-1').connectionGeneration += 1;
    await confirm({ candidateId: id }).expect(409);
    expect(db.credentials.size).toBe(0);
    expect(db.queue).toMatchObject([{ reason: 'connect_conflict' }]);
  });

  it('keeps the candidate when the confirmation cannot be saved', async () => {
    await callback(await launched());
    const { id } = (await candidate().expect(200))
      .body as CanvaPendingCandidate;
    credentials.activateCandidate.mockRejectedValueOnce(
      new CanvaPersistenceError(),
    );
    const failed = await confirm({ candidateId: id }).expect(503);
    expect(failed.body.message).toBe(
      'The Canva change was not saved; try again',
    );
    expect(db.candidates.size).toBe(1);
    await confirm({ candidateId: id }).expect(200);
  });

  it('rejects a candidate and queues its tokens', async () => {
    await callback(await launched());
    const { id } = (await candidate().expect(200))
      .body as CanvaPendingCandidate;
    await request(server())
      .post(`${BASE}/oauth/candidate/reject`)
      .set(as('session-1'))
      .send({ candidateId: id })
      .expect(200, { rejected: true });
    expect(db.queue).toMatchObject([{ reason: 'candidate_rejected' }]);
    await candidate().expect(404);
  });

  it('lists exhausted revocations without ciphertext and scopes retry and dismiss to the organization', async () => {
    for (const organizationId of ['org-1', 'org-other']) {
      db.enqueue({
        organizationId,
        chainId: `chain-${organizationId}`,
        canvaUserId: `UAF${organizationId}`,
        reason: 'disconnect',
        refreshToken: {
          keyVersion: 1,
          iv: 'iv',
          ciphertext: 'secret-ciphertext',
          tag: 'tag',
        },
      });
      Object.assign(db.queue.at(-1)!, { state: 'exhausted', attempts: 8 });
    }
    const listed = await request(server())
      .get(`${BASE}/revocations`)
      .set(as('session-1'))
      .expect(200);
    expect(listed.body).toEqual([
      expect.objectContaining({
        id: 'revocation-1',
        reason: 'disconnect',
        attempts: 8,
      }),
    ]);
    expect(JSON.stringify(listed.body)).not.toMatch(/secret-ciphertext|UAF/);
    await request(server())
      .post(`${BASE}/revocations/revocation-2/dismiss`)
      .set(as('session-1'))
      .expect(404);
    await request(server())
      .post(`${BASE}/revocations/revocation-1/retry`)
      .set(as('session-1'))
      .expect(200, { state: 'queued' });
    await request(server())
      .get(`${BASE}/revocations`)
      .set(as('session-3'))
      .expect(403);
  });

  it('disconnects by queuing the tokens, never revoking inline', async () => {
    await callback(await launched());
    const { id } = (await candidate().expect(200))
      .body as CanvaPendingCandidate;
    await confirm({ candidateId: id }).expect(200);
    const response = await request(server())
      .post(`${BASE}/disconnect`)
      .set(as('session-1'))
      .expect(201);
    expect(response.body).toMatchObject({
      status: 'DISCONNECTED',
      revocation: 'queued',
    });
    expect(db.queue).toMatchObject([{ reason: 'disconnect' }]);
    expect(
      canvaFetch.mock.calls.some(([url]) => String(url).includes('revoke')),
    ).toBe(false);
  });
});
