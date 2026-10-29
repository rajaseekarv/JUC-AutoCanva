import { describe, expect, it, vi } from 'vitest';
import {
  REVOCATION_CONFIGURATION_PAUSE_LIMIT_MS,
  REVOCATION_CONFIGURATION_PAUSE_MS,
  REVOCATION_MAX_ATTEMPTS,
  type CanvaRevokeResult,
} from './canva-revocation';
import { CanvaRevocationWorker } from './canva-revocation.worker';
import {
  MemoryCanvaDatabase,
  MemoryCredentialStore,
  MemoryRevocationQueue,
  testRealConfig,
} from './canva-oauth.test-doubles';
import { CanvaTokenKeyring, sealContext } from './canva-token-cipher';
import { CanvaTokenClient, type CanvaFetch } from './canva-token.client';
import type { ConsumedCanvaAttempt } from './canva-oauth.stores';

// Mocked queue and Canva client. These tests check the worker's sequencing;
// they are not evidence of PostgreSQL locking (gates H, I, N, O).
const config = testRealConfig({ persistence: true, revocationWorker: true });

function setup(
  respond: () => CanvaRevokeResult | Promise<CanvaRevokeResult> = () => ({
    kind: 'revoked',
  }),
  monotonic: () => number = () => 0,
) {
  const db = new MemoryCanvaDatabase();
  const queue = new MemoryRevocationQueue(db);
  const credentials = new MemoryCredentialStore(db);
  const revoke = vi.fn(async () => respond());
  const runtime = { monotonic, random: () => 0.5 };
  const worker = new CanvaRevocationWorker(
    config,
    queue,
    { revoke } as unknown as CanvaTokenClient,
    runtime,
  );
  const queueToken = (canvaUserId = 'canva-u', label = 'old') =>
    db.enqueue({
      organizationId: 'org-1',
      chainId: `chain-${label}`,
      canvaUserId,
      reason: 'disconnect',
      refreshToken: config.keyring.seal(
        `${label}-refresh`,
        sealContext.refreshToken('org-1'),
      ),
    });
  return { db, queue, credentials, revoke, worker, queueToken };
}

function launchedAttempt(
  db: MemoryCanvaDatabase,
  organizationId: string,
): ConsumedCanvaAttempt {
  const id = `attempt-${db.attempts.size + 1}`;
  db.attempts.set(id, {
    id,
    organizationId,
    userId: 'user-1',
    sessionId: 'session-1',
    launchTokenHash: id,
    redirectUri: 'unused',
    baseGeneration: db.connection(organizationId).connectionGeneration,
    launchExpiresAt: db.now(),
    launchedAt: db.now(),
    expiresAt: new Date(db.time + 600_000),
    consumedAt: db.now(),
    stateHash: id,
    browserBindingHash: id,
    codeVerifier: null,
  });
  return {
    attemptId: id,
    organizationId,
    userId: 'user-1',
    sessionId: 'session-1',
    baseGeneration: db.connection(organizationId).connectionGeneration,
    redirectUri: 'unused',
    codeVerifier: { keyVersion: 1, iv: '', ciphertext: '', tag: '' },
  };
}

function candidateFor(
  db: MemoryCanvaDatabase,
  organizationId: string,
  canvaUserId: string,
) {
  return {
    attempt: launchedAttempt(db, organizationId),
    chainId: `chain-new-${organizationId}`,
    writeId: `write-${organizationId}`,
    accessToken: config.keyring.seal(
      'a',
      sealContext.accessToken(organizationId),
    ),
    refreshToken: config.keyring.seal(
      'r',
      sealContext.refreshToken(organizationId),
    ),
    accessTokenExpiresAt: new Date(db.time + 3_600_000),
    scopes: [],
    canvaUserId,
    canvaTeamId: 'team',
    canvaDisplayName: 'Name',
    capabilities: { autofill: true, brandTemplate: true },
  };
}

