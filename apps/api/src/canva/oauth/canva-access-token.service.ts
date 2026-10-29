import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  CANVA_CLOCK,
  CANVA_OAUTH_CONFIG,
  type CanvaClock,
  type CanvaOAuthConfig,
} from './canva-oauth.config';
import {
  CANVA_CREDENTIAL_STORE,
  CanvaPersistenceError,
  CanvaRefreshBusyError,
  CanvaStaleCredentialError,
  CanvaWriteOutcomeUnknownError,
  type CanvaCredentialStore,
  type CanvaReauthorizationReason,
  type StoredCanvaCredential,
} from './canva-oauth.stores';
import { CanvaCipherError, sealContext } from './canva-token-cipher';
import {
  CanvaTokenClient,
  CanvaTokenError,
  type CanvaTokenSet,
} from './canva-token.client';
import { CanvaIdentityClient } from './canva-identity.client';
import { CanvaRevocationWorker } from './canva-revocation.worker';
import { realSleep, type SleepFn } from './canva-prisma.transaction';

// Refresh shortly before expiry so a token never expires mid-request.
export const ACCESS_TOKEN_REFRESH_SKEW_MS = 5 * 60_000;
// §5.7 step 8: a claimant that took over an expired lease and then gets
// invalid_grant waits this long for the previous holder's write.
export const TAKEOVER_GRACE_MS = 15_000;
const TAKEOVER_POLL_MS = 1_000;
export const CANVA_SLEEP = Symbol('CANVA_SLEEP');

// Permanent: the stored credential cannot be used again and an administrator
// must reconnect. Raised for no credential, a confirmed invalid_grant, or a
// credential that can no longer be decrypted (for example a retired key).
export class CanvaReconnectRequiredError extends Error {
  constructor(readonly reason: 'not_connected' | CanvaReauthorizationReason) {
    super('The Canva connection must be re-authorized');
    this.name = 'CanvaReconnectRequiredError';
  }
}

// Not retryable by waiting: the encryption key version that sealed the
// stored credential is not configured in this process. Nothing was changed;
// the credential becomes usable again once that key is configured.
export class CanvaKeyUnavailableError extends Error {
  constructor() {
    super('The Canva credential encryption key is not configured');
    this.name = 'CanvaKeyUnavailableError';
  }
}

// Retryable: Canva was busy or unreachable. The stored credential was not
// changed; try again later, honoring retryAfterSeconds when present.
export class CanvaTemporarilyUnavailableError extends Error {
  constructor(
    readonly outcomeUnknown: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    super('Canva is temporarily unavailable; try again later');
    this.name = 'CanvaTemporarilyUnavailableError';
  }
}

@Injectable()
export class CanvaAccessTokenService {
  private readonly logger = new Logger('CanvaAccessToken');
  private readonly sleep: SleepFn;

  constructor(
    @Inject(CANVA_OAUTH_CONFIG) private readonly config: CanvaOAuthConfig,
    @Inject(CANVA_CREDENTIAL_STORE)
    private readonly credentials: CanvaCredentialStore,
    private readonly tokens: CanvaTokenClient,
    @Inject(CANVA_CLOCK) private readonly now: CanvaClock,
    private readonly identity: CanvaIdentityClient,
    private readonly worker: CanvaRevocationWorker,
    @Optional() @Inject(CANVA_SLEEP) sleep?: SleepFn,
  ) {
    this.sleep = sleep ?? realSleep;
  }

  // Returns a usable access token for server-side Canva calls.
  async accessTokenFor(organizationId: string): Promise<string> {
    const config = this.realConfig();
    // Fast path: a fresh token needs no lease and no write.
    const known = await this.credentials.read(organizationId);
    if (known && this.isFresh(known)) {
      try {
        return config.keyring.open(
          known.accessToken,
          sealContext.accessToken(organizationId),
        );
      } catch {
        // Fall through: the leased path records an undecryptable credential.
      }
    }
    // A stale write means the credential was replaced or removed meanwhile;
    // one re-read under the lease then sees the newer state.
    try {
      return await this.refreshUnderLock(organizationId);
    } catch (error: unknown) {
      if (error instanceof CanvaRefreshBusyError)
        throw new CanvaTemporarilyUnavailableError(false);
      if (!(error instanceof CanvaStaleCredentialError)) throw error;
      return this.refreshUnderLock(organizationId);
    }
  }

