import { createHash, randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { CanvaAccessTokenService } from '../canva/oauth/canva-access-token.service';
import { PrismaCanvaCredentialStore } from '../canva/oauth/canva-credential.prisma-store';
import { CanvaIdentityClient } from '../canva/oauth/canva-identity.client';
import { PrismaCanvaOAuthAttemptStore } from '../canva/oauth/canva-oauth-attempt.prisma-store';
import {
  CANVA_OAUTH_CALLBACK_PATH,
  parseCanvaEnvironment,
  type CanvaOAuthConfig,
} from '../canva/oauth/canva-oauth.config';
import type { CanvaTransactionRunner } from '../canva/oauth/canva-prisma.transaction';
import { PrismaCanvaResealStore } from '../canva/oauth/canva-reseal.prisma-store';
import { PrismaCanvaRevocationQueue } from '../canva/oauth/canva-revocation.prisma-store';
import { CanvaRevocationWorker } from '../canva/oauth/canva-revocation.worker';
import { CanvaTokenKeyring } from '../canva/oauth/canva-token-cipher';
import { CanvaTokenResealService } from '../canva/oauth/canva-token-reseal.service';
import {
  CanvaTokenClient,
  type CanvaFetch,
} from '../canva/oauth/canva-token.client';

// Actors, pause points, the fake Canva, and the extended invariant checker
// for the Canva OAuth PostgreSQL gates (§10.1 of
// docs/integrations/canva-oauth-persistence-proposal.md). Used only by
// *.pg.spec.ts files; nothing here connects anywhere by itself. None of it
// has been run against PostgreSQL yet.

// ---------------------------------------------------------------------------
// Deferred values
// ---------------------------------------------------------------------------

export type Deferred<T = void> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  settled: () => boolean;
};

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let done = false;
  const promise = new Promise<T>((settle) => {
    resolve = (value: T) => {
      done = true;
      settle(value);
    };
  });
  return { promise, resolve, settled: () => done };
}

// ---------------------------------------------------------------------------
// Pause points at the store boundary
// ---------------------------------------------------------------------------

function sqlText(args: unknown[]): string {
  const [first, ...rest] = args;
  const sql = Array.isArray(first)
    ? Prisma.sql(first as unknown as TemplateStringsArray, ...rest)
    : (first as Prisma.Sql);
  return sql.text.replace(/\s+/g, ' ').trim();
}

type PausePoint = {
  // after: right after a matching statement returned, so its locks are
  // held. before-commit: at the end of a transaction body in which a
  // statement matched, before COMMIT is sent.
  kind: 'after' | 'before-commit';
  match: RegExp;
  reached: Deferred;
  release: Deferred;
};

// Named pause points, matched against the SQL a store sends. A test waits
// for `reached(name)`, acts (usually confirming a lock wait through the
// observer), then calls `release(name)`. Each point fires once. Tests never
// sleep to create an ordering.
export class PausePoints {
  private readonly points = new Map<string, PausePoint>();

  after(name: string, match: RegExp): this {
    this.points.set(name, {
      kind: 'after',
      match,
      reached: deferred(),
      release: deferred(),
    });
    return this;
  }

  beforeCommit(name: string, match: RegExp): this {
    this.points.set(name, {
      kind: 'before-commit',
      match,
      reached: deferred(),
      release: deferred(),
    });
    return this;
  }

  reached(name: string): Promise<void> {
    return this.point(name).reached.promise;
  }

  release(name: string): void {
    this.point(name).release.resolve();
  }

  releaseAll(): void {
    for (const point of this.points.values()) point.release.resolve();
  }

  private point(name: string): PausePoint {
    const point = this.points.get(name);
    if (!point) throw new Error(`No pause point ${name}`);
    return point;
  }

  async onStatement(text: string, seen: string[]): Promise<void> {
    seen.push(text);
    for (const point of this.points.values())
      if (
        point.kind === 'after' &&
        !point.reached.settled() &&
        point.match.test(text)
      ) {
        point.reached.resolve();
        await point.release.promise;
      }
  }

