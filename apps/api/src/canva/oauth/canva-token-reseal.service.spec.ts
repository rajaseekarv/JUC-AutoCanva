import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanvaOAuthConfig } from './canva-oauth.config';
import { CanvaPersistenceUnavailableError } from './canva-oauth.stores';
import {
  MemoryCanvaDatabase,
  MemoryResealStore,
  testRealConfig,
} from './canva-oauth.test-doubles';
import { CanvaTokenKeyring, sealContext } from './canva-token-cipher';
import { CanvaTokenResealService } from './canva-token-reseal.service';

// Mocked store. These tests check the reseal's decisions, resumability, and
// that it never exposes plaintext. They are not evidence that PostgreSQL
// applies the conditional writes as specified (gate 5).

const oldKey = Buffer.alloc(32, 1);
const newKey = Buffer.alloc(32, 2);
const oldKeyring = new CanvaTokenKeyring({ version: 1, key: oldKey });
// After rotation: version 2 is current, version 1 is kept for decryption.
const rotatedKeyring = new CanvaTokenKeyring(
  { version: 2, key: newKey },
  new Map([[1, oldKey]]),
);

function rotatedConfig(
  keyring: CanvaTokenKeyring = rotatedKeyring,
): CanvaOAuthConfig {
  return { ...testRealConfig({ persistence: true }), keyring };
}

const plaintexts = [
  'org-1-access',
  'org-1-refresh',
  'candidate-access',
  'candidate-refresh',
  'queued-refresh',
  'exhausted-refresh',
  'verifier-plain',
];

// One of every sealed kind, all under key version 1.
function seed(db: MemoryCanvaDatabase, keyring = oldKeyring) {
  db.seedCredential({
    organizationId: 'org-1',
    connectedById: 'user-1',
    accessToken: keyring.seal('org-1-access', sealContext.accessToken('org-1')),
    refreshToken: keyring.seal(
      'org-1-refresh',
      sealContext.refreshToken('org-1'),
    ),
    accessTokenExpiresAt: db.now(),
    scopes: [],
    canvaUserId: 'canva-1',
    canvaTeamId: 'team-1',
    chainId: 'chain-1',
    writeId: 'write-1',
  });
  db.candidates.set('org-2', {
    id: 'candidate-1',
    organizationId: 'org-2',
    userId: 'user-2',
    sessionId: 'session-2',
    attemptId: 'attempt-x',
    baseGeneration: 0,
    chainId: 'chain-2',
    writeId: 'write-2',
    accessToken: keyring.seal(
      'candidate-access',
      sealContext.accessToken('org-2'),
    ),
    refreshToken: keyring.seal(
      'candidate-refresh',
      sealContext.refreshToken('org-2'),
    ),
    accessTokenExpiresAt: db.now(),
    scopes: [],
    canvaUserId: 'canva-2',
    canvaTeamId: 'team-2',
    canvaDisplayName: null,
    capabilities: { autofill: true, brandTemplate: true },
    createdAt: db.now(),
    expiresAt: new Date(db.time + 600_000),
  });
  for (const [label, state] of [
    ['queued', 'queued'],
    ['exhausted', 'exhausted'],
  ] as const) {
    db.enqueue({
      organizationId: 'org-3',
      chainId: `chain-${label}`,
      canvaUserId: 'canva-3',
      reason: 'disconnect',
      refreshToken: keyring.seal(
        `${label}-refresh`,
        sealContext.refreshToken('org-3'),
      ),
    });
    db.queue.at(-1)!.state = state;
  }
  db.attempts.set('attempt-1', {
    id: 'attempt-1',
    organizationId: 'org-4',
    userId: 'user-4',
    sessionId: 'session-4',
    launchTokenHash: 'hash',
    redirectUri: 'unused',
    baseGeneration: 0,
    launchExpiresAt: db.now(),
    launchedAt: db.now(),
    expiresAt: new Date(db.time + 600_000),
    consumedAt: null,
    stateHash: 'state',
    browserBindingHash: 'binding',
    codeVerifier: keyring.seal(
      'verifier-plain',
      sealContext.codeVerifier('org-4'),
    ),
  });
}

function setup(config: CanvaOAuthConfig = rotatedConfig()) {
  const db = new MemoryCanvaDatabase();
  const store = new MemoryResealStore(db);
  const service = new CanvaTokenResealService(config, store);
  return { db, store, service };
}

