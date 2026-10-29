import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { CommitDropProxy } from './commit-drop-proxy';

// Harness for the Canva OAuth PostgreSQL gates (§10.1 of
// docs/integrations/canva-oauth-persistence-proposal.md). Used only by
// *.pg.spec.ts files, which run only in the `pg` Vitest project, which exists
// only when ADFLOW_PG_TEST_URL is set and ADFLOW_PG_GATES=run. Every check
// below runs before any write, and refuses anything but the isolated
// 127.0.0.1:55432 *_test database stamped with this run's marker.

export const isolated = {
  url: process.env.ADFLOW_PG_TEST_URL ?? '',
  marker: process.env.ADFLOW_PG_TEST_MARKER ?? '',
  dataDirectory: process.env.ADFLOW_PG_TEST_DATA_DIR ?? '',
  keepFailed: process.env.ADFLOW_GATE_KEEP === '1',
};

// The explicit opt-in, checked before any client is created: a stray
// ADFLOW_PG_TEST_URL alone, or a production process, never runs a gate.
export function assertGateEnvironment(environment: NodeJS.ProcessEnv): void {
  if (environment.NODE_ENV === 'production')
    throw new Error('Refusing to run: NODE_ENV is production');
  if (environment.ADFLOW_PG_GATES !== 'run')
    throw new Error('Refusing to run: ADFLOW_PG_GATES is not "run"');
}