  async onBeforeCommit(seen: string[]): Promise<void> {
    for (const point of this.points.values())
      if (
        point.kind === 'before-commit' &&
        !point.reached.settled() &&
        seen.some((text) => point.match.test(text))
      ) {
        point.reached.resolve();
        await point.release.promise;
      }
  }
}

// Wraps an actor's client so its stores pause at the named points. Every
// other member of the client and of each transaction passes through.
export function pausingRunner(
  client: PrismaClient,
  points: PausePoints,
): CanvaTransactionRunner {
  const watch = <T extends object>(target: T, seen: string[]): T =>
    new Proxy(target, {
      get(object, property, receiver) {
        const value = Reflect.get(object, property, receiver);
        if (property !== '$queryRaw' && property !== '$executeRaw')
          return typeof value === 'function' ? value.bind(object) : value;
        return async (...args: unknown[]) => {
          const result = await (value as (...a: unknown[]) => unknown).apply(
            object,
            args,
          );
          await points.onStatement(sqlText(args), seen);
          return result;
        };
      },
    });
  const outside = watch(client, []);
  return new Proxy(outside, {
    get(object, property, receiver) {
      if (property !== '$transaction')
        return Reflect.get(object, property, receiver);
      return (
        body: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options?: Parameters<CanvaTransactionRunner['$transaction']>[1],
      ) =>
        client.$transaction(async (tx) => {
          const seen: string[] = [];
          const value = await body(watch(tx, seen));
          await points.onBeforeCommit(seen);
          return value;
        }, options);
    },
  }) as unknown as CanvaTransactionRunner;
}

// ---------------------------------------------------------------------------
// The fake Canva
// ---------------------------------------------------------------------------

export type FakeCanvaEndpoint =
  'token' | 'revoke' | 'me' | 'capabilities' | 'profile';

export type FakeCanvaBehavior =
  | { kind: 'normal' }
  | { kind: 'status'; status: number; body?: unknown; retryAfter?: number }
  // The request is received and held until released (with a behavior).
  | { kind: 'hold'; held: Deferred<FakeCanvaBehavior>; arrived: Deferred }
  // No response: the client sees a network failure (ambiguous outcome).
  | { kind: 'drop' };

export type FakeCanvaRequest = {
  endpoint: FakeCanvaEndpoint;
  tokenHash: string;
  canvaUserId: string | undefined;
  at: number;
};

const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex').slice(0, 16);

const ENDPOINTS: Record<string, FakeCanvaEndpoint> = {
  '/rest/v1/oauth/token': 'token',
  '/rest/v1/oauth/revoke': 'revoke',
  '/rest/v1/users/me': 'me',
  '/rest/v1/users/me/capabilities': 'capabilities',
  '/rest/v1/users/me/profile': 'profile',
};

// An in-process stand-in for api.canva.com, reached only through the
// injected CanvaFetch: any other host throws. It issues random tokens per
// Canva user, rotates refresh tokens exactly once (a reused refresh token
// gets invalid_grant), records every request with a token hash, and can
// hold, fail, or drop the next response of an endpoint.
export class FakeCanva {
  readonly requests: FakeCanvaRequest[] = [];
  private readonly owners = new Map<string, string>();
  private readonly spent = new Set<string>();
  private readonly codes = new Map<string, string>();
  private readonly next = new Map<FakeCanvaEndpoint, FakeCanvaBehavior[]>();
  // Behaviors for one Canva user's requests, used before the shared queue.
  // A worker batch processes its claimed rows in an order PostgreSQL does
  // not guarantee (UPDATE ... RETURNING), so a gate that scripts several
  // rows' responses must key them by user, not by arrival order.
  private readonly perUser = new Map<string, FakeCanvaBehavior[]>();
  // Runs when a revoke arrives, before it is answered (INV-6 checks).
  onRevoke: ((canvaUserId: string | undefined) => Promise<void>) | null = null;

  // Every token value it has handed out, for the INV-7 scan.
  get issuedSecrets(): string[] {
    return [...this.owners.keys(), ...this.codes.keys()];
  }

