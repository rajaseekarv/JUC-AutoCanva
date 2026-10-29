import { describe, expect, it, vi } from 'vitest';
import {
  ACCESS_TOKEN_REFRESH_SKEW_MS,
  CanvaAccessTokenService,
  CanvaReconnectRequiredError,
  CanvaTemporarilyUnavailableError,
} from './canva-access-token.service';
import type { NewCanvaCredential } from './canva-oauth.stores';
import {
  MemoryCanvaDatabase,
  MemoryCredentialStore,
  testRealConfig,
  tokenSet,
} from './canva-oauth.test-doubles';
import { CanvaTokenKeyring, sealContext } from './canva-token-cipher';
import {
  CanvaTokenClient,
  CanvaTokenError,
  type CanvaTokenSet,
} from './canva-token.client';
import type { CanvaIdentityClient } from './canva-identity.client';
import type { CanvaRevocationWorker } from './canva-revocation.worker';

// Mocked store and Canva client. The memory store serializes operations, so
// these tests check the service's decisions, not PostgreSQL behavior.
const config = testRealConfig({ persistence: true });

function credential(
  db: MemoryCanvaDatabase,
  expiresInMs: number,
  label = 'current',
  keyring = config.keyring,
  // Each label is its own Canva user unless a test says otherwise.
  canvaUserId = `canva-${label}`,
): NewCanvaCredential {
  return {
    organizationId: 'org-1',
    connectedById: 'user-1',
    accessToken: keyring.seal(
      `${label}-access`,
      sealContext.accessToken('org-1'),
    ),
    refreshToken: keyring.seal(
      `${label}-refresh`,
      sealContext.refreshToken('org-1'),
    ),
    accessTokenExpiresAt: new Date(db.time + expiresInMs),
    scopes: ['brandtemplate:meta:read'],
    canvaUserId,
    canvaTeamId: 'canva-team-1',
    chainId: `chain-${label}`,
    writeId: `write-${label}`,
  };
}

const FRESH_MS = ACCESS_TOKEN_REFRESH_SKEW_MS + 60_000;

function setup(stored: 'expiring' | 'fresh' | 'none' = 'expiring') {
  const db = new MemoryCanvaDatabase();
  const store = new MemoryCredentialStore(db);
  if (stored !== 'none')
    db.seedCredential(credential(db, stored === 'fresh' ? FRESH_MS : 60_000));
  const tokens = {
    refresh: vi.fn(async (): Promise<CanvaTokenSet> =>
      tokenSet({ accessToken: 'new-access', refreshToken: 'new-refresh' }),
    ),
    revoke: vi.fn(),
  };
  const identity = {
    currentUser: vi.fn(async () => ({
      canvaUserId: 'canva-current',
      canvaTeamId: 'canva-team-1',
    })),
  };
  const worker = { trigger: vi.fn() };
  const sleep = vi.fn(async () => {
    db.advance(1_000);
  });
  const service = new CanvaAccessTokenService(
    config,
    store,
    tokens as unknown as CanvaTokenClient,
    () => db.now(),
    identity as unknown as CanvaIdentityClient,
    worker as unknown as CanvaRevocationWorker,
    sleep,
  );
  // An activation, as §5.5 does it: a different user's grant is queued.
  const reconnect = (label: string, canvaUserId = `canva-${label}`) => {
    const previous = db.credentials.get('org-1');
    if (previous && previous.canvaUserId !== canvaUserId)
      db.enqueue({
        organizationId: 'org-1',
        chainId: previous.chainId,
        canvaUserId: previous.canvaUserId,
        reason: 'replaced_other_user',
        refreshToken: previous.refreshToken,
      });
    db.credentials.delete('org-1');
    if (previous) db.releaseIfUnreferenced(previous.canvaUserId);
    return db.seedCredential(
      credential(db, FRESH_MS, label, config.keyring, canvaUserId),
    );
  };
  return { db, service, store, tokens, identity, worker, sleep, reconnect };
}

// Holds a refresh at Canva until released, so a reconnect or disconnect can
// happen while it is in flight.
function gatedRefresh(
  tokens: ReturnType<typeof setup>['tokens'],
  outcome: () => Promise<CanvaTokenSet>,
) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const inFlight = new Promise<void>((resolve) => {
    started = resolve;
  });
  tokens.refresh.mockImplementationOnce(async () => {
    started();
    await gate;
    return outcome();
  });
  return { inFlight, release };
}

