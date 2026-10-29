import type { SealedValue } from './canva-token-cipher';

// Persistence contracts for real Canva OAuth, specified by
// docs/integrations/canva-oauth-persistence-proposal.md (revision 5). The
// PostgreSQL implementations live in canva-*.prisma-store.ts; the module
// wires them only when CANVA_OAUTH_PERSISTENCE_ENABLED=true, and otherwise
// the "unavailable" implementations below, so real mode fails closed instead
// of falling back to in-memory state.

export const CANVA_OAUTH_ATTEMPT_STORE = Symbol('CANVA_OAUTH_ATTEMPT_STORE');
export const CANVA_CREDENTIAL_STORE = Symbol('CANVA_CREDENTIAL_STORE');
export const CANVA_REVOCATION_QUEUE = Symbol('CANVA_REVOCATION_QUEUE');
export const CANVA_RESEAL_STORE = Symbol('CANVA_RESEAL_STORE');

// ---------------------------------------------------------------------------
// Write outcomes. A store must report a definite failure only when it knows
// nothing was committed. Anything else that may have committed (a lost
// connection during COMMIT, a transaction timeout after the last statement)
// is ambiguous and must be reported as CanvaWriteOutcomeUnknownError, so
// callers re-read and verify by writeId before acting on it.
// ---------------------------------------------------------------------------

// Definite: persistence is not configured, so nothing was attempted.
export class CanvaPersistenceUnavailableError extends Error {
  constructor() {
    super('Canva OAuth persistence is not available');
    this.name = 'CanvaPersistenceUnavailableError';
  }
}

// Definite: the database rejected or rolled back the transaction (constraint
// violation, lock timeout, exhausted deadlock retries). Nothing was written.
export class CanvaPersistenceError extends Error {
  constructor() {
    super('The Canva change was not saved');
    this.name = 'CanvaPersistenceError';
  }
}

// Definite: a conditional write found that the credential changed since it
// was read (reconnected, disconnected, or written by another process). The
// transaction rolled back and nothing was written.
export class CanvaStaleCredentialError extends Error {
  constructor() {
    super('The Canva credential changed while it was being written');
    this.name = 'CanvaStaleCredentialError';
  }
}

// Definite: too many open OAuth attempts for the organization.
export class CanvaAttemptLimitError extends Error {
  constructor() {
    super('Too many Canva authorizations are in progress');
    this.name = 'CanvaAttemptLimitError';
  }
}

// Definite: another process holds the refresh lease and did not finish in
// time. Nothing was written; try again later.
export class CanvaRefreshBusyError extends Error {
  constructor() {
    super('A Canva token refresh is already in progress');
    this.name = 'CanvaRefreshBusyError';
  }
}

// Ambiguous: the write may or may not have committed.
export class CanvaWriteOutcomeUnknownError extends Error {
  constructor() {
    super('The Canva credential write could not be confirmed');
    this.name = 'CanvaWriteOutcomeUnknownError';
  }
}

// True only for failures where the store guarantees nothing was written.
export function isDefiniteWriteFailure(error: unknown): boolean {
  return (
    error instanceof CanvaPersistenceUnavailableError ||
    error instanceof CanvaPersistenceError ||
    error instanceof CanvaStaleCredentialError ||
    error instanceof CanvaAttemptLimitError ||
    error instanceof CanvaRefreshBusyError
  );
}

// ---------------------------------------------------------------------------
// OAuth attempts (§2.1, §5.1-5.3)
// ---------------------------------------------------------------------------

export const CANVA_LAUNCH_TOKEN_TTL_MS = 60_000;
export const CANVA_MAX_OPEN_ATTEMPTS = 20;

export type NewCanvaOAuthAttempt = {
  organizationId: string;
  userId: string;
  sessionId: string;
  // SHA-256 of the one-time launch token; the raw token is never stored.
  launchTokenHash: string;
  redirectUri: string;
};

