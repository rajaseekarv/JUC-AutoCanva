import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MigrateRunnerRefused,
  planMigrateCommand,
  runGuardedMigration,
  type MigrateRequest,
} from './prisma-migrate-runner';

// The gate F migrate runner's guards. Nothing here connects to a database
// or launches a process: spawn and the server check are mocks, and every
// refusal is shown never to reach spawn. The only side effect is a scratch
// workspace in the OS temp directory, removed after each test.

const isolatedUrl =
  'postgresql://gate:gate-password@127.0.0.1:55432/adflow_gates_test';
const optedIn: NodeJS.ProcessEnv = {
  ADFLOW_PG_GATES: 'run',
  ADFLOW_PG_MIGRATE_RUNNER: 'run',
  ADFLOW_PG_TEST_URL: isolatedUrl,
  PATH: '/usr/bin',
  // Must never reach the child process.
  DATABASE_URL: 'postgresql://dev@127.0.0.1:5432/adflow',
  CANVA_CLIENT_SECRET: 'never-forwarded-secret',
  JWT_ACCESS_SECRET: 'never-forwarded-jwt-secret',
};
const schema = 'gf_1767000000_a1b2c3';
const migration = '20261027120100_canva_oauth_persistence';
const fakeCli = () => '/repo/node_modules/prisma/build/index.js';

