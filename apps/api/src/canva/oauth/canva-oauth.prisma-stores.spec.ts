import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../../audit/audit.service';
import { PrismaCanvaCredentialStore } from './canva-credential.prisma-store';
import { PrismaCanvaOAuthAttemptStore } from './canva-oauth-attempt.prisma-store';
import {
  CanvaPersistenceError,
  CanvaStaleCredentialError,
  CanvaWriteOutcomeUnknownError,
  type NewCanvaCandidate,
} from './canva-oauth.stores';
import {
  RetryTransaction,
  RollbackWith,
  runCanvaTransaction,
  type CanvaTransactionRunner,
} from './canva-prisma.transaction';
import { PrismaCanvaResealStore } from './canva-reseal.prisma-store';
import { PrismaCanvaRevocationQueue } from './canva-revocation.prisma-store';

// A scripted stand-in for Prisma: it records every statement and answers
// from handlers matched against the SQL text. These tests check statement
// order (the lock order and read-after-lock rules), rollback branches,
// retries, and the definite-versus-ambiguous classification. They are NOT
// evidence that PostgreSQL enforces anything: the gates in §10 of the
// persistence proposal are.

type Answer = unknown[] | number | (() => unknown);
type Handler = { match: RegExp; answer: Answer; once?: boolean };

class ScriptedPrisma {
  readonly statements: string[] = [];
  readonly values: unknown[][] = [];
  readonly audit: Array<{ action: string; metadata: unknown }> = [];
  readonly options: unknown[] = [];
  transactions = 0;
  commitFailure: unknown = null;
  private handlers: Handler[] = [];

  on(match: RegExp, answer: Answer, once = false): this {
    this.handlers.push({ match, answer, once });
    return this;
  }

  private run(kind: 'query' | 'execute', args: unknown[]): unknown {
    const [first, ...rest] = args;
    const sql = Array.isArray(first)
      ? Prisma.sql(first as unknown as TemplateStringsArray, ...rest)
      : (first as Prisma.Sql);
    const text = sql.text.replace(/\s+/g, ' ').trim();
    this.statements.push(text);
    this.values.push(sql.values);
    const index = this.handlers.findIndex((handler) =>
      handler.match.test(text),
    );
    if (index < 0) return kind === 'query' ? [] : 1;
    const handler = this.handlers[index];
    if (handler.once) this.handlers.splice(index, 1);
    return typeof handler.answer === 'function'
      ? handler.answer()
      : handler.answer;
  }

  $queryRaw = vi.fn(async (...args: unknown[]) => this.run('query', args));
  $executeRaw = vi.fn(async (...args: unknown[]) => this.run('execute', args));
  auditLog = {
    create: vi.fn(
      async ({ data }: { data: { action: string; metadata: unknown } }) => {
        this.audit.push({ action: data.action, metadata: data.metadata });
        return data;
      },
    ),
  };

  $transaction = vi.fn(
    async <T>(body: (tx: unknown) => Promise<T>, options?: unknown) => {
      this.transactions += 1;
      this.options.push(options);
      const value = await body(this);
      if (this.commitFailure) {
        const failure = this.commitFailure;
        this.commitFailure = null;
        throw failure;
      }
      return value;
    },
  );

  indexOf(pattern: RegExp, from = 0): number {
    const index = this.statements.findIndex(
      (text, position) => position >= from && pattern.test(text),
    );
    return index;
  }
}

function auditService(prisma: ScriptedPrisma): AuditService {
  return {
    write: vi.fn(
      async (
        tx: ScriptedPrisma,
        input: { action: string; metadata?: unknown },
      ) =>
        tx.auditLog.create({
          data: { action: input.action, metadata: input.metadata ?? {} },
        }),
    ),
    prisma,
  } as unknown as AuditService;
}

const runner = (prisma: ScriptedPrisma) =>
  prisma as unknown as CanvaTransactionRunner;
const noSleep = { sleep: async () => undefined, random: () => 0 };

function rawFailure(sqlState: string, message = 'raw query failed') {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code: 'P2010',
    clientVersion: 'test',
    meta: { code: sqlState },
  });
}

