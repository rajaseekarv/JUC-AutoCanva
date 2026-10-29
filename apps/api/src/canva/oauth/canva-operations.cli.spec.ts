import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { INestApplicationContext, LoggerService } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CANVA_OAUTH_CONFIG } from './canva-oauth.config';
import { CANVA_REVOCATION_QUEUE } from './canva-oauth.stores';
import { CANVA_OPERATIONS_SHUTDOWN_WARNING } from './canva-operations';
import {
  StderrLogger,
  runCanvaOperationsCli,
  type CanvaContextOptions,
} from './canva-operations.cli';
import { testRealConfig } from './canva-oauth.test-doubles';
import { CanvaRevocationWorker } from './canva-revocation.worker';
import { CanvaTokenResealService } from './canva-token-reseal.service';

// The operator command's process wiring. Nothing here opens a database or
// calls Canva: the in-process tests pass a fake application context, and the
// child-process tests run the real entry point only on paths that are
// refused before the application context is created.

// Test-only values; none is a real credential.
const clientSecret = 'cli-test-only-client-secret-value';
const encryptionKey = Buffer.alloc(32, 9).toString('base64');
const jwtSecret = 'cli-test-only-jwt-secret-at-least-32-characters';
const blockedDatabase =
  'postgresql://cli-tests-must-not-connect@127.0.0.1:1/blocked';
const sensitive = [clientSecret, encryptionKey, jwtSecret, blockedDatabase];

const operatorEnvironment: NodeJS.ProcessEnv = {
  DATABASE_URL: blockedDatabase,
  REDIS_URL: 'redis://127.0.0.1:1',
  JWT_ACCESS_SECRET: jwtSecret,
  CANVA_PROVIDER_MODE: 'canva',
  CANVA_CLIENT_ID: 'OC-test-client-id',
  CANVA_CLIENT_SECRET: clientSecret,
  CANVA_REDIRECT_URI:
    'http://127.0.0.1:3000/api/v1/integrations/canva/oauth/callback',
  CANVA_TOKEN_ENCRYPTION_KEY: encryptionKey,
  CANVA_OAUTH_PERSISTENCE_ENABLED: 'true',
  CANVA_REVOCATION_WORKER_ENABLED: 'true',
};

const healthy = {
  counts: { queued: 0, in_flight: 0, exhausted: 0, finished: 0 },
  due: 0,
  crashed: 0,
  preview: [],
  health: {
    revocationConfigurationErrors: 0,
    revocationKeyUnavailable: 0,
    connectionConfigurationErrors: 0,
  },
};

// A fake Nest application context: get() answers the four tokens the CLI
// asks for, and records the options the CLI created it with.
function fakeContext(inspect = vi.fn(async () => healthy)) {
  const config = testRealConfig({ persistence: true, revocationWorker: true });
  const close = vi.fn(async () => undefined);
  const worker = {
    enabled: true,
    runOnce: vi.fn(),
    maintain: vi.fn(),
  };
  const reseal = { inventory: vi.fn(), run: vi.fn() };
  const created: CanvaContextOptions[] = [];
  const app = {
    get: (token: unknown) => {
      if (token === CANVA_OAUTH_CONFIG) return config;
      if (token === CANVA_REVOCATION_QUEUE) return { inspect };
      if (token === CanvaRevocationWorker) return worker;
      if (token === CanvaTokenResealService) return reseal;
      throw new Error('unexpected token');
    },
    close,
  } as unknown as INestApplicationContext;
  const createContext = vi.fn(async (options: CanvaContextOptions) => {
    created.push(options);
    return app;
  });
  return { createContext, created, close, inspect };
}

async function run(argv: string[], context = fakeContext()) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCanvaOperationsCli(
    argv,
    operatorEnvironment,
    context.createContext,
    (text) => out.push(text),
    (text) => err.push(text),
  );
  return { code, stdout: out.join(''), stderr: err.join(''), ...context };
}

// stdout must be exactly one newline-terminated JSON document.
function onlyJson(stdout: string): Record<string, unknown> {
  expect(stdout.endsWith('\n')).toBe(true);
  const lines = stdout.slice(0, -1).split('\n');
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]) as Record<string, unknown>;
}