  // §5.9: in one transaction the credential is deleted, a pending candidate
  // superseded, and both token sets queued; the worker decides later, under
  // the same-user guard, whether anything is revoked. Nothing is revoked
  // inline, so the result reports the revocation as queued, never done.
  async disconnect(
    organizationId: string,
    actorUserId: string,
  ): Promise<{ removed: boolean; revocation: 'queued' | 'none' }> {
    this.realConfig();
    const { removed, queued } = await this.credentials.disconnect(
      organizationId,
      actorUserId,
    );
    if (queued) this.worker.trigger();
    return { removed, revocation: queued ? 'queued' : 'none' };
  }

  // §2.8: a stored credential whose /users/me identity no longer matches is
  // marked identity_mismatch. Ownership is then unclear, so the tokens are
  // discarded, never queued. Only an explicit caller runs this check.
  // Intended caller: the real Autofill provider adapter, once per job before
  // its first Canva design call. That adapter is not built (design calls are
  // mock-only), so no request path calls this yet; refresh never changes the
  // Canva user, so nothing else needs it.
  async verifyStoredIdentity(organizationId: string): Promise<boolean> {
    const accessToken = await this.accessTokenFor(organizationId);
    const stored = await this.credentials.read(organizationId);
    if (!stored) throw new CanvaReconnectRequiredError('not_connected');
    const current = await this.identity.currentUser(accessToken);
    if (current.canvaUserId === stored.canvaUserId) return true;
    this.logger.warn('Canva credential identity changed; reconnect required');
    await this.credentials.markReauthorizationRequired(
      organizationId,
      stored.version,
      'identity_mismatch',
    );
    return false;
  }

