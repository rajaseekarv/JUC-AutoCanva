import {
  ConsoleLogger,
  type INestApplicationContext,
  type LogLevel,
  type LoggerService,
} from '@nestjs/common';
import {
  CANVA_OAUTH_CONFIG,
  type CanvaOAuthConfig,
} from './canva-oauth.config';
import {
  CANVA_REVOCATION_QUEUE,
  type CanvaRevocationQueueStore,
} from './canva-oauth.stores';
import { runCanvaOperationsProcess, wantsJson } from './canva-operations';
import { CanvaRevocationWorker } from './canva-revocation.worker';
import { CanvaTokenResealService } from './canva-token-reseal.service';

// The operator command's process wiring, separate from
// canva-operations.main.ts so it can be tested without importing the
// application module. main.ts passes NestFactory.createApplicationContext
// and process.stdout; tests pass fakes.

// With --json, stdout carries only the JSON report: every log line goes to
// stderr instead.
export class StderrLogger extends ConsoleLogger {
  protected printMessages(
    messages: unknown[],
    context?: string,
    logLevel?: LogLevel,
  ): void {
    super.printMessages(messages, context, logLevel, 'stderr');
  }
}

export const CANVA_OPERATIONS_LOG_LEVELS: LogLevel[] = ['error', 'warn', 'log'];

export type CanvaContextOptions = {
  logger: LoggerService | LogLevel[];
  // A failing module initialization throws (and is reported as a failed
  // run) instead of Nest's default process.abort().
  abortOnError: false;
};

export type CanvaContextFactory = (
  options: CanvaContextOptions,
) => Promise<INestApplicationContext>;

// Returns the exit code (CANVA_OPERATION_EXIT_CODES). Every refusal happens
// in runCanvaOperationsProcess before createContext is called. stdout gets
// the report (or text output); stderr gets only the fixed shutdown warning,
// never part of a --json report.
export function runCanvaOperationsCli(
  argv: string[],
  environment: NodeJS.ProcessEnv,
  createContext: CanvaContextFactory,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): Promise<number> {
  return runCanvaOperationsProcess(
    argv,
    environment,
    async () => {
      const app = await createContext({
        logger: wantsJson(argv)
          ? new StderrLogger('CanvaOperations', {
              logLevels: CANVA_OPERATIONS_LOG_LEVELS,
            })
          : CANVA_OPERATIONS_LOG_LEVELS,
        abortOnError: false,
      });
      return {
        dependencies: {
          config: app.get<CanvaOAuthConfig>(CANVA_OAUTH_CONFIG),
          worker: app.get(CanvaRevocationWorker),
          queue: app.get<CanvaRevocationQueueStore>(CANVA_REVOCATION_QUEUE),
          reseal: app.get(CanvaTokenResealService),
        },
        close: () => app.close(),
      };
    },
    (line) => stdout(`${line}\n`),
    (line) => stderr(`${line}\n`),
  );
}