const stale = () =>
  tokenSet({ accessToken: 'stale-access', refreshToken: 'stale-refresh' });

describe('CanvaAccessTokenService.accessTokenFor', () => {
  it('returns a fresh token from a plain read, without the refresh lease', async () => {
    const { service, tokens } = setup('fresh');
    const spy = vi.spyOn(
      (service as unknown as { credentials: MemoryCredentialStore })
        .credentials,
      'withRefreshLock',
    );
    await expect(service.accessTokenFor('org-1')).resolves.toBe(
      'current-access',
    );
    expect(spy).not.toHaveBeenCalled();
    expect(tokens.refresh).not.toHaveBeenCalled();
  });

  it('refreshes near expiry and stores the rotated tokens sealed under a new version', async () => {
    const { service, db, tokens } = setup();
    const before = db.credentials.get('org-1')!.version;
    await expect(service.accessTokenFor('org-1')).resolves.toBe('new-access');
    expect(tokens.refresh).toHaveBeenCalledWith('current-refresh');
    const stored = db.credentials.get('org-1')!;
    expect(stored.version).toBe(before + 1);
    expect(stored.chainId).toBe('chain-current');
    // Refresh never changes the Canva user (§2.8).
    expect(stored.canvaUserId).toBe('canva-current');
    expect(
      config.keyring.open(
        stored.refreshToken,
        sealContext.refreshToken('org-1'),
      ),
    ).toBe('new-refresh');
    expect(db.actions()).toContain('canva.credential.refreshed');
  });

  it('refreshes once when concurrent requests find an expiring token', async () => {
    const { service, tokens } = setup();
    const results = await Promise.all([
      service.accessTokenFor('org-1'),
      service.accessTokenFor('org-1'),
    ]);
    expect(results).toEqual(['new-access', 'new-access']);
    expect(tokens.refresh).toHaveBeenCalledTimes(1);
  });

  it('requires reconnection when there is no credential', async () => {
    const { service } = setup('none');
    await expect(service.accessTokenFor('org-1')).rejects.toMatchObject({
      reason: 'not_connected',
    });
  });

  it('marks reauthorization required only for a confirmed invalid_grant, queuing nothing', async () => {
    const { service, db, tokens } = setup();
    tokens.refresh.mockRejectedValueOnce(
      new CanvaTokenError('invalid_grant', 400),
    );
    await expect(service.accessTokenFor('org-1')).rejects.toBeInstanceOf(
      CanvaReconnectRequiredError,
    );
    expect(db.credentials.size).toBe(0);
    expect(db.connection('org-1')).toMatchObject({
      status: 'REAUTHORIZATION_REQUIRED',
      reauthorizationReason: 'invalid_grant',
    });
    expect(db.accounts.get('canva-current')).toBeNull();
    expect(db.queue).toHaveLength(0);
  });

  it.each([
    new CanvaTokenError('transient', 503, 30),
    new CanvaTokenError('network'),
  ])('keeps the credential for a retryable failure', async (failure) => {
    const { service, db, tokens } = setup();
    tokens.refresh.mockRejectedValueOnce(failure);
    await expect(service.accessTokenFor('org-1')).rejects.toBeInstanceOf(
      CanvaTemporarilyUnavailableError,
    );
    expect(db.credentials.get('org-1')?.chainId).toBe('chain-current');
  });

  it('keeps the credential for a configuration rejection and flags it in the status', async () => {
    const { service, db, tokens } = setup();
    tokens.refresh.mockRejectedValueOnce(new CanvaTokenError('rejected', 401));
    await expect(service.accessTokenFor('org-1')).rejects.toMatchObject({
      kind: 'rejected',
    });
    expect(db.credentials.size).toBe(1);
    expect(db.connection('org-1').configurationError).toBe(true);
  });

  it('fails closed without changing anything when the credential key is not configured', async () => {
    // A key removed too early, or an old instance during a rolling
    // deployment reading a credential that a new instance sealed.
    const { service, db, tokens } = setup('none');
    const unknownKey = new CanvaTokenKeyring({
      version: 9,
      key: Buffer.alloc(32, 9),
    });
    const stored = db.seedCredential(credential(db, 60_000, 'old', unknownKey));
    await expect(service.accessTokenFor('org-1')).rejects.toMatchObject({
      name: 'CanvaKeyUnavailableError',
    });
    expect(db.credentials.get('org-1')).toEqual(stored);
    expect(db.connection('org-1').status).toBe('CONNECTED');
    expect(tokens.refresh).not.toHaveBeenCalled();
    expect(db.queue).toHaveLength(0);
  });

  it('marks a credential undecryptable only when a configured key cannot open it', async () => {
    const { service, db } = setup('none');
    const stored = credential(db, 60_000, 'old');
    db.seedCredential({
      ...stored,
      refreshToken: { ...stored.refreshToken, tag: 'AAAAAAAAAAAAAAAAAAAAAA' },
    });
    await expect(service.accessTokenFor('org-1')).rejects.toMatchObject({
      reason: 'undecryptable',
    });
    expect(db.connection('org-1').reauthorizationReason).toBe('undecryptable');
  });

  it('reads an old-key credential on a promoted instance and writes the refresh under the new key', async () => {
    const { db, store, tokens, identity, worker } = setup('none');
    db.seedCredential(credential(db, 60_000, 'old'));
    const promoted = {
      ...config,
      keyring: new CanvaTokenKeyring(
        { version: 2, key: Buffer.alloc(32, 2) },
        new Map([[1, Buffer.alloc(32, 7)]]),
      ),
    };
    const service = new CanvaAccessTokenService(
      promoted,
      store,
      tokens as unknown as CanvaTokenClient,
      () => db.now(),
      identity as unknown as CanvaIdentityClient,
      worker as unknown as CanvaRevocationWorker,
    );
    await expect(service.accessTokenFor('org-1')).resolves.toBe('new-access');
    expect(db.credentials.get('org-1')!.refreshToken.keyVersion).toBe(2);
  });

  it('waits for a previous lease holder before marking invalid_grant after a takeover', async () => {
    const { service, store, db, tokens, sleep } = setup();
    // The previous holder's lease expired: this claim is a takeover.
    store.leases.set('org-1', { owner: 'other', until: db.time - 1 });
    tokens.refresh.mockRejectedValueOnce(
      new CanvaTokenError('invalid_grant', 400),
    );
    // The previous holder's rotation lands during the grace period.
    sleep.mockImplementationOnce(async () => {
      const current = db.credentials.get('org-1')!;
      const connection = db.connection('org-1');
      connection.credentialVersion += 1;
      db.credentials.set('org-1', {
        ...credential(db, FRESH_MS, 'rotated', config.keyring, 'canva-current'),
        chainId: current.chainId,
        version: connection.credentialVersion,
      });
    });
    await expect(service.accessTokenFor('org-1')).resolves.toBe(
      'rotated-access',
    );
    expect(db.connection('org-1').status).toBe('CONNECTED');
  });

  it('marks invalid_grant after the takeover grace period when nothing lands', async () => {
    const { service, store, db, tokens, sleep } = setup();
    store.leases.set('org-1', { owner: 'other', until: db.time - 1 });
    tokens.refresh.mockRejectedValueOnce(
      new CanvaTokenError('invalid_grant', 400),
    );
    await expect(service.accessTokenFor('org-1')).rejects.toMatchObject({
      reason: 'invalid_grant',
    });
    expect(sleep).toHaveBeenCalledTimes(15);
  });

  it('is disabled in mock mode', async () => {
    const db = new MemoryCanvaDatabase();
    const service = new CanvaAccessTokenService(
      { mode: 'mock', webOrigin: 'http://localhost:5173' },
      new MemoryCredentialStore(db),
      {} as CanvaTokenClient,
      () => db.now(),
      {} as CanvaIdentityClient,
      { trigger: vi.fn() } as unknown as CanvaRevocationWorker,
    );
    await expect(service.accessTokenFor('org-1')).rejects.toMatchObject({
      kind: 'disabled',
    });
  });
});