describe('runCanvaTransaction (§4)', () => {
  it('runs at READ COMMITTED with a lock timeout', async () => {
    const prisma = new ScriptedPrisma();
    await runCanvaTransaction(runner(prisma), async () => 'ok');
    expect(prisma.options[0]).toMatchObject({
      isolationLevel: 'ReadCommitted',
    });
    expect(prisma.statements[0]).toBe("SET LOCAL lock_timeout = '5s'");
  });

  it('reports a failure after the body finished (during COMMIT) as ambiguous', async () => {
    const prisma = new ScriptedPrisma();
    prisma.commitFailure = new Prisma.PrismaClientKnownRequestError(
      'Transaction already closed',
      { code: 'P2028', clientVersion: 'test' },
    );
    await expect(
      runCanvaTransaction(runner(prisma), async () => 'ok'),
    ).rejects.toBeInstanceOf(CanvaWriteOutcomeUnknownError);
  });

  it('reports a failure inside the body as definite', async () => {
    const prisma = new ScriptedPrisma();
    await expect(
      runCanvaTransaction(runner(prisma), async () => {
        throw new Error('connection reset');
      }),
    ).rejects.toBeInstanceOf(CanvaPersistenceError);
  });

  it('retries deadlocks and serialization failures at most 3 times', async () => {
    const prisma = new ScriptedPrisma();
    const body = vi.fn(async () => {
      throw rawFailure('40P01');
    });
    await expect(
      runCanvaTransaction(runner(prisma), body, noSleep),
    ).rejects.toBeInstanceOf(CanvaPersistenceError);
    expect(body).toHaveBeenCalledTimes(4);
  });

  it('retries after a missing account row (F19)', async () => {
    const prisma = new ScriptedPrisma();
    const body = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new RetryTransaction())
      .mockRejectedValueOnce(
        rawFailure(
          '23503',
          'violates foreign key constraint on canva_accounts',
        ),
      )
      .mockResolvedValueOnce('done');
    await expect(
      runCanvaTransaction(runner(prisma), body, noSleep),
    ).resolves.toBe('done');
    expect(body).toHaveBeenCalledTimes(3);
  });

  it('returns a rollback value without committing anything', async () => {
    const prisma = new ScriptedPrisma();
    await expect(
      runCanvaTransaction(runner(prisma), async () => {
        throw new RollbackWith('account_unavailable');
      }),
    ).resolves.toBe('account_unavailable');
  });

  it('passes definite domain failures through unchanged', async () => {
    const prisma = new ScriptedPrisma();
    await expect(
      runCanvaTransaction(runner(prisma), async () => {
        throw new CanvaStaleCredentialError();
      }),
    ).rejects.toBeInstanceOf(CanvaStaleCredentialError);
  });
});

const sealed = (label: string) => ({
  keyVersion: 1,
  iv: `${label}-iv`,
  ciphertext: `${label}-ciphertext`,
  tag: `${label}-tag`,
});

const newCandidate = (): NewCanvaCandidate => ({
  attempt: {
    attemptId: 'attempt-1',
    organizationId: 'org-1',
    userId: 'user-1',
    sessionId: 'session-1',
    baseGeneration: 3,
    redirectUri: 'unused',
    codeVerifier: sealed('verifier'),
  },
  chainId: 'chain-1',
  writeId: 'write-1',
  accessToken: sealed('access'),
  refreshToken: sealed('refresh'),
  accessTokenExpiresAt: new Date('2026-10-26T14:00:00.000Z'),
  scopes: ['profile:read'],
  canvaUserId: 'canva-u',
  canvaTeamId: 'canva-t',
  canvaDisplayName: 'Studio',
  capabilities: { autofill: true, brandTemplate: true },
});

function credentialStore(prisma: ScriptedPrisma) {
  return new PrismaCanvaCredentialStore(runner(prisma), auditService(prisma), {
    sleep: async () => undefined,
  });
}

const CONNECTION_LOCK =
  /FROM "canva_connections" WHERE "organizationId" = \$1 FOR UPDATE/;
const ACCOUNT_INSERT = /INSERT INTO "canva_accounts"/;
const ACCOUNT_LOCK =
  /FROM "canva_accounts" WHERE "canvaUserId" = \$1 FOR UPDATE/;