describe('runCanvaOperationsCli (in process, fake application context)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prints exactly one JSON document and exits 0 when healthy', async () => {
    const result = await run(['inspect', '--json']);
    expect(result.code).toBe(0);
    expect(onlyJson(result.stdout)).toMatchObject({
      command: 'inspect',
      status: 'ok',
      exitCode: 0,
    });
    expect(result.close).toHaveBeenCalledTimes(1);
    expect(result.stderr).toBe('');
  });

  // A failed shutdown happens after the report is printed. It must not
  // reject, change the exit code the report states, add to stdout, or
  // print the error; stderr gets one fixed warning.
  it.each([
    ['ok', healthy, 0],
    ['degraded', { ...healthy, crashed: 1 }, 3],
    ['failed', null, 1],
  ] as const)(
    'keeps a %s result and its exit code when close() fails',
    async (status, inspection, exitCode) => {
      const context = fakeContext(
        vi.fn(async () => {
          if (!inspection) throw new Error(`lost ${blockedDatabase}`);
          return inspection;
        }),
      );
      context.close.mockRejectedValueOnce(
        new Error(`disconnect failed for ${blockedDatabase} (${clientSecret})`),
      );
      const result = await run(['inspect', '--json'], context);
      expect(result.code).toBe(exitCode);
      const report = onlyJson(result.stdout);
      expect(report).toMatchObject({ status, exitCode });
      expect(report.exitCode).toBe(result.code);
      expect(result.close).toHaveBeenCalledTimes(1);
      expect(result.stderr).toBe(`${CANVA_OPERATIONS_SHUTDOWN_WARNING}\n`);
      for (const value of sensitive) {
        expect(result.stdout).not.toContain(value);
        expect(result.stderr).not.toContain(value);
      }
    },
  );

  it('keeps text output and the exit code when close() fails in text mode', async () => {
    const context = fakeContext();
    context.close.mockRejectedValueOnce(new Error(clientSecret));
    const result = await run(['inspect'], context);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Canva mode: durable storage on/);
    expect(result.stdout).not.toContain('shut down');
    expect(result.stderr).toBe(`${CANVA_OPERATIONS_SHUTDOWN_WARNING}\n`);
    expect(result.stderr).not.toContain(clientSecret);
  });

  it('creates the context with a stderr logger and without abort-on-error in JSON mode', async () => {
    const { created } = await run(['inspect', '--json']);
    expect(created).toHaveLength(1);
    expect(created[0].abortOnError).toBe(false);
    expect(created[0].logger).toBeInstanceOf(StderrLogger);

    const text = await run(['inspect']);
    expect(text.created[0].logger).toEqual(['error', 'warn', 'log']);
    expect(text.created[0].abortOnError).toBe(false);
  });

  it('writes application log lines to stderr, never stdout, in JSON mode', async () => {
    const { created } = await run(['inspect', '--json']);
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const logger = created[0].logger as LoggerService;
    logger.log('cli-log-line');
    logger.warn('cli-warn-line');
    logger.error('cli-error-line');
    const written = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).toContain('cli-log-line');
    expect(written).toContain('cli-warn-line');
    expect(written).toContain('cli-error-line');
    expect(stdout).not.toHaveBeenCalled();
  });

  it('propagates degraded (3) and failed (1) as exit codes', async () => {
    const degraded = await run(
      ['inspect', '--json'],
      fakeContext(vi.fn(async () => ({ ...healthy, crashed: 1 }))),
    );
    expect(degraded.code).toBe(3);
    expect(onlyJson(degraded.stdout)).toMatchObject({
      status: 'degraded',
      degraded: ['crashed_calls'],
    });

    const failed = await run(
      ['inspect', '--json'],
      fakeContext(
        vi.fn(async () => {
          throw new Error(`could not reach ${blockedDatabase}`);
        }),
      ),
    );
    expect(failed.code).toBe(1);
    expect(onlyJson(failed.stdout)).toMatchObject({ status: 'failed' });
    expect(failed.close).toHaveBeenCalledTimes(1);
    for (const value of sensitive) expect(failed.stdout).not.toContain(value);
  });

  it('reports an application that cannot start as failed (1), not a crash', async () => {
    const context = fakeContext();
    context.createContext.mockRejectedValueOnce(
      new Error(`module init failed for ${blockedDatabase}`),
    );
    const result = await run(['inspect', '--json'], context);
    expect(result.code).toBe(1);
    expect(onlyJson(result.stdout)).toMatchObject({
      status: 'failed',
      exitCode: 1,
      message:
        'The application could not start; see the log. Nothing was done.',
    });
    expect(result.close).not.toHaveBeenCalled();
    for (const value of sensitive) expect(result.stdout).not.toContain(value);
  });

  it('never creates the context for a refused command', async () => {
    const result = await run([
      'run-once',
      '--execute',
      '--json',
      '--limit',
      '0',
    ]);
    expect(result.code).toBe(2);
    expect(result.createContext).not.toHaveBeenCalled();
    expect(onlyJson(result.stdout)).toMatchObject({ status: 'refused' });
  });
});