  issue(canvaUserId: string): { accessToken: string; refreshToken: string } {
    const accessToken = `fake-access-${randomBytes(12).toString('hex')}`;
    const refreshToken = `fake-refresh-${randomBytes(12).toString('hex')}`;
    this.owners.set(accessToken, canvaUserId);
    this.owners.set(refreshToken, canvaUserId);
    return { accessToken, refreshToken };
  }

  // An authorization code that the token endpoint exchanges for this user.
  code(canvaUserId: string): string {
    const code = `fake-code-${randomBytes(12).toString('hex')}`;
    this.codes.set(code, canvaUserId);
    return code;
  }

  owner(token: string): string | undefined {
    return this.owners.get(token);
  }

  respond(endpoint: FakeCanvaEndpoint, behavior: FakeCanvaBehavior): void {
    this.next.set(endpoint, [...(this.next.get(endpoint) ?? []), behavior]);
  }

  // The next response of an endpoint for one Canva user's token.
  respondFor(
    endpoint: FakeCanvaEndpoint,
    canvaUserId: string,
    behavior: FakeCanvaBehavior,
  ): void {
    const key = `${endpoint}|${canvaUserId}`;
    this.perUser.set(key, [...(this.perUser.get(key) ?? []), behavior]);
  }

  // Holds the next response of an endpoint until the test releases it.
  hold(endpoint: FakeCanvaEndpoint): {
    arrived: Promise<void>;
    release: (behavior?: FakeCanvaBehavior) => void;
  } {
    const held = deferred<FakeCanvaBehavior>();
    const arrived = deferred();
    this.respond(endpoint, { kind: 'hold', held, arrived });
    return {
      arrived: arrived.promise,
      release: (behavior = { kind: 'normal' }) => held.resolve(behavior),
    };
  }

  count(endpoint: FakeCanvaEndpoint, canvaUserId?: string): number {
    return this.requests.filter(
      (request) =>
        request.endpoint === endpoint &&
        (canvaUserId === undefined || request.canvaUserId === canvaUserId),
    ).length;
  }

  readonly fetch: CanvaFetch = async (url, init) => {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.hostname !== 'api.canva.com')
      throw new Error(`The fake Canva refuses ${target.hostname}`);
    const endpoint = ENDPOINTS[target.pathname];
    if (!endpoint) throw new Error(`Unknown Canva endpoint ${target.pathname}`);
    const form = new URLSearchParams(
      typeof init.body === 'string' ? init.body : '',
    );
    const bearer = String(
      (init.headers as Record<string, string> | undefined)?.Authorization ?? '',
    ).replace(/^Bearer /, '');
    const token =
      form.get('refresh_token') ??
      form.get('token') ??
      form.get('code') ??
      bearer;
    const canvaUserId = this.owners.get(token) ?? this.codes.get(token);
    this.requests.push({
      endpoint,
      tokenHash: hashToken(token),
      canvaUserId,
      at: Date.now(),
    });
    if (endpoint === 'revoke') await this.onRevoke?.(canvaUserId);
    let behavior = (canvaUserId
      ? this.perUser.get(`${endpoint}|${canvaUserId}`)?.shift()
      : undefined) ??
      this.next.get(endpoint)?.shift() ?? { kind: 'normal' };
    if (behavior.kind === 'hold') {
      behavior.arrived.resolve();
      behavior = await behavior.held.promise;
    }
    if (behavior.kind === 'drop') throw new Error('connection reset');
    if (behavior.kind === 'status')
      return this.json(
        behavior.status,
        behavior.body ?? {},
        behavior.retryAfter,
      );
    return this.normal(endpoint, form, token, canvaUserId);
  };

  private normal(
    endpoint: FakeCanvaEndpoint,
    form: URLSearchParams,
    token: string,
    canvaUserId: string | undefined,
  ): Response {
    switch (endpoint) {
      case 'token': {
        // Each refresh token and code can be used once.
        if (!canvaUserId || this.spent.has(token))
          return this.json(400, { error: 'invalid_grant' });
        this.spent.add(token);
        const issued = this.issue(canvaUserId);
        return this.json(200, {
          access_token: issued.accessToken,
          refresh_token: issued.refreshToken,
          token_type: 'Bearer',
          expires_in: 14_400,
          scope:
            'brandtemplate:meta:read brandtemplate:content:read design:content:write profile:read',
        });
      }
      case 'revoke':
        if (!canvaUserId)
          return this.json(400, { error: 'bad_request_params' });
        this.spent.add(token);
        return this.json(200, {});
      case 'me':
        return canvaUserId
          ? this.json(200, {
              team_user: {
                user_id: canvaUserId,
                team_id: `team-${canvaUserId}`,
              },
            })
          : this.json(401, { code: 'invalid_access_token' });
      case 'capabilities':
        return this.json(200, { capabilities: ['autofill', 'brand_template'] });
      case 'profile':
        return this.json(200, {
          profile: { display_name: `Gate ${canvaUserId}` },
        });
    }
    return this.json(500, {});
  }

  private json(status: number, body: unknown, retryAfter?: number): Response {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (retryAfter !== undefined) headers['retry-after'] = String(retryAfter);
    return new Response(JSON.stringify(body), { status, headers });
  }
}

