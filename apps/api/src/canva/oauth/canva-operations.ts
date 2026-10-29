import { validateEnvironment } from '../../config/environment';
import {
  parseCanvaEnvironment,
  type CanvaOAuthConfig,
} from './canva-oauth.config';
import type {
  CanvaKeyInventory,
  CanvaRevocationInspection,
  CanvaRevocationQueueStore,
} from './canva-oauth.stores';
import type {
  CanvaRevocationRunSummary,
  CanvaRevocationWorker,
} from './canva-revocation.worker';
import {
  CanvaResealRefusedError,
  type CanvaKeyReport,
  type CanvaResealSummary,
  type CanvaTokenResealService,
} from './canva-token-reseal.service';

// The operator command for the revocation worker, maintenance, and the key
// reseal (canva-operations.main.ts is the process entry point). Every
// command is a dry run unless --execute is given, and only `run-once
// --execute` can reach Canva. Output carries counts, row IDs, organization
// IDs, key versions, and reasons: never tokens, ciphertext, keys, secrets,
// Canva IDs, or display names. The --json report is built field by field
// from those values, so nothing else a store returns can reach it.

export const CANVA_OPERATIONS_USAGE = `Usage: canva-operations <command> [options]

Commands (each is a dry run unless --execute is given):
  inspect                Read-only queue summary and a preview of what the
                         worker would do. No writes, no Canva requests.
  run-once [--limit N]   Run one worker batch (default 10 rows). Calls Canva's
                         revoke endpoint. Needs CANVA_REVOCATION_WORKER_ENABLED=true.
  maintain               Candidate expiry, 30-day abandon, 90-day purge, and
                         the account-hold sweep. Writes; no Canva requests.
  keys                   Read-only key-version inventory and which previous
                         keys are safe to retire.
  reseal [--limit N]     Re-encrypt stored values under the current key
                         (default 1000 rows). Writes; no Canva requests.

Options:
  --execute              Perform the command instead of previewing it.
  --limit N              Rows per run, 1 to 1000.
  --json                 Print one JSON report on stdout instead of text.

Exit codes:
  0  done, nothing needs attention
  1  failed or incomplete; safe to run again
  2  refused by a safety check; nothing was done
  3  done, but a degraded state needs attention (see "degraded")`;

// Exit codes. 3 is new in Stage 2.8: before it, a degraded state (exhausted
// revocations, a missing key) exited 0 and looked healthy.
export const CANVA_OPERATION_EXIT_CODES = {
  ok: 0,
  failed: 1,
  refused: 2,
  degraded: 3,
} as const;

export type CanvaOperationStatus = keyof typeof CANVA_OPERATION_EXIT_CODES;

// The degraded states, each defined by a count this command can read:
// - exhausted_revocations: rows waiting for an administrator's retry or
//   dismissal, or rows this batch exhausted.
// - crashed_calls: in_flight rows whose claim expired (a worker stopped
//   mid-call). The next batch recovers them; persisting ones need attention.
// - missing_encryption_keys: stored values, or a revocation this batch
//   could not send, sealed with a key version this process does not have;
//   for inspect, unfinished revocations last requeued for that reason.
// - configuration_errors: Canva refused the client credentials (a batch,
//   unfinished revocations last refused so, or connections whose last
//   token-endpoint refusal was a configuration problem).
// - send_deadline_missed: the process stalled between deciding and sending.
// - undecryptable_values: a configured key could not open a stored value.
export type CanvaDegradedReason =
  | 'exhausted_revocations'
  | 'crashed_calls'
  | 'missing_encryption_keys'
  | 'configuration_errors'
  | 'send_deadline_missed'
  | 'undecryptable_values';

export type CanvaOperationCommand =
  'inspect' | 'run-once' | 'maintain' | 'keys' | 'reseal';

export type CanvaOperationRequest = {
  command: CanvaOperationCommand;
  execute: boolean;
  limit?: number;
  json?: boolean;
};