describe('CanvaAccessTokenService: reconnect and disconnect during a refresh', () => {
  it('never lets a stale refresh overwrite a reconnect, and queues the orphaned rotation', async () => {
    const { service, db, tokens, reconnect, worker } = setup();
    const { inFlight, release } = gatedRefresh(tokens, async () => stale());
    const pending = service.accessTokenFor('org-1');
    await inFlight;
    const saved = reconnect('reconnected');
    release();
    await expect(pending).resolves.toBe('reconnected-access');
    expect(db.credentials.get('org-1')).toEqual(saved);
    const orphan = db.queue.find((row) => row.reason === 'orphaned_rotation')!;
    expect(orphan).toMatchObject({
      chainId: 'chain-current',
      canvaUserId: 'canva-current',
    });
    expect(
      config.keyring.open(
        orphan.refreshToken,
        sealContext.refreshToken('org-1'),
      ),
    ).toBe('stale-refresh');
    expect(worker.trigger).toHaveBeenCalledWith('canva-current');
    expect(tokens.revoke).not.toHaveBeenCalled();
  });

  it('queues the orphan of a same-user reconnect too; the worker guard skips it', async () => {
    const { service, db, tokens, reconnect } = setup();
    const { inFlight, release } = gatedRefresh(tokens, async () => stale());
    const pending = service.accessTokenFor('org-1');
    await inFlight;
    reconnect('reconnected', 'canva-current');
    release();
    await pending;
    expect(db.queue).toMatchObject([
      { reason: 'orphaned_rotation', canvaUserId: 'canva-current' },
    ]);
    // The same Canva user holds a credential: T1 would finish it
    // skipped_shared_consent without a call.
    expect(db.hasGrant('canva-current')).toBe(true);
  });

  it('never resurrects a credential removed by a disconnect during a refresh', async () => {
    const { service, db, tokens, store } = setup();
    const { inFlight, release } = gatedRefresh(tokens, async () => stale());
    const pending = service.accessTokenFor('org-1');
    await inFlight;
    await store.disconnect('org-1', 'user-1');
    release();
    await expect(pending).rejects.toMatchObject({ reason: 'not_connected' });
    expect(db.credentials.size).toBe(0);
    expect(db.queue.map((row) => row.reason).sort()).toEqual([
      'disconnect',
      'orphaned_rotation',
    ]);
  });

  it('does not disable a reconnect when the old credential fails with invalid_grant', async () => {
    const { service, db, tokens, reconnect } = setup();
    const { inFlight, release } = gatedRefresh(tokens, async () => {
      throw new CanvaTokenError('invalid_grant', 400);
    });
    const pending = service.accessTokenFor('org-1');
    await inFlight;
    reconnect('reconnected');
    release();
    await expect(pending).resolves.toBe('reconnected-access');
    expect(db.connection('org-1').status).toBe('CONNECTED');
  });
});