// ---------------------------------------------------------------------------
// Real services on one actor connection
// ---------------------------------------------------------------------------

// Real-mode configuration with per-run test keys. The client values are
// placeholders; no request can leave the process (FakeCanva.fetch).
export function gateConfig(
  keyring = new CanvaTokenKeyring({ version: 1, key: randomBytes(32) }),
): Extract<CanvaOAuthConfig, { mode: 'canva' }> {
  const config = parseCanvaEnvironment({
    CANVA_PROVIDER_MODE: 'canva',
    CANVA_CLIENT_ID: 'OC-gate-client-id',
    CANVA_CLIENT_SECRET: 'gate-only-client-secret-value',
    CANVA_REDIRECT_URI: `http://127.0.0.1:3000${CANVA_OAUTH_CALLBACK_PATH}`,
    CANVA_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  });
  if (config.mode !== 'canva') throw new Error('expected canva mode');
  return { ...config, keyring, persistence: true, revocationWorker: true };
}

export type GateClock = { now: () => Date; monotonic: () => number };

export function gateServices(
  client: PrismaClient,
  options: {
    fake: FakeCanva;
    config: Extract<CanvaOAuthConfig, { mode: 'canva' }>;
    points?: PausePoints;
    clock?: Partial<GateClock>;
    audit?: AuditService;
  },
) {
  const runner = options.points
    ? pausingRunner(client, options.points)
    : (client as unknown as CanvaTransactionRunner);
  const audit =
    options.audit ?? new AuditService(client as unknown as PrismaService);
  const now = options.clock?.now ?? (() => new Date());
  const tokens = new CanvaTokenClient(options.config, options.fake.fetch);
  const queue = new PrismaCanvaRevocationQueue(runner, audit);
  const credentials = new PrismaCanvaCredentialStore(runner, audit, {
    sleep: async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
  });
  const worker = new CanvaRevocationWorker(options.config, queue, tokens, {
    monotonic: options.clock?.monotonic ?? (() => performance.now()),
    random: () => 0.5,
  });
  const identity = new CanvaIdentityClient(options.config, options.fake.fetch);
  return {
    runner,
    attempts: new PrismaCanvaOAuthAttemptStore(runner, audit),
    credentials,
    queue,
    tokens,
    worker,
    identity,
    // The services' automatic triggers (fire-and-forget worker runs after
    // queuing) are inert in gates: a gate runs the worker explicitly, at the
    // point its scenario requires. A background run would share the actor's
    // single connection with the actor's own next steps and race the
    // gate's explicit runs (first Stage 2.5 run: a 15-second stall and
    // "revocation result not confirmed" warnings in gates 4 and 6).
    accessTokens: new CanvaAccessTokenService(
      options.config,
      credentials,
      tokens,
      now,
      identity,
      { trigger: () => undefined } as unknown as CanvaRevocationWorker,
    ),
    reseal: new CanvaTokenResealService(
      options.config,
      new PrismaCanvaResealStore(runner, audit),
    ),
  };
}

// An audit service whose writes fail, for gate 7.
export function failingAudit(): AuditService {
  return {
    write: async () => {
      throw new Error('audit write failed (gate 7)');
    },
  } as unknown as AuditService;
}