const COMMANDS = new Set<string>([
  'inspect',
  'run-once',
  'maintain',
  'keys',
  'reseal',
]);

export class CanvaOperationRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanvaOperationRefused';
  }
}

export function parseCanvaOperation(argv: string[]): CanvaOperationRequest {
  const [command, ...rest] = argv;
  if (!command || !COMMANDS.has(command))
    throw new CanvaOperationRefused(CANVA_OPERATIONS_USAGE);
  const request: CanvaOperationRequest = {
    command: command as CanvaOperationCommand,
    execute: false,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (option === '--execute') request.execute = true;
    else if (option === '--json') request.json = true;
    else if (option === '--limit') {
      const value = Number(rest[(index += 1)]);
      if (!Number.isInteger(value) || value < 1 || value > 1_000)
        throw new CanvaOperationRefused(
          '--limit must be an integer from 1 to 1000',
        );
      request.limit = value;
    } else
      throw new CanvaOperationRefused(
        `Unknown option ${option}\n${CANVA_OPERATIONS_USAGE}`,
      );
  }
  if (
    request.limit !== undefined &&
    !['run-once', 'reseal', 'inspect'].includes(request.command)
  )
    throw new CanvaOperationRefused(
      `--limit does not apply to ${request.command}`,
    );
  // Read-only commands have nothing to execute; refusing the flag keeps it
  // from ever suggesting a change that did not happen.
  if (
    request.execute &&
    (request.command === 'inspect' || request.command === 'keys')
  )
    throw new CanvaOperationRefused(
      `${request.command} is read-only and takes no --execute`,
    );
  return request;
}

// Checked before the process boots anything, so a refused command never
// opens a database connection. Ordinary development and test runs refuse:
// the default configuration is mock mode with storage and the worker off.
export function assertCanvaOperationAllowed(
  request: CanvaOperationRequest,
  config: CanvaOAuthConfig,
  environment: NodeJS.ProcessEnv,
): void {
  if (environment.VITEST || environment.NODE_ENV === 'test')
    throw new CanvaOperationRefused('Refusing to run inside a test process');
  if (config.mode !== 'canva')
    throw new CanvaOperationRefused(
      'Refusing: CANVA_PROVIDER_MODE is not canva (mock mode has nothing to operate)',
    );
  if (!config.persistence)
    throw new CanvaOperationRefused(
      'Refusing: CANVA_OAUTH_PERSISTENCE_ENABLED is not true',
    );
  if (
    request.command === 'run-once' &&
    request.execute &&
    !config.revocationWorker
  )
    throw new CanvaOperationRefused(
      'Refusing: run-once --execute calls Canva and needs CANVA_REVOCATION_WORKER_ENABLED=true',
    );
}

export type CanvaOperationDependencies = {
  config: CanvaOAuthConfig;
  worker: Pick<CanvaRevocationWorker, 'enabled' | 'runOnce' | 'maintain'>;
  queue: Pick<CanvaRevocationQueueStore, 'inspect'>;
  reseal: Pick<CanvaTokenResealService, 'inventory' | 'run'>;
  write: (line: string) => void;
};

// The --json report: one object, printed as a single line.
export type CanvaOperationReport = {
  command: CanvaOperationCommand | null;
  execute: boolean;
  status: CanvaOperationStatus;
  exitCode: number;
  degraded: CanvaDegradedReason[];
  // Refusals and failures only: fixed text naming settings, never values.
  message?: string;
  queue?: {
    queued: number;
    inFlight: number;
    exhausted: number;
    finished: number;
    due: number;
    crashed: number;
    preview: Array<{
      id: string;
      organizationId: string;
      reason: string;
      state: string;
      attempts: number;
      recovering: boolean;
      wouldDo: string;
    }>;
    health: CanvaRevocationInspection['health'];
  };
  worker?: CanvaRevocationRunSummary;
  maintenance?: {
    expiredCandidates: number;
    abandoned: number;
    purged: number;
    releasedHolds: number;
    deletedAccounts: number;
  };
  keys?: {
    currentKeyVersion: number;
    inventory: Array<{ kind: string; keyVersion: number; rows: number }>;
    retirement: Array<{
      keyVersion: number;
      rows: number;
      safeToRetire: boolean;
    }>;
    prestaged: number[];
    missingKeyVersions: number[];
  };
  reseal?: CanvaResealSummary;
};