// Created at launch and stored only as hashes and ciphertext.
export type CanvaLaunchSecrets = {
  stateHash: string;
  browserBindingHash: string;
  codeVerifier: SealedValue;
};

// A launched attempt, returned exactly once by consume().
export type ConsumedCanvaAttempt = {
  attemptId: string;
  organizationId: string;
  userId: string;
  sessionId: string;
  baseGeneration: number;
  codeVerifier: SealedValue;
  redirectUri: string;
};

export interface CanvaOAuthAttemptStore {
  // §5.1: under the connection lock, deletes old attempts, enforces the
  // open-attempt cap (CanvaAttemptLimitError), and records the attempt with
  // the current connectionGeneration. Expiry uses the database clock.
  create(attempt: NewCanvaOAuthAttempt): Promise<{ launchExpiresAt: Date }>;
  // §5.2: consumes the launch token at most once, within its lifetime, and
  // stores the hashes and sealed verifier that `secrets` builds for the
  // attempt's organization. Null when the token is unknown, used, or expired.
  launch(
    launchTokenHash: string,
    secrets: (organizationId: string) => CanvaLaunchSecrets,
    stateLifetimeMs: number,
  ): Promise<{ redirectUri: string; expiresAt: Date } | null>;
  // §5.3: one conditional update. Matches only an unexpired, launched,
  // unconsumed attempt whose browser-binding hash also matches, so a leaked
  // state without the cookie cannot burn the attempt. Under concurrent calls
  // at most one caller receives the attempt. Clears the sealed verifier.
  consume(
    stateHash: string,
    browserBindingHash: string,
  ): Promise<ConsumedCanvaAttempt | null>;
}

// ---------------------------------------------------------------------------
// Credentials, candidates, and ownership (§2.2-2.8, §5.4-5.9)
// ---------------------------------------------------------------------------

export type StoredCanvaCredential = {
  organizationId: string;
  connectedById: string;
  accessToken: SealedValue;
  refreshToken: SealedValue;
  accessTokenExpiresAt: Date;
  scopes: string[];
  // The Canva user and team that granted access (GET /v1/users/me). Canva
  // revokes the user's consent together with any of their refresh tokens,
  // so revocation decisions are made per Canva user.
  canvaUserId: string;
  canvaTeamId: string;
  // Identifies one OAuth grant: new on every connect, carried unchanged
  // through refreshes and reseals.
  chainId: string;
  // Unique per write, chosen by the writer, so after an ambiguous failure
  // the writer can re-read and tell whether its own write committed.
  writeId: string;
  // Assigned only by the store; equals the connection's credentialVersion.
  version: number;
};

// What callers supply for a rotation; the store assigns the version.
export type NewCanvaCredential = Omit<StoredCanvaCredential, 'version'>;

export type CanvaReauthorizationReason =
  'invalid_grant' | 'undecryptable' | 'rotation_lost' | 'identity_mismatch';

export type CanvaCapabilities = { autofill: boolean; brandTemplate: boolean };

export type NewCanvaCandidate = {
  attempt: ConsumedCanvaAttempt;
  chainId: string;
  writeId: string;
  accessToken: SealedValue;
  refreshToken: SealedValue;
  accessTokenExpiresAt: Date;
  // Empty when Canva did not report granted scopes.
  scopes: string[];
  canvaUserId: string;
  canvaTeamId: string;
  canvaDisplayName: string | null;
  capabilities: CanvaCapabilities;
};

// §5.4 results. Only pending_confirmation stores the tokens; conflict queues
// them for revocation inside the same transaction; account_unavailable and
// retry_connect mean the caller must discard them without revoking.
export type CanvaCandidateCreation =
  | { outcome: 'pending_confirmation'; candidateId: string; expiresAt: Date }
  | { outcome: 'conflict' }
  | { outcome: 'account_unavailable' }
  | { outcome: 'retry_connect' };