// The real entry point, canva-operations.main.ts, in a child process
// through ts-node (no build output). Each case is refused before the
// application context exists, so no database connection can be attempted;
// stderr is checked for Nest's startup line to prove it. The child's
// environment is built from scratch: no VITEST, NODE_ENV, or developer
// variables. The entry point's dotenv call may still read the repository's
// .env, but only fills variables not set here; it never overrides them.
describe('canva-operations.main.ts (child process, refusal paths only)', () => {
  const apiRoot = join(__dirname, '..', '..', '..');
  const entry = join(__dirname, 'canva-operations.main.ts');
  const register = require.resolve('ts-node/register/transpile-only');

  function runEntry(argv: string[], overrides: NodeJS.ProcessEnv = {}) {
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TS_NODE_PROJECT: join(apiRoot, 'tsconfig.json'),
      ...operatorEnvironment,
      ...overrides,
    };
    const child = spawnSync(
      process.execPath,
      ['-r', register, entry, ...argv],
      {
        cwd: apiRoot,
        env: environment,
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    if (child.error) throw child.error;
    for (const value of sensitive) {
      expect(child.stdout).not.toContain(value);
      expect(child.stderr).not.toContain(value);
    }
    // The application context was never created.
    expect(child.stderr).not.toMatch(/Starting Nest application/);
    return child;
  }

  it('refuses mock mode with one JSON document on stdout and exit code 2', () => {
    const child = runEntry(['inspect', '--json'], {
      CANVA_PROVIDER_MODE: 'mock',
    });
    expect(child.status).toBe(2);
    expect(onlyJson(child.stdout)).toEqual({
      command: 'inspect',
      execute: false,
      status: 'refused',
      exitCode: 2,
      degraded: [],
      message:
        'Refusing: CANVA_PROVIDER_MODE is not canva (mock mode has nothing to operate)',
    });
  }, 90_000);

  it('refuses run-once --execute without the worker flag (exit 2, JSON)', () => {
    const child = runEntry(['run-once', '--execute', '--json'], {
      CANVA_REVOCATION_WORKER_ENABLED: 'false',
    });
    expect(child.status).toBe(2);
    expect(onlyJson(child.stdout)).toMatchObject({
      command: 'run-once',
      execute: true,
      status: 'refused',
      message: expect.stringMatching(/CANVA_REVOCATION_WORKER_ENABLED/),
    });
  }, 90_000);

  it('refuses an invalid option as JSON, and in text mode prints text', () => {
    const json = runEntry(['inspect', '--json', '--limit', '0']);
    expect(json.status).toBe(2);
    expect(onlyJson(json.stdout)).toMatchObject({
      status: 'refused',
      message: '--limit must be an integer from 1 to 1000',
    });

    const text = runEntry(['inspect', '--limit', '0']);
    expect(text.status).toBe(2);
    expect(text.stdout).toBe('--limit must be an integer from 1 to 1000\n');
  }, 90_000);

  it('refuses an invalid environment without echoing its values', () => {
    const child = runEntry(['inspect', '--json'], {
      CANVA_REDIRECT_URI: 'https://evil.example/callback',
    });
    expect(child.status).toBe(2);
    const report = onlyJson(child.stdout);
    expect(report).toMatchObject({ status: 'refused' });
    expect(String(report.message)).toMatch(/CANVA_REDIRECT_URI/);
    expect(child.stdout).not.toContain('evil.example');
  }, 90_000);
});