const PREVIEW_LIMIT = 20;

function queueReport(
  inspection: CanvaRevocationInspection,
): NonNullable<CanvaOperationReport['queue']> {
  const { counts } = inspection;
  return {
    queued: counts.queued,
    inFlight: counts.in_flight,
    exhausted: counts.exhausted,
    finished: counts.finished,
    due: inspection.due,
    crashed: inspection.crashed,
    preview: inspection.preview.map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      reason: row.reason,
      state: row.state,
      attempts: row.attempts,
      recovering: row.recovering,
      wouldDo: row.wouldDo,
    })),
    health: {
      revocationConfigurationErrors:
        inspection.health.revocationConfigurationErrors,
      revocationKeyUnavailable: inspection.health.revocationKeyUnavailable,
      connectionConfigurationErrors:
        inspection.health.connectionConfigurationErrors,
    },
  };
}

function workerReport(
  summary: CanvaRevocationRunSummary,
): CanvaRevocationRunSummary {
  return {
    claimed: summary.claimed,
    sent: summary.sent,
    skipped: summary.skipped,
    exhausted: summary.exhausted,
    abandoned: summary.abandoned,
    keyUnavailable: summary.keyUnavailable,
    configurationErrors: summary.configurationErrors,
  };
}

function resealReport(summary: CanvaResealSummary): CanvaResealSummary {
  return {
    currentKeyVersion: summary.currentKeyVersion,
    scanned: summary.scanned,
    resealed: summary.resealed,
    skipped: summary.skipped,
    missingKey: summary.missingKey,
    undecryptable: summary.undecryptable,
    newerKey: summary.newerKey,
    interrupted: summary.interrupted,
    remaining: summary.remaining,
  };
}

// Key versions that stored values use but this process cannot open.
function missingKeyVersions(
  inventory: CanvaKeyInventory,
  config: CanvaOAuthConfig,
): number[] {
  if (config.mode !== 'canva') return [];
  const missing = inventory
    .filter(
      (entry) => entry.rows > 0 && !config.keyring.hasKey(entry.keyVersion),
    )
    .map((entry) => entry.keyVersion);
  return [...new Set(missing)].sort((a, b) => a - b);
}

function keysReport(
  report: CanvaKeyReport,
  config: CanvaOAuthConfig,
): NonNullable<CanvaOperationReport['keys']> {
  return {
    currentKeyVersion: report.currentKeyVersion,
    inventory: report.inventory.map((entry) => ({
      kind: entry.kind,
      keyVersion: entry.keyVersion,
      rows: entry.rows,
    })),
    retirement: report.retirement.map((key) => ({
      keyVersion: key.keyVersion,
      rows: key.rows,
      safeToRetire: key.safeToRetire,
    })),
    prestaged: [...report.prestaged],
    missingKeyVersions: missingKeyVersions(report.inventory, config),
  };
}

function writeInspection(
  inspection: CanvaRevocationInspection,
  write: (line: string) => void,
): void {
  const { counts } = inspection;
  write(
    `Queue: ${counts.queued} queued, ${counts.in_flight} in flight, ${counts.exhausted} exhausted, ${counts.finished} finished`,
  );
  write(
    `Due now: ${inspection.due}; crashed calls to recover: ${inspection.crashed}`,
  );
  for (const row of inspection.preview)
    write(
      `  ${row.id} org=${row.organizationId} reason=${row.reason} attempts=${row.attempts}${row.recovering ? ' recovering' : ''} -> ${row.wouldDo}`,
    );
  if (counts.exhausted)
    write(
      'Exhausted rows wait for an administrator: Retry or Dismiss in the Canva integration panel.',
    );
  const { health } = inspection;
  write(
    `Configuration: ${health.revocationConfigurationErrors} revocations paused (client credentials refused), ${health.revocationKeyUnavailable} paused (encryption key unavailable), ${health.connectionConfigurationErrors} connections with a token-endpoint configuration error`,
  );
}