// What the confirmation screen may show. Never includes tokens.
export type PendingCanvaCandidate = {
  id: string;
  organizationId: string;
  userId: string;
  sessionId: string;
  canvaUserId: string;
  canvaTeamId: string;
  canvaDisplayName: string | null;
  scopes: string[];
  capabilities: CanvaCapabilities;
  createdAt: Date;
  expiresAt: Date;
  // The organization's current credential's Canva user, if any.
  currentCanvaUserId: string | null;
};

export type CanvaCandidateOwner = {
  organizationId: string;
  userId: string;
  sessionId: string;
};

export type CanvaActivation =
  | {
      outcome: 'connected';
      credential: StoredCanvaCredential;
      replacedPrevious: boolean;
      sameCanvaUser: boolean;
    }
  | { outcome: 'not_found' }
  // The connection changed since the attempt started; the candidate was
  // removed and its tokens queued (connect_conflict).
  | { outcome: 'stale' };

export type CanvaRevocationReason =
  | 'disconnect'
  | 'replaced_other_user'
  | 'candidate_rejected'
  | 'candidate_expired'
  | 'candidate_superseded'
  | 'connect_conflict'
  | 'connect_failed'
  | 'connect_ineligible'
  | 'orphaned_rotation';

// `E` in the proposal. The refresh token stays sealed with the
// organization's refresh-token context; the worker opens it.
export type NewCanvaRevocation = {
  organizationId: string;
  chainId: string;
  canvaUserId: string;
  reason: CanvaRevocationReason;
  refreshToken: SealedValue;
};

export type CanvaRefreshLease = {
  // Another holder's lease had expired and was taken over (§5.7 step 8).
  tookOver: boolean;
};

export type CanvaConnectionDetails = {
  status: 'CONNECTED' | 'DISCONNECTED' | 'REAUTHORIZATION_REQUIRED';
  mode: string;
  connectedAt: Date | null;
  reauthorizationReason: string | null;
  configurationError: boolean;
  pendingRevocations: number;
  exhaustedRevocations: number;
};

export interface CanvaCredentialStore {
  // Current credential without locking, for the fresh-token fast path and
  // for verifying an ambiguous write. Null when there is none.
  read(organizationId: string): Promise<StoredCanvaCredential | null>;
  // §5.4. Locks the connection row, then the Canva user's account row; an
  // in-flight revocation for that user, or one whose possible-effect window
  // extends past the attempt's launch, yields retry_connect.
  createCandidate(
    candidate: NewCanvaCandidate,
  ): Promise<CanvaCandidateCreation>;
  // Verifies an ambiguous createCandidate by its writeId.
  candidateExists(writeId: string): Promise<boolean>;
  // The owner's unexpired candidate (expired ones are removed first).
  readCandidate(
    owner: CanvaCandidateOwner,
  ): Promise<PendingCanvaCandidate | null>;
  // §5.5. Same owner, unexpired, generation unchanged. Replaces any existing
  // credential: a different Canva user's tokens are queued
  // (replaced_other_user), the same user's are discarded.
  activateCandidate(
    owner: CanvaCandidateOwner,
    candidateId: string,
  ): Promise<CanvaActivation>;
  // §5.6 with reason candidate_rejected. False when no such candidate.
  rejectCandidate(
    owner: CanvaCandidateOwner,
    candidateId: string,
  ): Promise<boolean>;
  // §5.7. Claims the refresh lease (database time), waits for a holder for
  // a bounded time (CanvaRefreshBusyError), and passes the credential as
  // read under the lease. `replace` is written only if the stored version
  // and chain still match (compare-and-set). A definite conflict throws
  // CanvaStaleCredentialError; a write that may have committed throws
  // CanvaWriteOutcomeUnknownError. The lease is released on every exit.
  withRefreshLock<T>(
    organizationId: string,
    work: (
      current: StoredCanvaCredential | null,
      lease: CanvaRefreshLease,
    ) => Promise<{ result: T; replace?: NewCanvaCredential }>,
  ): Promise<T>;
  // §5.8. Deletes an unusable credential and marks the connection
  // REAUTHORIZATION_REQUIRED, with an audit event, only if its version still
  // equals `expectedVersion`. The dead token is not queued.
  markReauthorizationRequired(
    organizationId: string,
    expectedVersion: number,
    reason: CanvaReauthorizationReason,
  ): Promise<boolean>;
  // §5.9. Deletes the credential and supersedes a pending candidate, queuing
  // both token sets in the same transaction, and marks DISCONNECTED.
  disconnect(
    organizationId: string,
    actorUserId: string,
  ): Promise<{ removed: boolean; queued: number }>;
  // `E` in its own transaction (orphaned rotations, failed callbacks).
  enqueueRevocation(revocation: NewCanvaRevocation): Promise<void>;
  // §5.12, throttled to one write per 5 minutes.
  recordConfigurationError(organizationId: string): Promise<void>;
  details(organizationId: string): Promise<CanvaConnectionDetails | null>;
}

