import type { CanvaRevocationRecord } from './canva-oauth.stores';

// Canva revokes a refresh token's whole lineage *and the user's consent for
// the app* (https://www.canva.dev/docs/connect/api-reference/authentication/revoke-token/).
// AdFlow therefore never revokes from a request path. Every token it gives
// up is queued in the transaction that gave it up, and only the revocation
// worker (canva-revocation.worker.ts) sends a revocation, after its T1 has
// found, under the Canva user's account lock, no credential and no pending
// candidate for that user in any organization. This file holds the worker's
// pure policy: how a response is classified and when to try again.

export const REVOCATION_MAX_ATTEMPTS = 8;
// The worker sends only if T1 committed less than this long ago (monotonic
// time), which bounds how late a paused process can send (§2.7 step 3).
export const REVOCATION_SEND_DEADLINE_MS = 5_000;
export const REVOCATION_CONFIGURATION_PAUSE_MS = 15 * 60_000;
// Configuration pauses end in `exhausted` once the row is this old. The
// proposal counts paused time; row age is a conservative stand-in (it is
// never shorter than the paused time), so no schema column is needed.
export const REVOCATION_CONFIGURATION_PAUSE_LIMIT_MS = 7 * 24 * 60 * 60_000;
const BASE_DELAY_MS = 60_000;
const MAX_DELAY_MS = 60 * 60_000;

// What one revoke call established. Produced by CanvaTokenClient.revoke,
// which never throws, so no error path can turn into a different action.
// - revoked: 200.
// - not_revocable: 400 bad_request_params; the token is unusable.
// - configuration: 401 invalid_access_token (Canva's documented code for an
//   invalid client secret), 401 invalid_client, or 400 unauthorized_client.
// - rate_limited: 429.
// - rejected: any other 4xx; assumed not processed (A-R5).
// - unknown: 5xx, timeout, network failure, or an unreadable 2xx; Canva may
//   have processed it.
export type CanvaRevokeResult =
  | { kind: 'revoked' }
  | { kind: 'not_revocable' }
  | { kind: 'configuration'; status: number }
  | { kind: 'rate_limited'; retryAfterSeconds?: number }
  | { kind: 'rejected'; status: number }
  | { kind: 'unknown'; status?: number };

// §2.4: after the nth failure wait min(60 s × 2^(n−1), 1 h) with ±20%
// jitter, or Retry-After if that is longer.
export function revocationRetryDelayMs(
  failures: number,
  retryAfterSeconds: number | undefined,
  random: () => number,
): number {
  const exponent = Math.max(0, failures - 1);
  const base = Math.min(BASE_DELAY_MS * 2 ** exponent, MAX_DELAY_MS);
  const jittered = Math.round(base * (0.8 + 0.4 * random()));
  return Math.max(jittered, (retryAfterSeconds ?? 0) * 1_000);
}

// Turns a call's result into T2's update. `attempts` already includes the
// call just made (counted at T1).
export function planRevocationRecord(
  result: CanvaRevokeResult,
  context: { attempts: number; ageMs: number; random: () => number },
): CanvaRevocationRecord {
  const finish = (
    outcome: 'revoked' | 'not_revocable',
  ): CanvaRevocationRecord => ({
    next: 'finished',
    outcome,
    lastErrorKind: null,
    delayMs: 0,
    refund: false,
    ambiguous: false,
  });
  const retry = (
    lastErrorKind: string,
    ambiguous: boolean,
    retryAfterSeconds?: number,
  ): CanvaRevocationRecord => ({
    next: context.attempts >= REVOCATION_MAX_ATTEMPTS ? 'exhausted' : 'queued',
    outcome: null,
    lastErrorKind,
    delayMs: revocationRetryDelayMs(
      context.attempts,
      retryAfterSeconds,
      context.random,
    ),
    refund: false,
    ambiguous,
  });
  switch (result.kind) {
    case 'revoked':
      return finish('revoked');
    case 'not_revocable':
      return finish('not_revocable');
    case 'configuration':
      // A configuration problem says nothing about the token: pause without
      // consuming an attempt, until the pause limit.
      return context.ageMs >= REVOCATION_CONFIGURATION_PAUSE_LIMIT_MS
        ? {
            next: 'exhausted',
            outcome: null,
            lastErrorKind: 'configuration',
            delayMs: 0,
            refund: true,
            ambiguous: false,
          }
        : {
            next: 'queued',
            outcome: null,
            lastErrorKind: 'configuration',
            delayMs: REVOCATION_CONFIGURATION_PAUSE_MS,
            refund: true,
            ambiguous: false,
          };
    case 'rate_limited':
      return retry('rate_limited', false, result.retryAfterSeconds);
    case 'rejected':
      return retry('rejected', false);
    case 'unknown':
      return retry('unknown', true);
  }
}