describe('CanvaRevocationWorker', () => {
  it('sends a queued revocation when no grant for the Canva user remains', async () => {
    const { db, revoke, worker, queueToken } = setup();
    queueToken();
    await expect(worker.runOnce()).resolves.toMatchObject({
      claimed: 1,
      sent: 1,
    });
    expect(revoke).toHaveBeenCalledWith('old-refresh');
    expect(db.queue[0]).toMatchObject({
      state: 'finished',
      outcome: 'revoked',
      attempts: 1,
      sealedCleared: true,
    });
    expect(db.queue[0].possibleEffectUntil).toBe(db.time);
    expect(db.actions()).toContain('canva.connection.revocation_finished');
  });

  it('skips without a call while a credential for the same Canva user exists in any organization', async () => {
    const { db, revoke, worker, queueToken } = setup();
    queueToken('canva-u');
    db.seedCredential({
      organizationId: 'org-2',
      connectedById: 'user-2',
      accessToken: config.keyring.seal('x', sealContext.accessToken('org-2')),
      refreshToken: config.keyring.seal('y', sealContext.refreshToken('org-2')),
      accessTokenExpiresAt: db.now(),
      scopes: [],
      canvaUserId: 'canva-u',
      canvaTeamId: 'team',
      chainId: 'chain-other',
      writeId: 'w',
    });
    await worker.runOnce();
    expect(revoke).not.toHaveBeenCalled();
    expect(db.queue[0]).toMatchObject({
      state: 'finished',
      outcome: 'skipped_shared_consent',
    });
  });

  it('skips when a pending candidate for the same Canva user was created before T1', async () => {
    const { db, credentials, revoke, worker, queueToken } = setup();
    queueToken('canva-u');
    await expect(
      credentials.createCandidate(candidateFor(db, 'org-2', 'canva-u')),
    ).resolves.toMatchObject({ outcome: 'pending_confirmation' });
    await worker.runOnce();
    expect(revoke).not.toHaveBeenCalled();
    expect(db.queue[0].outcome).toBe('skipped_shared_consent');
  });

  it('refuses a new candidate while the call is in flight, and after a definite answer within the attempt', async () => {
    let releaseCall: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      releaseCall = resolve;
    });
    // The revoke call is held open until released.
    const { db, credentials, revoke, worker, queueToken } = setup(async () => {
      await pending;
      return { kind: 'revoked' };
    });
    queueToken('canva-u');
    const run = worker.runOnce();
    await vi.waitFor(() => expect(revoke).toHaveBeenCalled());
    // An attempt launched while the call is unsettled is refused.
    const during = candidateFor(db, 'org-2', 'canva-u');
    await expect(credentials.createCandidate(during)).resolves.toEqual({
      outcome: 'retry_connect',
    });
    db.advance(1_000);
    releaseCall();
    await run;
    // Launched before the answer: still inside the window.
    db.attempts.get(during.attempt.attemptId)!.launchedAt = new Date(
      db.time - 500,
    );
    await expect(credentials.createCandidate(during)).resolves.toEqual({
      outcome: 'retry_connect',
    });
    // Launched after the window closed: allowed.
    db.advance(1);
    const after = candidateFor(db, 'org-2', 'canva-u');
    await expect(credentials.createCandidate(after)).resolves.toMatchObject({
      outcome: 'pending_confirmation',
    });
  });

  it('extends the window by the ambiguous allowance after an unknown outcome', async () => {
    const { db, worker, queueToken } = setup(() => ({ kind: 'unknown' }));
    queueToken();
    const startedAt = db.time;
    await worker.runOnce();
    expect(db.queue[0]).toMatchObject({ state: 'queued', attempts: 1 });
    expect(db.queue[0].possibleEffectUntil).toBe(startedAt + 135_000);
  });

  it('never sends after the send deadline', async () => {
    // T1 commits at 0; the process then pauses for 6 seconds before sending.
    const monotonic = vi
      .fn<() => number>()
      .mockReturnValueOnce(0)
      .mockReturnValue(6_000);
    const { db, revoke, worker, queueToken } = setup(
      () => ({ kind: 'revoked' }),
      monotonic,
    );
    queueToken();
    await expect(worker.runOnce()).resolves.toMatchObject({ abandoned: 1 });
    expect(revoke).not.toHaveBeenCalled();
    // Left in_flight; the next claimer recovers it with the crashed-call
    // window after the claim expires.
    expect(db.queue[0].state).toBe('in_flight');
  });

  it('recovers a crashed call with the 135-second window and runs the guard again', async () => {
    const { db, revoke, worker, queueToken } = setup();
    queueToken();
    const row = db.queue[0];
    Object.assign(row, {
      state: 'in_flight',
      attempts: 1,
      callStartedAt: db.time - 120_000,
      claimToken: 'crashed',
      claimedUntil: db.time - 1,
    });
    await worker.runOnce();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(row.attempts).toBe(2);
    expect(row.possibleEffectUntil).toBeGreaterThanOrEqual(
      db.time - 120_000 + 135_000,
    );
  });

  it('does not call Canva when T1 fails or its commit is unconfirmed', async () => {
    const { db, queue, revoke, worker, queueToken } = setup();
    queueToken();
    queue.failNextDecide = 'definite';
    await worker.runOnce();
    expect(db.queue[0].state).toBe('queued');
    // Reclaimable again; this time T1 commits but its outcome is unknown.
    db.queue[0].claimedUntil = null;
    queue.failNextDecide = 'committed_unknown';
    await worker.runOnce();
    expect(revoke).not.toHaveBeenCalled();
    // Committed as in_flight: recovered later with the crashed-call window.
    expect(db.queue[0].state).toBe('in_flight');
  });

  it('survives an unrecorded result; the row is recovered as a crash', async () => {
    const { db, queue, revoke, worker, queueToken } = setup();
    queueToken();
    queue.failNextRecord = true;
    await expect(worker.runOnce()).resolves.toMatchObject({ sent: 1 });
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(db.queue[0].state).toBe('in_flight');
  });

  it('requeues a row whose key is not configured, keeping its ciphertext, consuming no attempt, and sending nothing', async () => {
    // As on an instance that does not have the new key yet during a rolling
    // deployment, or after a key was removed too early.
    const { db, revoke, worker } = setup();
    const newer = new CanvaTokenKeyring({
      version: 2,
      key: Buffer.alloc(32, 2),
    });
    const sealed = newer.seal(
      'newer-refresh',
      sealContext.refreshToken('org-1'),
    );
    db.enqueue({
      organizationId: 'org-1',
      chainId: 'chain-newer',
      canvaUserId: 'canva-u',
      reason: 'disconnect',
      refreshToken: sealed,
    });
    await expect(worker.runOnce()).resolves.toMatchObject({
      claimed: 1,
      sent: 0,
      keyUnavailable: 1,
    });
    expect(revoke).not.toHaveBeenCalled();
    expect(db.queue[0]).toMatchObject({
      state: 'queued',
      attempts: 0,
      lastErrorKind: 'key_unavailable',
      sealedCleared: false,
      refreshToken: sealed,
      // No request was sent, so no window was opened.
      possibleEffectUntil: null,
    });
    expect(db.queue[0].nextAttemptAt).toBeGreaterThan(db.time);
  });

  it('exhausts a row whose configured key cannot open it, keeping the ciphertext for an administrator', async () => {
    const { db, revoke, worker } = setup();
    const sealed = config.keyring.seal(
      'refresh',
      sealContext.refreshToken('org-1'),
    );
    const corrupt = { ...sealed, tag: 'AAAAAAAAAAAAAAAAAAAAAA' };
    db.enqueue({
      organizationId: 'org-1',
      chainId: 'chain-bad',
      canvaUserId: 'canva-u',
      reason: 'disconnect',
      refreshToken: corrupt,
    });
    await worker.runOnce();
    expect(revoke).not.toHaveBeenCalled();
    expect(db.queue[0]).toMatchObject({
      state: 'exhausted',
      lastErrorKind: 'undecryptable',
      sealedCleared: false,
      refreshToken: corrupt,
      possibleEffectUntil: null,
    });
    expect(db.actions()).toContain('canva.connection.revocation_exhausted');
  });

  it('exhausts after eight attempts, keeps the ciphertext, and supports retry and dismiss', async () => {
    const { db, queue, revoke, worker, queueToken } = setup(() => ({
      kind: 'unknown',
    }));
    queueToken();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await worker.runOnce();
      db.advance(2 * 3_600_000);
    }
    expect(revoke).toHaveBeenCalledTimes(8);
    expect(db.queue[0]).toMatchObject({
      state: 'exhausted',
      sealedCleared: false,
    });
    expect(db.actions()).toContain('canva.connection.revocation_exhausted');
    await worker.runOnce();
    expect(revoke).toHaveBeenCalledTimes(8);
    await expect(
      queue.retryExhausted('org-1', db.queue[0].id, 'user-1'),
    ).resolves.toBe(true);
    expect(db.queue[0]).toMatchObject({ state: 'queued', attempts: 0 });
    db.queue[0].state = 'exhausted';
    await expect(
      queue.dismissExhausted('org-1', db.queue[0].id, 'user-1'),
    ).resolves.toBe(true);
    expect(db.queue[0]).toMatchObject({
      state: 'finished',
      outcome: 'dismissed',
      sealedCleared: true,
    });
  });

  it('pauses on configuration errors without consuming attempts', async () => {
    const { db, worker, queueToken } = setup(() => ({
      kind: 'configuration',
      status: 401,
    }));
    queueToken();
    await worker.runOnce();
    expect(db.queue[0]).toMatchObject({
      state: 'queued',
      attempts: 0,
      lastErrorKind: 'configuration',
    });
    expect(db.queue[0].nextAttemptAt).toBe(db.time + 15 * 60_000);
  });

  it('does nothing unless real mode with persistence is configured', async () => {
    const db = new MemoryCanvaDatabase();
    const queue = new MemoryRevocationQueue(db);
    const revoke = vi.fn();
    const off = new CanvaRevocationWorker(testRealConfig(), queue, {
      revoke,
    } as unknown as CanvaTokenClient);
    await expect(off.runOnce()).resolves.toMatchObject({ claimed: 0 });
    expect(queue.claim).not.toHaveBeenCalled();
    const mock = new CanvaRevocationWorker(
      { mode: 'mock', webOrigin: 'http://localhost:5173' },
      queue,
      { revoke } as unknown as CanvaTokenClient,
    );
    await expect(mock.runOnce()).resolves.toMatchObject({ claimed: 0 });
    expect(revoke).not.toHaveBeenCalled();
  });

  it('ignores triggers unless the worker is enabled', () => {
    const db = new MemoryCanvaDatabase();
    const queue = new MemoryRevocationQueue(db);
    const worker = new CanvaRevocationWorker(
      testRealConfig({ persistence: true }),
      queue,
      { revoke: vi.fn() } as unknown as CanvaTokenClient,
    );
    expect(worker.enabled).toBe(false);
    worker.trigger('canva-u');
    expect(queue.claim).not.toHaveBeenCalled();
  });

  it('refuses a direct runOnce (the operator path) unless the worker flag is set', async () => {
    const db = new MemoryCanvaDatabase();
    const queue = new MemoryRevocationQueue(db);
    const revoke = vi.fn();
    db.enqueue({
      organizationId: 'org-1',
      chainId: 'chain-1',
      canvaUserId: 'canva-u',
      reason: 'disconnect',
      refreshToken: config.keyring.seal(
        'refresh',
        sealContext.refreshToken('org-1'),
      ),
    });
    const worker = new CanvaRevocationWorker(
      testRealConfig({ persistence: true }),
      queue,
      { revoke } as unknown as CanvaTokenClient,
    );
    await expect(worker.runOnce()).resolves.toMatchObject({ claimed: 0 });
    expect(queue.claim).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    // maintain() makes no external call and needs only durable storage.
    await expect(worker.maintain()).resolves.not.toBeNull();
  });
});