// ---------------------------------------------------------------------------
// Revocation queue (§2.4, §2.7, §5.10, §5.13)
// ---------------------------------------------------------------------------

export type ClaimedCanvaRevocation = { id: string; canvaUserId: string };

// T1's decision for one claimed row.
export type CanvaRevocationDecision =
  // The claim was lost or the row is no longer pending: do nothing.
  | { kind: 'lost' }
  // A credential or candidate for the same Canva user exists: finished
  // without a call (skipped_shared_consent).
  | { kind: 'skipped' }
  | { kind: 'exhausted' }
  // Committed as in_flight with callStartedAt; the caller may send once,
  // within the send deadline.
  | {
      kind: 'send';
      organizationId: string;
      reason: CanvaRevocationReason;
      attempts: number;
      ageMs: number;
      refreshToken: SealedValue;
    };

// T2's input, computed by planRevocationRecord (canva-revocation.ts).
export type CanvaRevocationRecord = {
  next: 'queued' | 'finished' | 'exhausted';
  outcome: 'revoked' | 'not_revocable' | 'undecryptable' | null;
  lastErrorKind: string | null;
  delayMs: number;
  // Return the attempt counted at T1 (configuration pause).
  refund: boolean;
  // Ambiguous calls extend the possible-effect window (§2.7 step 2).
  ambiguous: boolean;
  // False when T1 committed but no request was sent (the key needed to open
  // the token is not available): the window is left as it was. Default true.
  called?: boolean;
};

// An exhausted row as an administrator sees it. Never includes ciphertext
// or Canva IDs.
export type CanvaExhaustedRevocation = {
  id: string;
  reason: CanvaRevocationReason;
  attempts: number;
  lastErrorKind: string | null;
  createdAt: Date;
  exhaustedAt: Date;
};

// What T1 would decide for a due row if it ran now, computed read-only and
// without locks, so it is only a preview: a concurrent change can alter it.
export type CanvaRevocationPreview = {
  id: string;
  organizationId: string;
  reason: CanvaRevocationReason;
  state: 'queued' | 'in_flight';
  attempts: number;
  // in_flight with an expired claim: a crashed or paused call to recover.
  recovering: boolean;
  wouldDo: 'skip_shared_consent' | 'exhaust' | 'send';
};

export type CanvaRevocationInspection = {
  counts: Record<'queued' | 'in_flight' | 'exhausted' | 'finished', number>;
  due: number;
  crashed: number;
  preview: CanvaRevocationPreview[];
  // Aggregate counts from the last recorded outcome of each row or
  // connection; no IDs, tokens, or ciphertext.
  health: {
    // Unfinished revocations whose last attempt Canva refused for the
    // client credentials (lastErrorKind = configuration).
    revocationConfigurationErrors: number;
    // Unfinished revocations last requeued because their key version was
    // not configured (lastErrorKind = key_unavailable).
    revocationKeyUnavailable: number;
    // Connections whose last token-endpoint refusal was a configuration
    // problem (lastProviderErrorKind = configuration; a later successful
    // refresh or reconnect clears it).
    connectionConfigurationErrors: number;
  };
};