const workspaces: string[] = [];
afterEach(() => {
  for (const path of workspaces.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function workspace(prefix = 'adflow-gate-f-'): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  workspaces.push(path);
  writeFileSync(join(path, 'schema.prisma'), '// scratch copy\n');
  mkdirSync(join(path, 'migrations', migration), { recursive: true });
  writeFileSync(
    join(path, 'migrations', migration, 'migration.sql'),
    'SELECT 1;\n',
  );
  return path;
}

function harness() {
  const spawn = vi.fn(async () => ({ code: 0, output: 'ok' }));
  const verifyServer = vi.fn(async () => undefined);
  return { spawn, verifyServer };
}

async function expectRefused(
  request: MigrateRequest,
  environment: NodeJS.ProcessEnv,
  reason: RegExp,
) {
  const { spawn, verifyServer } = harness();
  await expect(
    runGuardedMigration(request, environment, {
      spawn,
      verifyServer,
      prismaCli: fakeCli,
    }),
  ).rejects.toThrow(reason);
  expect(spawn).not.toHaveBeenCalled();
  expect(verifyServer).not.toHaveBeenCalled();
}

describe('gate F migrate runner: refusals never launch the command', () => {
  it.each([
    ['no gate opt-in', { ADFLOW_PG_GATES: undefined }, /ADFLOW_PG_GATES/],
    [
      'no runner opt-in',
      { ADFLOW_PG_MIGRATE_RUNNER: undefined },
      /ADFLOW_PG_MIGRATE_RUNNER/,
    ],
    ['a production process', { NODE_ENV: 'production' }, /production/],
    ['no test URL', { ADFLOW_PG_TEST_URL: undefined }, /not set/],
    [
      'the default PostgreSQL port',
      { ADFLOW_PG_TEST_URL: 'postgresql://g@127.0.0.1:5432/adflow_gates_test' },
      /isolated/,
    ],
    [
      'localhost instead of 127.0.0.1',
      {
        ADFLOW_PG_TEST_URL: 'postgresql://g@localhost:55432/adflow_gates_test',
      },
      /isolated/,
    ],
    [
      'a remote host',
      { ADFLOW_PG_TEST_URL: 'postgresql://g@db.example.com:55432/adflow_test' },
      /isolated/,
    ],
    [
      'a database not named *_test (a developer database)',
      { ADFLOW_PG_TEST_URL: 'postgresql://g@127.0.0.1:55432/adflow' },
      /isolated/,
    ],
    [
      'a URL that already names a schema (ambiguous target)',
      { ADFLOW_PG_TEST_URL: `${isolatedUrl}?schema=public` },
      /must not name a schema/,
    ],
  ])('refuses %s', async (_case, overrides, reason) => {
    await expectRefused(
      { action: { kind: 'deploy' }, schema, workspace: workspace() },
      { ...optedIn, ...overrides },
      reason,
    );
  });

  it.each([
    ['public', 'public'],
    ['another gate’s schema', 'ga_1767000000_a1b2c3'],
    ['the reference schema', 'gfref_1767000000_a1b2c3'],
    ['an injection attempt', `${schema}"; DROP SCHEMA public; --`],
    ['an empty name', ''],
  ])('refuses the schema %s', async (_case, target) => {
    await expectRefused(
      { action: { kind: 'deploy' }, schema: target, workspace: workspace() },
      optedIn,
      /gate F schema/,
    );
  });

  it('refuses a workspace that is not a fresh adflow-gate-f-* temp directory', async () => {
    const wrongPrefix = workspace('adflow-other-');
    const nested = join(workspace(), 'nested');
    mkdirSync(nested);
    for (const path of [
      wrongPrefix,
      nested,
      join(workspace(), '..', '..'),
      process.cwd(),
      join(process.cwd(), '..', '..', '..'),
    ])
      await expectRefused(
        { action: { kind: 'deploy' }, schema, workspace: path },
        optedIn,
        /workspace/,
      );
  });

  it('refuses a workspace without the copied schema and migrations', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'adflow-gate-f-'));
    workspaces.push(empty);
    await expectRefused(
      { action: { kind: 'deploy' }, schema, workspace: empty },
      optedIn,
      /schema.prisma and migrations/,
    );
  });

  it.each([
    ['a migration that does not exist', '20261027999999_missing'],
    ['a path traversal', '../../etc'],
    ['an option injection', '--force'],
  ])('refuses resolve with %s', async (_case, name) => {
    await expectRefused(
      {
        action: { kind: 'resolve-rolled-back', migration: name },
        schema,
        workspace: workspace(),
      },
      optedIn,
      /not one of the workspace migrations/,
    );
  });

  it('refuses any action other than deploy and resolve --rolled-back', async () => {
    await expectRefused(
      {
        action: { kind: 'reset' } as unknown as MigrateRequest['action'],
        schema,
        workspace: workspace(),
      },
      optedIn,
      /only deploy and resolve/,
    );
  });

  it('does not spawn when the server identity check fails', async () => {
    const { spawn } = harness();
    await expect(
      runGuardedMigration(
        { action: { kind: 'deploy' }, schema, workspace: workspace() },
        optedIn,
        {
          spawn,
          verifyServer: async () => {
            throw new Error('Refusing to run: server identity check failed');
          },
          prismaCli: fakeCli,
        },
      ),
    ).rejects.toThrow(/identity/);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('gate F migrate runner: an allowed plan', () => {
  it('targets only the gate schema, with a minimal environment and no shell', async () => {
    const path = workspace();
    const { spawn, verifyServer } = harness();
    await runGuardedMigration(
      {
        action: { kind: 'resolve-rolled-back', migration },
        schema,
        workspace: path,
      },
      optedIn,
      { spawn, verifyServer, prismaCli: fakeCli },
    );
    expect(verifyServer).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; env: Record<string, string>; shell: boolean },
    ];
    expect(command).toBe(process.execPath);
    expect(args).toEqual([
      fakeCli(),
      'migrate',
      'resolve',
      '--rolled-back',
      migration,
      '--schema',
      join(path, 'schema.prisma'),
    ]);
    expect(options.shell).toBe(false);
    expect(options.cwd).toBe(path);
    expect(Object.keys(options.env).sort()).toEqual([
      'CHECKPOINT_DISABLE',
      'DATABASE_URL',
      'NO_COLOR',
      'PATH',
      'PRISMA_HIDE_UPDATE_MESSAGE',
    ]);
    const target = new URL(options.env.DATABASE_URL);
    expect(target.host).toBe('127.0.0.1:55432');
    expect(target.pathname).toBe('/adflow_gates_test');
    expect(target.searchParams.get('schema')).toBe(schema);
    expect(JSON.stringify(options.env)).not.toMatch(
      /never-forwarded|5432\/adflow"/,
    );
  });

  it('reports the target without credentials', () => {
    const plan = planMigrateCommand(
      { action: { kind: 'deploy' }, schema, workspace: workspace() },
      optedIn,
      { prismaCli: fakeCli },
    );
    expect(plan.target).not.toContain('gate-password');
    expect(plan.args.slice(1, 3)).toEqual(['migrate', 'deploy']);
  });

  it('throws a typed refusal', () => {
    expect(() =>
      planMigrateCommand(
        { action: { kind: 'deploy' }, schema: 'public', workspace: '/tmp/x' },
        optedIn,
        { prismaCli: fakeCli },
      ),
    ).toThrow(MigrateRunnerRefused);
  });
});