describe('CanvaAccessTokenService after an ambiguous or failed rotation write', () => {
  it('treats a write that committed but reported an unknown outcome as success', async () => {
    const { service, store, db } = setup();
    store.nextRotationFault = 'committed_unknown';
    await expect(service.accessTokenFor('org-1')).resolves.toBe('new-access');
    expect(db.queue).toHaveLength(0);
  });

  it('marks rotation_lost when an unknown outcome is verified as not committed', async () => {
    const { service, store, db, tokens } = setup();
    store.nextRotationFault = 'uncommitted_unknown';
    await expect(service.accessTokenFor('org-1')).rejects.toMatchObject({
      name: 'CanvaReconnectRequiredError',
      reason: 'rotation_lost',
    });
    // The spent token is no longer stored, so it can never be used again.
    expect(db.credentials.size).toBe(0);
    expect(db.queue).toHaveLength(0);
    expect(tokens.revoke).not.toHaveBeenCalled();
  });

  it('stays temporary, marking nothing, when an unknown outcome meets a newer write on the same chain', async () => {
    const { service, store, db } = setup();
    store.nextRotationFault = 'uncommitted_unknown';
    const read = store.read.getMockImplementation()!;
    let reads = 0;
    store.read.mockImplementation(async (organizationId: string) => {
      reads += 1;
      const current = await read(organizationId);
      // Another writer advanced the version on the same chain.
      return reads === 2 && current
        ? { ...current, version: current.version + 1, writeId: 'write-other' }
        : current;
    });
    await expect(service.accessTokenFor('org-1')).rejects.toMatchObject({
      name: 'CanvaTemporarilyUnavailableError',
      outcomeUnknown: true,
    });
    expect(store.markReauthorizationRequired).not.toHaveBeenCalled();
    expect(db.queue).toHaveLength(0);
  });

  it('gives nothing up when the outcome cannot be verified because the re-read fails', async () => {
    const { service, store, db } = setup();
    store.nextRotationFault = 'uncommitted_unknown';
    const read = store.read.getMockImplementation()!;
    let reads = 0;
    store.read.mockImplementation(async (organizationId: string) => {
      reads += 1;
      // The fast-path read succeeds; the verification re-read fails.
      if (reads === 2) throw new Error('read failed');
      return read(organizationId);
    });
    await expect(service.accessTokenFor('org-1')).rejects.toMatchObject({
      outcomeUnknown: true,
    });
    expect(db.queue).toHaveLength(0);
  });
});