// ---------------------------------------------------------------------------
// Extended invariant checker (§10.1)
// ---------------------------------------------------------------------------

export type InvariantReport = { violations: string[]; notes: string[] };

// INV-2, INV-4, INV-6 (database part), and INV-7. INV-1, INV-3, and INV-5
// are in checkInvariants (canva-gate-harness.ts). INV-6's revoke-time part
// is checked by revokeTimeGuard below.
export async function checkExtendedInvariants(
  client: PrismaClient,
  secrets: string[],
): Promise<InvariantReport> {
  const report: InvariantReport = { violations: [], notes: [] };
  const stale = await client.$queryRaw<Array<{ canvaUserId: string }>>`
    SELECT a."canvaUserId" FROM "canva_accounts" a
    WHERE a."organizationId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "canva_credentials" c WHERE c."canvaUserId" = a."canvaUserId")
      AND NOT EXISTS (SELECT 1 FROM "canva_connection_candidates" d WHERE d."canvaUserId" = a."canvaUserId")`;
  // Stale holds are safe (they only refuse) and swept; reported, not failed.
  if (stale.length) report.notes.push(`INV-2: ${stale.length} stale hold(s)`);
  const duplicates = await client.$queryRaw<Array<{ n: number }>>`
    SELECT (
      (SELECT count(*) FROM (SELECT "organizationId" FROM "canva_credentials" GROUP BY 1 HAVING count(*) > 1) x) +
      (SELECT count(*) FROM (SELECT "canvaUserId" FROM "canva_credentials" GROUP BY 1 HAVING count(*) > 1) x) +
      (SELECT count(*) FROM (SELECT "organizationId" FROM "canva_connection_candidates" GROUP BY 1 HAVING count(*) > 1) x) +
      (SELECT count(*) FROM (SELECT "canvaUserId" FROM "canva_connection_candidates" GROUP BY 1 HAVING count(*) > 1) x)
    )::int AS "n"`;
  if (duplicates[0]?.n)
    report.violations.push('INV-4: duplicate credential or candidate');
  // A candidate created after a revocation call for its user started must
  // have been launched after that call's possible-effect window.
  const windows = await client.$queryRaw<Array<{ id: string }>>`
    SELECT d."id" FROM "canva_connection_candidates" d
    JOIN "canva_oauth_attempts" a ON a."id" = d."attemptId"
    JOIN "canva_pending_revocations" r ON r."canvaUserId" = d."canvaUserId"
    WHERE r."callStartedAt" IS NOT NULL AND r."callStartedAt" <= d."createdAt"
      AND (r."state" = 'in_flight' OR r."possibleEffectUntil" IS NULL
           OR a."launchedAt" < r."possibleEffectUntil")`;
  if (windows.length)
    report.violations.push(
      'INV-6: a candidate was created inside a revocation window',
    );
  const audit = await client.$queryRaw<Array<{ metadata: string }>>`
    SELECT "metadata"::text AS "metadata" FROM "audit_logs"`;
  const leaked = audit.filter(({ metadata }) =>
    secrets.some((secret) => secret && metadata.includes(secret)),
  );
  if (leaked.length)
    report.violations.push(
      'INV-7: a secret or Canva ID reached audit metadata',
    );
  return report;
}

// INV-6 at revoke time: when the fake receives a revoke for user U, no
// credential or candidate for U may exist (T1 committed in_flight first, so
// any later candidate for U must have been refused). Records violations.
export function revokeTimeGuard(
  fake: FakeCanva,
  observer: PrismaClient,
  violations: string[],
): void {
  fake.onRevoke = async (canvaUserId) => {
    if (!canvaUserId) return;
    const [row] = await observer.$queryRaw<Array<{ n: number }>>`
      SELECT (
        (SELECT count(*) FROM "canva_credentials" WHERE "canvaUserId" = ${canvaUserId}) +
        (SELECT count(*) FROM "canva_connection_candidates" WHERE "canvaUserId" = ${canvaUserId})
      )::int AS "n"`;
    if (row.n)
      violations.push(
        'INV-6: a revoke reached Canva while the user still had a grant',
      );
  };
}

// A seeded generator for the randomized gates (E, P), printed for replay.
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