function writeKeys(
  keys: NonNullable<CanvaOperationReport['keys']>,
  write: (line: string) => void,
): void {
  write(`Current key version: ${keys.currentKeyVersion}`);
  for (const entry of keys.inventory)
    write(`  ${entry.kind} key ${entry.keyVersion}: ${entry.rows} rows`);
  for (const key of keys.retirement)
    write(
      `Previous key ${key.keyVersion}: ${key.rows} rows; ${key.safeToRetire ? 'safe to retire' : 'still in use, keep it configured'}`,
    );
  for (const version of keys.prestaged)
    write(
      `Key ${version} is configured but newer than the current key (pre-staged): promote it on every instance before resealing`,
    );
  for (const version of keys.missingKeyVersions)
    write(
      `Key ${version} is used by stored values but not configured here: restore it on every instance`,
    );
}

function inspectionDegraded(
  inspection: CanvaRevocationInspection,
): CanvaDegradedReason[] {
  const reasons: CanvaDegradedReason[] = [];
  if (inspection.counts.exhausted > 0) reasons.push('exhausted_revocations');
  if (inspection.crashed > 0) reasons.push('crashed_calls');
  const { health } = inspection;
  if (
    health.revocationConfigurationErrors > 0 ||
    health.connectionConfigurationErrors > 0
  )
    reasons.push('configuration_errors');
  if (health.revocationKeyUnavailable > 0)
    reasons.push('missing_encryption_keys');
  return reasons;
}

function workerDegraded(
  summary: CanvaRevocationRunSummary,
): CanvaDegradedReason[] {
  const reasons: CanvaDegradedReason[] = [];
  if (summary.exhausted > 0) reasons.push('exhausted_revocations');
  if (summary.keyUnavailable > 0) reasons.push('missing_encryption_keys');
  if (summary.configurationErrors > 0) reasons.push('configuration_errors');
  if (summary.abandoned > 0) reasons.push('send_deadline_missed');
  return reasons;
}

function resealDegraded(summary: CanvaResealSummary): CanvaDegradedReason[] {
  const reasons: CanvaDegradedReason[] = [];
  if (summary.missingKey > 0) reasons.push('missing_encryption_keys');
  if (summary.undecryptable > 0) reasons.push('undecryptable_values');
  return reasons;
}

// Prints the outcome (the JSON report, or a status line for a degraded text
// run) and returns the exit code.
type ReportTarget = {
  command: CanvaOperationCommand | null;
  execute: boolean;
  json?: boolean;
};

function finish(
  request: ReportTarget,
  report: Omit<
    CanvaOperationReport,
    'status' | 'exitCode' | 'command' | 'execute'
  >,
  outcome: 'done' | 'failed' | 'refused',
  write: (line: string) => void,
): number {
  const degraded = [...new Set(report.degraded)];
  const status: CanvaOperationStatus =
    outcome === 'done' ? (degraded.length ? 'degraded' : 'ok') : outcome;
  const exitCode = CANVA_OPERATION_EXIT_CODES[status];
  if (request.json)
    write(
      JSON.stringify({
        command: request.command,
        execute: request.execute,
        status,
        exitCode,
        ...report,
        degraded,
      } satisfies CanvaOperationReport),
    );
  else if (status === 'degraded')
    write(`Status: degraded (${degraded.join(', ')})`);
  return exitCode;
}

