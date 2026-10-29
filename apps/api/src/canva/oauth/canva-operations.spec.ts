import { describe, expect, it, vi } from 'vitest';
import type { CanvaOAuthConfig } from './canva-oauth.config';
import {
  CANVA_OPERATIONS_SHUTDOWN_WARNING,
  CanvaOperationRefused,
  assertCanvaOperationAllowed,
  parseCanvaOperation,
  runCanvaOperation,
  runCanvaOperationsProcess,
} from './canva-operations';
import { testRealConfig } from './canva-oauth.test-doubles';
import {
  CanvaResealRefusedError,
  type CanvaResealSummary,
} from './canva-token-reseal.service';

// The operator command's gating and output, with every dependency mocked.
// Nothing here boots Nest, opens a database, or calls Canva.

// An operator shell: not a test process.
const operatorEnvironment: NodeJS.ProcessEnv = {};

function dependencies(config: CanvaOAuthConfig) {
  const lines: string[] = [];
  return {
    lines,
    deps: {
      config,
      worker: {
        enabled: config.mode === 'canva' && config.revocationWorker,
        runOnce: vi.fn(async () => ({
          claimed: 2,
          sent: 1,
          skipped: 1,
          exhausted: 0,
          abandoned: 0,
          keyUnavailable: 0,
          configurationErrors: 0,
        })),
        maintain: vi.fn(async () => ({
          expiredCandidates: 1,
          abandoned: 0,
          purged: 3,
          releasedHolds: 0,
          deletedAccounts: 0,
        })),
      },
      queue: {
        inspect: vi.fn(async () => ({
          counts: { queued: 2, in_flight: 1, exhausted: 1, finished: 4 },
          due: 2,
          crashed: 1,
          health: {
            revocationConfigurationErrors: 0,
            revocationKeyUnavailable: 0,
            connectionConfigurationErrors: 0,
          },
          preview: [
            {
              id: 'revocation-1',
              organizationId: 'org-1',
              reason: 'disconnect' as const,
              state: 'queued' as const,
              attempts: 0,
              recovering: false,
              wouldDo: 'send' as const,
            },
          ],
        })),
      },
      reseal: {
        inventory: vi.fn(async () => ({
          currentKeyVersion: 2,
          inventory: [
            { kind: 'credential' as const, keyVersion: 1, rows: 3 },
            { kind: 'credential' as const, keyVersion: 2, rows: 5 },
          ],
          retirement: [{ keyVersion: 1, rows: 3, safeToRetire: false }],
          prestaged: [] as number[],
        })),
        run: vi.fn(async (): Promise<CanvaResealSummary> => ({
          currentKeyVersion: 2,
          scanned: 3,
          resealed: 2,
          skipped: 1,
          missingKey: 0,
          undecryptable: 0,
          newerKey: 0,
          interrupted: false,
          remaining: 1,
        })),
      },
      write: (line: string) => lines.push(line),
    },
  };
}

const workerOn = testRealConfig({ persistence: true, revocationWorker: true });
const storageOnly = testRealConfig({ persistence: true });

describe('parseCanvaOperation', () => {
  it('defaults every command to a dry run', () => {
    expect(parseCanvaOperation(['run-once'])).toEqual({
      command: 'run-once',
      execute: false,
    });
    expect(
      parseCanvaOperation(['reseal', '--limit', '50', '--execute']),
    ).toEqual({ command: 'reseal', execute: true, limit: 50 });
  });

  it('refuses unknown commands, unknown options, and bad limits', () => {
    for (const argv of [
      [],
      ['start'],
      ['run-once', '--force'],
      ['run-once', '--limit', '0'],
      ['run-once', '--limit', '1001'],
      ['run-once', '--limit', 'ten'],
      ['maintain', '--limit', '5'],
      ['inspect', '--execute'],
      ['keys', '--execute'],
    ])
      expect(() => parseCanvaOperation(argv)).toThrow(CanvaOperationRefused);
  });
});