export function assertIsolatedUrl(raw: string): void {
  if (!raw) throw new Error('Refusing to run: ADFLOW_PG_TEST_URL is not set');
  const url = new URL(raw);
  const database = url.pathname.replace(/^\//, '');
  const problems: string[] = [];
  if (!['postgresql:', 'postgres:'].includes(url.protocol))
    problems.push(`protocol ${url.protocol}`);
  if (url.hostname !== '127.0.0.1') problems.push(`host ${url.hostname}`);
  if (url.port !== '55432') problems.push(`port ${url.port || '(default)'}`);
  if (!database.endsWith('_test')) problems.push(`database ${database}`);
  // Connection parameters that would redirect the connection (another host,
  // a Unix socket, another port) while the URL still reads 127.0.0.1:55432.
  for (const name of ['host', 'hostaddr', 'port', 'socket'])
    if (url.searchParams.has(name)) problems.push(`parameter ${name}`);
  if (problems.length)
    throw new Error(
      `Refusing to run: not the isolated test database (${problems.join(', ')})`,
    );
}

// A disposable cluster listens on loopback only; a shared or production
// server does not.
const LOOPBACK_LISTEN = new Set(['127.0.0.1', 'localhost']);

const normalizePath = (value: string) =>
  value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// Read-only identity check against the server itself.
export async function assertIsolatedServer(
  client: PrismaClient,
): Promise<void> {
  if (!isolated.marker || !isolated.dataDirectory)
    throw new Error('Refusing to run: test marker or data directory not set');
  const [identity] = await client.$queryRaw<
    Array<{
      database: string;
      address: string;
      port: number;
      dataDirectory: string;
      comment: string | null;
      listen: string;
    }>
  >`
    SELECT current_database() AS "database",
           host(inet_server_addr()) AS "address",
           inet_server_port() AS "port",
           current_setting('data_directory') AS "dataDirectory",
           shobj_description(oid, 'pg_database') AS "comment",
           current_setting('listen_addresses') AS "listen"
    FROM pg_database WHERE datname = current_database()`;
  const problems: string[] = [];
  if (!identity?.database.endsWith('_test'))
    problems.push(`database ${identity?.database}`);
  if (identity?.address !== '127.0.0.1')
    problems.push(`address ${identity?.address}`);
  if (identity?.port !== 55432) problems.push(`port ${identity?.port}`);
  if (
    normalizePath(identity?.dataDirectory ?? '') !==
    normalizePath(isolated.dataDirectory)
  )
    problems.push('data directory is not the isolated test cluster');
  if (identity?.comment !== `adflow-isolated-test:${isolated.marker}`)
    problems.push('test marker missing or different');
  if (!LOOPBACK_LISTEN.has((identity?.listen ?? '').trim()))
    problems.push('the server listens beyond loopback');
  if (problems.length)
    throw new Error(
      `Refusing to run: server identity check failed (${problems.join(', ')})`,
    );
}

const MIGRATIONS = resolve(__dirname, '../../../../prisma/migrations');
const SCHEMA_PATTERN = /^g[a-z0-9]+_(\d+)_[0-9a-f]+$/;
const STALE_SCHEMA_MS = 60 * 60_000;

export function migrationNames(): string[] {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

// The reviewed migration SQL of the named migrations, in order.
function migrationStatements(names: string[]): string[] {
  return names.flatMap((name) =>
    readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8')
      .split(/;\s*$/m)
      .map((statement) =>
        statement
          .split('\n')
          .filter((line) => !line.trim().startsWith('--'))
          .join('\n')
          .trim(),
      )
      .filter(Boolean),
  );
}

function urlFor(schema: string, applicationName: string): string {
  const url = new URL(isolated.url);
  url.searchParams.set('schema', schema);
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('application_name', applicationName);
  return url.toString();
}

// One gate's isolated schema and its independent actors.
export class GateSchema {
  private readonly actors: PrismaClient[] = [];

  private constructor(
    readonly gate: string,
    readonly schema: string,
    private readonly admin: PrismaClient,
  ) {}

  // Creates g<gate>_<epoch>_<random> and applies every migration to it
  // (minus `exclude`, which gate F applies later). Leftover gate schemas
  // older than an hour are dropped first, so an aborted run is repaired by
  // the next one.
  static async create(
    admin: PrismaClient,
    gate: string,
    options: { exclude?: string[] } = {},
  ): Promise<GateSchema> {
    await assertIsolatedServer(admin);
    const leftovers = await admin.$queryRaw<Array<{ name: string }>>`
      SELECT nspname AS "name" FROM pg_namespace WHERE nspname LIKE 'g%\\_%'`;
    for (const { name } of leftovers) {
      const match = SCHEMA_PATTERN.exec(name);
      if (match && Date.now() - Number(match[1]) * 1000 > STALE_SCHEMA_MS)
        await admin.$executeRawUnsafe(`DROP SCHEMA "${name}" CASCADE`);
    }
    const schema = `g${gate.toLowerCase()}_${Math.floor(Date.now() / 1000)}_${randomBytes(3).toString('hex')}`;
    if (!SCHEMA_PATTERN.test(schema)) throw new Error('bad gate name');
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const gateSchema = new GateSchema(gate, schema, admin);
    await gateSchema.applyMigrations(
      migrationNames().filter((name) => !options.exclude?.includes(name)),
    );
    return gateSchema;
  }

  // Applies the named migrations' reviewed SQL to this schema, in order.
  async applyMigrations(names: string[]): Promise<void> {
    const migrator = this.actor(`migrator-${this.actors.length}`);
    await assertIsolatedServer(migrator);
    for (const statement of migrationStatements(names))
      await migrator.$executeRawUnsafe(statement);
  }

  // A separate backend connection with its own transactions. Lock and
  // statement timeouts make a lock-order bug fail fast instead of hanging.
  // `via` routes the actor through the commit-dropping proxy (gates A, B,
  // and O); the proxy forwards only to the validated 127.0.0.1 server.
  actor(name: string, options: { via?: CommitDropProxy } = {}): PrismaClient {
    const direct = urlFor(this.schema, `gate-${this.gate}-${name}`);
    const client = new PrismaClient({
      datasourceUrl: options.via ? options.via.url(direct) : direct,
    });
    this.actors.push(client);
    return client;
  }

  // The URL of a direct actor in this schema, for a client the harness does
  // not construct itself (gate G's application).
  actorUrl(name: string): string {
    return urlFor(this.schema, `gate-${this.gate}-${name}`);
  }

  async prepare(client: PrismaClient): Promise<void> {
    await assertIsolatedServer(client);
    await client.$executeRawUnsafe(`SET lock_timeout = '5s'`);
    await client.$executeRawUnsafe(`SET statement_timeout = '15s'`);
  }

  // Confirms that an actor is really blocked on a lock before the test
  // releases the holder. Never sleeps to create an ordering.
  async waitUntilBlocked(name: string, timeoutMs = 5_000): Promise<void> {
    const applicationName = `gate-${this.gate}-${name}`;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await this.admin.$queryRaw<Array<{ waiting: number }>>`
        SELECT count(*)::int AS "waiting" FROM pg_stat_activity
        WHERE application_name = ${applicationName} AND wait_event_type = 'Lock'`;
      if (row.waiting > 0) return;
      if (Date.now() > deadline)
        throw new Error(`${applicationName} never waited on a lock`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async drop(failed: boolean): Promise<void> {
    for (const client of this.actors)
      await client.$disconnect().catch(() => undefined);
    if (failed && isolated.keepFailed) {
      console.warn(`Gate ${this.gate} failed; schema kept: ${this.schema}`);
      return;
    }
    await this.admin.$executeRawUnsafe(
      `DROP SCHEMA IF EXISTS "${this.schema}" CASCADE`,
    );
  }
}

// Holds an interactive transaction open until released: the "process"
// paused at a named point while holding its locks.
export function holdTransaction(
  client: PrismaClient,
  work: (
    tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0],
  ) => Promise<void>,
): { ready: Promise<void>; release: () => void; done: Promise<void> } {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const done = client.$transaction(
    async (tx) => {
      await work(tx);
      ready();
      await released;
    },
    { timeout: 30_000, maxWait: 5_000 },
  );
  return { ready: readyPromise, release, done };
}

export type GateOwner = {
  organizationId: string;
  userId: string;
  sessionId: string;
};

// Fixture rows written only after the identity checks have passed.
export async function seedOwner(
  client: PrismaClient,
  label: string,
): Promise<GateOwner> {
  const owner = {
    organizationId: `org-${label}`,
    userId: `user-${label}`,
    sessionId: `session-${label}`,
  };
  await client.$executeRaw`
    INSERT INTO "organizations" ("id", "name", "code", "updatedAt")
    VALUES (${owner.organizationId}, ${label}, ${owner.organizationId}, now())`;
  await client.$executeRaw`
    INSERT INTO "users" ("id", "organizationId", "name", "email", "updatedAt")
    VALUES (${owner.userId}, ${owner.organizationId}, ${label}, ${`${label}@example.test`}, now())`;
  await client.$executeRaw`
    INSERT INTO "auth_sessions" ("id", "userId", "expiresAt")
    VALUES (${owner.sessionId}, ${owner.userId}, now() + interval '1 hour')`;
  await client.$executeRaw`
    INSERT INTO "canva_connections" ("id", "organizationId", "status", "mode", "updatedAt")
    VALUES (${`connection-${label}`}, ${owner.organizationId}, 'DISCONNECTED', 'CANVA', now())`;
  return owner;
}

// A consumed, launched attempt, as the callback has it after §5.3.
export async function seedConsumedAttempt(
  client: PrismaClient,
  owner: GateOwner,
  id: string,
): Promise<void> {
  await client.$executeRaw`
    INSERT INTO "canva_oauth_attempts" ("id", "launchTokenHash", "stateHash",
      "browserBindingHash", "organizationId", "userId", "sessionId", "baseGeneration",
      "redirectUri", "launchExpiresAt", "launchedAt", "expiresAt", "consumedAt")
    VALUES (${id}, ${`launch-${id}`}, ${`state-${id}`}, ${`binding-${id}`},
      ${owner.organizationId}, ${owner.userId}, ${owner.sessionId}, 0, 'redirect',
      (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'),
      (now() AT TIME ZONE 'UTC') + interval '10 minutes', (now() AT TIME ZONE 'UTC'))`;
}

// §10.1 invariant checker for the database-checkable invariants. Returns
// the violations; an empty list passes.
export async function checkInvariants(client: PrismaClient): Promise<string[]> {
  const violations: string[] = [];
  const ownership = await client.$queryRaw<Array<{ canvaUserId: string }>>`
    SELECT x."canvaUserId" FROM (
      SELECT "canvaUserId", "organizationId" FROM "canva_credentials"
      UNION ALL SELECT "canvaUserId", "organizationId" FROM "canva_connection_candidates") x
    LEFT JOIN "canva_accounts" a ON a."canvaUserId" = x."canvaUserId"
    WHERE a."organizationId" IS DISTINCT FROM x."organizationId"`;
  if (ownership.length)
    violations.push(
      'INV-1: credential or candidate not held by its organization',
    );
  const versions = await client.$queryRaw<Array<{ organizationId: string }>>`
    SELECT c."organizationId" FROM "canva_credentials" c
    JOIN "canva_connections" n ON n."organizationId" = c."organizationId"
    WHERE c."version" <> n."credentialVersion"`;
  if (versions.length)
    violations.push('INV-3: credential version differs from the connection');
  const queue = await client.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "canva_pending_revocations"
    WHERE ("state" = 'finished' AND "refreshTokenCiphertext" IS NOT NULL)
       OR ("state" <> 'finished' AND "refreshTokenCiphertext" IS NULL)
       OR "attempts" > 8
       OR ("state" = 'in_flight' AND "claimToken" IS NULL)`;
  if (queue.length)
    violations.push(
      'INV-5: queue row ciphertext, attempts, or claim inconsistent',
    );
  return violations;
}
