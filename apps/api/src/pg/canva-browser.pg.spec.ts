import http from 'node:http';
import net from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it, onTestFailed } from 'vitest';
import { AppModule } from '../app.module';
import { PERMISSIONS } from '../auth/permissions';
import { PrismaService } from '../prisma/prisma.service';
import {
  CANVA_AUTHORIZE_ENDPOINT,
  CANVA_OAUTH_CALLBACK_PATH,
} from '../canva/oauth/canva-oauth.config';
import { CANVA_FETCH } from '../canva/oauth/canva-token.client';
import { FakeCanva, checkExtendedInvariants } from './canva-gate-actors';
import {
  FakeAuthorizeServer,
  TempBrowserProfile,
  WebOriginStandIn,
  browserDriverInstalled,
  loadBrowserDriver,
  type BrowserSession,
} from './canva-browser-harness';
import {
  GateSchema,
  assertGateEnvironment,
  assertIsolatedServer,
  assertIsolatedUrl,
  checkInvariants,
  isolated,
  seedOwner,
  type GateOwner,
} from './canva-gate-harness';

// Gate G (§10.2): browser binding and confirmation, end to end, in real
// headless browsers with isolated temporary profiles.
//
// BLOCKED: no headless browser driver is installed. Until one is approved
// and installed (docs/integrations/canva.md, "Gate G"), this file registers
// a todo and does nothing. With a driver, it runs only in the `pg` project
// (ADFLOW_PG_TEST_URL and ADFLOW_PG_GATES=run) against the guarded isolated
// cluster, like every gate. It has never run.
//
// Topology, all on 127.0.0.1: the API (real AppModule, PostgreSQL stores on
// a gate schema, the fake Canva behind CANVA_FETCH, and the checked
// authorize-endpoint override pointing at the fake authorize page), the
// fake authorize page, and a stand-in for the web origin that posts the
// launch form exactly as the web app does. The test calls authenticated JSON
// endpoints itself (it holds the JWTs); browsers do only what browsers do:
// the launch form post, the redirects, and the callback with its cookie.

const OUTCOME = /[?&]canva=([a-z_]+)/;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