describe('assertCanvaOperationAllowed', () => {
  it('refuses inside a test process even when fully configured', () => {
    expect(() =>
      assertCanvaOperationAllowed(
        { command: 'inspect', execute: false },
        workerOn,
        { VITEST: 'true' },
      ),
    ).toThrow(/test process/);
    expect(() =>
      assertCanvaOperationAllowed(
        { command: 'inspect', execute: false },
        workerOn,
        { NODE_ENV: 'test' },
      ),
    ).toThrow(/test process/);
  });

  it('refuses the default development configuration (mock mode)', () => {
    expect(() =>
      assertCanvaOperationAllowed(
        { command: 'inspect', execute: false },
        { mode: 'mock', webOrigin: 'http://localhost:5173' },
        operatorEnvironment,
      ),
    ).toThrow(/CANVA_PROVIDER_MODE/);
  });

  it('refuses real mode without durable storage', () => {
    expect(() =>
      assertCanvaOperationAllowed(
        { command: 'maintain', execute: true },
        testRealConfig(),
        operatorEnvironment,
      ),
    ).toThrow(/CANVA_OAUTH_PERSISTENCE_ENABLED/);
  });

  it('allows a run-once dry run without the worker flag, but not an execution', () => {
    expect(() =>
      assertCanvaOperationAllowed(
        { command: 'run-once', execute: false },
        storageOnly,
        operatorEnvironment,
      ),
    ).not.toThrow();
    expect(() =>
      assertCanvaOperationAllowed(
        { command: 'run-once', execute: true },
        storageOnly,
        operatorEnvironment,
      ),
    ).toThrow(/CANVA_REVOCATION_WORKER_ENABLED/);
  });
});

describe('runCanvaOperation', () => {
  it('inspects read-only: nothing is claimed, sent, changed, or resealed', async () => {
    const { deps, lines } = dependencies(workerOn);
    // The fixture holds an exhausted row and a crashed call: degraded (3).
    await expect(
      runCanvaOperation(
        { command: 'inspect', execute: false },
        deps,
        operatorEnvironment,
      ),
    ).resolves.toBe(3);
    expect(deps.queue.inspect).toHaveBeenCalledWith(20);
    expect(deps.worker.runOnce).not.toHaveBeenCalled();
    expect(deps.worker.maintain).not.toHaveBeenCalled();
    expect(deps.reseal.run).not.toHaveBeenCalled();
    expect(lines).toContain(
      '  revocation-1 org=org-1 reason=disconnect attempts=0 -> send',
    );
    expect(lines.join('\n')).toMatch(
      /Exhausted rows wait for an administrator/,
    );
    expect(lines.at(-1)).toBe(
      'Status: degraded (exhausted_revocations, crashed_calls)',
    );
  });

  it('previews run-once without --execute and never calls the worker', async () => {
    const { deps, lines } = dependencies(workerOn);
    await expect(
      runCanvaOperation(
        { command: 'run-once', execute: false },
        deps,
        operatorEnvironment,
      ),
      // Degraded: the previewed queue holds an exhausted row.
    ).resolves.toBe(3);
    expect(deps.worker.runOnce).not.toHaveBeenCalled();
    expect(lines).toContain(
      'Dry run: nothing was claimed or sent. Add --execute to run one batch.',
    );
  });

  it('runs one worker batch only with --execute and the worker enabled', async () => {
    const { deps, lines } = dependencies(workerOn);
    await expect(
      runCanvaOperation(
        { command: 'run-once', execute: true, limit: 5 },
        deps,
        operatorEnvironment,
      ),
    ).resolves.toBe(0);
    expect(deps.worker.runOnce).toHaveBeenCalledWith({ limit: 5 });
    expect(lines.at(-1)).toMatch(/2 claimed, 1 sent, 1 skipped/);
  });

  it('refuses run-once --execute with the worker flag off, calling nothing', async () => {
    const { deps } = dependencies(storageOnly);
    await expect(
      runCanvaOperation(
        { command: 'run-once', execute: true },
        deps,
        operatorEnvironment,
      ),
    ).resolves.toBe(2);
    expect(deps.worker.runOnce).not.toHaveBeenCalled();
    expect(deps.queue.inspect).not.toHaveBeenCalled();
  });

  it('refuses everything inside a test process, calling nothing', async () => {
    const { deps } = dependencies(workerOn);
    await expect(
      runCanvaOperation({ command: 'inspect', execute: false }, deps, {
        VITEST: 'true',
      }),
    ).resolves.toBe(2);
    expect(deps.queue.inspect).not.toHaveBeenCalled();
  });

  it('maintains only with --execute', async () => {
    const { deps, lines } = dependencies(storageOnly);
    await runCanvaOperation(
      { command: 'maintain', execute: false },
      deps,
      operatorEnvironment,
    );
    expect(deps.worker.maintain).not.toHaveBeenCalled();
    await expect(
      runCanvaOperation(
        { command: 'maintain', execute: true },
        deps,
        operatorEnvironment,
      ),
    ).resolves.toBe(0);
    expect(deps.worker.maintain).toHaveBeenCalledTimes(1);
    expect(lines.at(-1)).toMatch(/1 candidates expired/);
  });

  it('reports key retirement safety and reseals only with --execute', async () => {
    const { deps, lines } = dependencies(storageOnly);
    await runCanvaOperation(
      { command: 'reseal', execute: false },
      deps,
      operatorEnvironment,
    );
    expect(deps.reseal.run).not.toHaveBeenCalled();
    expect(lines).toContain(
      'Previous key 1: 3 rows; still in use, keep it configured',
    );
    await expect(
      runCanvaOperation(
        { command: 'reseal', execute: true, limit: 100 },
        deps,
        operatorEnvironment,
      ),
    ).resolves.toBe(0);
    expect(deps.reseal.run).toHaveBeenCalledWith({ limit: 100 });
  });

  it('exits 1 when a reseal was interrupted, so automation can rerun it', async () => {
    const { deps, lines } = dependencies(storageOnly);
    deps.reseal.run.mockResolvedValueOnce({
      currentKeyVersion: 2,
      scanned: 1,
      resealed: 0,
      skipped: 0,
      missingKey: 0,
      undecryptable: 0,
      newerKey: 0,
      interrupted: true,
      remaining: null,
    });
    await expect(
      runCanvaOperation(
        { command: 'reseal', execute: true },
        deps,
        operatorEnvironment,
      ),
    ).resolves.toBe(1);
    expect(lines.at(-1)).toMatch(/run it again to resume/);
  });
});