// Every stored value, opened with the rotated keyring.
function openAll(db: MemoryCanvaDatabase, keyring = rotatedKeyring) {
  const credential = db.credentials.get('org-1')!;
  const candidate = db.candidates.get('org-2')!;
  return {
    credential: [
      keyring.open(credential.accessToken, sealContext.accessToken('org-1')),
      keyring.open(credential.refreshToken, sealContext.refreshToken('org-1')),
    ],
    candidate: [
      keyring.open(candidate.accessToken, sealContext.accessToken('org-2')),
      keyring.open(candidate.refreshToken, sealContext.refreshToken('org-2')),
    ],
    queue: db.queue.map((row) =>
      keyring.open(row.refreshToken, sealContext.refreshToken('org-3')),
    ),
    verifier: keyring.open(
      db.attempts.get('attempt-1')!.codeVerifier!,
      sealContext.codeVerifier('org-4'),
    ),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CanvaTokenResealService.run (§5.11)', () => {
  it('reseals every kind under the current key without changing version, writeId, or plaintext', async () => {
    const { db, service } = setup();
    seed(db);
    const before = db.credentials.get('org-1')!;
    const summary = await service.run();
    expect(summary).toMatchObject({
      currentKeyVersion: 2,
      scanned: 5,
      resealed: 5,
      skipped: 0,
      missingKey: 0,
      undecryptable: 0,
      interrupted: false,
      remaining: 0,
    });
    const after = db.credentials.get('org-1')!;
    expect(after.accessToken.keyVersion).toBe(2);
    expect(after.refreshToken.keyVersion).toBe(2);
    expect(after).toMatchObject({
      version: before.version,
      writeId: before.writeId,
      chainId: before.chainId,
      canvaUserId: before.canvaUserId,
    });
    // Exhausted rows keep (resealed) ciphertext for an administrator retry.
    expect(db.queue.map((row) => row.state)).toEqual(['queued', 'exhausted']);
    expect(openAll(db)).toEqual({
      credential: ['org-1-access', 'org-1-refresh'],
      candidate: ['candidate-access', 'candidate-refresh'],
      queue: ['queued-refresh', 'exhausted-refresh'],
      verifier: 'verifier-plain',
    });
    // The new key alone opens everything now.
    const newOnly = new CanvaTokenKeyring({ version: 2, key: newKey });
    expect(() => openAll(db, newOnly)).not.toThrow();
    expect(db.audit).toEqual([
      {
        organizationId: 'org-1',
        actorUserId: null,
        action: 'canva.credential.resealed',
        metadata: { fromKeyVersion: 1, toKeyVersion: 2 },
      },
    ]);
  });

  it('is idempotent: a second run finds nothing to do', async () => {
    const { db, service, store } = setup();
    seed(db);
    await service.run();
    store.reseal.mockClear();
    await expect(service.run()).resolves.toMatchObject({
      scanned: 0,
      resealed: 0,
      remaining: 0,
    });
    expect(store.reseal).not.toHaveBeenCalled();
  });

  it('lets a refresh that lands first win, and leaves its row alone', async () => {
    const { db, service, store } = setup();
    seed(db);
    store.beforeReseal = (row) => {
      if (row.kind !== 'credential') return;
      // A refresh writes new tokens under the current key.
      const current = db.credentials.get('org-1')!;
      db.credentials.set('org-1', {
        ...current,
        accessToken: rotatedKeyring.seal(
          'refreshed-access',
          sealContext.accessToken('org-1'),
        ),
        refreshToken: rotatedKeyring.seal(
          'refreshed-refresh',
          sealContext.refreshToken('org-1'),
        ),
        writeId: 'write-refresh',
        version: current.version + 1,
      });
    };
    const summary = await service.run();
    expect(summary).toMatchObject({ resealed: 4, skipped: 1, remaining: 0 });
    expect(
      rotatedKeyring.open(
        db.credentials.get('org-1')!.refreshToken,
        sealContext.refreshToken('org-1'),
      ),
    ).toBe('refreshed-refresh');
    expect(db.actions()).not.toContain('canva.credential.resealed');
  });

  it('skips a credential while a refresh lease is active and reseals it on a later run', async () => {
    const { db, service, store } = setup();
    seed(db);
    store.activeLeases.add('org-1');
    await expect(service.run()).resolves.toMatchObject({
      resealed: 4,
      skipped: 1,
      remaining: 1,
    });
    await expect(service.inventory()).resolves.toMatchObject({
      retirement: [{ keyVersion: 1, rows: 1, safeToRetire: false }],
    });
    store.activeLeases.clear();
    await expect(service.run()).resolves.toMatchObject({
      resealed: 1,
      remaining: 0,
    });
    await expect(service.inventory()).resolves.toMatchObject({
      retirement: [{ keyVersion: 1, rows: 0, safeToRetire: true }],
    });
  });

  it('skips rows removed concurrently by a disconnect, a consumption, or the worker', async () => {
    const { db, service, store } = setup();
    seed(db);
    store.beforeReseal = (row) => {
      if (row.kind === 'credential') db.credentials.delete('org-1');
      if (row.kind === 'attempt')
        db.attempts.get('attempt-1')!.consumedAt = db.now();
      if (row.kind === 'revocation') {
        const queued = db.queue.find((entry) => entry.id === row.id)!;
        queued.state = 'finished';
        queued.sealedCleared = true;
      }
    };
    await expect(service.run()).resolves.toMatchObject({
      resealed: 1,
      skipped: 4,
      remaining: 0,
    });
    expect(db.credentials.size).toBe(0);
  });

  it('stops on a store failure and resumes from the remaining rows on the next run', async () => {
    const { db, service, store } = setup();
    seed(db);
    let calls = 0;
    const reseal = store.reseal.getMockImplementation()!;
    store.reseal.mockImplementation(async (row, values) => {
      calls += 1;
      if (calls === 3) throw new Error('connection lost');
      return reseal(row, values);
    });
    const first = await service.run();
    expect(first).toMatchObject({
      resealed: 2,
      interrupted: true,
      remaining: 3,
    });
    store.reseal.mockImplementation(reseal);
    await expect(service.run()).resolves.toMatchObject({
      resealed: 3,
      interrupted: false,
      remaining: 0,
    });
    expect(openAll(db).queue).toEqual(['queued-refresh', 'exhausted-refresh']);
  });

  it('reports an interrupted run when the listing fails, writing nothing', async () => {
    const { db, service, store } = setup();
    seed(db);
    store.failNextList = true;
    await expect(service.run()).resolves.toMatchObject({
      scanned: 0,
      interrupted: true,
      remaining: 5,
    });
    expect(store.reseal).not.toHaveBeenCalled();
  });

  it('bounds a run with a limit and continues where the next run starts', async () => {
    const { db, service } = setup();
    seed(db);
    await expect(service.run({ limit: 4 })).resolves.toMatchObject({
      scanned: 4,
      resealed: 4,
      remaining: 1,
    });
    await expect(service.run({ limit: 4 })).resolves.toMatchObject({
      scanned: 1,
      resealed: 1,
      remaining: 0,
    });
  });

  it('never destroys a row whose key is missing or whose value does not open', async () => {
    // Current key 3 and previous key 1 are configured; key 2 was removed.
    const { db, service, store } = setup(
      rotatedConfig(
        new CanvaTokenKeyring(
          { version: 3, key: Buffer.alloc(32, 3) },
          new Map([[1, oldKey]]),
        ),
      ),
    );
    seed(db, new CanvaTokenKeyring({ version: 2, key: Buffer.alloc(32, 9) }));
    const corrupt = db.candidates.get('org-2')!;
    await expect(service.run()).resolves.toMatchObject({
      missingKey: 5,
      resealed: 0,
      remaining: 5,
    });
    expect(store.reseal).not.toHaveBeenCalled();
    expect(db.candidates.get('org-2')).toBe(corrupt);
    expect(db.credentials.size).toBe(1);
    expect(db.queue.every((row) => !row.sealedCleared)).toBe(true);
  });

  it('counts a value that does not open with its configured key as undecryptable and leaves it', async () => {
    const { db, service } = setup();
    seed(db);
    const credential = db.credentials.get('org-1')!;
    db.credentials.set('org-1', {
      ...credential,
      refreshToken: {
        ...credential.refreshToken,
        tag: 'AAAAAAAAAAAAAAAAAAAAAA',
      },
    });
    await expect(service.run()).resolves.toMatchObject({
      undecryptable: 1,
      resealed: 4,
      remaining: 1,
    });
    expect(db.credentials.get('org-1')!.accessToken.keyVersion).toBe(1);
  });

  it('leaves malformed stored values untouched: short IV, garbage ciphertext, unknown version 0', async () => {
    const { db, service, store } = setup();
    seed(db);
    const credential = db.credentials.get('org-1')!;
    db.credentials.set('org-1', {
      ...credential,
      accessToken: { ...credential.accessToken, iv: 'AAAA' },
    });
    const candidate = db.candidates.get('org-2')!;
    candidate.refreshToken = {
      ...candidate.refreshToken,
      ciphertext: '%%% not base64 %%%',
    };
    // The store reports a queue row with no key version as version 0.
    db.queue[0].refreshToken = { ...db.queue[0].refreshToken, keyVersion: 0 };
    const before = JSON.stringify([
      db.credentials.get('org-1'),
      candidate,
      db.queue[0],
    ]);
    await expect(service.run()).resolves.toMatchObject({
      undecryptable: 2,
      missingKey: 1,
      resealed: 2,
      interrupted: false,
      remaining: 3,
    });
    expect(
      JSON.stringify([db.credentials.get('org-1'), candidate, db.queue[0]]),
    ).toBe(before);
    expect(store.reseal).toHaveBeenCalledTimes(2);
    await expect(service.inventory()).resolves.toMatchObject({
      retirement: [{ keyVersion: 1, safeToRetire: false }],
    });
  });

  it('never logs or returns plaintext tokens or verifiers', async () => {
    const { db, service } = setup();
    seed(db);
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error'] as const)
      vi.spyOn(Logger.prototype, level).mockImplementation(
        (...args: unknown[]) => {
          lines.push(String(args[0]));
        },
      );
    const summary = await service.run();
    const report = await service.inventory();
    const output = JSON.stringify({ summary, report, lines });
    for (const plaintext of plaintexts) expect(output).not.toContain(plaintext);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('refuses in mock mode and without durable storage', async () => {
    const mock = setup({ mode: 'mock', webOrigin: 'http://localhost:5173' });
    await expect(mock.service.run()).rejects.toBeInstanceOf(
      CanvaPersistenceUnavailableError,
    );
    const off = setup(testRealConfig());
    await expect(off.service.inventory()).rejects.toBeInstanceOf(
      CanvaPersistenceUnavailableError,
    );
    expect(off.store.inventory).not.toHaveBeenCalled();
  });
});

describe('CanvaTokenResealService during a rolling key rotation', () => {
  it('leaves rows sealed with a newer key alone (an instance that has not been promoted)', async () => {
    // This process still has key 1 current; promoted instances wrote key 2.
    const { db, service, store } = setup(rotatedConfig(oldKeyring));
    seed(db, new CanvaTokenKeyring({ version: 2, key: newKey }));
    await expect(service.run()).resolves.toMatchObject({
      newerKey: 5,
      resealed: 0,
      missingKey: 0,
      remaining: 0,
    });
    expect(store.reseal).not.toHaveBeenCalled();
  });

  it('refuses to run while a newer key is only pre-staged, so rows never move backwards', async () => {
    // Pre-staging step: key 2 configured for decryption, key 1 still current.
    const prestaged = new CanvaTokenKeyring(
      { version: 1, key: oldKey },
      new Map([[2, newKey]]),
    );
    const { db, service, store } = setup(rotatedConfig(prestaged));
    seed(db, new CanvaTokenKeyring({ version: 2, key: newKey }));
    await expect(service.run()).rejects.toMatchObject({
      name: 'CanvaResealRefusedError',
    });
    expect(store.listStale).not.toHaveBeenCalled();
    await expect(service.inventory()).resolves.toMatchObject({
      currentKeyVersion: 1,
      retirement: [],
      prestaged: [2],
    });
  });

  it('lets a pre-staged instance read rows that promoted instances sealed with the new key', () => {
    const prestaged = new CanvaTokenKeyring(
      { version: 1, key: oldKey },
      new Map([[2, newKey]]),
    );
    const promoted = new CanvaTokenKeyring({ version: 2, key: newKey });
    const context = sealContext.refreshToken('org-1');
    expect(prestaged.open(promoted.seal('token', context), context)).toBe(
      'token',
    );
  });
});

describe('CanvaTokenResealService.inventory', () => {
  it('reports only the previous versions, and which are safe to retire', async () => {
    const { db, service } = setup();
    seed(db);
    const report = await service.inventory();
    expect(report.currentKeyVersion).toBe(2);
    expect(report.retirement).toEqual([
      { keyVersion: 1, rows: 5, safeToRetire: false },
    ]);
    expect(report.inventory).toContainEqual({
      kind: 'revocation',
      keyVersion: 1,
      rows: 2,
    });
  });
});
