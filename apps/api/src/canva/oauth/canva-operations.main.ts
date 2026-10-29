import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module';
import { runCanvaOperationsCli } from './canva-operations.cli';

// Operator entry point (see canva-operations.ts and docs/integrations/
// canva.md). Built to dist/canva/oauth/canva-operations.main.js and run with
// `pnpm --filter @adflow/api canva:ops <command>`. It is never imported by
// the application, and nothing schedules it. All checks run in
// runCanvaOperationsProcess before the application context (and with it any
// database connection) is created. canva-operations.cli.spec.ts runs this
// file in a child process for the refusal paths.

dotenv.config({ path: resolve(__dirname, '../../../../../.env') });

void runCanvaOperationsCli(
  process.argv.slice(2),
  process.env,
  (options) => NestFactory.createApplicationContext(AppModule, options),
  (text) => process.stdout.write(text),
  (text) => process.stderr.write(text),
).then(
  (code) => {
    process.exitCode = code;
  },
  // Last resort: runCanvaOperationsCli handles every failure it can report
  // (including a failed shutdown), so this runs only if writing the output
  // itself failed. No report was printed then, so the run counts as failed.
  () => {
    process.exitCode = 1;
  },
);