  private async refreshUnderLock(organizationId: string): Promise<string> {
    const config = this.realConfig();
    let rotated: CanvaTokenSet | undefined;
    // Identifies this attempt's write, so an ambiguous outcome can be
    // verified by re-reading; the chain is the grant being refreshed.
    const writeId = randomUUID();
    let chainId: string | undefined;
    let canvaUserId: string | undefined;
    let readVersion: number | undefined;
    try {
      return await this.credentials.withRefreshLock(
        organizationId,
        async (current, lease) => {
          if (!current) throw new CanvaReconnectRequiredError('not_connected');
          chainId = current.chainId;
          canvaUserId = current.canvaUserId;
          readVersion = current.version;
          let refreshToken: string;
          try {
            if (this.isFresh(current))
              return {
                result: config.keyring.open(
                  current.accessToken,
                  sealContext.accessToken(organizationId),
                ),
              };
            refreshToken = config.keyring.open(
              current.refreshToken,
              sealContext.refreshToken(organizationId),
            );
          } catch (error: unknown) {
            if (error instanceof CanvaCipherError) {
              // Fail closed and keep the credential when its key is simply
              // not configured here: a key removed too early, or an instance
              // without the new key during a rolling deployment. Restoring
              // the key makes it usable again; marking would delete it.
              if (
                !config.keyring.hasKey(current.accessToken.keyVersion) ||
                !config.keyring.hasKey(current.refreshToken.keyVersion)
              )
                throw new CanvaKeyUnavailableError();
              // A configured key that cannot open the value: unusable.
              await this.requireReauthorization(current, 'undecryptable');
            }
            throw error;
          }
          try {
            rotated = await this.tokens.refresh(refreshToken);
          } catch (error: unknown) {
            if (!(error instanceof CanvaTokenError)) throw error;
            if (error.kind === 'invalid_grant') {
              // The previous lease holder may have rotated this token and
              // still be writing; give its write a chance to land.
              if (lease.tookOver) await this.awaitTakeoverWrite(current);
              await this.requireReauthorization(current, 'invalid_grant');
            }
            if (error.retryable)
              throw new CanvaTemporarilyUnavailableError(
                error.outcomeUnknown,
                error.retryAfterSeconds,
              );
            // Other rejections are configuration problems: the credential is
            // kept, the status shows it (§5.12), and the error surfaces.
            if (error.kind === 'rejected')
              await this.credentials
                .recordConfigurationError(organizationId)
                .catch(() => undefined);
            throw error;
          }
          const issuedAt = this.now().getTime();
          return {
            result: rotated.accessToken,
            replace: {
              organizationId,
              connectedById: current.connectedById,
              accessToken: config.keyring.seal(
                rotated.accessToken,
                sealContext.accessToken(organizationId),
              ),
              refreshToken: config.keyring.seal(
                rotated.refreshToken,
                sealContext.refreshToken(organizationId),
              ),
              accessTokenExpiresAt: new Date(
                issuedAt + rotated.expiresInSeconds * 1000,
              ),
              scopes: rotated.scopes.length ? rotated.scopes : current.scopes,
              // Refresh never changes the Canva user (§2.8).
              canvaUserId: current.canvaUserId,
              canvaTeamId: current.canvaTeamId,
              chainId: current.chainId,
              writeId,
            },
          };
        },
      );
    } catch (error: unknown) {
      const writeFailed =
        error instanceof CanvaPersistenceError ||
        error instanceof CanvaStaleCredentialError ||
        error instanceof CanvaWriteOutcomeUnknownError;
      if (!rotated || !chainId || !writeFailed) throw error;
      return this.recoverFailedRotationWrite(
        organizationId,
        rotated,
        { chainId, canvaUserId, readVersion, writeId },
        error,
      );
    }
  }

  // Polls for up to the grace period; a changed version means another
  // holder's write landed, so this read is stale and the caller re-reads.
  private async awaitTakeoverWrite(
    current: StoredCanvaCredential,
  ): Promise<void> {
    for (
      let waited = 0;
      waited < TAKEOVER_GRACE_MS;
      waited += TAKEOVER_POLL_MS
    ) {
      await this.sleep(TAKEOVER_POLL_MS);
      const latest = await this.credentials
        .read(current.organizationId)
        .catch(() => undefined);
      if (latest === undefined) continue;
      if (latest?.version !== current.version)
        throw new CanvaStaleCredentialError();
    }
  }

