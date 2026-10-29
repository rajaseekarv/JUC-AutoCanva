import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  CanvaAuthorizationStart,
  CanvaCandidateConfirmed,
  CanvaExhaustedRevocation,
  CanvaPendingCandidate,
} from '@adflow/shared-types';
import { z } from 'zod';
import type { AuthenticatedPrincipal } from '../../auth/auth.types';
import { PERMISSIONS } from '../../auth/permissions';
import {
  CANVA_AUTHORIZE_ENDPOINT,
  CANVA_CLOCK,
  CANVA_OAUTH_CONFIG,
  CANVA_OAUTH_ENDPOINTS,
  CANVA_OAUTH_STATE_TTL_MS,
  canvaLaunchUrl,
  checkAuthorizeEndpoint,
  canvaReturnUrl,
  type CanvaClock,
  type CanvaOAuthConfig,
  type CanvaOAuthOutcome,
} from './canva-oauth.config';
import {
  OAUTH_STATE_PATTERN,
  buildAuthorizationUrl,
  codeChallengeFor,
  createCodeVerifier,
  createOAuthState,
  hashOAuthState,
} from './canva-oauth.crypto';
import {
  CANVA_CREDENTIAL_STORE,
  CANVA_OAUTH_ATTEMPT_STORE,
  CANVA_REVOCATION_QUEUE,
  CanvaAttemptLimitError,
  CanvaPersistenceUnavailableError,
  CanvaWriteOutcomeUnknownError,
  isDefiniteWriteFailure,
  type CanvaCandidateCreation,
  type CanvaCandidateOwner,
  type CanvaCapabilities,
  type CanvaCredentialStore,
  type CanvaOAuthAttemptStore,
  type CanvaRevocationQueueStore,
  type CanvaRevocationReason,
  type ConsumedCanvaAttempt,
  type PendingCanvaCandidate,
} from './canva-oauth.stores';
import {
  CANVA_PRINCIPAL_CHECK,
  type CanvaPrincipalCheck,
} from './canva-principal-check';
import { sealContext, type SealedValue } from './canva-token-cipher';
import { CanvaTokenClient, type CanvaTokenSet } from './canva-token.client';
import {
  CanvaIdentityClient,
  CanvaIdentityError,
  type CanvaIdentity,
} from './canva-identity.client';
import {
  CanvaCapabilitiesClient,
  CanvaProfileClient,
  grantedScopeCheck,
} from './canva-account.clients';
import { CanvaRevocationWorker } from './canva-revocation.worker';

// Anything else in the callback query, such as a "redirect" or "return_to"
// parameter, is ignored.
const callbackQuerySchema = z.object({
  state: z.string().max(256).optional(),
  code: z.string().max(4_096).optional(),
  error: z.string().max(256).optional(),
});
const AUTHORIZATION_CODE_PATTERN = /^[\x21-\x7e]{1,4096}$/;
// 32 random bytes as base64url, like the state.
const LAUNCH_TOKEN_PATTERN = OAUTH_STATE_PATTERN;
const BINDING_PATTERN = OAUTH_STATE_PATTERN;
const ENTITY_ID_PATTERN = /^[\w-]{1,128}$/;

const launchBodySchema = z.object({ launch_token: z.string().max(256) });
const candidateActionSchema = z
  .object({ candidateId: z.string().regex(ENTITY_ID_PATTERN) })
  .strict();