describe('CanvaAccessTokenService when a rotation cannot be saved (rotation_lost)', () => {
  it('marks rotation_lost when the write definitely failed and the spent token is still stored', async () => {
    const { service, store, db, tokens } = setup();
    store.nextRotationFault = 'definite';
    await expect(service.accessTokenFor('org-1')).rejects.toMatchObject({
      name: 'CanvaReconnectRequiredError',
      reason: 'rotation_lost',
    });
    expect(tokens.refresh).toHaveBeenCalledTimes(1);
    expect(db.credentials.size).toBe(0);
    expect(db.connection('org-1')).toMatchObject({
      status: 'REAUTHORIZATION_REQUIRED',
      reauthorizationReason: 'rotation_lost',
    });
    // Like any lost or dead token (§5.8), nothing is queued or revoked.
    expect(db.queue).toHaveLength(0);
    expect(tokens.revoke).not.toHaveBeenCalled();
    expect(db.audit.at(-1)).toMatchObject({
      action: 'canva.connection.reauthorization_required',
      metadata: { reason: 'rotation_lost' },
    });
  });

  it('gives nothing up and keeps the credential when the mark itself cannot be saved', async () => {
    const { service, store, db } = setup();
    store.nextRotationFault = 'definite';
    store.markReauthorizationRequired.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    await expect(service.accessTokenFor('org-1')).rejects.toMatchObject({
      name: 'CanvaTemporarilyUnavailableError',
      outcomeUnknown: false,
    });
    expect(db.credentials.get('org-1')?.writeId).toBe('write-current');
    expect(db.queue).toHaveLength(0);
  });

  it('gives nothing up when the state cannot be re-read after the failed write', async () => {
    const { service, store, db } = setup();
    store.nextRotationFault = 'definite';
    const read = store.read.getMockImplementation()!;
    let reads = 0;
    store.read.mockImplementation(async (organizationId: string) => {
      reads += 1;
      if (reads === 2) throw new Error('read failed');
      return read(organizationId);
    });
    await expect(service.accessTokenFor('org-1')).rejects.toBeInstanceOf(
      CanvaTemporarilyUnavailableError,
    );
    expect(store.markReauthorizationRequired).not.toHaveBeenCalled();
    expect(db.credentials.size).toBe(1);
    expect(db.queue).toHaveLength(0);
  });

  it('queues the rotation as orphaned, without marking, when the re-read finds another chain', async () => {
    const { service, store, db, tokens } = setup();
    store.nextRotationFault = 'definite';
    const read = store.read.getMockImplementation()!;
    let reads = 0;
    store.read.mockImplementation(async (organizationId: string) => {
      reads += 1;
      const current = await read(organizationId);
      // The verification re-read sees a reconnect's chain.
      return reads === 2 && current
        ? { ...current, chainId: 'chain-other' }
        : current;
    });
    // The stale result makes the service re-read once and refresh again.
    await expect(service.accessTokenFor('org-1')).resolves.toBe('new-access');
    expect(store.markReauthorizationRequired).not.toHaveBeenCalled();
    expect(db.queue).toMatchObject([
      { reason: 'orphaned_rotation', chainId: 'chain-current' },
    ]);
    expect(tokens.revoke).not.toHaveBeenCalled();
  });
});

