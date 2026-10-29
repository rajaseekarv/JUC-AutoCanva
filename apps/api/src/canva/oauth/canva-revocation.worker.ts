import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  CANVA_OAUTH_CONFIG,
  type CanvaOAuthConfig,
} from './canva-oauth.config';
import {
  CANVA_REVOCATION_QUEUE,
  type CanvaRevocationQueueStore,
  type CanvaRevocationRecord,
} from './canva-oauth.stores';
import {
  REVOCATION_CONFIGURATION_PAUSE_MS,
  REVOCATION_SEND_DEADLINE_MS,
  planRevocationRecord,
} from './canva-revocation';
import { sealContext } from './canva-token-cipher';
import { CanvaTokenClient } from './canva-token.client';

// Injected so tests control time and jitter.
export type CanvaWorkerRuntime = {
  // Monotonic milliseconds (performance.now in production).
  monotonic: () => number;
  random: () => number;
};
export const CANVA_WORKER_RUNTIME = Symbol('CANVA_WORKER_RUNTIME');

export type CanvaRevocationRunSummary = {
  claimed: number;
  sent: number;
  skipped: number;
  exhausted: number;
  abandoned: number;
  // Not sent because no key for the token's version is configured.
  keyUnavailable: number;
  // Sent, and Canva refused the client credentials: paused without using
  // an attempt (canva-revocation.ts). Counted only; nothing else changes.
  configurationErrors: number;
};

const BATCH = 10;

// The only caller of CanvaTokenClient.revoke (§2.5, §5.10). For each claimed
// row: T1 decides and fences under the Canva user's account lock; the call
// is made outside any transaction, only within the send deadline; T2
// records the result. A database transaction cannot be atomic with Canva,
// so an ambiguous or late call is covered by the possible-effect window,
// which keeps new grants for that user from being stored (§2.7).
//
// Nothing starts this worker on a schedule. It runs only with
// CANVA_REVOCATION_WORKER_ENABLED=true: when triggered (after a transaction
// that queued work, on status reads, and after retry_connect), or from the
// operator command (`run-once --execute`, canva-operations.main.ts).
// maintain() makes no external call and needs only durable storage.
@Injectable()
export class CanvaRevocationWorker {
  private readonly logger = new Logger('CanvaRevocationWorker');
  private readonly runtime: CanvaWorkerRuntime;
  private running: Promise<unknown> | null = null;

  constructor(
    @Inject(CANVA_OAUTH_CONFIG) private readonly config: CanvaOAuthConfig,
    @Inject(CANVA_REVOCATION_QUEUE)
    private readonly queue: CanvaRevocationQueueStore,
    private readonly tokens: CanvaTokenClient,
    @Optional()
    @Inject(CANVA_WORKER_RUNTIME)
    runtime?: CanvaWorkerRuntime,
  ) {
    this.runtime = runtime ?? {
      monotonic: () => performance.now(),
      random: Math.random,
    };
  }

  get enabled(): boolean {
    return (
      this.config.mode === 'canva' &&
      this.config.persistence &&
      this.config.revocationWorker
    );
  }

  // Fire and forget. Never throws and never blocks the request.
  trigger(canvaUserId?: string): void {
    if (!this.enabled || this.running) return;
    this.running = this.runOnce({ canvaUserId })
      .catch(() => this.logger.warn('Canva revocation worker run failed'))
      .finally(() => {
        this.running = null;
      });
  }