describe('runCanvaOperationsProcess: every refusal happens before boot', () => {
  // Parsed only, never connected to: the process refuses or boots first.
  const baseEnvironment: NodeJS.ProcessEnv = {
    DATABASE_URL: 'postgresql://ops-tests-must-not-connect@127.0.0.1:1/blocked',
    REDIS_URL: 'redis://127.0.0.1:1',
    JWT_ACCESS_SECRET: 'ops-test-only-secret-value-at-least-32-chars',
    CANVA_PROVIDER_MODE: 'canva',
    CANVA_CLIENT_ID: 'OC-test-client-id',
    CANVA_CLIENT_SECRET: 'test-only-client-secret-value',
    CANVA_REDIRECT_URI:
      'http://127.0.0.1:3000/api/v1/integrations/canva/oauth/callback',
    CANVA_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    CANVA_OAUTH_PERSISTENCE_ENABLED: 'true',
  };

  function harness(config = storageOnly) {
    const { deps, lines } = dependencies(config);
    const close = vi.fn(async () => undefined);
    const boot = vi.fn(async () => ({ dependencies: deps, close }));
    return { deps, lines, boot, close };
  }

  it.each([
    ['a test process', ['inspect'], { VITEST: 'true' }],
    [
      'mock mode (the development default)',
      ['inspect'],
      { CANVA_PROVIDER_MODE: 'mock' },
    ],
    [
      'durable storage off',
      ['maintain', '--execute'],
      { CANVA_OAUTH_PERSISTENCE_ENABLED: 'false' },
    ],
    [
      'run-once --execute without the worker flag',
      ['run-once', '--execute'],
      {},
    ],
    ['an unknown command', ['drop-everything'], {}],
    ['an invalid environment', ['inspect'], { DATABASE_URL: 'not a url' }],
    [
      'an invalid Canva configuration',
      ['inspect'],
      { CANVA_REDIRECT_URI: 'https://evil.example/x' },
    ],
  ])(
    'refuses %s with exit code 2 and never boots',
    async (_case, argv, overrides) => {
      const { boot, lines } = harness();
      await expect(
        runCanvaOperationsProcess(
          argv,
          { ...baseEnvironment, ...overrides },
          boot,
          (line) => lines.push(line),
        ),
      ).resolves.toBe(2);
      expect(boot).not.toHaveBeenCalled();
      // Messages name settings, never their values.
      expect(lines.join(' ')).not.toMatch(
        /ops-tests-must-not-connect|test-only-client-secret/,
      );
    },
  );

  it('boots only after every check passes, and always closes', async () => {
    const { boot, close, deps, lines } = harness();
    await expect(
      runCanvaOperationsProcess(['inspect'], baseEnvironment, boot, (line) =>
        lines.push(line),
      ),
    ).resolves.toBe(3);
    expect(boot).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(deps.queue.inspect).toHaveBeenCalled();
  });

  it('exits 1 and still closes when the operation fails', async () => {
    const { boot, close, deps } = harness();
    deps.queue.inspect.mockRejectedValueOnce(new Error('connection lost'));
    await expect(
      runCanvaOperationsProcess(
        ['inspect'],
        baseEnvironment,
        boot,
        () => undefined,
      ),
    ).resolves.toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('resolves with the reported exit code when close() fails, warning only through warn', async () => {
    const { boot, close, lines } = harness();
    close.mockRejectedValueOnce(new Error('disconnect failed'));
    const warnings: string[] = [];
    await expect(
      runCanvaOperationsProcess(
        ['inspect', '--json'],
        baseEnvironment,
        boot,
        (line) => lines.push(line),
        (line) => warnings.push(line),
      ),
    ).resolves.toBe(3);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      status: 'degraded',
      exitCode: 3,
    });
    expect(warnings).toEqual([CANVA_OPERATIONS_SHUTDOWN_WARNING]);
    expect(warnings.join('')).not.toContain('disconnect failed');
  });

  it('never rejects on a failed close() even without a warn sink', async () => {
    const { boot, close } = harness();
    close.mockRejectedValueOnce(new Error('disconnect failed'));
    await expect(
      runCanvaOperationsProcess(
        ['inspect'],
        baseEnvironment,
        boot,
        () => undefined,
      ),
    ).resolves.toBe(3);
  });
});