// Regression (Stage 2.8): Canva documents 401 invalid_access_token for an
// invalid client secret on its revoke endpoint. It was classified as an
// ordinary rejection, which consumed attempts and exhausted every queued row
// within hours. The real token client parses the documented response here.
describe('CanvaRevocationWorker with an invalid client secret', () => {
  it('pauses without consuming attempts or clearing the ciphertext, until the pause limit', async () => {
    const db = new MemoryCanvaDatabase();
    const queue = new MemoryRevocationQueue(db);
    const fetchMock = vi.fn<CanvaFetch>(
      async () =>
        new Response(
          JSON.stringify({
            code: 'invalid_access_token',
            message: 'Client secret is invalid for OC-test-client-id',
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const worker = new CanvaRevocationWorker(
      config,
      queue,
      new CanvaTokenClient(config, fetchMock),
      { monotonic: () => 0, random: () => 0.5 },
    );
    const sealed = config.keyring.seal(
      'old-refresh',
      sealContext.refreshToken('org-1'),
    );
    db.enqueue({
      organizationId: 'org-1',
      chainId: 'chain-old',
      canvaUserId: 'canva-u',
      reason: 'disconnect',
      refreshToken: sealed,
    });
    const row = db.queue[0];

    // Twice the attempt limit: an ordinary rejection would be exhausted.
    for (let run = 1; run <= REVOCATION_MAX_ATTEMPTS * 2; run += 1) {
      await expect(worker.runOnce()).resolves.toMatchObject({
        claimed: 1,
        sent: 1,
        exhausted: 0,
        configurationErrors: 1,
      });
      expect(row).toMatchObject({
        state: 'queued',
        attempts: 0,
        lastErrorKind: 'configuration',
        outcome: null,
        sealedCleared: false,
        refreshToken: sealed,
        nextAttemptAt: db.time + REVOCATION_CONFIGURATION_PAUSE_MS,
      });
      db.advance(REVOCATION_CONFIGURATION_PAUSE_MS);
    }
    expect(fetchMock).toHaveBeenCalledTimes(REVOCATION_MAX_ATTEMPTS * 2);
    // inspect reports the paused row as a configuration error.
    await expect(queue.inspect(10)).resolves.toMatchObject({
      health: {
        revocationConfigurationErrors: 1,
        revocationKeyUnavailable: 0,
      },
    });
    expect(db.actions()).not.toContain('canva.connection.revocation_exhausted');

    // Past the configuration pause limit the row is exhausted for an
    // administrator, still holding its ciphertext and its unused attempts.
    db.time = row.createdAt + REVOCATION_CONFIGURATION_PAUSE_LIMIT_MS;
    await expect(worker.runOnce()).resolves.toMatchObject({ exhausted: 1 });
    expect(row).toMatchObject({
      state: 'exhausted',
      attempts: 0,
      lastErrorKind: 'configuration',
      sealedCleared: false,
      refreshToken: sealed,
    });
    expect(db.actions()).toContain('canva.connection.revocation_exhausted');
  });
});
