import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import type { AuthenticatedPrincipal } from '../../auth/auth.types';
import { PERMISSIONS } from '../../auth/permissions';
import {
  CANVA_OAUTH_CALLBACK_PATH,
  parseCanvaEnvironment,
} from './canva-oauth.config';
import {
  CANVA_MAX_OPEN_ATTEMPTS,
  CanvaAttemptLimitError,
  CanvaPersistenceError,
  CanvaStaleCredentialError,
  CanvaWriteOutcomeUnknownError,
  type CanvaActivation,
  type CanvaExhaustedRevocation,
  type CanvaKeyInventory,
  type CanvaResealStore,
  type CanvaResealedValues,
  type CanvaRevocationInspection,
  type CanvaSealedKind,
  type StaleCanvaSeal,
  type CanvaCandidateCreation,
  type CanvaCandidateOwner,
  type CanvaConnectionDetails,
  type CanvaCredentialStore,
  type CanvaLaunchSecrets,
  type CanvaOAuthAttemptStore,
  type CanvaReauthorizationReason,
  type CanvaRefreshLease,
  type CanvaRevocationDecision,
  type CanvaRevocationQueueStore,
  type CanvaRevocationReason,
  type CanvaRevocationRecord,
  type ClaimedCanvaRevocation,
  type ConsumedCanvaAttempt,
  type NewCanvaCandidate,
  type NewCanvaCredential,
  type NewCanvaOAuthAttempt,
  type NewCanvaRevocation,
  type PendingCanvaCandidate,
  type StoredCanvaCredential,
} from './canva-oauth.stores';
import { REVOCATION_MAX_ATTEMPTS } from './canva-revocation';
import type { SealedValue } from './canva-token-cipher';
import type { CanvaTokenSet } from './canva-token.client';

// In-memory doubles of the persistence contracts. They model what the
// services depend on (single-use consumption, ownership holds across
// credentials and candidates, versioned compare-and-set writes, the durable
// queue, the same-user guard, and the possible-effect window) so service and
// worker logic can be tested without a database. Every operation runs to
// completion before the next starts, so they cannot model PostgreSQL
// locking, commit uncertainty, or cross-process timing: those are the
// PostgreSQL gates in the persistence proposal (§10).

export const testRedirectUri = `http://127.0.0.1:3000${CANVA_OAUTH_CALLBACK_PATH}`;

// Test-only placeholders; none of these are real Canva credentials.
export function testRealConfig(
  overrides: { persistence?: boolean; revocationWorker?: boolean } = {},
) {
  const config = parseCanvaEnvironment({
    CANVA_PROVIDER_MODE: 'canva',
    CANVA_CLIENT_ID: 'OC-test-client-id',
    CANVA_CLIENT_SECRET: 'test-only-client-secret-value',
    CANVA_REDIRECT_URI: testRedirectUri,
    CANVA_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  });
  if (config.mode !== 'canva') throw new Error('expected canva mode');
  return {
    ...config,
    persistence: false,
    revocationWorker: false,
    ...overrides,
  };
}

export const testAdmin: AuthenticatedPrincipal = {
  id: 'user-1',
  organizationId: 'org-1',
  name: 'Admin',
  email: 'admin@example.local',
  permissions: [PERMISSIONS.CANVA_INTEGRATION_MANAGE],
  branches: [],
  sessionId: 'session-1',
};