const FENCE =
  /FROM "canva_pending_revocations" WHERE "canvaUserId" = \$1 AND \("state" = 'in_flight' OR "possibleEffectUntil" >/;
const HOLD = /UPDATE "canva_accounts" SET "organizationId" = \$1/;
const CANDIDATE_INSERT = /INSERT INTO "canva_connection_candidates"/;
const QUEUE_INSERT = /INSERT INTO "canva_pending_revocations"/;

describe('PrismaCanvaCredentialStore.createCandidate (§5.4)', () => {
  function scripted() {
    return new ScriptedPrisma()
      .on(CONNECTION_LOCK, [{ connectionGeneration: 3, credentialVersion: 2 }])
      .on(ACCOUNT_LOCK, [{ organizationId: null }])
      .on(CANDIDATE_INSERT, [{ expiresAt: new Date('2026-10-26T10:10:00Z') }]);
  }

  it('locks the connection, then the account, then checks the fence, then holds and inserts', async () => {
    const prisma = scripted();
    await expect(
      credentialStore(prisma).createCandidate(newCandidate()),
    ).resolves.toMatchObject({
      outcome: 'pending_confirmation',
    });
    const order = [
      CONNECTION_LOCK,
      /FROM "canva_connection_candidates" WHERE "organizationId"/,
      ACCOUNT_INSERT,
      ACCOUNT_LOCK,
      FENCE,
      HOLD,
      CANDIDATE_INSERT,
    ].map((pattern) => prisma.indexOf(pattern));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The fence compares against the attempt's launch time (§2.7 step 4).
    expect(prisma.statements[order[4]]).toMatch(
      /SELECT "launchedAt" FROM "canva_oauth_attempts" WHERE "id" = \$2/,
    );
    expect(prisma.audit.map((entry) => entry.action)).toEqual([
      'canva.oauth.pending_confirmation',
    ]);
  });

  it('stores only ciphertext and never a plaintext token', async () => {
    const prisma = scripted();
    await credentialStore(prisma).createCandidate(newCandidate());
    const insert = prisma.values[prisma.indexOf(CANDIDATE_INSERT)];
    expect(insert).toContain('refresh-ciphertext');
    expect(insert).toContain('access-ciphertext');
    expect(JSON.stringify(prisma.values)).not.toMatch(/test-refresh-token/);
  });

  it('rolls back with account_unavailable when another organization holds the user', async () => {
    const held = new ScriptedPrisma()
      .on(CONNECTION_LOCK, [{ connectionGeneration: 3, credentialVersion: 2 }])
      .on(ACCOUNT_LOCK, [{ organizationId: 'org-2' }]);
    await expect(
      credentialStore(held).createCandidate(newCandidate()),
    ).resolves.toEqual({ outcome: 'account_unavailable' });
    expect(held.indexOf(CANDIDATE_INSERT)).toBe(-1);
    expect(held.indexOf(HOLD)).toBe(-1);
    expect(held.audit).toHaveLength(0);
  });

  it('rolls back with retry_connect when a revocation for the user may still take effect', async () => {
    const prisma = new ScriptedPrisma()
      .on(CONNECTION_LOCK, [{ connectionGeneration: 3, credentialVersion: 2 }])
      .on(ACCOUNT_LOCK, [{ organizationId: null }])
      .on(FENCE, [{ id: 'revocation-1' }]);
    await expect(
      credentialStore(prisma).createCandidate(newCandidate()),
    ).resolves.toEqual({ outcome: 'retry_connect' });
    expect(prisma.indexOf(CANDIDATE_INSERT)).toBe(-1);
    expect(prisma.indexOf(QUEUE_INSERT)).toBe(-1);
  });

  it('retries the transaction when the sweep deleted the account row (F19)', async () => {
    const prisma = new ScriptedPrisma()
      .on(CONNECTION_LOCK, [{ connectionGeneration: 3, credentialVersion: 2 }])
      .on(ACCOUNT_LOCK, [], true)
      .on(ACCOUNT_LOCK, [{ organizationId: null }])
      .on(CANDIDATE_INSERT, [{ expiresAt: new Date() }]);
    await expect(
      credentialStore(prisma).createCandidate(newCandidate()),
    ).resolves.toMatchObject({ outcome: 'pending_confirmation' });
    expect(prisma.transactions).toBe(2);
  });

  it('queues the new tokens when another unexpired candidate is pending', async () => {
    const prisma = new ScriptedPrisma()
      .on(CONNECTION_LOCK, [{ connectionGeneration: 3, credentialVersion: 2 }])
      .on(/FROM "canva_connection_candidates" WHERE "organizationId"/, [
        { id: 'other', expired: false, canvaUserId: 'canva-other' },
      ])
      .on(ACCOUNT_LOCK, [{ organizationId: null }]);
    await expect(
      credentialStore(prisma).createCandidate(newCandidate()),
    ).resolves.toEqual({ outcome: 'conflict' });
    const queued = prisma.values[prisma.indexOf(QUEUE_INSERT)];
    expect(queued).toContain('connect_conflict');
    expect(queued).toContain('refresh-ciphertext');
    expect(prisma.audit.map((entry) => entry.action)).toEqual([
      'canva.oauth.failed',
    ]);
  });
});

describe('PrismaCanvaCredentialStore.activateCandidate (§5.5)', () => {
  const candidateRow = {
    id: 'candidate-1',
    organizationId: 'org-1',
    userId: 'user-1',
    sessionId: 'session-1',
    baseGeneration: 3,
    chainId: 'chain-new',
    writeId: 'write-new',
    keyVersion: 1,
    accessTokenIv: 'a',
    accessTokenCiphertext: 'b',
    accessTokenTag: 'c',
    refreshTokenIv: 'd',
    refreshTokenCiphertext: 'e',
    refreshTokenTag: 'f',
    accessTokenExpiresAt: new Date(),
    scopes: [],
    canvaUserId: 'canva-b',
    canvaTeamId: 't',
  };
  const previousRow = {
    ...candidateRow,
    organizationId: 'org-1',
    connectedById: 'user-1',
    chainId: 'chain-old',
    writeId: 'write-old',
    version: 2,
    canvaUserId: 'canva-a',
  };

  function scripted(generation = 3) {
    return new ScriptedPrisma()
      .on(CONNECTION_LOCK, [
        { connectionGeneration: generation, credentialVersion: 2 },
      ])
      .on(/FROM "canva_connection_candidates" WHERE "id" = \$1/, [candidateRow])
      .on(/SELECT "canvaUserId" FROM "canva_credentials"/, [
        { canvaUserId: 'canva-a' },
      ])
      .on(ACCOUNT_LOCK, [{ organizationId: 'org-1' }])
      .on(
        /SELECT \* FROM "canva_credentials" WHERE "organizationId" = \$1 FOR UPDATE/,
        [previousRow],
      )
      .on(/SELECT "id" FROM "canva_credentials"/, [])
      .on(/INSERT INTO "canva_credentials"/, [
        { ...previousRow, ...candidateRow, version: 3 },
      ]);
  }
  const owner = {
    organizationId: 'org-1',
    userId: 'user-1',
    sessionId: 'session-1',
  };

  it("locks accounts in ascending order and queues a different user's replaced grant before deleting it", async () => {
    const prisma = scripted();
    await expect(
      credentialStore(prisma).activateCandidate(owner, 'candidate-1'),
    ).resolves.toMatchObject({ outcome: 'connected', sameCanvaUser: false });
    const locks = prisma.statements
      .map((text, index) => ({ text, index }))
      .filter(({ text }) => ACCOUNT_LOCK.test(text))
      .map(({ index }) => prisma.values[index][0]);
    expect(locks.slice(0, 2)).toEqual(['canva-a', 'canva-b']);
    const queued = prisma.indexOf(QUEUE_INSERT);
    const deleted = prisma.indexOf(/DELETE FROM "canva_credentials"/);
    const released = prisma.indexOf(
      /UPDATE "canva_accounts" SET "organizationId" = NULL/,
    );
    const inserted = prisma.indexOf(/INSERT INTO "canva_credentials"/);
    expect(prisma.values[queued]).toContain('replaced_other_user');
    expect(queued).toBeLessThan(deleted);
    expect(deleted).toBeLessThan(released);
    expect(released).toBeLessThan(inserted);
    expect(prisma.audit.map((entry) => entry.action)).toEqual([
      'canva.connection.connected',
    ]);
  });

  it('removes the candidate and queues its tokens on a stale generation', async () => {
    const prisma = scripted(4);
    await expect(
      credentialStore(prisma).activateCandidate(owner, 'candidate-1'),
    ).resolves.toEqual({ outcome: 'stale' });
    expect(prisma.indexOf(/INSERT INTO "canva_credentials"/)).toBe(-1);
    expect(prisma.values[prisma.indexOf(QUEUE_INSERT)]).toContain(
      'connect_conflict',
    );
  });
});

describe('PrismaCanvaCredentialStore.disconnect (§5.9)', () => {
  it('queues the credential and a same-user candidate (D14), then releases the hold', async () => {
    const credentialRow = {
      organizationId: 'org-1',
      chainId: 'chain-c',
      canvaUserId: 'canva-u',
      keyVersion: 1,
      refreshTokenIv: 'a',
      refreshTokenCiphertext: 'b',
      refreshTokenTag: 'c',
    };
    const prisma = new ScriptedPrisma()
      .on(CONNECTION_LOCK, [{ connectionGeneration: 1, credentialVersion: 1 }])
      .on(/SELECT "canvaUserId" FROM "canva_credentials"/, [
        { canvaUserId: 'canva-u' },
      ])
      .on(/FROM "canva_connection_candidates" WHERE "organizationId"/, [
        { ...credentialRow, id: 'cand', chainId: 'chain-d', expired: false },
      ])
      .on(ACCOUNT_LOCK, [{ organizationId: 'org-1' }])
      .on(
        /SELECT \* FROM "canva_credentials" WHERE "organizationId" = \$1 FOR UPDATE/,
        [credentialRow],
      )
      .on(/SELECT "id" FROM "canva_credentials"/, []);
    await expect(
      credentialStore(prisma).disconnect('org-1', 'user-1'),
    ).resolves.toEqual({ removed: true, queued: 2 });
    const reasons = prisma.statements
      .map((text, index) =>
        QUEUE_INSERT.test(text) ? prisma.values[index][4] : null,
      )
      .filter(Boolean);
    expect(reasons).toEqual(['disconnect', 'candidate_superseded']);
    expect(prisma.audit.at(-1)).toMatchObject({
      action: 'canva.connection.disconnected',
      metadata: { revocation: 'queued' },
    });
  });
});

describe('PrismaCanvaOAuthAttemptStore', () => {
  it('consumes in one statement that requires the binding hash and clears the verifier', async () => {
    const prisma = new ScriptedPrisma().on(/WITH target AS/, []);
    const store = new PrismaCanvaOAuthAttemptStore(
      runner(prisma),
      auditService(prisma),
    );
    await expect(
      store.consume('state-hash', 'binding-hash'),
    ).resolves.toBeNull();
    const statement = prisma.statements[prisma.indexOf(/WITH target AS/)];
    expect(statement).toMatch(/"browserBindingHash" = \$\d+/);
    expect(statement).toMatch(/"consumedAt" IS NULL/);
    expect(statement).toMatch(/"codeVerifierCiphertext" = NULL/);
    expect(statement).toMatch(/FOR UPDATE/);
  });

  it('enforces the open-attempt cap under the connection lock', async () => {
    const prisma = new ScriptedPrisma()
      .on(CONNECTION_LOCK, [{ connectionGeneration: 0, credentialVersion: 0 }])
      .on(/count\(\*\)::int AS "open"/, [{ open: 20 }]);
    const store = new PrismaCanvaOAuthAttemptStore(
      runner(prisma),
      auditService(prisma),
    );
    await expect(
      store.create({
        organizationId: 'org-1',
        userId: 'user-1',
        sessionId: 'session-1',
        launchTokenHash: 'h',
        redirectUri: 'r',
      }),
    ).rejects.toMatchObject({ name: 'CanvaAttemptLimitError' });
    expect(prisma.indexOf(CONNECTION_LOCK)).toBeLessThan(
      prisma.indexOf(/count\(\*\)::int AS "open"/),
    );
    expect(prisma.indexOf(/INSERT INTO "canva_oauth_attempts"/)).toBe(-1);
  });
});

describe('PrismaCanvaRevocationQueue (§5.10)', () => {
  const queued = {
    id: 'r1',
    organizationId: 'org-1',
    canvaUserId: 'canva-u',
    reason: 'disconnect',
    state: 'queued',
    attempts: 1,
    keyVersion: 1,
    refreshTokenIv: 'a',
    refreshTokenCiphertext: 'b',
    refreshTokenTag: 'c',
  };
  const ROW_LOCK =
    /FROM "canva_pending_revocations" WHERE "id" = \$1 AND "claimToken" = \$2 FOR UPDATE/;
  const GUARD = /FROM "canva_credentials" WHERE "canvaUserId" = \$1 UNION ALL/;

  function queue(prisma: ScriptedPrisma) {
    return new PrismaCanvaRevocationQueue(runner(prisma), auditService(prisma));
  }

  it('T1 locks the account, then the row, then runs the guard, then fences with clock_timestamp()', async () => {
    const prisma = new ScriptedPrisma()
      .on(/SELECT "canvaUserId" FROM "canva_pending_revocations"/, [
        { canvaUserId: 'canva-u' },
      ])
      .on(ACCOUNT_LOCK, [{ organizationId: null }])
      .on(ROW_LOCK, [queued])
      .on(/SET "state" = 'in_flight'/, [{ attempts: 2, ageMs: 1000 }]);
    await expect(queue(prisma).decide('r1', 'claim')).resolves.toMatchObject({
      kind: 'send',
      attempts: 2,
      refreshToken: { ciphertext: 'b' },
    });
    const order = [
      ACCOUNT_LOCK,
      ROW_LOCK,
      GUARD,
      /SET "state" = 'in_flight'/,
    ].map((pattern) => prisma.indexOf(pattern));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(prisma.statements[order[3]]).toMatch(
      /"callStartedAt" = \(clock_timestamp\(\) AT TIME ZONE 'UTC'\)/,
    );
    expect(prisma.statements[order[3]]).toMatch(
      /"claimedUntil" = \(clock_timestamp\(\) AT TIME ZONE 'UTC'\) \+/,
    );
  });

  it('T1 finishes skipped_shared_consent when a credential or candidate exists, without fencing', async () => {
    const prisma = new ScriptedPrisma()
      .on(/SELECT "canvaUserId" FROM "canva_pending_revocations"/, [
        { canvaUserId: 'canva-u' },
      ])
      .on(ACCOUNT_LOCK, [{ organizationId: 'org-2' }])
      .on(ROW_LOCK, [queued])
      .on(GUARD, [{ found: 1 }]);
    await expect(queue(prisma).decide('r1', 'claim')).resolves.toEqual({
      kind: 'skipped',
    });
    expect(prisma.indexOf(/SET "state" = 'in_flight'/)).toBe(-1);
    expect(
      prisma.statements.find((text) => /'skipped_shared_consent'/.test(text)),
    ).toMatch(/"refreshTokenCiphertext" = NULL/);
    expect(prisma.audit).toMatchObject([
      {
        action: 'canva.connection.revocation_finished',
        metadata: { outcome: 'skipped_shared_consent' },
      },
    ]);
  });

  it('T1 recovers a crashed call with the 135-second window before the guard', async () => {
    const prisma = new ScriptedPrisma()
      .on(/SELECT "canvaUserId" FROM "canva_pending_revocations"/, [
        { canvaUserId: 'canva-u' },
      ])
      .on(ACCOUNT_LOCK, [{ organizationId: null }])
      .on(ROW_LOCK, [{ ...queued, state: 'in_flight' }])
      .on(/SET "state" = 'in_flight'/, [{ attempts: 2, ageMs: 0 }]);
    await queue(prisma).decide('r1', 'claim');
    const recovery = prisma.indexOf(/interval '135 seconds'/);
    expect(recovery).toBeGreaterThan(prisma.indexOf(ROW_LOCK));
    expect(recovery).toBeLessThan(prisma.indexOf(GUARD));
  });

  it('T1 exhausts at the attempt limit, keeping the ciphertext', async () => {
    const prisma = new ScriptedPrisma()
      .on(/SELECT "canvaUserId" FROM "canva_pending_revocations"/, [
        { canvaUserId: 'canva-u' },
      ])
      .on(ACCOUNT_LOCK, [{ organizationId: null }])
      .on(ROW_LOCK, [{ ...queued, attempts: 8 }]);
    await expect(queue(prisma).decide('r1', 'claim')).resolves.toEqual({
      kind: 'exhausted',
    });
    const update = prisma.statements.find((text) => /'exhausted'/.test(text))!;
    expect(update).not.toMatch(/"refreshTokenCiphertext" = NULL/);
    expect(prisma.audit[0].action).toBe(
      'canva.connection.revocation_exhausted',
    );
  });

  it('T1 reports a lost claim without changes', async () => {
    const prisma = new ScriptedPrisma()
      .on(/SELECT "canvaUserId" FROM "canva_pending_revocations"/, [
        { canvaUserId: 'canva-u' },
      ])
      .on(ACCOUNT_LOCK, [{ organizationId: null }])
      .on(ROW_LOCK, []);
    await expect(queue(prisma).decide('r1', 'claim')).resolves.toEqual({
      kind: 'lost',
    });
    expect(prisma.indexOf(GUARD)).toBe(-1);
  });

  it('T2 is conditioned on the claim and in_flight, and widens an ambiguous window', async () => {
    const prisma = new ScriptedPrisma().on(
      /UPDATE "canva_pending_revocations" SET "state" = \$1/,
      [],
    );
    await expect(
      queue(prisma).record('r1', 'claim', {
        next: 'queued',
        outcome: null,
        lastErrorKind: 'unknown',
        delayMs: 60_000,
        refund: false,
        ambiguous: true,
      }),
    ).resolves.toBe(false);
    const statement = prisma.statements.find((text) =>
      /SET "state" = \$1/.test(text),
    )!;
    expect(statement).toMatch(/"claimToken" = \$\d+ AND "state" = 'in_flight'/);
    expect(statement).toMatch(
      /interval '15 seconds'\) \+ interval '120 seconds'/,
    );
    expect(statement).toMatch(/GREATEST\(\s?COALESCE\("possibleEffectUntil"/);
  });

  it('T2 leaves the window unchanged when no request was sent', async () => {
    const prisma = new ScriptedPrisma();
    await queue(prisma).record('r1', 'claim', {
      next: 'queued',
      outcome: null,
      lastErrorKind: 'key_unavailable',
      delayMs: 900_000,
      refund: true,
      ambiguous: false,
      called: false,
    });
    const statement = prisma.statements.find((text) =>
      /SET "state" = \$1/.test(text),
    )!;
    expect(statement).toMatch(/"possibleEffectUntil" = "possibleEffectUntil"/);
    expect(statement).not.toMatch(/GREATEST/);
  });

  it('claims queued and crashed rows with SKIP LOCKED in one statement', async () => {
    const prisma = new ScriptedPrisma();
    await queue(prisma).claim('claim', 10, 'canva-u');
    expect(prisma.transactions).toBe(0);
    expect(prisma.statements[0]).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(prisma.statements[0]).toMatch(
      /"state" = 'in_flight' AND "claimedUntil" </,
    );
    expect(prisma.values[0]).toContain('canva-u');
  });
});

describe('PrismaCanvaRevocationQueue listing and inspection', () => {
  const queue = (prisma: ScriptedPrisma) =>
    new PrismaCanvaRevocationQueue(runner(prisma), auditService(prisma));

  it('lists only the organization’s exhausted rows, without ciphertext', async () => {
    const prisma = new ScriptedPrisma();
    await queue(prisma).listExhausted('org-1');
    expect(prisma.statements).toHaveLength(1);
    expect(prisma.statements[0]).toMatch(
      /WHERE "organizationId" = \$1 AND "state" = 'exhausted'/,
    );
    expect(prisma.statements[0]).not.toMatch(/Ciphertext|canvaUserId/);
    expect(prisma.values[0]).toContain('org-1');
  });

  it('inspects with plain reads only and previews T1 in its order: guard, then the attempt limit', async () => {
    const prisma = new ScriptedPrisma()
      .on(/GROUP BY "state"/, [
        { state: 'queued', rows: 3 },
        { state: 'exhausted', rows: 1 },
      ])
      .on(/FILTER/, [
        { due: 2, crashed: 1, configuration: 2, keyUnavailable: 1 },
      ])
      .on(/FROM "canva_connections" WHERE "lastProviderErrorKind"/, [
        { configuration: 1 },
      ])
      .on(/AS "shared"/, [
        {
          id: 'r1',
          organizationId: 'org-1',
          reason: 'disconnect',
          state: 'queued',
          attempts: 9,
          shared: true,
        },
        {
          id: 'r2',
          organizationId: 'org-1',
          reason: 'disconnect',
          state: 'queued',
          attempts: 8,
          shared: false,
        },
        {
          id: 'r3',
          organizationId: 'org-2',
          reason: 'replaced_other_user',
          state: 'in_flight',
          attempts: 2,
          shared: false,
        },
      ]);
    const inspection = await queue(prisma).inspect(10);
    expect(prisma.transactions).toBe(0);
    for (const statement of prisma.statements) {
      expect(statement).toMatch(/^SELECT/);
      expect(statement).not.toMatch(/FOR UPDATE|UPDATE "|INSERT|DELETE/);
    }
    expect(inspection).toMatchObject({
      counts: { queued: 3, in_flight: 0, exhausted: 1, finished: 0 },
      due: 2,
      crashed: 1,
      health: {
        revocationConfigurationErrors: 2,
        revocationKeyUnavailable: 1,
        connectionConfigurationErrors: 1,
      },
    });
    // Aggregates only: unfinished rows by their last error kind, and
    // connections by their last provider error. No ciphertext or Canva IDs.
    const health = prisma.statements.filter((statement) =>
      /lastErrorKind|lastProviderErrorKind/.test(statement),
    );
    expect(health).toHaveLength(2);
    expect(health[0]).toMatch(
      /"state" <> 'finished' AND "lastErrorKind" = 'configuration'/,
    );
    expect(health[1]).toMatch(
      /SELECT count\(\*\)::int AS "configuration" FROM "canva_connections" WHERE "lastProviderErrorKind" = 'configuration'/,
    );
    for (const statement of health)
      expect(statement).not.toMatch(/Ciphertext|canvaUserId|"id"/);
    expect(
      inspection.preview.map(({ id, wouldDo, recovering }) => ({
        id,
        wouldDo,
        recovering,
      })),
    ).toEqual([
      { id: 'r1', wouldDo: 'skip_shared_consent', recovering: false },
      { id: 'r2', wouldDo: 'exhaust', recovering: false },
      { id: 'r3', wouldDo: 'send', recovering: true },
    ]);
  });
});

describe('PrismaCanvaResealStore (§5.11)', () => {
  const sealed = (label: string, keyVersion = 2) => ({
    keyVersion,
    iv: `${label}-iv`,
    ciphertext: `${label}-ct`,
    tag: `${label}-tag`,
  });
  const credential = {
    kind: 'credential' as const,
    id: 'credential-1',
    organizationId: 'org-1',
    version: 4,
    writeId: 'write-4',
    keyVersion: 1,
    accessToken: sealed('old-access', 1),
    refreshToken: sealed('old-refresh', 1),
  };
  const resealedPair = {
    keyVersion: 2,
    accessToken: sealed('new-access'),
    refreshToken: sealed('new-refresh'),
  };
  const store = (prisma: ScriptedPrisma) =>
    new PrismaCanvaResealStore(runner(prisma), auditService(prisma));
  const setClause = (statement: string) => statement.split(' WHERE ')[0];

  it('conditions a credential reseal on version, writeId, key version, and no active lease, auditing in the same transaction', async () => {
    const prisma = new ScriptedPrisma().on(/UPDATE "canva_credentials"/, 1);
    await expect(store(prisma).reseal(credential, resealedPair)).resolves.toBe(
      true,
    );
    const update = prisma.statements.find((text) =>
      text.startsWith('UPDATE "canva_credentials"'),
    )!;
    expect(update).toMatch(
      /"version" = \$\d+ AND "writeId" = \$\d+ AND "keyVersion" = \$\d+/,
    );
    expect(update).toMatch(
      /"refreshLeaseUntil" IS NULL OR "refreshLeaseUntil" < \(clock_timestamp\(\)/,
    );
    // Only ciphertext and the key version change: never the version,
    // write identity, chain, or Canva user.
    expect(setClause(update)).not.toMatch(
      /"version"|"writeId"|"chainId"|"canvaUserId"/,
    );
    expect(prisma.transactions).toBe(1);
    expect(prisma.audit).toEqual([
      {
        action: 'canva.credential.resealed',
        metadata: { fromKeyVersion: 1, toKeyVersion: 2 },
      },
    ]);
    // Ciphertext only: the store never sees a plaintext token.
    expect(prisma.values.flat()).toContain('new-refresh-ct');
  });

  it('writes no audit event when the credential changed or a lease is active', async () => {
    const prisma = new ScriptedPrisma().on(/UPDATE "canva_credentials"/, 0);
    await expect(store(prisma).reseal(credential, resealedPair)).resolves.toBe(
      false,
    );
    expect(prisma.audit).toEqual([]);
  });

  it('refuses values sealed under mixed key versions before writing anything', async () => {
    const prisma = new ScriptedPrisma();
    await expect(
      store(prisma).reseal(credential, {
        ...resealedPair,
        refreshToken: sealed('new-refresh', 3),
      }),
    ).rejects.toBeInstanceOf(CanvaPersistenceError);
    expect(prisma.statements).toEqual([]);
  });

  it('reseals unfinished queue rows (exhausted included) and unconsumed verifiers, conditioned on the key version', async () => {
    const prisma = new ScriptedPrisma();
    await store(prisma).reseal(
      {
        kind: 'revocation',
        id: 'r1',
        organizationId: 'org-1',
        keyVersion: 1,
        refreshToken: sealed('old', 1),
      },
      { keyVersion: 2, refreshToken: sealed('new') },
    );
    await store(prisma).reseal(
      {
        kind: 'attempt',
        id: 'a1',
        organizationId: 'org-1',
        keyVersion: 1,
        codeVerifier: sealed('old', 1),
      },
      { keyVersion: 2, codeVerifier: sealed('new') },
    );
    expect(prisma.statements[0]).toMatch(
      /COALESCE\("keyVersion", 0\) = \$\d+ AND "state" <> 'finished'/,
    );
    expect(prisma.statements[1]).toMatch(
      /COALESCE\("codeVerifierKeyVersion", 0\) = \$\d+ AND "consumedAt" IS NULL/,
    );
    expect(prisma.transactions).toBe(0);
  });

  it('lists stale rows in id order after the cursor, so a run can resume', async () => {
    const prisma = new ScriptedPrisma();
    await store(prisma).listStale('candidate', 2, 'candidate-5', 10);
    expect(prisma.statements[0]).toMatch(
      /WHERE "keyVersion" <> \$1 AND "id" > \$2 ORDER BY "id" LIMIT \$3/,
    );
    expect(prisma.values[0]).toEqual([2, 'candidate-5', 10]);
  });
});
