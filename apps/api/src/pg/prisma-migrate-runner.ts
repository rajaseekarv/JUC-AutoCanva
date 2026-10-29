import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { assertGateEnvironment, assertIsolatedUrl } from './canva-gate-harness';

// A narrowly scoped runner for the Prisma migrate CLI, for gate F only
// (failed-migration recovery with `prisma migrate resolve`). It can do
// exactly two things to one dedicated gate schema on the guarded isolated
// test cluster: `migrate deploy`, and `migrate resolve --rolled-back`.
//
// Every check runs in planMigrateCommand, before a command line exists; the
// runner then verifies the server's identity before it spawns anything. A
// refused request can never reach `spawn`.
// - Opt-in: ADFLOW_PG_GATES=run (as for every gate) AND
//   ADFLOW_PG_MIGRATE_RUNNER=run (this runner specifically); never in a
//   production process.
// - Target: ADFLOW_PG_TEST_URL must pass the isolated-URL guard and carry no
//   schema of its own; the schema must be a gate F schema (gf_<epoch>_<hex>).
// - Workspace: a direct child of the OS temp directory named
//   adflow-gate-f-*, holding a copied schema.prisma and migrations/. The
//   repository's own migrations are never the target of a command.
// - Environment: built from scratch (PATH and the Windows system root, the
//   computed DATABASE_URL, and Prisma's quiet flags). Nothing else is
//   inherited, so a developer DATABASE_URL or any secret never reaches it.
// Nothing in the application imports this file.

export type MigrateAction =
  { kind: 'deploy' } | { kind: 'resolve-rolled-back'; migration: string };

export type MigrateRequest = {
  action: MigrateAction;
  schema: string;
  workspace: string;
};

export type MigratePlan = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  // For logs and assertions: the target without credentials.
  target: string;
};

export class MigrateRunnerRefused extends Error {
  constructor(reason: string) {
    super(`Refusing to run the Prisma migrate CLI: ${reason}`);
    this.name = 'MigrateRunnerRefused';
  }
}

const GATE_F_SCHEMA = /^gf_\d{9,12}_[0-9a-f]{6}$/;
const WORKSPACE_NAME = /^adflow-gate-f-[A-Za-z0-9]{6,}$/;
const MIGRATION_NAME = /^\d{14}_[a-z0-9_]{1,100}$/;

function refuse(reason: string): never {
  throw new MigrateRunnerRefused(reason);
}

// The Prisma CLI entry point of the repository's pinned `prisma` package.
export function resolvePrismaCli(): string {
  return require.resolve('prisma/build/index.js', {
    paths: [resolve(__dirname, '../../../..')],
  });
}

export function planMigrateCommand(
  request: MigrateRequest,
  environment: NodeJS.ProcessEnv,
  options: { tempRoot?: string; prismaCli?: () => string } = {},
): MigratePlan {
  try {
    assertGateEnvironment(environment);
  } catch (error) {
    refuse(error instanceof Error ? error.message : 'gate opt-in missing');
  }
  if (environment.ADFLOW_PG_MIGRATE_RUNNER !== 'run')
    refuse('ADFLOW_PG_MIGRATE_RUNNER is not "run"');

  const base = environment.ADFLOW_PG_TEST_URL ?? '';
  try {
    assertIsolatedUrl(base);
  } catch (error) {
    refuse(error instanceof Error ? error.message : 'not the isolated URL');
  }
  const url = new URL(base);
  if (url.searchParams.has('schema'))
    refuse('ADFLOW_PG_TEST_URL must not name a schema; the runner sets it');
  if (!GATE_F_SCHEMA.test(request.schema))
    refuse('the target schema is not a gate F schema (gf_<epoch>_<hex>)');

  const tempRoot = resolve(options.tempRoot ?? tmpdir());
  const workspace = resolve(request.workspace);
  if (
    dirname(workspace) !== tempRoot ||
    !WORKSPACE_NAME.test(basename(workspace))
  )
    refuse('the workspace is not a temporary adflow-gate-f-* directory');
  const schemaFile = join(workspace, 'schema.prisma');
  const migrations = join(workspace, 'migrations');
  if (!existsSync(schemaFile) || !existsSync(migrations))
    refuse('the workspace has no schema.prisma and migrations/ copy');

  let args: string[];
  switch (request.action.kind) {
    case 'deploy':
      args = ['migrate', 'deploy', '--schema', schemaFile];
      break;
    case 'resolve-rolled-back': {
      const name = request.action.migration;
      if (
        !MIGRATION_NAME.test(name) ||
        !existsSync(join(migrations, name)) ||
        !statSync(join(migrations, name)).isDirectory()
      )
        refuse('the migration is not one of the workspace migrations');
      args = [
        'migrate',
        'resolve',
        '--rolled-back',
        name,
        '--schema',
        schemaFile,
      ];
      break;
    }
    default:
      refuse('only deploy and resolve --rolled-back are allowed');
  }

  url.searchParams.set('schema', request.schema);
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('application_name', 'gate-f-migrator');
  const target = url.toString();
  // Defense in depth: the computed URL must still be the isolated one.
  assertIsolatedUrl(target);

  const env: Record<string, string> = {
    DATABASE_URL: target,
    PRISMA_HIDE_UPDATE_MESSAGE: '1',
    CHECKPOINT_DISABLE: '1',
    NO_COLOR: '1',
  };
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT'])
    if (environment[name]) env[name] = environment[name]!;

  const redacted = new URL(target);
  redacted.username = '';
  redacted.password = '';
  return {
    command: process.execPath,
    args: [(options.prismaCli ?? resolvePrismaCli)(), ...args],
    cwd: workspace,
    env,
    target: redacted.toString(),
  };
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    shell: false;
    windowsHide: true;
  },
) => Promise<{ code: number | null; output: string }>;

// Plans (every refusal first), verifies the server's identity, and only then
// spawns. Returns the exit code and output; never throws for a non-zero
// exit, which gate F expects for its injected failure.
export async function runGuardedMigration(
  request: MigrateRequest,
  environment: NodeJS.ProcessEnv,
  dependencies: {
    verifyServer: () => Promise<void>;
    spawn: SpawnFn;
    prismaCli?: () => string;
    tempRoot?: string;
  },
): Promise<{ code: number | null; output: string }> {
  const plan = planMigrateCommand(request, environment, {
    prismaCli: dependencies.prismaCli,
    tempRoot: dependencies.tempRoot,
  });
  await dependencies.verifyServer();
  return dependencies.spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    shell: false,
    windowsHide: true,
  });
}

// The real spawn, used only by gate F.
export const nodeSpawn: SpawnFn = async (command, args, options) => {
  const { spawn } = await import('node:child_process');
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, options);
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolveRun({ code, output }));
  });
};