export interface CanvaRevocationQueueStore {
  // Single statement, FOR UPDATE SKIP LOCKED: queued rows that are due, and
  // in_flight rows whose claim expired (a crashed or paused call).
  claim(
    claimToken: string,
    limit: number,
    canvaUserId?: string,
  ): Promise<ClaimedCanvaRevocation[]>;
  // T1: locks the account row, recovers a crashed call (window extended to
  // callStartedAt + 135 s), applies the same-user guard, the attempt limit,
  // and otherwise commits in_flight before any call is made.
  decide(id: string, claimToken: string): Promise<CanvaRevocationDecision>;
  // T2: conditioned on the claim and state in_flight. False when the claim
  // was lost (a recovering worker's window already covers this call).
  record(
    id: string,
    claimToken: string,
    record: CanvaRevocationRecord,
  ): Promise<boolean>;
  // Administrator actions on exhausted rows (§2.4), audited.
  retryExhausted(
    organizationId: string,
    id: string,
    actorUserId: string,
  ): Promise<boolean>;
  dismissExhausted(
    organizationId: string,
    id: string,
    actorUserId: string,
  ): Promise<boolean>;
  // The organization's exhausted rows, so an administrator can act on them.
  listExhausted(organizationId: string): Promise<CanvaExhaustedRevocation[]>;
  // Read-only, lock-free operator view (the worker's dry run). Writes
  // nothing and makes no external call.
  inspect(limit: number): Promise<CanvaRevocationInspection>;
  // Candidate expiry, the 30-day abandon, the 90-day purge, and the
  // account-hold sweep (§5.13).
  maintain(): Promise<{
    expiredCandidates: number;
    abandoned: number;
    purged: number;
    releasedHolds: number;
    deletedAccounts: number;
  }>;
}

// ---------------------------------------------------------------------------
// Key reseal (§5.11)
// ---------------------------------------------------------------------------

export type CanvaSealedKind =
  'credential' | 'candidate' | 'revocation' | 'attempt';

// A row holding values sealed under a key version other than the current
// one, with the identity its conditional reseal is checked against.
export type StaleCanvaSeal =
  | {
      kind: 'credential';
      id: string;
      organizationId: string;
      version: number;
      writeId: string;
      keyVersion: number;
      accessToken: SealedValue;
      refreshToken: SealedValue;
    }
  | {
      kind: 'candidate';
      id: string;
      organizationId: string;
      keyVersion: number;
      accessToken: SealedValue;
      refreshToken: SealedValue;
    }
  | {
      kind: 'revocation';
      id: string;
      organizationId: string;
      keyVersion: number;
      refreshToken: SealedValue;
    }
  | {
      kind: 'attempt';
      id: string;
      organizationId: string;
      keyVersion: number;
      codeVerifier: SealedValue;
    };

// The same values sealed under the current key; one key version per row.
export type CanvaResealedValues = {
  keyVersion: number;
  accessToken?: SealedValue;
  refreshToken?: SealedValue;
  codeVerifier?: SealedValue;
};

export type CanvaKeyInventory = Array<{
  kind: CanvaSealedKind;
  keyVersion: number;
  rows: number;
}>;