  async runOnce(
    options: { canvaUserId?: string; limit?: number } = {},
  ): Promise<CanvaRevocationRunSummary> {
    const summary: CanvaRevocationRunSummary = {
      claimed: 0,
      sent: 0,
      skipped: 0,
      exhausted: 0,
      abandoned: 0,
      keyUnavailable: 0,
      configurationErrors: 0,
    };
    const config = this.config;
    // Every entry point, a trigger or the operator command, needs the
    // explicit worker flag; nothing else can make it call Canva.
    if (config.mode !== 'canva' || !this.enabled) return summary;
    const claimToken = randomUUID();
    const claimed = await this.queue.claim(
      claimToken,
      options.limit ?? BATCH,
      options.canvaUserId,
    );
    summary.claimed = claimed.length;
    for (const { id } of claimed) {
      let decision;
      try {
        decision = await this.queue.decide(id, claimToken);
      } catch {
        // Definite or ambiguous, T1 is not known to have committed as ours:
        // never call. If it did commit, the claim expires and the next
        // worker recovers the row with the crashed-call window.
        this.logger.warn('Canva revocation not sent: decision not confirmed');
        continue;
      }
      if (decision.kind === 'skipped') summary.skipped += 1;
      if (decision.kind === 'exhausted') summary.exhausted += 1;
      if (decision.kind !== 'send') continue;
      const committedAt = this.runtime.monotonic();

      // Fail closed, keeping the ciphertext: a token that cannot be opened
      // is never sent, and never cleared either.
      // - No key for its version (a key removed too early, or an instance
      //   that does not have the new key yet during a rolling deployment):
      //   requeue after the configuration pause, without consuming the
      //   attempt. It is sent once a key for that version is configured.
      // - A key exists but the value does not open (corruption, or a
      //   different key reusing the version number): exhausted, which keeps
      //   the ciphertext for an administrator to retry after a fix or to
      //   dismiss.
      // No request is made either way, so the window is not extended.
      if (!config.keyring.hasKey(decision.refreshToken.keyVersion)) {
        summary.keyUnavailable += 1;
        this.logger.warn(
          'Canva revocation not sent: encryption key unavailable',
        );
        await this.recordSafely(id, claimToken, {
          next: 'queued',
          outcome: null,
          lastErrorKind: 'key_unavailable',
          delayMs: REVOCATION_CONFIGURATION_PAUSE_MS,
          refund: true,
          ambiguous: false,
          called: false,
        });
        continue;
      }
      let refreshToken: string;
      try {
        refreshToken = config.keyring.open(
          decision.refreshToken,
          sealContext.refreshToken(decision.organizationId),
        );
      } catch {
        summary.exhausted += 1;
        await this.recordSafely(id, claimToken, {
          next: 'exhausted',
          outcome: null,
          lastErrorKind: 'undecryptable',
          delayMs: 0,
          refund: true,
          ambiguous: false,
          called: false,
        });
        continue;
      }
      // §2.7 step 3: a paused process must not send late.
      if (
        this.runtime.monotonic() - committedAt >
        REVOCATION_SEND_DEADLINE_MS
      ) {
        summary.abandoned += 1;
        this.logger.warn('Canva revocation not sent: send deadline passed');
        continue;
      }
      summary.sent += 1;
      const result = await this.tokens.revoke(refreshToken);
      const record = planRevocationRecord(result, {
        attempts: decision.attempts,
        ageMs: decision.ageMs,
        random: this.runtime.random,
      });
      if (record.next === 'exhausted') summary.exhausted += 1;
      if (record.lastErrorKind === 'configuration')
        summary.configurationErrors += 1;
      await this.recordSafely(id, claimToken, record);
    }
    return summary;
  }

  // Candidate expiry, the 30-day abandon, the 90-day purge, and the hold
  // sweep. Makes no external call.
  async maintain() {
    if (this.config.mode !== 'canva' || !this.config.persistence) return null;
    return this.queue.maintain();
  }

  // An unrecorded result is recovered as a crashed call: the next claimer
  // extends the window to callStartedAt + 135 s and runs the guard again.
  private async recordSafely(
    id: string,
    claimToken: string,
    record: CanvaRevocationRecord,
  ): Promise<void> {
    try {
      if (!(await this.queue.record(id, claimToken, record)))
        this.logger.warn('Canva revocation result not recorded: claim lost');
    } catch {
      this.logger.warn('Canva revocation result not confirmed');
    }
  }
}