// JSON over loopback HTTP, without the global fetch.
function api(
  origin: string,
  method: 'GET' | 'POST',
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(
      `${origin}/api/v1${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (response) => {
        let text = '';
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
          }),
        );
      },
    );
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

// Gives a seeded owner the integration-management permission.
async function grantManage(client: PrismaClient, owner: GateOwner) {
  const role = `role-${owner.userId}`;
  await client.$executeRaw`
    INSERT INTO "roles" ("id", "organizationId", "name", "updatedAt")
    VALUES (${role}, ${owner.organizationId}, ${role}, now())`;
  await client.$executeRaw`
    INSERT INTO "permissions" ("id", "code")
    VALUES (${PERMISSIONS.CANVA_INTEGRATION_MANAGE}, ${PERMISSIONS.CANVA_INTEGRATION_MANAGE})
    ON CONFLICT ("code") DO NOTHING`;
  await client.$executeRaw`
    INSERT INTO "role_permissions" ("roleId", "permissionId")
    SELECT ${role}, "id" FROM "permissions" WHERE "code" = ${PERMISSIONS.CANVA_INTEGRATION_MANAGE}`;
  await client.$executeRaw`
    INSERT INTO "user_roles" ("userId", "roleId") VALUES (${owner.userId}, ${role})`;
}

async function until(condition: () => boolean, what: string) {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const withEnvironment = (values: Record<string, string>) => {
  const saved: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(values)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  return () => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  };
};

describe('Gate G: browser binding and confirmation (isolated test database)', () => {
  if (!browserDriverInstalled()) {
    it.todo(
      'Gate G: BLOCKED until the approved headless browser driver is installed (docs/integrations/canva.md, "Gate G")',
    );
    return;
  }

  it('Gate G: only the browser that launched can complete, and confirmation needs every acknowledgement', async () => {
    assertGateEnvironment(process.env);
    assertIsolatedUrl(isolated.url);
    const admin = new PrismaClient({ datasourceUrl: isolated.url });
    await assertIsolatedServer(admin);
    const driver = await loadBrowserDriver();
    if (!driver) throw new Error('Gate G: the browser driver did not load');
    const schema = await GateSchema.create(admin, 'g');
    let failed = false;
    onTestFailed(() => {
      failed = true;
    });
    const cleanups: Array<() => Promise<unknown> | unknown> = [];
    try {
      const setup = schema.actor('setup');
      await schema.prepare(setup);
      const victim = await seedOwner(setup, 'victim');
      const attacker = await seedOwner(setup, 'attacker');
      await grantManage(setup, victim);
      await grantManage(setup, attacker);

      const fake = new FakeCanva();
      let canvaUser = 'canva-g';
      const apiPort = await freePort();
      const apiOrigin = `http://127.0.0.1:${apiPort}`;
      const redirectUri = `${apiOrigin}${CANVA_OAUTH_CALLBACK_PATH}`;
      const authorize = await FakeAuthorizeServer.start({
        registeredRedirectUri: redirectUri,
        code: () => fake.code(canvaUser),
      });
      cleanups.push(() => authorize.close());
      const web = await WebOriginStandIn.start();
      cleanups.push(() => web.close());

      // Test-only placeholders; real mode with durable storage, worker off.
      const restore = withEnvironment({
        CANVA_PROVIDER_MODE: 'canva',
        CANVA_CLIENT_ID: 'OC-gate-g-client',
        CANVA_CLIENT_SECRET: 'gate-g-only-client-secret',
        CANVA_REDIRECT_URI: redirectUri,
        CANVA_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
        CANVA_OAUTH_PERSISTENCE_ENABLED: 'true',
        CANVA_REVOCATION_WORKER_ENABLED: 'false',
        WEB_ORIGIN: web.origin,
        JWT_ACCESS_SECRET: 'gate-g-only-jwt-secret-at-least-32-characters',
      });
      cleanups.push(restore);
      const apiClient = new PrismaClient({
        datasourceUrl: schema.actorUrl('api'),
      });
      await assertIsolatedServer(apiClient);
      cleanups.push(() => apiClient.$disconnect());
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(PrismaService)
        .useValue(apiClient)
        .overrideProvider(CANVA_FETCH)
        .useValue(fake.fetch)
        .overrideProvider(CANVA_AUTHORIZE_ENDPOINT)
        .useValue(authorize.url)
        .compile();
      const app: INestApplication = moduleRef.createNestApplication();
      app.setGlobalPrefix('api/v1');
      await app.listen(apiPort, '127.0.0.1');
      cleanups.push(() => app.close());
      const jwt = app.get(JwtService);
      const tokenOf = (owner: GateOwner) =>
        jwt.signAsync({ sub: owner.userId, sid: owner.sessionId });
      const victimToken = await tokenOf(victim);
      const attackerToken = await tokenOf(attacker);

      const profiles = [
        TempBrowserProfile.create(),
        TempBrowserProfile.create(),
      ];
      for (const profile of profiles) cleanups.push(() => profile.remove());
      const browserA = await driver.open(profiles[0]);
      cleanups.push(() => browserA.close());
      const browserB = await driver.open(profiles[1]);
      cleanups.push(() => browserB.close());

      // Starts a flow (JWT, as the web app does) and lets the browser post
      // the launch form. `host` replaces the launch URL's host.
      const launch = async (
        browser: BrowserSession,
        token: string,
        host = '127.0.0.1',
      ) => {
        const started = await api(
          apiOrigin,
          'POST',
          '/integrations/canva/oauth/authorize',
          token,
        );
        expect(started.status).toBe(200);
        const launchUrl = new URL(String(started.body.launchUrl));
        launchUrl.hostname = host;
        await browser.goto(
          web.prepare(launchUrl.toString(), String(started.body.launchToken)),
        );
      };
      const outcome = async (browser: BrowserSession) =>
        OUTCOME.exec(await browser.waitForUrl(OUTCOME))?.[1];
      const capture = async (browser: BrowserSession, token: string) => {
        authorize.mode = 'capture';
        const before = authorize.captured.length;
        await launch(browser, token);
        await until(
          () => authorize.captured.length > before,
          'the captured callback',
        );
        authorize.mode = 'redirect';
        return authorize.captured[authorize.captured.length - 1];
      };
      const candidate = (token: string) =>
        api(apiOrigin, 'GET', '/integrations/canva/oauth/candidate', token);
      const reject = async (token: string) => {
        const pending = await candidate(token);
        if (pending.status === 200)
          await api(
            apiOrigin,
            'POST',
            '/integrations/canva/oauth/candidate/reject',
            token,
            {
              candidateId: pending.body.id,
            },
          );
      };
      const unconsumedLaunched = async () => {
        const [row] = await setup.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS "n" FROM "canva_oauth_attempts"
          WHERE "launchedAt" IS NOT NULL AND "consumedAt" IS NULL`;
        return row.n;
      };

      // (a) The normal flow reaches pending_confirmation, showing the
      // foreign display name to the starting session only.
      await launch(browserA, victimToken);
      expect(await outcome(browserA)).toBe('pending_confirmation');
      const pending = await candidate(victimToken);
      expect(pending.body.canvaDisplayName).toBe('Gate canva-g');
      expect((await candidate(attackerToken)).status).toBe(404);
      await reject(victimToken);

      // (b) A launch on the wrong host sets the cookie there; the callback
      // host never sees it, so nothing is consumed.
      const openBefore = await unconsumedLaunched();
      await launch(browserA, victimToken, 'localhost');
      expect(await outcome(browserA)).toBe('expired_or_used');
      expect(await unconsumedLaunched()).toBe(openBefore + 1);
      expect((await candidate(victimToken)).status).toBe(404);

      // (c) The victim's callback replayed in a second profile does
      // nothing; the original browser can still complete it.
      const victimCallback = await capture(browserA, victimToken);
      await browserB.goto(victimCallback);
      expect(await outcome(browserB)).toBe('expired_or_used');
      expect((await candidate(victimToken)).status).toBe(404);
      await browserA.goto(victimCallback);
      expect(await outcome(browserA)).toBe('pending_confirmation');
      await reject(victimToken);

      // (d) An attacker's callback injected into the victim's browser
      // matches nothing (wrong binding): no candidate for the victim, and
      // the attacker's own attempt is not burned by it.
      canvaUser = 'canva-attacker';
      const attackerCallback = await capture(browserB, attackerToken);
      canvaUser = 'canva-g';
      await capture(browserA, victimToken);
      await browserA.goto(attackerCallback);
      expect(await outcome(browserA)).toBe('expired_or_used');
      expect((await candidate(victimToken)).status).toBe(404);
      await browserB.goto(attackerCallback);
      expect(await outcome(browserB)).toBe('pending_confirmation');
      expect((await candidate(victimToken)).status).toBe(404);
      await reject(attackerToken);

      // (e) Confirmation requires every acknowledgement shown.
      fake.respond('profile', { kind: 'status', status: 500 });
      await launch(browserA, victimToken);
      expect(await outcome(browserA)).toBe('pending_confirmation');
      const unnamed = await candidate(victimToken);
      expect(unnamed.body.warnings).toEqual(['missingDisplayName']);
      const confirm = (acknowledgements: Record<string, boolean>) =>
        api(
          apiOrigin,
          'POST',
          '/integrations/canva/oauth/candidate/confirm',
          victimToken,
          {
            candidateId: unnamed.body.id,
            acknowledgements,
          },
        );
      expect((await confirm({})).status).toBe(400);
      expect((await confirm({ missingDisplayName: true })).status).toBe(200);

      expect(await checkInvariants(setup)).toEqual([]);
      const extended = await checkExtendedInvariants(setup, [
        ...fake.issuedSecrets,
        'canva-g',
        'canva-attacker',
      ]);
      expect(extended.violations).toEqual([]);
      expect(fake.count('revoke')).toBe(0);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      for (const cleanup of cleanups.reverse())
        await Promise.resolve()
          .then(cleanup)
          .catch(() => undefined);
      await schema.drop(failed);
      await admin.$disconnect();
    }
  });
});