const confirmationSchema = z
  .object({
    candidateId: z.string().regex(ENTITY_ID_PATTERN),
    acknowledgements: z
      .object({
        differentAccount: z.boolean().optional(),
        missingDisplayName: z.boolean().optional(),
        scopesNotReported: z.boolean().optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

// Warnings the confirmation screen shows; each needs an explicit
// acknowledgement in the confirmation request (§2.3).
export type CanvaCandidateWarning =
  'differentAccount' | 'missingDisplayName' | 'scopesNotReported';

class CallbackOutcome extends Error {
  constructor(readonly outcome: CanvaOAuthOutcome) {
    super(outcome);
  }
}

// Only the hash of a launch token or binding value is ever stored.
function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

// Opaque Canva IDs are shown shortened, enough to tell accounts apart.
function shortId(id: string): string {
  return id.length <= 8 ? id : `…${id.slice(-6)}`;
}

export function candidateWarnings(
  candidate: PendingCanvaCandidate,
): CanvaCandidateWarning[] {
  const warnings: CanvaCandidateWarning[] = [];
  if (
    candidate.currentCanvaUserId &&
    candidate.currentCanvaUserId !== candidate.canvaUserId
  )
    warnings.push('differentAccount');
  if (!candidate.canvaDisplayName) warnings.push('missingDisplayName');
  if (!candidate.scopes.length) warnings.push('scopesNotReported');
  return warnings;
}

// Maps storage failures on authenticated routes to safe HTTP errors.
function storageException(error: unknown): HttpException | null {
  if (error instanceof CanvaPersistenceUnavailableError)
    return new ServiceUnavailableException(
      'Real Canva connection is not available yet',
    );
  if (error instanceof CanvaAttemptLimitError)
    return new HttpException(
      'Too many Canva authorizations are in progress; try again later',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  if (error instanceof CanvaWriteOutcomeUnknownError)
    return new ServiceUnavailableException(
      'The Canva change could not be confirmed; reload to check before retrying',
    );
  if (isDefiniteWriteFailure(error))
    return new ServiceUnavailableException(
      'The Canva change was not saved; try again',
    );
  return null;
}

@Injectable()
export class CanvaOAuthService {
  private readonly logger = new Logger('CanvaOAuth');
  private readonly authorizeEndpoint: string;

  constructor(
    @Inject(CANVA_OAUTH_CONFIG) private readonly config: CanvaOAuthConfig,
    @Inject(CANVA_OAUTH_ATTEMPT_STORE)
    private readonly attempts: CanvaOAuthAttemptStore,
    @Inject(CANVA_CREDENTIAL_STORE)
    private readonly credentials: CanvaCredentialStore,
    @Inject(CANVA_REVOCATION_QUEUE)
    private readonly revocations: CanvaRevocationQueueStore,
    private readonly tokens: CanvaTokenClient,
    @Inject(CANVA_PRINCIPAL_CHECK)
    private readonly principals: CanvaPrincipalCheck,
    @Inject(CANVA_CLOCK) private readonly now: CanvaClock,
    private readonly identity: CanvaIdentityClient,
    private readonly profiles: CanvaProfileClient,
    private readonly capabilityClient: CanvaCapabilitiesClient,
    private readonly worker: CanvaRevocationWorker,
    @Optional()
    @Inject(CANVA_AUTHORIZE_ENDPOINT)
    authorizeEndpoint?: string,
  ) {
    // Fails the module's boot on any override outside a gate run.
    this.authorizeEndpoint = checkAuthorizeEndpoint(
      authorizeEndpoint ?? CANVA_OAUTH_ENDPOINTS.authorize,
      process.env,
    );
  }

  private realConfig(user: AuthenticatedPrincipal) {
    if (!user.permissions.includes(PERMISSIONS.CANVA_INTEGRATION_MANAGE))
      throw new ForbiddenException('Permission denied');
    const config = this.config;
    if (config.mode !== 'canva')
      throw new ConflictException(
        'Canva OAuth is disabled while the mock provider is active',
      );
    return config;
  }

  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error: unknown) {
      throw storageException(error) ?? error;
    }
  }

  // §2.1: records an attempt holding only the hash of a one-time launch
  // token. The browser posts that token to launchUrl in a top-level form
  // submission; the state and PKCE verifier are created there.
  async beginAuthorization(
    user: AuthenticatedPrincipal,
  ): Promise<CanvaAuthorizationStart> {
    const config = this.realConfig(user);
    const launchToken = randomToken();
    const { launchExpiresAt } = await this.guarded(() =>
      this.attempts.create({
        organizationId: user.organizationId,
        userId: user.id,
        sessionId: user.sessionId,
        launchTokenHash: sha256(launchToken),
        redirectUri: config.redirectUri,
      }),
    );
    return {
      launchUrl: canvaLaunchUrl(config),
      launchToken,
      expiresAt: launchExpiresAt.toISOString(),
    };
  }

  // §5.2. Unauthenticated by design (a top-level form POST carries no
  // Bearer token); the one-time launch token authenticates it. Returns the
  // Canva URL and the raw binding value for the HttpOnly cookie, or the
  // fixed web return URL when the token is unusable.
  async launch(
    body: unknown,
  ): Promise<{ location: string; bindingCookie?: string }> {
    const config = this.config;
    if (config.mode !== 'canva')
      return { location: canvaReturnUrl(config.webOrigin, 'disabled') };
    const parsed = launchBodySchema.safeParse(body);
    if (!parsed.success || !LAUNCH_TOKEN_PATTERN.test(parsed.data.launch_token))
      return { location: canvaReturnUrl(config.webOrigin, 'invalid_request') };
    const state = createOAuthState();
    const codeVerifier = createCodeVerifier();
    const binding = randomToken();
    let launched: { redirectUri: string } | null;
    try {
      launched = await this.attempts.launch(
        sha256(parsed.data.launch_token),
        (organizationId) => ({
          stateHash: hashOAuthState(state),
          browserBindingHash: sha256(binding),
          codeVerifier: config.keyring.seal(
            codeVerifier,
            sealContext.codeVerifier(organizationId),
          ),
        }),
        CANVA_OAUTH_STATE_TTL_MS,
      );
    } catch (error: unknown) {
      return {
        location: canvaReturnUrl(
          config.webOrigin,
          error instanceof CanvaPersistenceUnavailableError
            ? 'unavailable'
            : 'failed',
        ),
      };
    }
    if (!launched)
      return { location: canvaReturnUrl(config.webOrigin, 'expired_or_used') };
    return {
      location: buildAuthorizationUrl({
        clientId: config.clientId,
        redirectUri: launched.redirectUri,
        scopes: config.scopes,
        state,
        codeChallenge: codeChallengeFor(codeVerifier),
        endpoint: this.authorizeEndpoint,
      }),
      bindingCookie: binding,
    };
  }

  // Handles Canva's redirect. Never throws and always returns the fixed web
  // return URL with one of a closed set of outcomes.
  async completeAuthorization(
    query: unknown,
    bindingCookie?: string,
  ): Promise<string> {
    let outcome: CanvaOAuthOutcome;
    try {
      outcome = await this.finishAuthorization(query, bindingCookie);
    } catch (error: unknown) {
      outcome = error instanceof CallbackOutcome ? error.outcome : 'failed';
    }
    if (outcome !== 'pending_confirmation')
      // Only the outcome is logged; never the code, state, or tokens.
      this.logger.warn(`Canva authorization did not complete: ${outcome}`);
    return canvaReturnUrl(this.config.webOrigin, outcome);
  }

  private async finishAuthorization(
    query: unknown,
    bindingCookie: string | undefined,
  ): Promise<CanvaOAuthOutcome> {
    const config = this.config;
    if (config.mode !== 'canva') return 'disabled';
    const parsed = callbackQuerySchema.safeParse(query);
    if (!parsed.success) return 'invalid_request';
    const { state, code, error } = parsed.data;
    if (!state || !OAUTH_STATE_PATTERN.test(state)) return 'invalid_request';
    // Without the browser's binding cookie nothing can match, so a leaked
    // state cannot burn the owner's attempt.
    if (!bindingCookie || !BINDING_PATTERN.test(bindingCookie))
      return 'expired_or_used';

    // Consume first: a forged, expired, or already used state stops here,
    // and even an error response burns its state so it cannot be retried.
    let attempt: ConsumedCanvaAttempt | null;
    try {
      attempt = await this.attempts.consume(
        hashOAuthState(state),
        sha256(bindingCookie),
      );
    } catch (cause: unknown) {
      return cause instanceof CanvaPersistenceUnavailableError
        ? 'unavailable'
        : 'failed';
    }
    if (!attempt) return 'expired_or_used';
    if (attempt.redirectUri !== config.redirectUri) return 'failed';
    if (error) return error === 'access_denied' ? 'denied' : 'failed';
    if (!code || !AUTHORIZATION_CODE_PATTERN.test(code))
      return 'invalid_request';
    if (!(await this.principals.stillAuthorized(attempt)))
      return 'not_authorized';

    const codeVerifier = config.keyring.open(
      attempt.codeVerifier,
      sealContext.codeVerifier(attempt.organizationId),
    );
    // PKCE: Canva only issues tokens when this verifier matches the challenge
    // sent with the authorization request, so an injected code fails here.
    const tokens = await this.tokens.exchangeAuthorizationCode(
      code,
      codeVerifier,
    );
    // Who granted access decides every later revocation. Without a reliable
    // identity the same-user guard cannot apply, so the tokens are
    // discarded, never queued.
    let identity: CanvaIdentity;
    try {
      identity = await this.identity.currentUser(tokens.accessToken);
    } catch (cause: unknown) {
      this.logger.warn('Canva tokens discarded: identity could not be read');
      return cause instanceof CanvaIdentityError && cause.retryable
        ? 'unavailable'
        : 'failed';
    }
    const organizationId = attempt.organizationId;
    const chainId = randomUUID();
    const accessToken = config.keyring.seal(
      tokens.accessToken,
      sealContext.accessToken(organizationId),
    );
    const refreshToken = config.keyring.seal(
      tokens.refreshToken,
      sealContext.refreshToken(organizationId),
    );
    // The identity is known: anything given up from here is queued, and the
    // worker's guard decides whether it is ever revoked.
    const giveUp = (reason: CanvaRevocationReason) =>
      this.queueGivenUp({
        organizationId,
        chainId,
        canvaUserId: identity.canvaUserId,
        reason,
        refreshToken,
      });

    let capabilities: CanvaCapabilities;
    try {
      capabilities = await this.capabilityClient.capabilities(
        tokens.accessToken,
      );
    } catch (cause: unknown) {
      await giveUp('connect_failed');
      return cause instanceof CanvaIdentityError && cause.retryable
        ? 'unavailable'
        : 'failed';
    }
    if (!capabilities.autofill || !capabilities.brandTemplate) {
      await giveUp('connect_ineligible');
      return 'account_ineligible';
    }
    const scopeCheck = grantedScopeCheck(tokens.scopes, config.scopes);
    if (scopeCheck.missing.length) {
      await giveUp('connect_ineligible');
      return 'insufficient_scope';
    }
    const displayName = await this.profiles
      .displayName(tokens.accessToken)
      .catch(() => null);

    const writeId = randomUUID();
    let created: CanvaCandidateCreation;
    try {
      created = await this.credentials.createCandidate({
        attempt,
        chainId,
        writeId,
        accessToken,
        refreshToken,
        accessTokenExpiresAt: this.expiry(tokens),
        scopes: tokens.scopes,
        canvaUserId: identity.canvaUserId,
        canvaTeamId: identity.canvaTeamId,
        canvaDisplayName: displayName,
        capabilities,
      });
    } catch (cause: unknown) {
      if (isDefiniteWriteFailure(cause)) {
        await giveUp('connect_failed');
        return cause instanceof CanvaPersistenceUnavailableError
          ? 'unavailable'
          : 'failed';
      }
      // Ambiguous: never queue tokens that may also be stored; verify first.
      const stored = await this.credentials
        .candidateExists(writeId)
        .catch(() => undefined);
      if (stored === true) return 'pending_confirmation';
      if (stored === false) await giveUp('connect_failed');
      else this.logger.warn('Canva tokens discarded: save not verifiable');
      return 'failed';
    }
    switch (created.outcome) {
      case 'pending_confirmation':
        return 'pending_confirmation';
      case 'conflict':
        // The store queued the tokens in the same transaction.
        this.worker.trigger(identity.canvaUserId);
        return 'conflict';
      case 'account_unavailable':
        // Revoking would end the consent the holding organization uses.
        this.logger.warn('Canva tokens discarded: account held elsewhere');
        return 'account_unavailable';
      case 'retry_connect':
        // §2.7: a revocation for this Canva user may still take effect at
        // Canva, so this grant may already be dead, and revoking it would
        // end the user's consent. Discard it and let the worker settle the
        // pending revocation before the administrator retries.
        this.logger.warn('Canva tokens discarded: revocation window open');
        this.worker.trigger(identity.canvaUserId);
        return 'retry_connect';
    }
  }

  private expiry(tokens: CanvaTokenSet): Date {
    return new Date(this.now().getTime() + tokens.expiresInSeconds * 1000);
  }

  // `E` in its own transaction. If it fails, the tokens are discarded:
  // revoking inline would bypass the guard.
  private async queueGivenUp(revocation: {
    organizationId: string;
    chainId: string;
    canvaUserId: string;
    reason: CanvaRevocationReason;
    refreshToken: SealedValue;
  }): Promise<void> {
    try {
      await this.credentials.enqueueRevocation(revocation);
      this.worker.trigger(revocation.canvaUserId);
    } catch {
      this.logger.warn(
        'Canva tokens discarded: revocation could not be queued',
      );
    }
  }

  private owner(user: AuthenticatedPrincipal): CanvaCandidateOwner {
    return {
      organizationId: user.organizationId,
      userId: user.id,
      sessionId: user.sessionId,
    };
  }

  // §2.3: the confirmation screen. Only the administrator and session that
  // started the flow can see the candidate.
  async getCandidate(
    user: AuthenticatedPrincipal,
  ): Promise<CanvaPendingCandidate> {
    const config = this.realConfig(user);
    const candidate = await this.guarded(() =>
      this.credentials.readCandidate(this.owner(user)),
    );
    if (!candidate) throw new NotFoundException('No Canva account to confirm');
    const scopes = grantedScopeCheck(candidate.scopes, config.scopes);
    return {
      id: candidate.id,
      // Untrusted text, already sanitized; render as text only.
      canvaDisplayName: candidate.canvaDisplayName,
      canvaUserId: shortId(candidate.canvaUserId),
      canvaTeamId: shortId(candidate.canvaTeamId),
      scopes: {
        reported: scopes.reported,
        granted: candidate.scopes,
        required: [...config.scopes],
        missing: scopes.missing,
      },
      capabilities: candidate.capabilities,
      startedAt: candidate.createdAt.toISOString(),
      expiresAt: candidate.expiresAt.toISOString(),
      warnings: candidateWarnings(candidate),
    };
  }

  // §2.3 and §5.5. Every warning shown needs its acknowledgement; a missing
  // one is a 400 that keeps the candidate.
  async confirmCandidate(
    user: AuthenticatedPrincipal,
    body: unknown,
  ): Promise<CanvaCandidateConfirmed> {
    const config = this.realConfig(user);
    const parsed = confirmationSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('Invalid Canva confirmation');
    const owner = this.owner(user);
    const candidate = await this.guarded(() =>
      this.credentials.readCandidate(owner),
    );
    if (!candidate || candidate.id !== parsed.data.candidateId)
      throw new NotFoundException('No Canva account to confirm');
    const ineligible =
      !candidate.capabilities.autofill ||
      !candidate.capabilities.brandTemplate ||
      grantedScopeCheck(candidate.scopes, config.scopes).missing.length > 0;
    if (ineligible) {
      // Defensive: the callback never stores such a candidate.
      await this.guarded(() =>
        this.credentials.rejectCandidate(owner, candidate.id),
      );
      this.worker.trigger(candidate.canvaUserId);
      throw new ConflictException('This Canva account cannot be connected');
    }
    const acknowledged = parsed.data.acknowledgements;
    if (candidateWarnings(candidate).some((warning) => !acknowledged[warning]))
      throw new BadRequestException(
        'Confirm each warning before connecting this Canva account',
      );
    const activation = await this.guarded(() =>
      this.credentials.activateCandidate(owner, candidate.id),
    );
    if (activation.outcome === 'not_found')
      throw new NotFoundException('No Canva account to confirm');
    this.worker.trigger();
    if (activation.outcome === 'stale')
      throw new ConflictException(
        'The Canva connection changed while this authorization was pending; start again',
      );
    return {
      status: 'CONNECTED',
      replacedPrevious: activation.replacedPrevious,
      sameCanvaUser: activation.sameCanvaUser,
    };
  }

  async rejectCandidate(user: AuthenticatedPrincipal, body: unknown) {
    this.realConfig(user);
    const parsed = candidateActionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid Canva request');
    const rejected = await this.guarded(() =>
      this.credentials.rejectCandidate(
        this.owner(user),
        parsed.data.candidateId,
      ),
    );
    if (!rejected) throw new NotFoundException('No Canva account to reject');
    this.worker.trigger();
    return { rejected: true };
  }

  // §2.4: the organization's exhausted revocations, so an administrator can
  // retry or dismiss them. No ciphertext or Canva IDs.
  async listExhaustedRevocations(
    user: AuthenticatedPrincipal,
  ): Promise<CanvaExhaustedRevocation[]> {
    this.realConfig(user);
    const rows = await this.guarded(() =>
      this.revocations.listExhausted(user.organizationId),
    );
    return rows.map((row) => ({
      id: row.id,
      reason: row.reason,
      attempts: row.attempts,
      lastErrorKind: row.lastErrorKind,
      createdAt: row.createdAt.toISOString(),
      exhaustedAt: row.exhaustedAt.toISOString(),
    }));
  }

  // §2.4: an administrator retries or dismisses an exhausted revocation.
  async retryRevocation(user: AuthenticatedPrincipal, id: string) {
    this.realConfig(user);
    if (!ENTITY_ID_PATTERN.test(id))
      throw new NotFoundException('Revocation not found');
    const retried = await this.guarded(() =>
      this.revocations.retryExhausted(user.organizationId, id, user.id),
    );
    if (!retried) throw new NotFoundException('Revocation not found');
    this.worker.trigger();
    return { state: 'queued' as const };
  }

  async dismissRevocation(user: AuthenticatedPrincipal, id: string) {
    this.realConfig(user);
    if (!ENTITY_ID_PATTERN.test(id))
      throw new NotFoundException('Revocation not found');
    const dismissed = await this.guarded(() =>
      this.revocations.dismissExhausted(user.organizationId, id, user.id),
    );
    if (!dismissed) throw new NotFoundException('Revocation not found');
    return { state: 'finished' as const, outcome: 'dismissed' as const };
  }
}