export interface CanvaResealStore {
  // Read-only counts of rows still holding sealed values, per kind and key
  // version. Finished revocations and consumed attempts hold none.
  inventory(): Promise<CanvaKeyInventory>;
  // Up to `limit` rows of one kind sealed under another key version, in id
  // order after `afterId`, so a run can resume and never loops on a row it
  // had to skip.
  listStale(
    kind: CanvaSealedKind,
    currentKeyVersion: number,
    afterId: string | null,
    limit: number,
  ): Promise<StaleCanvaSeal[]>;
  // One conditional write (§5.11): matches only if the row still holds the
  // listed key version (and, for a credential, the same version and writeId
  // with no active refresh lease). Never changes version or writeId. False
  // when the row changed or is busy; it is picked up again by a later run.
  reseal(row: StaleCanvaSeal, values: CanvaResealedValues): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Fail-closed implementations
// ---------------------------------------------------------------------------

export class UnavailableCanvaOAuthAttemptStore implements CanvaOAuthAttemptStore {
  async create(): Promise<{ launchExpiresAt: Date }> {
    throw new CanvaPersistenceUnavailableError();
  }
  async launch(): Promise<{ redirectUri: string; expiresAt: Date } | null> {
    throw new CanvaPersistenceUnavailableError();
  }
  async consume(): Promise<ConsumedCanvaAttempt | null> {
    throw new CanvaPersistenceUnavailableError();
  }
}

export class UnavailableCanvaCredentialStore implements CanvaCredentialStore {
  async read(): Promise<StoredCanvaCredential | null> {
    throw new CanvaPersistenceUnavailableError();
  }
  async createCandidate(): Promise<CanvaCandidateCreation> {
    throw new CanvaPersistenceUnavailableError();
  }
  async candidateExists(): Promise<boolean> {
    throw new CanvaPersistenceUnavailableError();
  }
  async readCandidate(): Promise<PendingCanvaCandidate | null> {
    throw new CanvaPersistenceUnavailableError();
  }
  async activateCandidate(): Promise<CanvaActivation> {
    throw new CanvaPersistenceUnavailableError();
  }
  async rejectCandidate(): Promise<boolean> {
    throw new CanvaPersistenceUnavailableError();
  }
  async withRefreshLock<T>(): Promise<T> {
    throw new CanvaPersistenceUnavailableError();
  }
  async markReauthorizationRequired(): Promise<boolean> {
    throw new CanvaPersistenceUnavailableError();
  }
  async disconnect(): Promise<{ removed: boolean; queued: number }> {
    throw new CanvaPersistenceUnavailableError();
  }
  async enqueueRevocation(): Promise<void> {
    throw new CanvaPersistenceUnavailableError();
  }
  async recordConfigurationError(): Promise<void> {
    throw new CanvaPersistenceUnavailableError();
  }
  async details(): Promise<CanvaConnectionDetails | null> {
    throw new CanvaPersistenceUnavailableError();
  }
}

export class UnavailableCanvaRevocationQueue implements CanvaRevocationQueueStore {
  async claim(): Promise<ClaimedCanvaRevocation[]> {
    throw new CanvaPersistenceUnavailableError();
  }
  async decide(): Promise<CanvaRevocationDecision> {
    throw new CanvaPersistenceUnavailableError();
  }
  async record(): Promise<boolean> {
    throw new CanvaPersistenceUnavailableError();
  }
  async retryExhausted(): Promise<boolean> {
    throw new CanvaPersistenceUnavailableError();
  }
  async dismissExhausted(): Promise<boolean> {
    throw new CanvaPersistenceUnavailableError();
  }
  async listExhausted(): Promise<CanvaExhaustedRevocation[]> {
    throw new CanvaPersistenceUnavailableError();
  }
  async inspect(): Promise<CanvaRevocationInspection> {
    throw new CanvaPersistenceUnavailableError();
  }
  async maintain(): Promise<{
    expiredCandidates: number;
    abandoned: number;
    purged: number;
    releasedHolds: number;
    deletedAccounts: number;
  }> {
    throw new CanvaPersistenceUnavailableError();
  }
}

export class UnavailableCanvaResealStore implements CanvaResealStore {
  async inventory(): Promise<CanvaKeyInventory> {
    throw new CanvaPersistenceUnavailableError();
  }
  async listStale(): Promise<StaleCanvaSeal[]> {
    throw new CanvaPersistenceUnavailableError();
  }
  async reseal(): Promise<boolean> {
    throw new CanvaPersistenceUnavailableError();
  }
}