// Returns the process exit code (CANVA_OPERATION_EXIT_CODES).
export async function runCanvaOperation(
  request: CanvaOperationRequest,
  dependencies: CanvaOperationDependencies,
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  const { worker, queue, reseal, write } = dependencies;
  // In JSON mode the report is the only output.
  const text = (line: string) => {
    if (!request.json) write(line);
  };
  try {
    assertCanvaOperationAllowed(request, dependencies.config, environment);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Refused';
    text(message);
    return finish(request, { degraded: [], message }, 'refused', write);
  }
  const config = dependencies.config;
  if (config.mode === 'canva')
    text(
      `Canva mode: durable storage on, worker ${config.revocationWorker ? 'on' : 'off'}`,
    );
  switch (request.command) {
    case 'inspect': {
      const inspection = await queue.inspect(request.limit ?? PREVIEW_LIMIT);
      writeInspection(inspection, text);
      return finish(
        request,
        {
          degraded: inspectionDegraded(inspection),
          queue: queueReport(inspection),
        },
        'done',
        write,
      );
    }
    case 'run-once': {
      if (!request.execute) {
        const inspection = await queue.inspect(request.limit ?? PREVIEW_LIMIT);
        writeInspection(inspection, text);
        text(
          'Dry run: nothing was claimed or sent. Add --execute to run one batch.',
        );
        return finish(
          request,
          {
            degraded: inspectionDegraded(inspection),
            queue: queueReport(inspection),
          },
          'done',
          write,
        );
      }
      if (!worker.enabled) {
        const message = 'Refusing: the revocation worker is not enabled';
        text(message);
        return finish(request, { degraded: [], message }, 'refused', write);
      }
      const summary = await worker.runOnce({ limit: request.limit });
      text(
        `Worker batch: ${summary.claimed} claimed, ${summary.sent} sent, ${summary.skipped} skipped (shared consent), ${summary.exhausted} exhausted, ${summary.abandoned} not sent (deadline), ${summary.keyUnavailable} not sent (encryption key unavailable), ${summary.configurationErrors} paused (client credentials refused)`,
      );
      return finish(
        request,
        { degraded: workerDegraded(summary), worker: workerReport(summary) },
        'done',
        write,
      );
    }
    case 'maintain': {
      if (!request.execute) {
        const inspection = await queue.inspect(PREVIEW_LIMIT);
        writeInspection(inspection, text);
        text('Dry run: nothing was changed. Add --execute to run maintenance.');
        return finish(
          request,
          {
            degraded: inspectionDegraded(inspection),
            queue: queueReport(inspection),
          },
          'done',
          write,
        );
      }
      const result = await worker.maintain();
      if (!result) {
        const message = 'Refusing: durable storage is not enabled';
        text(message);
        return finish(request, { degraded: [], message }, 'refused', write);
      }
      text(
        `Maintenance: ${result.expiredCandidates} candidates expired, ${result.abandoned} exhausted rows abandoned, ${result.purged} finished rows purged, ${result.releasedHolds} holds released, ${result.deletedAccounts} accounts deleted`,
      );
      return finish(
        request,
        {
          degraded: [],
          maintenance: {
            expiredCandidates: result.expiredCandidates,
            abandoned: result.abandoned,
            purged: result.purged,
            releasedHolds: result.releasedHolds,
            deletedAccounts: result.deletedAccounts,
          },
        },
        'done',
        write,
      );
    }
    case 'keys':
    case 'reseal': {
      if (request.command === 'keys' || !request.execute) {
        const keys = keysReport(await reseal.inventory(), config);
        writeKeys(keys, text);
        if (request.command === 'reseal')
          text('Dry run: nothing was re-encrypted. Add --execute to reseal.');
        return finish(
          request,
          {
            degraded: keys.missingKeyVersions.length
              ? ['missing_encryption_keys']
              : [],
            keys,
          },
          'done',
          write,
        );
      }
      let summary;
      try {
        summary = await reseal.run({ limit: request.limit });
      } catch (error: unknown) {
        if (!(error instanceof CanvaResealRefusedError)) throw error;
        text(error.message);
        return finish(
          request,
          { degraded: [], message: error.message },
          'refused',
          write,
        );
      }
      text(
        `Reseal to key ${summary.currentKeyVersion}: ${summary.resealed} resealed, ${summary.skipped} skipped (changed or busy), ${summary.missingKey} with no configured key, ${summary.undecryptable} undecryptable, ${summary.newerKey} under a newer key (left alone), ${summary.remaining ?? 'unknown'} remaining`,
      );
      if (summary.interrupted)
        text('Interrupted by a storage failure; run it again to resume.');
      return finish(
        request,
        { degraded: resealDegraded(summary), reseal: resealReport(summary) },
        summary.interrupted ? 'failed' : 'done',
        write,
      );
    }
  }
}

