import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REVOCATION_CONFIGURATION_PAUSE_LIMIT_MS,
  REVOCATION_CONFIGURATION_PAUSE_MS,
  REVOCATION_MAX_ATTEMPTS,
  planRevocationRecord,
  revocationRetryDelayMs,
  type CanvaRevokeResult,
} from './canva-revocation';

const midJitter = () => 0.5;
const plan = (result: CanvaRevokeResult, attempts = 1, ageMs = 0) =>
  planRevocationRecord(result, { attempts, ageMs, random: midJitter });

describe('revocation retry delay (§2.4)', () => {
  it('doubles from 60 seconds and caps at one hour', () => {
    expect(revocationRetryDelayMs(1, undefined, midJitter)).toBe(60_000);
    expect(revocationRetryDelayMs(2, undefined, midJitter)).toBe(120_000);
    expect(revocationRetryDelayMs(7, undefined, midJitter)).toBe(3_600_000);
    expect(revocationRetryDelayMs(20, undefined, midJitter)).toBe(3_600_000);
  });

  it('applies ±20% jitter', () => {
    expect(revocationRetryDelayMs(1, undefined, () => 0)).toBe(48_000);
    expect(revocationRetryDelayMs(1, undefined, () => 1)).toBe(72_000);
  });

  it('honors a longer Retry-After, never a shorter one', () => {
    expect(revocationRetryDelayMs(1, 600, midJitter)).toBe(600_000);
    expect(revocationRetryDelayMs(3, 5, midJitter)).toBe(240_000);
  });
});

describe('revocation response policy (§2.4, §2.7)', () => {
  it('finishes a 200 as revoked with a definite window end', () => {
    expect(plan({ kind: 'revoked' })).toEqual({
      next: 'finished',
      outcome: 'revoked',
      lastErrorKind: null,
      delayMs: 0,
      refund: false,
      ambiguous: false,
    });
  });

  it('finishes 400 bad_request_params as not revocable', () => {
    expect(plan({ kind: 'not_revocable' })).toMatchObject({
      next: 'finished',
      outcome: 'not_revocable',
      ambiguous: false,
    });
  });

  it('pauses on a configuration rejection without consuming an attempt', () => {
    expect(plan({ kind: 'configuration', status: 401 }, 3)).toEqual({
      next: 'queued',
      outcome: null,
      lastErrorKind: 'configuration',
      delayMs: REVOCATION_CONFIGURATION_PAUSE_MS,
      refund: true,
      ambiguous: false,
    });
  });

  it('exhausts a configuration pause once the row passes the pause limit', () => {
    expect(
      plan(
        { kind: 'configuration', status: 401 },
        3,
        REVOCATION_CONFIGURATION_PAUSE_LIMIT_MS,
      ),
    ).toMatchObject({ next: 'exhausted', refund: true });
  });

  it('retries 429 with Retry-After and a definite window', () => {
    expect(
      plan({ kind: 'rate_limited', retryAfterSeconds: 900 }, 1),
    ).toMatchObject({
      next: 'queued',
      lastErrorKind: 'rate_limited',
      delayMs: 900_000,
      ambiguous: false,
      refund: false,
    });
  });

  it('retries another 4xx as rejected with a definite window', () => {
    expect(plan({ kind: 'rejected', status: 403 }, 2)).toMatchObject({
      next: 'queued',
      lastErrorKind: 'rejected',
      delayMs: 120_000,
      ambiguous: false,
    });
  });

  it('retries 5xx, timeouts, and network failures with an ambiguous window', () => {
    expect(plan({ kind: 'unknown', status: 503 })).toMatchObject({
      next: 'queued',
      lastErrorKind: 'unknown',
      ambiguous: true,
    });
    expect(plan({ kind: 'unknown' })).toMatchObject({ ambiguous: true });
  });

  it('exhausts after the eighth counted attempt, keeping the window', () => {
    expect(plan({ kind: 'unknown' }, REVOCATION_MAX_ATTEMPTS)).toMatchObject({
      next: 'exhausted',
      ambiguous: true,
    });
    expect(
      plan({ kind: 'unknown' }, REVOCATION_MAX_ATTEMPTS - 1),
    ).toMatchObject({ next: 'queued' });
  });
});

describe('the only revocation call site', () => {
  // Every revocation must pass the worker's T1 guard. Any other call to
  // CanvaTokenClient.revoke would bypass it.
  it('calls revoke() only from the revocation worker', () => {
    const directory = __dirname;
    const callers = readdirSync(directory)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
      .filter((name) =>
        /\.revoke\(/.test(readFileSync(join(directory, name), 'utf8')),
      );
    expect(callers).toEqual(['canva-revocation.worker.ts']);
  });
});