  // Canva rotated the token (so the stored refresh token is spent), but the
  // write did not report success. Nothing is given up on a version mismatch
  // alone: re-read and decide.
  //
  // | Re-read finds                         | Definite | Ambiguous | Stale |
  // | ------------------------------------- | -------- | --------- | ----- |
  // | our writeId (the write committed)     | success  | success   | —     |
  // | no credential, or a different chain   | orphan   | orphan    | orphan|
  // | same chain, the version we read       | lost     | lost      | —     |
  // | same chain, a newer version           | rethrow  | temporary | stale |
  // | nothing (the re-read failed)          | temporary| temporary | temp. |
  //
  // - orphan: our tokens were never stored. They are queued as
  //   orphaned_rotation; the worker's same-user guard decides whether they
  //   are ever revoked. Then stale, so the caller re-reads once.
  // - lost: the stored credential holds the spent token, so it can never be
  //   refreshed again: mark rotation_lost (§6), version-conditioned (§5.8).
  //   For an ambiguous outcome the re-read proves the write had not landed
  //   when read; if a late commit lands first after all, it changed the
  //   version, the mark matches nothing, and the caller re-reads the new
  //   credential. The rotated grant is discarded, not queued, as §5.8 does
  //   for any lost token; it stays valid at Canva until it expires.
  // - temporary: nothing verifiable; give nothing up. A later refresh with
  //   the spent token gets invalid_grant and marks the connection then.
  // Nothing here revokes: only the worker does, under the guard.
  private async recoverFailedRotationWrite(
    organizationId: string,
    rotated: CanvaTokenSet,
    read: {
      chainId: string;
      canvaUserId: string | undefined;
      readVersion: number | undefined;
      writeId: string;
    },
    failure:
      | CanvaPersistenceError
      | CanvaStaleCredentialError
      | CanvaWriteOutcomeUnknownError,
  ): Promise<string> {
    const ambiguous = failure instanceof CanvaWriteOutcomeUnknownError;
    let stored: StoredCanvaCredential | null;
    try {
      stored = await this.credentials.read(organizationId);
    } catch {
      throw new CanvaTemporarilyUnavailableError(
        !(failure instanceof CanvaPersistenceError),
      );
    }
    if (stored?.writeId === read.writeId) return rotated.accessToken;
    if (!stored || stored.chainId !== read.chainId) {
      if (read.canvaUserId)
        await this.queueOrphanedRotation(
          organizationId,
          read.chainId,
          read.canvaUserId,
          rotated.refreshToken,
        );
      throw new CanvaStaleCredentialError();
    }
    if (failure instanceof CanvaStaleCredentialError) throw failure;
    if (stored.version !== read.readVersion) {
      if (ambiguous) throw new CanvaTemporarilyUnavailableError(true);
      throw failure;
    }
    let marked: boolean;
    try {
      marked = await this.credentials.markReauthorizationRequired(
        organizationId,
        stored.version,
        'rotation_lost',
      );
    } catch {
      this.logger.warn('Canva rotation lost; reconnect mark not saved');
      throw new CanvaTemporarilyUnavailableError(ambiguous);
    }
    if (!marked) {
      // A reconnect, disconnect, or late commit won the race with the mark.
      // If our chain is gone, the rotated grant is an orphan like any other.
      const latest = await this.credentials
        .read(organizationId)
        .catch(() => undefined);
      if (
        latest !== undefined &&
        latest?.chainId !== read.chainId &&
        read.canvaUserId
      )
        await this.queueOrphanedRotation(
          organizationId,
          read.chainId,
          read.canvaUserId,
          rotated.refreshToken,
        );
      throw new CanvaStaleCredentialError();
    }
    this.logger.warn('Canva rotation lost; reconnect required');
    throw new CanvaReconnectRequiredError('rotation_lost');
  }

  private async queueOrphanedRotation(
    organizationId: string,
    chainId: string,
    canvaUserId: string,
    refreshToken: string,
  ): Promise<void> {
    const config = this.realConfig();
    try {
      await this.credentials.enqueueRevocation({
        organizationId,
        chainId,
        canvaUserId,
        reason: 'orphaned_rotation',
        refreshToken: config.keyring.seal(
          refreshToken,
          sealContext.refreshToken(organizationId),
        ),
      });
      this.worker.trigger(canvaUserId);
    } catch {
      this.logger.warn('Orphaned Canva rotation discarded: not queued');
    }
  }

  // Version-conditioned, so a late failure never disables a newer credential.
  // When the mark is refused, a reconnect already replaced the dead
  // credential: signal a stale read so the caller retries with the new one.
  private async requireReauthorization(
    current: StoredCanvaCredential,
    reason: CanvaReauthorizationReason,
  ): Promise<never> {
    const marked = await this.credentials.markReauthorizationRequired(
      current.organizationId,
      current.version,
      reason,
    );
    if (!marked) throw new CanvaStaleCredentialError();
    throw new CanvaReconnectRequiredError(reason);
  }

  private isFresh(credential: StoredCanvaCredential): boolean {
    return (
      credential.accessTokenExpiresAt.getTime() - this.now().getTime() >
      ACCESS_TOKEN_REFRESH_SKEW_MS
    );
  }

  private realConfig() {
    if (this.config.mode !== 'canva') throw new CanvaTokenError('disabled');
    return this.config;
  }
}