export function tokenSet(
  overrides: Partial<CanvaTokenSet> = {},
): CanvaTokenSet {
  return {
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    expiresInSeconds: 14_400,
    scopes: [
      'brandtemplate:meta:read',
      'brandtemplate:content:read',
      'design:content:write',
      'profile:read',
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The shared in-memory "database"
// ---------------------------------------------------------------------------

type ConnectionRecord = {
  status: CanvaConnectionDetails['status'];
  mode: string;
  connectedAt: Date | null;
  connectionGeneration: number;
  credentialVersion: number;
  reauthorizationReason: string | null;
  configurationError: boolean;
};

type AttemptRecord = NewCanvaOAuthAttempt & {
  id: string;
  baseGeneration: number;
  launchExpiresAt: Date;
  launchedAt: Date | null;
  expiresAt: Date | null;
  consumedAt: Date | null;
  stateHash: string | null;
  browserBindingHash: string | null;
  codeVerifier: SealedValue | null;
};

type CandidateRecord = PendingCanvaCandidateCore & {
  attemptId: string;
  baseGeneration: number;
  chainId: string;
  writeId: string;
  accessToken: SealedValue;
  refreshToken: SealedValue;
  accessTokenExpiresAt: Date;
};

type PendingCanvaCandidateCore = Omit<
  PendingCanvaCandidate,
  'currentCanvaUserId'
>;

export type QueueRecord = NewCanvaRevocation & {
  id: string;
  state: 'queued' | 'in_flight' | 'exhausted' | 'finished';
  refreshToken: SealedValue;
  sealedCleared: boolean;
  attempts: number;
  nextAttemptAt: number;
  claimToken: string | null;
  claimedUntil: number | null;
  callStartedAt: number | null;
  possibleEffectUntil: number | null;
  outcome: string | null;
  lastErrorKind: string | null;
  createdAt: number;
};

export type AuditRecord = {
  organizationId: string;
  actorUserId: string | null;
  action: string;
  metadata: Record<string, unknown>;
};

// Fault injection for the next write of a kind.
// - committed_unknown: the write commits, then reports an unknown outcome.
// - uncommitted_unknown: nothing is written, and the outcome is unknown.
// - definite: nothing is written; a definite failure.
export type InjectedWriteFault =
  'committed_unknown' | 'uncommitted_unknown' | 'definite';

export class MemoryCanvaDatabase {
  // Milliseconds; tests advance it explicitly.
  time = Date.parse('2026-10-26T10:00:00.000Z');
  readonly connections = new Map<string, ConnectionRecord>();
  readonly attempts = new Map<string, AttemptRecord>();
  readonly candidates = new Map<string, CandidateRecord>();
  readonly credentials = new Map<string, StoredCanvaCredential>();
  // canvaUserId -> holding organization (null = unheld).
  readonly accounts = new Map<string, string | null>();
  readonly queue: QueueRecord[] = [];
  readonly audit: AuditRecord[] = [];

  now(): Date {
    return new Date(this.time);
  }
  advance(ms: number): void {
    this.time += ms;
  }

  connection(organizationId: string): ConnectionRecord {
    let record = this.connections.get(organizationId);
    if (!record) {
      record = {
        status: 'DISCONNECTED',
        mode: 'CANVA',
        connectedAt: null,
        connectionGeneration: 0,
        credentialVersion: 0,
        reauthorizationReason: null,
        configurationError: false,
      };
      this.connections.set(organizationId, record);
    }
    return record;
  }

  // Database-enforced ownership: a credential or candidate for a Canva
  // user may exist only in the organization holding that user.
  hold(canvaUserId: string, organizationId: string): void {
    const holder = this.accounts.get(canvaUserId) ?? null;
    if (holder !== null && holder !== organizationId)
      throw new Error('foreign key violation: account held elsewhere');
    this.accounts.set(canvaUserId, organizationId);
  }

  releaseIfUnreferenced(canvaUserId: string): void {
    const referenced =
      [...this.credentials.values()].some(
        (credential) => credential.canvaUserId === canvaUserId,
      ) ||
      [...this.candidates.values()].some(
        (candidate) => candidate.canvaUserId === canvaUserId,
      );
    if (!referenced && this.accounts.has(canvaUserId))
      this.accounts.set(canvaUserId, null);
  }

  hasGrant(canvaUserId: string): boolean {
    return (
      [...this.credentials.values()].some(
        (c) => c.canvaUserId === canvaUserId,
      ) ||
      [...this.candidates.values()].some((c) => c.canvaUserId === canvaUserId)
    );
  }

  enqueue(revocation: NewCanvaRevocation): void {
    if (!this.accounts.has(revocation.canvaUserId))
      this.accounts.set(revocation.canvaUserId, null);
    if (
      this.queue.some(
        (row) =>
          row.chainId === revocation.chainId &&
          row.reason === revocation.reason,
      )
    )
      return;
    this.queue.push({
      ...revocation,
      id: `revocation-${this.queue.length + 1}`,
      state: 'queued',
      sealedCleared: false,
      attempts: 0,
      nextAttemptAt: this.time,
      claimToken: null,
      claimedUntil: null,
      callStartedAt: null,
      possibleEffectUntil: null,
      outcome: null,
      lastErrorKind: null,
      createdAt: this.time,
    });
  }

  writeAudit(record: AuditRecord): void {
    this.audit.push(record);
  }

  actions(): string[] {
    return this.audit.map((record) => record.action);
  }

  // Seeds an active credential as if activated.
  seedCredential(credential: NewCanvaCredential): StoredCanvaCredential {
    const connection = this.connection(credential.organizationId);
    this.hold(credential.canvaUserId, credential.organizationId);
    connection.credentialVersion += 1;
    connection.connectionGeneration += 1;
    connection.status = 'CONNECTED';
    connection.connectedAt = this.now();
    const stored = { ...credential, version: connection.credentialVersion };
    this.credentials.set(credential.organizationId, stored);
    return stored;
  }

  // §5.6 inside the "transaction".
  removeCandidate(
    candidate: CandidateRecord,
    reason: Extract<
      CanvaRevocationReason,
      | 'candidate_rejected'
      | 'candidate_expired'
      | 'candidate_superseded'
      | 'connect_conflict'
    >,
    actorUserId: string | null,
  ): void {
    const credential = this.credentials.get(candidate.organizationId);
    const sameUser = credential?.canvaUserId === candidate.canvaUserId;
    if (!sameUser || reason === 'candidate_superseded')
      this.enqueue({
        organizationId: candidate.organizationId,
        chainId: candidate.chainId,
        canvaUserId: candidate.canvaUserId,
        reason,
        refreshToken: candidate.refreshToken,
      });
    this.candidates.delete(candidate.organizationId);
    this.releaseIfUnreferenced(candidate.canvaUserId);
    this.writeAudit({
      organizationId: candidate.organizationId,
      actorUserId,
      action: 'canva.oauth.candidate_rejected',
      metadata: { reason },
    });
  }

  expireCandidate(organizationId: string): void {
    const candidate = this.candidates.get(organizationId);
    if (candidate && candidate.expiresAt.getTime() <= this.time)
      this.removeCandidate(candidate, 'candidate_expired', null);
  }
}

// ---------------------------------------------------------------------------
// Attempt store
// ---------------------------------------------------------------------------

export class MemoryAttemptStore implements CanvaOAuthAttemptStore {
  constructor(readonly db: MemoryCanvaDatabase) {}

  create = vi.fn(async (attempt: NewCanvaOAuthAttempt) => {
    const connection = this.db.connection(attempt.organizationId);
    const open = [...this.db.attempts.values()].filter(
      (record) =>
        record.organizationId === attempt.organizationId &&
        !record.consumedAt &&
        (record.expiresAt ?? record.launchExpiresAt).getTime() > this.db.time,
    ).length;
    if (open >= CANVA_MAX_OPEN_ATTEMPTS) throw new CanvaAttemptLimitError();
    const launchExpiresAt = new Date(this.db.time + 60_000);
    const id = `attempt-${this.db.attempts.size + 1}`;
    this.db.attempts.set(id, {
      ...attempt,
      id,
      baseGeneration: connection.connectionGeneration,
      launchExpiresAt,
      launchedAt: null,
      expiresAt: null,
      consumedAt: null,
      stateHash: null,
      browserBindingHash: null,
      codeVerifier: null,
    });
    this.db.writeAudit({
      organizationId: attempt.organizationId,
      actorUserId: attempt.userId,
      action: 'canva.oauth.started',
      metadata: { mode: 'CANVA' },
    });
    return { launchExpiresAt };
  });

  launch = vi.fn(
    async (
      launchTokenHash: string,
      secrets: (organizationId: string) => CanvaLaunchSecrets,
      stateLifetimeMs: number,
    ) => {
      const record = [...this.db.attempts.values()].find(
        (candidate) =>
          candidate.launchTokenHash === launchTokenHash &&
          !candidate.launchedAt &&
          candidate.launchExpiresAt.getTime() > this.db.time,
      );
      if (!record) return null;
      const built = secrets(record.organizationId);
      record.launchedAt = this.db.now();
      record.stateHash = built.stateHash;
      record.browserBindingHash = built.browserBindingHash;
      record.codeVerifier = built.codeVerifier;
      record.expiresAt = new Date(this.db.time + stateLifetimeMs);
      return { redirectUri: record.redirectUri, expiresAt: record.expiresAt };
    },
  );

  consume = vi.fn(
    async (
      stateHash: string,
      browserBindingHash: string,
    ): Promise<ConsumedCanvaAttempt | null> => {
      const record = [...this.db.attempts.values()].find(
        (candidate) =>
          candidate.stateHash === stateHash &&
          !candidate.consumedAt &&
          candidate.launchedAt &&
          candidate.expiresAt &&
          candidate.expiresAt.getTime() > this.db.time &&
          candidate.browserBindingHash === browserBindingHash,
      );
      if (!record?.codeVerifier) return null;
      record.consumedAt = this.db.now();
      const codeVerifier = record.codeVerifier;
      record.codeVerifier = null;
      return {
        attemptId: record.id,
        organizationId: record.organizationId,
        userId: record.userId,
        sessionId: record.sessionId,
        baseGeneration: record.baseGeneration,
        redirectUri: record.redirectUri,
        codeVerifier,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Credential store
// ---------------------------------------------------------------------------

export class MemoryCredentialStore implements CanvaCredentialStore {
  nextCandidateFault: InjectedWriteFault | null = null;
  nextRotationFault: InjectedWriteFault | null = null;
  failNextRead = false;
  failNextCandidateCheck = false;
  failNextEnqueue = false;
  // Leases, modeled by owner and expiry (database time).
  readonly leases = new Map<string, { owner: string; until: number }>();
  private lock: Promise<unknown> = Promise.resolve();

  constructor(readonly db: MemoryCanvaDatabase) {}

  read = vi.fn(async (organizationId: string) => {
    if (this.failNextRead) {
      this.failNextRead = false;
      throw new Error('read failed');
    }
    return this.db.credentials.get(organizationId) ?? null;
  });

  createCandidate = vi.fn(
    async (candidate: NewCanvaCandidate): Promise<CanvaCandidateCreation> => {
      const fault = this.nextCandidateFault;
      this.nextCandidateFault = null;
      if (fault === 'definite') throw new CanvaPersistenceError();
      if (fault === 'uncommitted_unknown')
        throw new CanvaWriteOutcomeUnknownError();
      const { attempt } = candidate;
      const organizationId = attempt.organizationId;
      this.db.expireCandidate(organizationId);
      if (this.db.candidates.has(organizationId)) {
        this.db.enqueue({
          organizationId,
          chainId: candidate.chainId,
          canvaUserId: candidate.canvaUserId,
          reason: 'connect_conflict',
          refreshToken: candidate.refreshToken,
        });
        this.db.writeAudit({
          organizationId,
          actorUserId: attempt.userId,
          action: 'canva.oauth.failed',
          metadata: { outcome: 'conflict' },
        });
        return { outcome: 'conflict' };
      }
      const holder = this.db.accounts.get(candidate.canvaUserId) ?? null;
      if (holder !== null && holder !== organizationId)
        return { outcome: 'account_unavailable' };
      const launchedAt = this.db.attempts.get(attempt.attemptId)?.launchedAt;
      const fenced = this.db.queue.some(
        (row) =>
          row.canvaUserId === candidate.canvaUserId &&
          (row.state === 'in_flight' ||
            (row.possibleEffectUntil !== null &&
              launchedAt !== null &&
              launchedAt !== undefined &&
              row.possibleEffectUntil > launchedAt.getTime())),
      );
      if (fenced) return { outcome: 'retry_connect' };
      this.db.hold(candidate.canvaUserId, organizationId);
      const id = `candidate-${randomUUID()}`;
      const expiresAt = new Date(this.db.time + 10 * 60_000);
      this.db.candidates.set(organizationId, {
        id,
        organizationId,
        userId: attempt.userId,
        sessionId: attempt.sessionId,
        attemptId: attempt.attemptId,
        baseGeneration: attempt.baseGeneration,
        chainId: candidate.chainId,
        writeId: candidate.writeId,
        accessToken: candidate.accessToken,
        refreshToken: candidate.refreshToken,
        accessTokenExpiresAt: candidate.accessTokenExpiresAt,
        scopes: candidate.scopes,
        canvaUserId: candidate.canvaUserId,
        canvaTeamId: candidate.canvaTeamId,
        canvaDisplayName: candidate.canvaDisplayName,
        capabilities: candidate.capabilities,
        createdAt: this.db.now(),
        expiresAt,
      });
      this.db.writeAudit({
        organizationId,
        actorUserId: attempt.userId,
        action: 'canva.oauth.pending_confirmation',
        metadata: { mode: 'CANVA' },
      });
      if (fault === 'committed_unknown')
        throw new CanvaWriteOutcomeUnknownError();
      return { outcome: 'pending_confirmation', candidateId: id, expiresAt };
    },
  );

  candidateExists = vi.fn(async (writeId: string) => {
    if (this.failNextCandidateCheck) {
      this.failNextCandidateCheck = false;
      throw new Error('read failed');
    }
    return [...this.db.candidates.values()].some(
      (candidate) => candidate.writeId === writeId,
    );
  });

  private ownedCandidate(owner: CanvaCandidateOwner, id?: string) {
    const candidate = this.db.candidates.get(owner.organizationId);
    if (
      !candidate ||
      candidate.userId !== owner.userId ||
      candidate.sessionId !== owner.sessionId ||
      (id !== undefined && candidate.id !== id)
    )
      return null;
    return candidate;
  }

  readCandidate = vi.fn(async (owner: CanvaCandidateOwner) => {
    this.db.expireCandidate(owner.organizationId);
    const candidate = this.ownedCandidate(owner);
    if (!candidate) return null;
    const view: PendingCanvaCandidate = {
      id: candidate.id,
      organizationId: candidate.organizationId,
      userId: candidate.userId,
      sessionId: candidate.sessionId,
      canvaUserId: candidate.canvaUserId,
      canvaTeamId: candidate.canvaTeamId,
      canvaDisplayName: candidate.canvaDisplayName,
      scopes: candidate.scopes,
      capabilities: candidate.capabilities,
      createdAt: candidate.createdAt,
      expiresAt: candidate.expiresAt,
      currentCanvaUserId:
        this.db.credentials.get(owner.organizationId)?.canvaUserId ?? null,
    };
    return view;
  });

  activateCandidate = vi.fn(
    async (
      owner: CanvaCandidateOwner,
      candidateId: string,
    ): Promise<CanvaActivation> => {
      const candidate = this.ownedCandidate(owner, candidateId);
      if (!candidate || candidate.expiresAt.getTime() <= this.db.time)
        return { outcome: 'not_found' };
      const connection = this.db.connection(owner.organizationId);
      if (connection.connectionGeneration !== candidate.baseGeneration) {
        this.db.removeCandidate(candidate, 'connect_conflict', owner.userId);
        return { outcome: 'stale' };
      }
      const previous = this.db.credentials.get(owner.organizationId);
      const sameCanvaUser = previous?.canvaUserId === candidate.canvaUserId;
      if (previous && !sameCanvaUser)
        this.db.enqueue({
          organizationId: owner.organizationId,
          chainId: previous.chainId,
          canvaUserId: previous.canvaUserId,
          reason: 'replaced_other_user',
          refreshToken: previous.refreshToken,
        });
      this.db.credentials.delete(owner.organizationId);
      if (previous && !sameCanvaUser)
        this.db.releaseIfUnreferenced(previous.canvaUserId);
      connection.credentialVersion += 1;
      connection.connectionGeneration += 1;
      connection.status = 'CONNECTED';
      connection.mode = 'CANVA';
      connection.connectedAt = this.db.now();
      connection.reauthorizationReason = null;
      connection.configurationError = false;
      const credential: StoredCanvaCredential = {
        organizationId: owner.organizationId,
        connectedById: candidate.userId,
        accessToken: candidate.accessToken,
        refreshToken: candidate.refreshToken,
        accessTokenExpiresAt: candidate.accessTokenExpiresAt,
        scopes: candidate.scopes,
        canvaUserId: candidate.canvaUserId,
        canvaTeamId: candidate.canvaTeamId,
        chainId: candidate.chainId,
        writeId: candidate.writeId,
        version: connection.credentialVersion,
      };
      this.db.credentials.set(owner.organizationId, credential);
      this.db.candidates.delete(owner.organizationId);
      this.db.writeAudit({
        organizationId: owner.organizationId,
        actorUserId: owner.userId,
        action: 'canva.connection.connected',
        metadata: { replacedPrevious: !!previous, sameCanvaUser },
      });
      return {
        outcome: 'connected',
        credential,
        replacedPrevious: !!previous,
        sameCanvaUser,
      };
    },
  );

  rejectCandidate = vi.fn(
    async (owner: CanvaCandidateOwner, candidateId: string) => {
      const candidate = this.ownedCandidate(owner, candidateId);
      if (!candidate) return false;
      this.db.removeCandidate(candidate, 'candidate_rejected', owner.userId);
      return true;
    },
  );

  // Serialized like the lease; the compare-and-set is what makes stale
  // writes safe, as in production.
  withRefreshLock<T>(
    organizationId: string,
    work: (
      current: StoredCanvaCredential | null,
      lease: CanvaRefreshLease,
    ) => Promise<{ result: T; replace?: NewCanvaCredential }>,
  ): Promise<T> {
    const run = this.lock.then(async () => {
      const current = this.db.credentials.get(organizationId) ?? null;
      const previousLease = this.leases.get(organizationId);
      const tookOver = !!previousLease;
      this.leases.delete(organizationId);
      const { result, replace } = await work(current, { tookOver });
      if (replace) {
        const latest = this.db.credentials.get(organizationId);
        if (
          !current ||
          latest?.version !== current.version ||
          latest.chainId !== current.chainId
        )
          throw new CanvaStaleCredentialError();
        const fault = this.nextRotationFault;
        this.nextRotationFault = null;
        if (fault === 'uncommitted_unknown')
          throw new CanvaWriteOutcomeUnknownError();
        if (fault === 'definite') throw new CanvaPersistenceError();
        const connection = this.db.connection(organizationId);
        connection.credentialVersion += 1;
        connection.configurationError = false;
        this.db.credentials.set(organizationId, {
          ...replace,
          version: connection.credentialVersion,
        });
        this.db.writeAudit({
          organizationId,
          actorUserId: null,
          action: 'canva.credential.refreshed',
          metadata: { fromVersion: current.version },
        });
        if (fault === 'committed_unknown')
          throw new CanvaWriteOutcomeUnknownError();
      }
      return result;
    });
    this.lock = run.catch(() => undefined);
    return run;
  }

  markReauthorizationRequired = vi.fn(
    async (
      organizationId: string,
      expectedVersion: number,
      reason: CanvaReauthorizationReason,
    ) => {
      const current = this.db.credentials.get(organizationId);
      if (current?.version !== expectedVersion) return false;
      this.db.credentials.delete(organizationId);
      this.db.releaseIfUnreferenced(current.canvaUserId);
      const connection = this.db.connection(organizationId);
      connection.status = 'REAUTHORIZATION_REQUIRED';
      connection.reauthorizationReason = reason;
      connection.connectionGeneration += 1;
      connection.credentialVersion += 1;
      this.db.writeAudit({
        organizationId,
        actorUserId: null,
        action: 'canva.connection.reauthorization_required',
        metadata: { reason },
      });
      return true;
    },
  );

  disconnect = vi.fn(async (organizationId: string, actorUserId: string) => {
    const connection = this.db.connection(organizationId);
    const credential = this.db.credentials.get(organizationId);
    const candidate = this.db.candidates.get(organizationId);
    let queued = 0;
    if (credential) {
      this.db.enqueue({
        organizationId,
        chainId: credential.chainId,
        canvaUserId: credential.canvaUserId,
        reason: 'disconnect',
        refreshToken: credential.refreshToken,
      });
      queued += 1;
      this.db.credentials.delete(organizationId);
    }
    if (candidate) {
      this.db.removeCandidate(candidate, 'candidate_superseded', actorUserId);
      queued += 1;
    }
    if (credential) this.db.releaseIfUnreferenced(credential.canvaUserId);
    connection.status = 'DISCONNECTED';
    connection.connectedAt = null;
    connection.connectionGeneration += 1;
    connection.credentialVersion += 1;
    this.db.writeAudit({
      organizationId,
      actorUserId,
      action: 'canva.connection.disconnected',
      metadata: { mode: 'CANVA', revocation: queued ? 'queued' : 'none' },
    });
    return { removed: !!credential, queued };
  });

  enqueueRevocation = vi.fn(async (revocation: NewCanvaRevocation) => {
    if (this.failNextEnqueue) {
      this.failNextEnqueue = false;
      throw new CanvaPersistenceError();
    }
    this.db.enqueue(revocation);
  });

  recordConfigurationError = vi.fn(async (organizationId: string) => {
    this.db.connection(organizationId).configurationError = true;
  });

  details = vi.fn(async (organizationId: string) => {
    const connection = this.db.connections.get(organizationId);
    if (!connection) return null;
    const rows = this.db.queue.filter(
      (row) => row.organizationId === organizationId,
    );
    return {
      status: connection.status,
      mode: connection.mode,
      connectedAt: connection.connectedAt,
      reauthorizationReason: connection.reauthorizationReason,
      configurationError: connection.configurationError,
      pendingRevocations: rows.filter(
        (row) => row.state === 'queued' || row.state === 'in_flight',
      ).length,
      exhaustedRevocations: rows.filter((row) => row.state === 'exhausted')
        .length,
    } satisfies CanvaConnectionDetails;
  });
}

// ---------------------------------------------------------------------------
// Revocation queue
// ---------------------------------------------------------------------------

const CLAIM_MS = 60_000;
const CRASHED_CALL_WINDOW_MS = 135_000;

export class MemoryRevocationQueue implements CanvaRevocationQueueStore {
  failNextDecide: 'definite' | 'committed_unknown' | null = null;
  failNextRecord = false;

  constructor(readonly db: MemoryCanvaDatabase) {}

  claim = vi.fn(
    async (
      claimToken: string,
      limit: number,
      canvaUserId?: string,
    ): Promise<ClaimedCanvaRevocation[]> => {
      const now = this.db.time;
      const due = this.db.queue
        .filter(
          (row) =>
            (!canvaUserId || row.canvaUserId === canvaUserId) &&
            ((row.state === 'queued' &&
              row.nextAttemptAt <= now &&
              (row.claimedUntil === null || row.claimedUntil < now)) ||
              (row.state === 'in_flight' &&
                row.claimedUntil !== null &&
                row.claimedUntil < now)),
        )
        .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
        .slice(0, limit);
      for (const row of due) {
        row.claimToken = claimToken;
        row.claimedUntil = now + CLAIM_MS;
      }
      return due.map((row) => ({ id: row.id, canvaUserId: row.canvaUserId }));
    },
  );

  decide = vi.fn(
    async (
      id: string,
      claimToken: string,
    ): Promise<CanvaRevocationDecision> => {
      const fault = this.failNextDecide;
      this.failNextDecide = null;
      if (fault === 'definite') throw new CanvaPersistenceError();
      const row = this.db.queue.find((candidate) => candidate.id === id);
      if (
        !row ||
        row.claimToken !== claimToken ||
        (row.state !== 'queued' && row.state !== 'in_flight')
      )
        return { kind: 'lost' };
      if (row.state === 'in_flight' && row.callStartedAt !== null) {
        row.state = 'queued';
        row.possibleEffectUntil = Math.max(
          row.possibleEffectUntil ?? -Infinity,
          row.callStartedAt + CRASHED_CALL_WINDOW_MS,
        );
      }
      if (this.db.hasGrant(row.canvaUserId)) {
        this.finish(row, 'skipped_shared_consent');
        return { kind: 'skipped' };
      }
      if (row.attempts >= REVOCATION_MAX_ATTEMPTS) {
        row.state = 'exhausted';
        row.claimedUntil = null;
        row.nextAttemptAt = this.db.time;
        this.db.writeAudit({
          organizationId: row.organizationId,
          actorUserId: null,
          action: 'canva.connection.revocation_exhausted',
          metadata: { reason: row.reason, attempts: row.attempts },
        });
        return { kind: 'exhausted' };
      }
      row.state = 'in_flight';
      row.attempts += 1;
      row.callStartedAt = this.db.time;
      row.claimedUntil = this.db.time + CLAIM_MS;
      if (fault === 'committed_unknown')
        throw new CanvaWriteOutcomeUnknownError();
      return {
        kind: 'send',
        organizationId: row.organizationId,
        reason: row.reason,
        attempts: row.attempts,
        ageMs: this.db.time - row.createdAt,
        refreshToken: row.refreshToken,
      };
    },
  );

  record = vi.fn(
    async (id: string, claimToken: string, record: CanvaRevocationRecord) => {
      if (this.failNextRecord) {
        this.failNextRecord = false;
        throw new CanvaWriteOutcomeUnknownError();
      }
      const row = this.db.queue.find((candidate) => candidate.id === id);
      if (!row || row.claimToken !== claimToken || row.state !== 'in_flight')
        return false;
      const effectEnd = record.ambiguous
        ? Math.max(this.db.time, (row.callStartedAt ?? 0) + 15_000) + 120_000
        : this.db.time;
      // No request sent: the window is left as it was.
      if (record.called !== false)
        row.possibleEffectUntil = Math.max(
          row.possibleEffectUntil ?? -Infinity,
          effectEnd,
        );
      row.lastErrorKind = record.lastErrorKind;
      if (record.refund) row.attempts -= 1;
      row.claimedUntil = null;
      if (record.next === 'finished') {
        this.finish(row, record.outcome ?? 'revoked');
      } else if (record.next === 'exhausted') {
        row.state = 'exhausted';
        row.nextAttemptAt = this.db.time;
        this.db.writeAudit({
          organizationId: row.organizationId,
          actorUserId: null,
          action: 'canva.connection.revocation_exhausted',
          metadata: { reason: row.reason, attempts: row.attempts },
        });
      } else {
        row.state = 'queued';
        row.nextAttemptAt = this.db.time + record.delayMs;
      }
      return true;
    },
  );

  retryExhausted = vi.fn(
    async (organizationId: string, id: string, actorUserId: string) => {
      const row = this.db.queue.find(
        (candidate) =>
          candidate.id === id &&
          candidate.organizationId === organizationId &&
          candidate.state === 'exhausted',
      );
      if (!row) return false;
      const previousAttempts = row.attempts;
      row.state = 'queued';
      row.attempts = 0;
      row.nextAttemptAt = this.db.time;
      row.claimToken = null;
      this.db.writeAudit({
        organizationId,
        actorUserId,
        action: 'canva.connection.revocation_retried',
        metadata: { reason: row.reason, previousAttempts },
      });
      return true;
    },
  );

  dismissExhausted = vi.fn(
    async (organizationId: string, id: string, actorUserId: string) => {
      const row = this.db.queue.find(
        (candidate) =>
          candidate.id === id &&
          candidate.organizationId === organizationId &&
          candidate.state === 'exhausted',
      );
      if (!row) return false;
      this.finish(row, 'dismissed', false);
      this.db.writeAudit({
        organizationId,
        actorUserId,
        action: 'canva.connection.revocation_dismissed',
        metadata: { reason: row.reason, outcome: 'dismissed' },
      });
      return true;
    },
  );

  listExhausted = vi.fn(
    async (organizationId: string): Promise<CanvaExhaustedRevocation[]> =>
      this.db.queue
        .filter(
          (row) =>
            row.organizationId === organizationId && row.state === 'exhausted',
        )
        .map((row) => ({
          id: row.id,
          reason: row.reason,
          attempts: row.attempts,
          lastErrorKind: row.lastErrorKind,
          createdAt: new Date(row.createdAt),
          exhaustedAt: new Date(row.nextAttemptAt),
        })),
  );

  inspect = vi.fn(async (limit: number): Promise<CanvaRevocationInspection> => {
    const now = this.db.time;
    const counts = { queued: 0, in_flight: 0, exhausted: 0, finished: 0 };
    for (const row of this.db.queue) counts[row.state] += 1;
    const due = this.db.queue.filter(
      (row) =>
        row.state === 'queued' &&
        row.nextAttemptAt <= now &&
        (row.claimedUntil === null || row.claimedUntil < now),
    );
    const crashed = this.db.queue.filter(
      (row) =>
        row.state === 'in_flight' &&
        row.claimedUntil !== null &&
        row.claimedUntil < now,
    );
    const preview = [...due, ...crashed]
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        reason: row.reason,
        state: row.state as 'queued' | 'in_flight',
        attempts: row.attempts,
        recovering: row.state === 'in_flight',
        wouldDo: this.db.hasGrant(row.canvaUserId)
          ? ('skip_shared_consent' as const)
          : row.attempts >= REVOCATION_MAX_ATTEMPTS
            ? ('exhaust' as const)
            : ('send' as const),
      }));
    const unfinished = this.db.queue.filter((row) => row.state !== 'finished');
    return {
      counts,
      due: due.length,
      crashed: crashed.length,
      preview,
      health: {
        revocationConfigurationErrors: unfinished.filter(
          (row) => row.lastErrorKind === 'configuration',
        ).length,
        revocationKeyUnavailable: unfinished.filter(
          (row) => row.lastErrorKind === 'key_unavailable',
        ).length,
        connectionConfigurationErrors: [...this.db.connections.values()].filter(
          (connection) => connection.configurationError,
        ).length,
      },
    };
  });

  maintain = vi.fn(async () => ({
    expiredCandidates: 0,
    abandoned: 0,
    purged: 0,
    releasedHolds: 0,
    deletedAccounts: 0,
  }));

  private finish(row: QueueRecord, outcome: string, audit = true): void {
    row.state = 'finished';
    row.outcome = outcome;
    row.claimedUntil = null;
    row.sealedCleared = true;
    if (audit)
      this.db.writeAudit({
        organizationId: row.organizationId,
        actorUserId: null,
        action: 'canva.connection.revocation_finished',
        metadata: { reason: row.reason, outcome, attempts: row.attempts },
      });
  }
}

// ---------------------------------------------------------------------------
// Reseal store (§5.11)
// ---------------------------------------------------------------------------

export class MemoryResealStore implements CanvaResealStore {
  // Organizations whose credential holds an active refresh lease.
  readonly activeLeases = new Set<string>();
  failNextList = false;
  failNextReseal = false;
  // Runs just before a reseal is applied, to model a concurrent writer.
  beforeReseal: ((row: StaleCanvaSeal) => void) | null = null;

  constructor(readonly db: MemoryCanvaDatabase) {}

  private rows(kind: CanvaSealedKind): StaleCanvaSeal[] {
    const rows: StaleCanvaSeal[] = [];
    if (kind === 'credential')
      for (const credential of this.db.credentials.values())
        rows.push({
          kind,
          id: `credential-${credential.organizationId}`,
          organizationId: credential.organizationId,
          version: credential.version,
          writeId: credential.writeId,
          keyVersion: credential.accessToken.keyVersion,
          accessToken: credential.accessToken,
          refreshToken: credential.refreshToken,
        });
    if (kind === 'candidate')
      for (const candidate of this.db.candidates.values())
        rows.push({
          kind,
          id: candidate.id,
          organizationId: candidate.organizationId,
          keyVersion: candidate.accessToken.keyVersion,
          accessToken: candidate.accessToken,
          refreshToken: candidate.refreshToken,
        });
    if (kind === 'revocation')
      for (const row of this.db.queue)
        if (row.state !== 'finished' && !row.sealedCleared)
          rows.push({
            kind,
            id: row.id,
            organizationId: row.organizationId,
            keyVersion: row.refreshToken.keyVersion,
            refreshToken: row.refreshToken,
          });
    if (kind === 'attempt')
      for (const attempt of this.db.attempts.values())
        if (attempt.codeVerifier && !attempt.consumedAt)
          rows.push({
            kind,
            id: attempt.id,
            organizationId: attempt.organizationId,
            keyVersion: attempt.codeVerifier.keyVersion,
            codeVerifier: attempt.codeVerifier,
          });
    return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  inventory = vi.fn(async (): Promise<CanvaKeyInventory> => {
    const counts = new Map<string, number>();
    for (const kind of [
      'credential',
      'candidate',
      'revocation',
      'attempt',
    ] as const)
      for (const row of this.rows(kind)) {
        const key = `${kind}:${row.keyVersion}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    return [...counts].map(([key, rows]) => {
      const [kind, version] = key.split(':');
      return {
        kind: kind as CanvaSealedKind,
        keyVersion: Number(version),
        rows,
      };
    });
  });

  listStale = vi.fn(
    async (
      kind: CanvaSealedKind,
      currentKeyVersion: number,
      afterId: string | null,
      limit: number,
    ) => {
      if (this.failNextList) {
        this.failNextList = false;
        throw new CanvaPersistenceError();
      }
      return this.rows(kind)
        .filter(
          (row) =>
            row.keyVersion !== currentKeyVersion &&
            (afterId === null || row.id > afterId),
        )
        .slice(0, limit);
    },
  );

  reseal = vi.fn(async (row: StaleCanvaSeal, values: CanvaResealedValues) => {
    if (this.failNextReseal) {
      this.failNextReseal = false;
      throw new CanvaPersistenceError();
    }
    this.beforeReseal?.(row);
    switch (row.kind) {
      case 'credential': {
        const stored = this.db.credentials.get(row.organizationId);
        if (
          !stored ||
          stored.version !== row.version ||
          stored.writeId !== row.writeId ||
          stored.accessToken.keyVersion !== row.keyVersion ||
          this.activeLeases.has(row.organizationId)
        )
          return false;
        this.db.credentials.set(row.organizationId, {
          ...stored,
          accessToken: values.accessToken!,
          refreshToken: values.refreshToken!,
        });
        this.db.writeAudit({
          organizationId: row.organizationId,
          actorUserId: null,
          action: 'canva.credential.resealed',
          metadata: {
            fromKeyVersion: row.keyVersion,
            toKeyVersion: values.keyVersion,
          },
        });
        return true;
      }
      case 'candidate': {
        const candidate = [...this.db.candidates.values()].find(
          (entry) => entry.id === row.id,
        );
        if (!candidate || candidate.accessToken.keyVersion !== row.keyVersion)
          return false;
        candidate.accessToken = values.accessToken!;
        candidate.refreshToken = values.refreshToken!;
        return true;
      }
      case 'revocation': {
        const queued = this.db.queue.find((entry) => entry.id === row.id);
        if (
          !queued ||
          queued.state === 'finished' ||
          queued.sealedCleared ||
          queued.refreshToken.keyVersion !== row.keyVersion
        )
          return false;
        queued.refreshToken = values.refreshToken!;
        return true;
      }
      case 'attempt': {
        const attempt = this.db.attempts.get(row.id);
        if (
          !attempt?.codeVerifier ||
          attempt.consumedAt ||
          attempt.codeVerifier.keyVersion !== row.keyVersion
        )
          return false;
        attempt.codeVerifier = values.codeVerifier!;
        return true;
      }
    }
  });
}
