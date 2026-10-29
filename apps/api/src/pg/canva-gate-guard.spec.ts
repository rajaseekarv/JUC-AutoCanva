import type { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GateSchema,
  assertGateEnvironment,
  assertIsolatedServer,
  assertIsolatedUrl,
  isolated,
} from './canva-gate-harness';

// The PostgreSQL gate guards, checked without any database: these refuse
// before a client could connect. (A unit test, not a *.pg.spec.ts file.)

const guarded = 'postgresql://gate@127.0.0.1:55432/adflow_gates_test';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('PostgreSQL gate guards', () => {
  it('requires the explicit opt-in and refuses a production process', () => {
    expect(() => assertGateEnvironment({})).toThrow(/ADFLOW_PG_GATES/);
    expect(() => assertGateEnvironment({ ADFLOW_PG_GATES: 'yes' })).toThrow(
      /ADFLOW_PG_GATES/,
    );
    expect(() =>
      assertGateEnvironment({ ADFLOW_PG_GATES: 'run', NODE_ENV: 'production' }),
    ).toThrow(/production/);
    expect(() =>
      assertGateEnvironment({ ADFLOW_PG_GATES: 'run' }),
    ).not.toThrow();
  });

  it('accepts only the isolated loopback test database URL', () => {
    expect(() => assertIsolatedUrl(guarded)).not.toThrow();
    for (const url of [
      '',
      'postgresql://gate@localhost:55432/adflow_gates_test',
      'postgresql://gate@10.0.0.5:55432/adflow_gates_test',
      'postgresql://gate@127.0.0.1:5432/adflow_gates_test',
      'postgresql://gate@127.0.0.1/adflow_gates_test',
      'postgresql://gate@127.0.0.1:55432/adflow',
      'postgresql://gate@127.0.0.1:55432/adflow_test_copy',
      'mysql://gate@127.0.0.1:55432/adflow_gates_test',
      // Parameters that would send the connection elsewhere.
      `${guarded}?host=/var/run/postgresql`,
      `${guarded}?host=db.example.com`,
      `${guarded}?hostaddr=10.0.0.5`,
      `${guarded}?port=5432`,
      `${guarded}?socket=/tmp`,
    ])
      expect(() => assertIsolatedUrl(url)).toThrow(/Refusing to run/);
  });

  it('refuses a server without the run marker before querying it', async () => {
    const queryRaw = vi.fn();
    const client = { $queryRaw: queryRaw } as unknown as PrismaClient;
    await expect(assertIsolatedServer(client)).rejects.toThrow(
      /marker or data directory not set/,
    );
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('refuses to create a gate schema on an unverified server, writing nothing', async () => {
    const executeRawUnsafe = vi.fn();
    const admin = {
      $queryRaw: vi.fn(),
      $executeRawUnsafe: executeRawUnsafe,
    } as unknown as PrismaClient;
    await expect(GateSchema.create(admin, 'x')).rejects.toThrow(
      /Refusing to run/,
    );
    expect(executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('keeps every PostgreSQL spec out of the default test projects', async () => {
    const { default: config } = await import('../../vitest.config');
    const projects = (config.test?.projects ?? []) as Array<{
      test?: { name?: string; exclude?: string[] };
    }>;
    expect(projects.map((project) => project.test?.name)).toEqual([
      'unit',
      'http',
    ]);
    expect(projects[0].test?.exclude).toContain('src/**/*.pg.spec.ts');
  });

  it('does not create the pg project from a stray test URL without the opt-in', async () => {
    vi.stubEnv('ADFLOW_PG_TEST_URL', guarded);
    vi.resetModules();
    const { default: withUrlOnly } = await import('../../vitest.config');
    expect(
      (withUrlOnly.test?.projects as Array<{ test?: { name?: string } }>).map(
        (project) => project.test?.name,
      ),
    ).not.toContain('pg');
    vi.stubEnv('ADFLOW_PG_GATES', 'run');
    vi.resetModules();
    const { default: optedIn } = await import('../../vitest.config');
    expect(
      (optedIn.test?.projects as Array<{ test?: { name?: string } }>).map(
        (project) => project.test?.name,
      ),
    ).toContain('pg');
  });
});

describe('PostgreSQL gate server identity check (fake client, no database)', () => {
  const marker = 'test-marker-1';
  const dataDirectory = 'C:/adflow-gates/data';
  const matching = {
    database: 'adflow_gates_test',
    address: '127.0.0.1',
    port: 55432,
    dataDirectory,
    comment: `adflow-isolated-test:${marker}`,
    listen: '127.0.0.1',
  };
  const saved = { ...isolated };
  afterEach(() => {
    Object.assign(isolated, saved);
  });
  const client = (identity: Record<string, unknown>) =>
    ({ $queryRaw: vi.fn(async () => [identity]) }) as unknown as PrismaClient;

  it('accepts the stamped, loopback-only isolated cluster', async () => {
    Object.assign(isolated, { marker, dataDirectory });
    await expect(
      assertIsolatedServer(client(matching)),
    ).resolves.toBeUndefined();
    await expect(
      assertIsolatedServer(
        // Case and a trailing separator are normalized away.
        client({
          ...matching,
          listen: 'localhost',
          dataDirectory: 'c:/ADFLOW-GATES/data/',
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['a server listening on every address', { listen: '*' }, /beyond loopback/],
    [
      'a server listening on a LAN address too',
      { listen: '127.0.0.1,192.168.1.5' },
      /beyond loopback/,
    ],
    [
      'a Unix-socket connection (no server address)',
      { address: null },
      /address/,
    ],
    ['the default port', { port: 5432 }, /port/],
    ['a database not named *_test', { database: 'adflow' }, /database/],
    [
      'another cluster’s data directory',
      { dataDirectory: '/var/lib/postgresql/data' },
      /data directory/,
    ],
    ['a missing or different marker', { comment: null }, /marker/],
  ])('refuses %s', async (_case, overrides, reason) => {
    Object.assign(isolated, { marker, dataDirectory });
    await expect(
      assertIsolatedServer(client({ ...matching, ...overrides })),
    ).rejects.toThrow(reason);
  });
});