// What the process entry point boots after every check has passed: the
// application context (which is what opens database connections) and the
// dependencies it provides.
export type CanvaOperationsBoot = () => Promise<{
  dependencies: Omit<CanvaOperationDependencies, 'write'>;
  close: () => Promise<void>;
}>;

// Whether the arguments ask for JSON output, read before parsing so that a
// refused command line still answers in the format requested.
export function wantsJson(argv: string[]): boolean {
  return argv.includes('--json');
}

// Printed (to `warn`, stderr in the CLI) when the application context does
// not shut down cleanly. Fixed text: the error itself is never printed.
export const CANVA_OPERATIONS_SHUTDOWN_WARNING =
  'Warning: the application did not shut down cleanly; the result reported above stands.';

// The whole process: parse the command, validate the environment, and
// apply every refusal BEFORE `boot` runs, so a refused command never opens
// a database connection. Returns the exit code (CANVA_OPERATION_EXIT_CODES).
// It never rejects because of shutdown: see the end of the function.
export async function runCanvaOperationsProcess(
  argv: string[],
  environment: NodeJS.ProcessEnv,
  boot: CanvaOperationsBoot,
  write: (line: string) => void,
  warn: (line: string) => void = () => undefined,
): Promise<number> {
  const json = wantsJson(argv);
  let request: CanvaOperationRequest;
  try {
    request = parseCanvaOperation(argv);
    validateEnvironment(environment);
    assertCanvaOperationAllowed(
      request,
      parseCanvaEnvironment(environment),
      environment,
    );
  } catch (error: unknown) {
    // Validation messages name settings, never their values.
    const message = error instanceof Error ? error.message : 'Refused';
    if (!json) write(message);
    const command = COMMANDS.has(argv[0] ?? '')
      ? (argv[0] as CanvaOperationCommand)
      : null;
    return finish(
      { command, execute: argv.includes('--execute'), json },
      { degraded: [], message },
      'refused',
      write,
    );
  }
  let app: Awaited<ReturnType<CanvaOperationsBoot>>;
  try {
    app = await boot();
  } catch {
    // The application could not start (for example a module failed to
    // initialize). Nothing ran; the error is not printed, as below.
    if (!json)
      write(
        'The application could not start; see the log above. Nothing was done.',
      );
    return finish(
      request,
      {
        degraded: [],
        message:
          'The application could not start; see the log. Nothing was done.',
      },
      'failed',
      write,
    );
  }
  let exitCode: number;
  try {
    exitCode = await runCanvaOperation(
      request,
      { ...app.dependencies, write },
      environment,
    );
  } catch {
    // Every step is idempotent and resumable; nothing is retried here. The
    // error is never printed: its message could carry values.
    if (!json)
      write('The operation failed; see the log above. Run it again to resume.');
    exitCode = finish(
      request,
      {
        degraded: [],
        message: 'The operation failed; see the log. Run it again to resume.',
      },
      'failed',
      write,
    );
  }
  // The report is already printed, and the operation's writes either
  // committed or did not before shutdown began, so a failed close() cannot
  // change the result: the exit code stays the one the report states, and
  // only a fixed warning is printed.
  try {
    await app.close();
  } catch {
    warn(CANVA_OPERATIONS_SHUTDOWN_WARNING);
  }
  return exitCode;
}