describe('runCanvaOperation during a key rotation', () => {
  it('reports a refused reseal (pre-staged key) as refused, not as a failure', async () => {
    const { deps, lines } = dependencies(storageOnly);
    deps.reseal.run.mockRejectedValueOnce(
      new CanvaResealRefusedError(
        'Refusing to reseal: a newer key version is configured than the current one. Promote it first.',
      ),
    );
    await expect(
      runCanvaOperation(
        { command: 'reseal', execute: true },
        deps,
        operatorEnvironment,
      ),
    ).resolves.toBe(2);
    expect(lines.at(-1)).toMatch(/Promote it first/);
  });

  it('lists a pre-staged key in the key report', async () => {
    const { deps, lines } = dependencies(storageOnly);
    deps.reseal.inventory.mockResolvedValueOnce({
      currentKeyVersion: 1,
      inventory: [],
      retirement: [],
      prestaged: [2],
    });
    await runCanvaOperation(
      { command: 'keys', execute: false },
      deps,
      operatorEnvironment,
    );
    expect(lines.join('\n')).toMatch(/Key 2 is configured but newer/);
  });
});

describe('canva:ops --json and exit codes (Stage 2.8)', () => {
  const healthyInspection = {
    counts: { queued: 1, in_flight: 0, exhausted: 0, finished: 2 },
    due: 1,
    crashed: 0,
    health: {
      revocationConfigurationErrors: 0,
      revocationKeyUnavailable: 0,
      connectionConfigurationErrors: 0,
    },
    preview: [],
  };
  // Test-only values that must never reach the output.
  const sensitive = [
    'test-only-client-secret-value',
    Buffer.alloc(32, 7).toString('base64'),
    'SEALED-CIPHERTEXT-VALUE',
    'RAW-REFRESH-TOKEN-VALUE',
    'canva-user-id-value',
  ];

  // The single JSON line, parsed. Fails when anything else was printed.
  function report(lines: string[]) {
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]) as Record<string, unknown>;
  }

  it('accepts --json with every command without changing the dry-run default', () => {
    expect(parseCanvaOperation(['inspect', '--json'])).toEqual({
      command: 'inspect',
      execute: false,
      json: true,
    });
    expect(parseCanvaOperation(['run-once', '--json'])).toMatchObject({
      execute: false,
    });
    expect(() => parseCanvaOperation(['keys', '--json', '--execute'])).toThrow(
      CanvaOperationRefused,
    );
  });

  it('prints only one JSON report for a healthy inspection and exits 0', async () => {
    const { deps, lines } = dependencies(workerOn);
    deps.queue.inspect.mockResolvedValueOnce(healthyInspection);
    await expect(
      runCanvaOperation(
        { command: 'inspect', execute: false, json: true },
        deps,
        operatorEnvironment,
      ),
    ).resolves.toBe(0);
    expect(report(lines)).toEqual({
      command: 'inspect',
      execute: false,
      status: 'ok',
      exitCode: 0,
      degraded: [],
      queue: {
        queued: 1,
        inFlight: 0,
        exhausted: 0,
        finished: 2,
        due: 1,
        crashed: 0,
        health: {
          revocationConfigurationErrors: 0,
          revocationKeyUnavailable: 0,
          connectionConfigurationErrors: 0,
        },
        preview: [],
      },
    });
  });

  it.each([
    [
      'paused revocations',
      { revocationConfigurationErrors: 2 },
      ['configuration_errors'],
    ],
    [
      'a connection with a token-endpoint configuration error',
      { connectionConfigurationErrors: 1 },
      ['configuration_errors'],
    ],
    [
      'revocations waiting for an encryption key',
      { revocationKeyUnavailable: 1 },
      ['missing_encryption_keys'],
    ],
  ] as const)(
    'reports %s from inspect as degraded, in JSON and text',
    async (_case, counts, reasons) => {
      const health = {
        revocationConfigurationErrors: 0,
        revocationKeyUnavailable: 0,
        connectionConfigurationErrors: 0,
        ...counts,
      };
      const json = dependencies(workerOn);
      json.deps.queue.inspect.mockResolvedValueOnce({
        ...healthyInspection,
        health,
      });
      await expect(
        runCanvaOperation(
          { command: 'inspect', execute: false, json: true },
          json.deps,
          operatorEnvironment,
        ),
      ).resolves.toBe(3);
      expect(report(json.lines)).toMatchObject({
        status: 'degraded',
        degraded: reasons,
        queue: { health },
      });

      const text = dependencies(workerOn);
      text.deps.queue.inspect.mockResolvedValueOnce({
        ...healthyInspection,
        health,
      });
      await expect(
        runCanvaOperation(
          { command: 'inspect', execute: false },
          text.deps,
          operatorEnvironment,
        ),
      ).resolves.toBe(3);
      expect(text.lines).toContain(
        `Configuration: ${health.revocationConfigurationErrors} revocations paused (client credentials refused), ${health.revocationKeyUnavailable} paused (encryption key unavailable), ${health.connectionConfigurationErrors} connections with a token-endpoint configuration error`,
      );
      expect(text.lines.at(-1)).toBe(
        `Status: degraded (${reasons.join(', ')})`,
      );
    },
  );

  it('reports exhausted rows and crashed calls as degraded (exit 3)', async () => {
    const { deps, lines } = dependencies(workerOn);
    await expect(
      runCanvaOperation(
        { command: 'inspect', execute: false, json: true },
        deps,
        operatorEnvironment,
      ),
    ).resolves.toBe(3);
    expect(report(lines)).toMatchObject({
      status: 'degraded',
      exitCode: 3,
      degraded: ['exhausted_revocations', 'crashed_calls'],
      queue: { exhausted: 1, crashed: 1, inFlight: 1 },
    });
  });

  it('keeps run-once a preview under --json, calling no worker', async () => {
    const { deps, lines } = dependencies(workerOn);
    deps.queue.inspect.mockResolvedValueOnce(healthyInspection);
    await expect(
      runCanvaOperation(
        { command: 'run-once', execute: false, json: true },
        deps,
        operatorEnvironment,
      ),
    ).resolves.toBe(0);
    expect(deps.worker.runOnce).not.toHaveBeenCalled();
    expect(report(lines)).toMatchObject({
      command: 'run-once',
      execute: false,
      status: 'ok',
    });
  });

  it('reports a healthy worker batch as ok', async () => {
    const { deps, lines } = dependencies(workerOn);
    await expect(
      runCanvaOperation(
        { command: 'run-once', execute: true, json: true },
        deps,
        operatorEnvironment,
      ),
    ).resolves.toBe(0);
    expect(report(lines)).toEqual({
      command: 'run-once',
      execute: true,
      status: 'ok',
      exitCode: 0,
      degraded: [],
      worker: {
        claimed: 2,
        sent: 1,
        skipped: 1,
        exhausted: 0,
        abandoned: 0,
        keyUnavailable: 0,
        configurationErrors: 0,
      },
    });
  });

  it.each([
    ['exhausted', 'exhausted_revocations'],
    ['keyUnavailable', 'missing_encryption_keys'],
    ['configurationErrors', 'configuration_errors'],
    ['abandoned', 'send_deadline_missed'],
  ] as const)(
    'never reports a batch with %s as healthy, in JSON or text',
    async (field, reason) => {
      const batch = {
        claimed: 1,
        sent: 0,
        skipped: 0,
        exhausted: 0,
        abandoned: 0,
        keyUnavailable: 0,
        configurationErrors: 0,
        [field]: 1,
      };
      const json = dependencies(workerOn);
      json.deps.worker.runOnce.mockResolvedValueOnce(batch);
      await expect(
        runCanvaOperation(
          { command: 'run-once', execute: true, json: true },
          json.deps,
          operatorEnvironment,
        ),
      ).resolves.toBe(3);
      expect(report(json.lines)).toMatchObject({
        status: 'degraded',
        degraded: [reason],
      });

      const text = dependencies(workerOn);
      text.deps.worker.runOnce.mockResolvedValueOnce(batch);
      await expect(
        runCanvaOperation(
          { command: 'run-once', execute: true },
          text.deps,
          operatorEnvironment,
        ),
      ).resolves.toBe(3);
      expect(text.lines.at(-1)).toBe(`Status: degraded (${reason})`);
    },
  );

  it('reports maintenance counts as ok', async () => {
    const { deps, lines } = dependencies(storageOnly);
    await expect(
      runCanvaOperation(
        { command: 'maintain', execute: true, json: true },
        deps,
        operatorEnvironment,
      ),
    ).resolves.toBe(0);
    expect(report(lines)).toMatchObject({
      status: 'ok',
      maintenance: { expiredCandidates: 1, purged: 3 },
    });
  });

  it('reports stored values under an unconfigured key version as degraded', async () => {
    // storageOnly has key version 1 only; the fixture stores rows under 2.
    const json = dependencies(storageOnly);
    await expect(
      runCanvaOperation(
        { command: 'keys', execute: false, json: true },
        json.deps,
        operatorEnvironment,
      ),
    ).resolves.toBe(3);
    expect(report(json.lines)).toMatchObject({
      status: 'degraded',
      degraded: ['missing_encryption_keys'],
      keys: { missingKeyVersions: [2] },
    });
    expect(json.deps.reseal.run).not.toHaveBeenCalled();

    const text = dependencies(storageOnly);
    await expect(
      runCanvaOperation(
        { command: 'keys', execute: false },
        text.deps,
        operatorEnvironment,
      ),
    ).resolves.toBe(3);
    expect(text.lines).toContain(
      'Key 2 is used by stored values but not configured here: restore it on every instance',
    );
  });

  it('reports a key inventory this process can open as ok', async () => {
    const { deps, lines } = dependencies(storageOnly);
    deps.reseal.inventory.mockResolvedValueOnce({
      currentKeyVersion: 1,
      inventory: [{ kind: 'credential' as const, keyVersion: 1, rows: 4 }],
      retirement: [],
      prestaged: [],
    });
    await expect(
      runCanvaOperation(
        { command: 'keys', execute: false, json: true },
        deps,
        operatorEnvironment,
      ),
    ).resolves.toBe(0);
    expect(report(lines)).toMatchObject({
      status: 'ok',
      keys: { missingKeyVersions: [] },
    });
  });

  it('reports reseal rows it could not open as degraded, and an interruption as failed', async () => {
    const { deps, lines } = dependencies(storageOnly);
    deps.reseal.run.mockResolvedValueOnce({
      currentKeyVersion: 2,
      scanned: 4,
      resealed: 2,
      skipped: 0,
      missingKey: 1,
      undecryptable: 1,
      newerKey: 0,
      interrupted: false,
      remaining: 2,
    });
    await expect(
      runCanvaOperation(
        { command: 'reseal', execute: true, json: true },
        deps,
        operatorEnvironment,
      ),
    ).resolves.toBe(3);
    expect(report(lines)).toMatchObject({
      status: 'degraded',
      degraded: ['missing_encryption_keys', 'undecryptable_values'],
      reseal: { missingKey: 1, undecryptable: 1 },
    });

    const interrupted = dependencies(storageOnly);
    interrupted.deps.reseal.run.mockResolvedValueOnce({
      currentKeyVersion: 2,
      scanned: 1,
      resealed: 0,
      skipped: 0,
      missingKey: 0,
      undecryptable: 0,
      newerKey: 0,
      interrupted: true,
      remaining: null,
    });
    await expect(
      runCanvaOperation(
        { command: 'reseal', execute: true, json: true },
        interrupted.deps,
        operatorEnvironment,
      ),
    ).resolves.toBe(1);
    expect(report(interrupted.lines)).toMatchObject({
      status: 'failed',
      exitCode: 1,
    });
  });

  it('reports refusals as JSON with exit 2, calling nothing', async () => {
    const worker = dependencies(storageOnly);
    await expect(
      runCanvaOperation(
        { command: 'run-once', execute: true, json: true },
        worker.deps,
        operatorEnvironment,
      ),
    ).resolves.toBe(2);
    expect(worker.deps.worker.runOnce).not.toHaveBeenCalled();
    expect(report(worker.lines)).toMatchObject({
      status: 'refused',
      exitCode: 2,
      message: expect.stringMatching(/CANVA_REVOCATION_WORKER_ENABLED/),
    });

    const rotation = dependencies(storageOnly);
    rotation.deps.reseal.run.mockRejectedValueOnce(
      new CanvaResealRefusedError('Refusing to reseal: promote it first.'),
    );
    await expect(
      runCanvaOperation(
        { command: 'reseal', execute: true, json: true },
        rotation.deps,
        operatorEnvironment,
      ),
    ).resolves.toBe(2);
    expect(report(rotation.lines)).toMatchObject({ status: 'refused' });
  });

  it('never copies tokens, ciphertext, keys, or secrets into the report', async () => {
    const { deps, lines } = dependencies(workerOn);
    // A store that returned more than its type: extra fields must not leak.
    const extra = {
      refreshToken: 'RAW-REFRESH-TOKEN-VALUE',
      ciphertext: 'SEALED-CIPHERTEXT-VALUE',
      canvaUserId: 'canva-user-id-value',
    };
    deps.queue.inspect.mockResolvedValueOnce({
      counts: { queued: 1, in_flight: 0, exhausted: 0, finished: 0 },
      due: 1,
      crashed: 0,
      health: {
        revocationConfigurationErrors: 0,
        revocationKeyUnavailable: 0,
        connectionConfigurationErrors: 0,
      },
      preview: [
        {
          id: 'revocation-9',
          organizationId: 'org-1',
          reason: 'disconnect' as const,
          state: 'queued' as const,
          attempts: 0,
          recovering: false,
          wouldDo: 'send' as const,
          ...extra,
        },
      ],
    });
    await runCanvaOperation(
      { command: 'inspect', execute: false, json: true },
      deps,
      operatorEnvironment,
    );
    deps.worker.runOnce.mockResolvedValueOnce({
      claimed: 0,
      sent: 0,
      skipped: 0,
      exhausted: 0,
      abandoned: 0,
      keyUnavailable: 0,
      configurationErrors: 0,
      ...extra,
    });
    await runCanvaOperation(
      { command: 'run-once', execute: true, json: true },
      deps,
      operatorEnvironment,
    );
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).queue.preview[0]).toEqual({
      id: 'revocation-9',
      organizationId: 'org-1',
      reason: 'disconnect',
      state: 'queued',
      attempts: 0,
      recovering: false,
      wouldDo: 'send',
    });
    for (const value of sensitive)
      expect(lines.join('\n')).not.toContain(value);
  });

  describe('the process', () => {
    const baseEnvironment: NodeJS.ProcessEnv = {
      DATABASE_URL:
        'postgresql://ops-tests-must-not-connect@127.0.0.1:1/blocked',
      REDIS_URL: 'redis://127.0.0.1:1',
      JWT_ACCESS_SECRET: 'ops-test-only-secret-value-at-least-32-chars',
      CANVA_PROVIDER_MODE: 'canva',
      CANVA_CLIENT_ID: 'OC-test-client-id',
      CANVA_CLIENT_SECRET: 'test-only-client-secret-value',
      CANVA_REDIRECT_URI:
        'http://127.0.0.1:3000/api/v1/integrations/canva/oauth/callback',
      CANVA_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      CANVA_OAUTH_PERSISTENCE_ENABLED: 'true',
    };

    function harness() {
      const { deps, lines } = dependencies(storageOnly);
      const close = vi.fn(async () => undefined);
      const boot = vi.fn(async () => ({ dependencies: deps, close }));
      return { deps, lines, boot, close };
    }

    it.each([
      ['a test process', ['inspect', '--json'], { VITEST: 'true' }],
      ['mock mode', ['inspect', '--json'], { CANVA_PROVIDER_MODE: 'mock' }],
      [
        'run-once --execute without the worker flag',
        ['run-once', '--execute', '--json'],
        {},
      ],
      ['an unknown option', ['inspect', '--json', '--force'], {}],
      ['an unknown command', ['drop-everything', '--json'], {}],
      [
        'an invalid Canva configuration',
        ['inspect', '--json'],
        { CANVA_REDIRECT_URI: 'https://evil.example/x' },
      ],
    ])(
      'refuses %s as one JSON report, exit 2, without booting',
      async (_case, argv, overrides) => {
        const { boot, lines } = harness();
        await expect(
          runCanvaOperationsProcess(
            argv,
            { ...baseEnvironment, ...overrides },
            boot,
            (line) => lines.push(line),
          ),
        ).resolves.toBe(2);
        expect(boot).not.toHaveBeenCalled();
        expect(report(lines)).toMatchObject({
          status: 'refused',
          exitCode: 2,
          degraded: [],
        });
        expect(lines[0]).not.toMatch(
          /ops-tests-must-not-connect|test-only-client-secret|ops-test-only-secret/,
        );
      },
    );

    it('reports a failure as JSON (exit 1) without the error text, and closes', async () => {
      const { boot, close, deps, lines } = harness();
      deps.queue.inspect.mockRejectedValueOnce(
        new Error(
          'connection to postgresql://ops-tests-must-not-connect@127.0.0.1 failed',
        ),
      );
      await expect(
        runCanvaOperationsProcess(
          ['inspect', '--json'],
          baseEnvironment,
          boot,
          (line) => lines.push(line),
        ),
      ).resolves.toBe(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(report(lines)).toMatchObject({
        command: 'inspect',
        status: 'failed',
        exitCode: 1,
      });
      expect(lines[0]).not.toContain('ops-tests-must-not-connect');
    });
  });
});