describe('CanvaAccessTokenService after rotation_lost: use and recovery', () => {
  async function lost() {
    const context = setup();
    context.store.nextRotationFault = 'definite';
    await expect(context.service.accessTokenFor('org-1')).rejects.toMatchObject(
      { reason: 'rotation_lost' },
    );
    context.tokens.refresh.mockClear();
    return context;
  }

  it('never treats the spent credential as usable afterwards', async () => {
    const { service, db, tokens } = await lost();
    await expect(service.accessTokenFor('org-1')).rejects.toMatchObject({
      name: 'CanvaReconnectRequiredError',
      reason: 'not_connected',
    });
    // No second refresh with the spent token.
    expect(tokens.refresh).not.toHaveBeenCalled();
    expect(db.connection('org-1')).toMatchObject({
      status: 'REAUTHORIZATION_REQUIRED',
      reauthorizationReason: 'rotation_lost',
    });
  });

  it('recovers only through an administrator reconnect', async () => {
    const { service, reconnect } = await lost();
    reconnect('replacement');
    await expect(service.accessTokenFor('org-1')).resolves.toBe(
      'replacement-access',
    );
  });

  it('has nothing left to queue on a later disconnect', async () => {
    const { service, db, tokens } = await lost();
    await expect(service.disconnect('org-1', 'user-1')).resolves.toEqual({
      removed: false,
      revocation: 'none',
    });
    expect(db.queue).toHaveLength(0);
    expect(tokens.revoke).not.toHaveBeenCalled();
  });

  it('lets a reconnect that lands before the mark win, and queues the orphaned rotation', async () => {
    const { service, store, db, reconnect } = setup();
    store.nextRotationFault = 'definite';
    const mark = store.markReauthorizationRequired.getMockImplementation()!;
    store.markReauthorizationRequired.mockImplementationOnce(
      async (...args) => {
        reconnect('racing');
        return mark(...args);
      },
    );
    await expect(service.accessTokenFor('org-1')).resolves.toBe(
      'racing-access',
    );
    expect(db.connection('org-1').status).toBe('CONNECTED');
    expect(db.credentials.get('org-1')?.chainId).toBe('chain-racing');
    expect(db.queue.map((row) => [row.reason, row.chainId]).sort()).toEqual([
      ['orphaned_rotation', 'chain-current'],
      ['replaced_other_user', 'chain-current'],
    ]);
  });
});

describe('CanvaAccessTokenService.disconnect (§5.9)', () => {
  it('removes the credential and queues its tokens; nothing is revoked inline', async () => {
    const { service, db, tokens, worker } = setup('fresh');
    await expect(service.disconnect('org-1', 'user-1')).resolves.toEqual({
      removed: true,
      revocation: 'queued',
    });
    expect(db.credentials.size).toBe(0);
    expect(db.queue).toMatchObject([
      { reason: 'disconnect', canvaUserId: 'canva-current' },
    ]);
    expect(db.accounts.get('canva-current')).toBeNull();
    expect(tokens.revoke).not.toHaveBeenCalled();
    expect(worker.trigger).toHaveBeenCalled();
    expect(db.audit.at(-1)).toMatchObject({
      action: 'canva.connection.disconnected',
      metadata: { revocation: 'queued' },
    });
  });

  it('supersedes a pending candidate for the same Canva user and queues both lineages (D14)', async () => {
    const { service, db } = setup('fresh');
    db.candidates.set('org-1', {
      id: 'candidate-1',
      organizationId: 'org-1',
      userId: 'user-1',
      sessionId: 'session-1',
      attemptId: 'attempt-1',
      baseGeneration: 1,
      chainId: 'chain-candidate',
      writeId: 'write-candidate',
      accessToken: { keyVersion: 1, iv: 'a', ciphertext: 'b', tag: 'c' },
      refreshToken: { keyVersion: 1, iv: 'd', ciphertext: 'e', tag: 'f' },
      accessTokenExpiresAt: db.now(),
      scopes: [],
      canvaUserId: 'canva-current',
      canvaTeamId: 'canva-team-1',
      canvaDisplayName: null,
      capabilities: { autofill: true, brandTemplate: true },
      createdAt: db.now(),
      expiresAt: new Date(db.time + 600_000),
    });
    await service.disconnect('org-1', 'user-1');
    expect(db.queue.map((row) => row.reason).sort()).toEqual([
      'candidate_superseded',
      'disconnect',
    ]);
    expect(db.accounts.get('canva-current')).toBeNull();
  });

  it('reports nothing queued when no credential is stored', async () => {
    const { service, worker } = setup('none');
    await expect(service.disconnect('org-1', 'user-1')).resolves.toEqual({
      removed: false,
      revocation: 'none',
    });
    expect(worker.trigger).not.toHaveBeenCalled();
  });
});

describe('CanvaAccessTokenService.verifyStoredIdentity (§2.8)', () => {
  it('accepts a matching identity', async () => {
    const { service } = setup('fresh');
    await expect(service.verifyStoredIdentity('org-1')).resolves.toBe(true);
  });

  it('marks identity_mismatch and discards the tokens without queuing them', async () => {
    const { service, db, identity } = setup('fresh');
    identity.currentUser.mockResolvedValueOnce({
      canvaUserId: 'someone-else',
      canvaTeamId: 'canva-team-1',
    });
    await expect(service.verifyStoredIdentity('org-1')).resolves.toBe(false);
    expect(db.connection('org-1').reauthorizationReason).toBe(
      'identity_mismatch',
    );
    expect(db.credentials.size).toBe(0);
    expect(db.queue).toHaveLength(0);
  });
});
