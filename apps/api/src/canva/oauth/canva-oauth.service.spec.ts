import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedPrincipal } from '../../auth/auth.types';
import { PERMISSIONS } from '../../auth/permissions';
import type { CanvaOAuthConfig } from './canva-oauth.config';
import { codeChallengeFor } from './canva-oauth.crypto';
import { CanvaOAuthService } from './canva-oauth.service';
import { CanvaIdentityError } from './canva-identity.client';
import type {
  CanvaCapabilitiesClient,
  CanvaProfileClient,
} from './canva-account.clients';
import type { CanvaIdentityClient } from './canva-identity.client';
import type { CanvaRevocationWorker } from './canva-revocation.worker';
import {
  CANVA_MAX_OPEN_ATTEMPTS,
  UnavailableCanvaCredentialStore,
  UnavailableCanvaOAuthAttemptStore,
  UnavailableCanvaRevocationQueue,
} from './canva-oauth.stores';
import {
  MemoryAttemptStore,
  MemoryCanvaDatabase,
  MemoryCredentialStore,
  MemoryRevocationQueue,
  testAdmin,
  testRealConfig,
  testRedirectUri,
  tokenSet,
} from './canva-oauth.test-doubles';
import { sealContext } from './canva-token-cipher';
import { CanvaTokenClient, CanvaTokenError } from './canva-token.client';

// Mocked stores and Canva clients: these tests check the service's
// decisions and what it stores, queues, or discards. They are not evidence
// of PostgreSQL behavior (see the gates in the persistence proposal).

const sha256 = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex');

function setup(
  options: {
    config?: CanvaOAuthConfig;
    db?: MemoryCanvaDatabase;
    unavailable?: boolean;
    authorized?: boolean;
    authorizeEndpoint?: string;
  } = {},
) {
  const config = options.config ?? testRealConfig({ persistence: true });
  const db = options.db ?? new MemoryCanvaDatabase();
  const attempts = options.unavailable
    ? new UnavailableCanvaOAuthAttemptStore()
    : new MemoryAttemptStore(db);
  const credentials = new MemoryCredentialStore(db);
  const queue = new MemoryRevocationQueue(db);
  const tokens = {
    exchangeAuthorizationCode: vi.fn(async () => tokenSet()),
    revoke: vi.fn(),
  };
  const principals = {
    stillAuthorized: vi.fn(async () => options.authorized ?? true),
  };
  const identity = {
    currentUser: vi.fn(async () => ({
      canvaUserId: 'canva-user-1',
      canvaTeamId: 'canva-team-1',
    })),
  };
  const profiles = { displayName: vi.fn(async () => 'Brand Studio') };
  const capabilities = {
    capabilities: vi.fn(async () => ({ autofill: true, brandTemplate: true })),
  };
  const worker = { trigger: vi.fn() };
  const service = new CanvaOAuthService(
    config,
    attempts,
    options.unavailable ? new UnavailableCanvaCredentialStore() : credentials,
    options.unavailable ? new UnavailableCanvaRevocationQueue() : queue,
    tokens as unknown as CanvaTokenClient,
    principals,
    () => db.now(),
    identity as unknown as CanvaIdentityClient,
    profiles as unknown as CanvaProfileClient,
    capabilities as unknown as CanvaCapabilitiesClient,
    worker as unknown as CanvaRevocationWorker,
    options.authorizeEndpoint,
  );

  // Start, launch, and return what the browser holds afterwards.
  async function launched(user: AuthenticatedPrincipal = testAdmin) {
    const started = await service.beginAuthorization(user);
    const result = await service.launch({ launch_token: started.launchToken });
    const location = new URL(result.location);
    return {
      started,
      location,
      state: location.searchParams.get('state') ?? '',
      binding: result.bindingCookie ?? '',
    };
  }

  // A full callback with the browser's cookie.
  async function callback(
    flow: { state: string; binding: string },
    query: Record<string, string> = { code: 'auth-code' },
  ) {
    const url = await service.completeAuthorization(
      { state: flow.state, ...query },
      flow.binding,
    );
    return new URL(url).searchParams.get('canva');
  }

  return {
    service,
    db,
    attempts,
    credentials,
    queue,
    tokens,
    principals,
    identity,
    profiles,
    capabilities,
    worker,
    launched,
    callback,
    config,
  };
}

const manager = testAdmin;
const reader: AuthenticatedPrincipal = {
  ...testAdmin,
  permissions: [PERMISSIONS.CANVA_INTEGRATION_READ],
};

describe('CanvaOAuthService: start and launch (§2.1, §5.1, §5.2)', () => {
  it('requires the integration-management permission', async () => {
    const { service, attempts } = setup();
    await expect(service.beginAuthorization(reader)).rejects.toThrow(
      ForbiddenException,
    );
    expect(attempts.create).not.toHaveBeenCalled();
  });

  it('refuses in mock mode', async () => {
    const { service } = setup({
      config: { mode: 'mock', webOrigin: 'http://localhost:5173' },
    });
    await expect(service.beginAuthorization(manager)).rejects.toThrow(
      new ConflictException(
        'Canva OAuth is disabled while the mock provider is active',
      ),
    );
  });

  it('fails closed with 503 while durable storage is not enabled', async () => {
    const { service } = setup({ unavailable: true });
    await expect(service.beginAuthorization(manager)).rejects.toThrow(
      new ServiceUnavailableException(
        'Real Canva connection is not available yet',
      ),
    );
  });

  it('stores only the hash of the one-time launch token, with ownership from the principal', async () => {
    const { service, attempts, db } = setup();
    const started = await service.beginAuthorization(manager);
    expect(started.launchUrl).toBe(
      'http://127.0.0.1:3000/api/v1/integrations/canva/oauth/launch',
    );
    expect(started.launchToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(attempts.create).toHaveBeenCalledWith({
      organizationId: 'org-1',
      userId: 'user-1',
      sessionId: 'session-1',
      launchTokenHash: sha256(started.launchToken),
      redirectUri: testRedirectUri,
    });
    expect(JSON.stringify([...db.attempts.values()])).not.toContain(
      started.launchToken,
    );
  });

  it('answers 429 when too many attempts are open', async () => {
    const { service } = setup();
    for (let index = 0; index < CANVA_MAX_OPEN_ATTEMPTS; index += 1)
      await service.beginAuthorization(manager);
    const error = await service
      .beginAuthorization(manager)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
  });

  it('launches once: builds the Canva URL with S256 PKCE and sets a binding value', async () => {
    const { service, db, launched } = setup();
    const flow = await launched();
    expect(flow.location.origin + flow.location.pathname).toBe(
      'https://www.canva.com/api/oauth/authorize',
    );
    expect(flow.location.searchParams.get('code_challenge_method')).toBe(
      'S256',
    );
    expect(flow.location.searchParams.get('redirect_uri')).toBe(
      testRedirectUri,
    );
    expect(flow.location.searchParams.get('scope')).toBe(
      'brandtemplate:meta:read brandtemplate:content:read design:content:write profile:read',
    );
    expect(flow.binding).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [attempt] = [...db.attempts.values()];
    // Only hashes and the sealed verifier are stored.
    expect(attempt.browserBindingHash).toBe(sha256(flow.binding));
    expect(JSON.stringify(attempt)).not.toContain(flow.state);
    const verifier = testRealConfig().keyring.open(
      attempt.codeVerifier!,
      sealContext.codeVerifier('org-1'),
    );
    expect(flow.location.searchParams.get('code_challenge')).toBe(
      codeChallengeFor(verifier),
    );
    // The launch token is single-use.
    const again = await service.launch({
      launch_token: flow.started.launchToken,
    });
    expect(again).toEqual({
      location:
        'http://localhost:5173/?canva=expired_or_used#canva-integration',
    });
  });

  it('refuses an expired or malformed launch token without a cookie', async () => {
    const { service, db } = setup();
    const started = await service.beginAuthorization(manager);
    db.advance(61_000);
    await expect(
      service.launch({ launch_token: started.launchToken }),
    ).resolves.toEqual({
      location:
        'http://localhost:5173/?canva=expired_or_used#canva-integration',
    });
    await expect(service.launch({ launch_token: 'short' })).resolves.toEqual({
      location:
        'http://localhost:5173/?canva=invalid_request#canva-integration',
    });
  });
});

describe('CanvaOAuthService: callback (§5.3, §5.4)', () => {
  it('stores a pending candidate, never an active credential', async () => {
    const { db, launched, callback, profiles, capabilities } = setup();
    const flow = await launched();
    await expect(callback(flow)).resolves.toBe('pending_confirmation');
    expect(db.credentials.size).toBe(0);
    const candidate = db.candidates.get('org-1')!;
    expect(candidate).toMatchObject({
      canvaUserId: 'canva-user-1',
      canvaDisplayName: 'Brand Studio',
      capabilities: { autofill: true, brandTemplate: true },
      userId: 'user-1',
      sessionId: 'session-1',
    });
    expect(db.accounts.get('canva-user-1')).toBe('org-1');
    expect(profiles.displayName).toHaveBeenCalledWith('test-access-token');
    expect(capabilities.capabilities).toHaveBeenCalledWith('test-access-token');
    // Tokens are sealed for this organization; nothing is queued.
    expect(
      testRealConfig().keyring.open(
        candidate.refreshToken,
        sealContext.refreshToken('org-1'),
      ),
    ).toBe('test-refresh-token');
    expect(db.queue).toHaveLength(0);
  });

  it('needs the binding cookie; a leaked state alone cannot burn the attempt', async () => {
    const { launched, callback, tokens } = setup();
    const flow = await launched();
    await expect(callback({ ...flow, binding: '' })).resolves.toBe(
      'expired_or_used',
    );
    await expect(callback({ ...flow, binding: 'B'.repeat(43) })).resolves.toBe(
      'expired_or_used',
    );
    expect(tokens.exchangeAuthorizationCode).not.toHaveBeenCalled();
    // The owner's browser still succeeds.
    await expect(callback(flow)).resolves.toBe('pending_confirmation');
  });

  it('consumes the state once; a replay is expired_or_used', async () => {
    const { launched, callback, tokens } = setup();
    const flow = await launched();
    await callback(flow);
    await expect(callback(flow)).resolves.toBe('expired_or_used');
    expect(tokens.exchangeAuthorizationCode).toHaveBeenCalledTimes(1);
  });

  it('expires a launched state after 10 minutes of database time', async () => {
    const { db, launched, callback } = setup();
    const flow = await launched();
    db.advance(10 * 60_000);
    await expect(callback(flow)).resolves.toBe('expired_or_used');
  });

  it('burns the state on a Canva error response', async () => {
    const { launched, callback } = setup();
    const flow = await launched();
    await expect(callback(flow, { error: 'access_denied' })).resolves.toBe(
      'denied',
    );
    await expect(callback(flow)).resolves.toBe('expired_or_used');
  });

  it('re-checks the starting principal before exchanging the code', async () => {
    const { launched, callback, tokens } = setup({ authorized: false });
    const flow = await launched();
    await expect(callback(flow)).resolves.toBe('not_authorized');
    expect(tokens.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it('discards the tokens, never queuing them, when the identity is unknown', async () => {
    const { launched, callback, identity, db } = setup();
    identity.currentUser.mockRejectedValueOnce(
      new CanvaIdentityError('transient', 503),
    );
    const flow = await launched();
    await expect(callback(flow)).resolves.toBe('unavailable');
    expect(db.queue).toHaveLength(0);
    expect(db.candidates.size).toBe(0);
  });

  it('queues the tokens under the guard when capabilities cannot be read', async () => {
    const { launched, callback, capabilities, db, worker } = setup();
    capabilities.capabilities.mockRejectedValueOnce(
      new CanvaIdentityError('unauthorized', 403),
    );
    const flow = await launched();
    await expect(callback(flow)).resolves.toBe('failed');
    expect(db.queue).toMatchObject([
      { reason: 'connect_failed', canvaUserId: 'canva-user-1' },
    ]);
    expect(worker.trigger).toHaveBeenCalledWith('canva-user-1');
    expect(db.candidates.size).toBe(0);
  });

  it('refuses an account without both capabilities and queues its tokens', async () => {
    const { launched, callback, capabilities, db } = setup();
    capabilities.capabilities.mockResolvedValueOnce({
      autofill: false,
      brandTemplate: true,
    });
    const flow = await launched();
    await expect(callback(flow)).resolves.toBe('account_ineligible');
    expect(db.queue).toMatchObject([{ reason: 'connect_ineligible' }]);
    expect(db.candidates.size).toBe(0);
  });

  it('refuses reported granted scopes that miss a required scope', async () => {
    const { launched, callback, tokens, db } = setup();
    tokens.exchangeAuthorizationCode.mockResolvedValueOnce(
      tokenSet({ scopes: ['brandtemplate:meta:read'] }),
    );
    const flow = await launched();
    await expect(callback(flow)).resolves.toBe('insufficient_scope');
    expect(db.queue).toMatchObject([{ reason: 'connect_ineligible' }]);
  });

  it('accepts unreported scopes and a missing display name as warnings', async () => {
    const { launched, callback, tokens, profiles, service } = setup();
    tokens.exchangeAuthorizationCode.mockResolvedValueOnce(
      tokenSet({ scopes: [] }),
    );
    profiles.displayName.mockRejectedValueOnce(
      new CanvaIdentityError('unauthorized', 403),
    );
    const flow = await launched();
    await expect(callback(flow)).resolves.toBe('pending_confirmation');
    await expect(service.getCandidate(manager)).resolves.toMatchObject({
      canvaDisplayName: null,
      scopes: { reported: false, granted: [] },
      warnings: ['missingDisplayName', 'scopesNotReported'],
    });
  });

  it('discards the tokens when the Canva user is held by another organization', async () => {
    const { launched, callback, db } = setup();
    db.accounts.set('canva-user-1', 'org-2');
    const flow = await launched();
    await expect(callback(flow)).resolves.toBe('account_unavailable');
    expect(db.queue).toHaveLength(0);
    expect(db.candidates.size).toBe(0);
  });

  it('queues the new tokens when another candidate is pending in the organization', async () => {
    const { launched, callback, db, identity } = setup();
    await callback(await launched());
    identity.currentUser.mockResolvedValueOnce({
      canvaUserId: 'canva-user-2',
      canvaTeamId: 'canva-team-1',
    });
    await expect(callback(await launched())).resolves.toBe('conflict');
    expect(db.queue).toMatchObject([
      { reason: 'connect_conflict', canvaUserId: 'canva-user-2' },
    ]);
  });

  it('discards the tokens and asks for a retry while a revocation for the same user may still take effect', async () => {
    const { launched, callback, db, worker } = setup();
    const flow = await launched();
    db.enqueue({
      organizationId: 'org-9',
      chainId: 'chain-old',
      canvaUserId: 'canva-user-1',
      reason: 'disconnect',
      refreshToken: { keyVersion: 1, iv: 'i', ciphertext: 'c', tag: 't' },
    });
    db.queue[0].state = 'in_flight';
    await expect(callback(flow)).resolves.toBe('retry_connect');
    expect(db.candidates.size).toBe(0);
    // Not queued: if the revocation reaches it, it is already dead; if not,
    // revoking it would end the user's consent.
    expect(db.queue).toHaveLength(1);
    expect(worker.trigger).toHaveBeenCalledWith('canva-user-1');
  });

  it('queues the tokens after a definite storage failure', async () => {
    const { launched, callback, credentials, db } = setup();
    credentials.nextCandidateFault = 'definite';
    await expect(callback(await launched())).resolves.toBe('failed');
    expect(db.queue).toMatchObject([{ reason: 'connect_failed' }]);
  });

  it('treats an ambiguous save that committed as pending confirmation', async () => {
    const { launched, callback, credentials, db } = setup();
    credentials.nextCandidateFault = 'committed_unknown';
    await expect(callback(await launched())).resolves.toBe(
      'pending_confirmation',
    );
    expect(db.candidates.size).toBe(1);
    expect(db.queue).toHaveLength(0);
  });

  it('queues the tokens after an ambiguous save that verifiably did not commit', async () => {
    const { launched, callback, credentials, db } = setup();
    credentials.nextCandidateFault = 'uncommitted_unknown';
    await expect(callback(await launched())).resolves.toBe('failed');
    expect(db.queue).toMatchObject([{ reason: 'connect_failed' }]);
  });

  it('discards the tokens when an ambiguous save cannot be verified', async () => {
    const { launched, callback, credentials, db } = setup();
    credentials.nextCandidateFault = 'uncommitted_unknown';
    credentials.failNextCandidateCheck = true;
    await expect(callback(await launched())).resolves.toBe('failed');
    expect(db.queue).toHaveLength(0);
  });

  it('discards the tokens when they cannot be queued', async () => {
    const { launched, callback, credentials, capabilities, db } = setup();
    capabilities.capabilities.mockRejectedValueOnce(
      new CanvaIdentityError('rejected', 400),
    );
    credentials.failNextEnqueue = true;
    await expect(callback(await launched())).resolves.toBe('failed');
    expect(db.queue).toHaveLength(0);
  });

  it('never calls revoke from the callback', async () => {
    const { launched, callback, tokens, capabilities } = setup();
    capabilities.capabilities.mockRejectedValueOnce(
      new CanvaIdentityError('rejected', 400),
    );
    await callback(await launched());
    expect(tokens.revoke).not.toHaveBeenCalled();
  });

  it('reports a failed code exchange as failed without storing anything', async () => {
    const { launched, callback, tokens, db } = setup();
    tokens.exchangeAuthorizationCode.mockRejectedValueOnce(
      new CanvaTokenError('invalid_grant', 400),
    );
    await expect(callback(await launched())).resolves.toBe('failed');
    expect(db.candidates.size).toBe(0);
    expect(db.queue).toHaveLength(0);
  });

  it('answers disabled in mock mode and ignores redirect parameters', async () => {
    const { service } = setup({
      config: { mode: 'mock', webOrigin: 'http://localhost:5173' },
    });
    await expect(
      service.completeAuthorization(
        { state: 'A'.repeat(43), code: 'x', redirect: 'https://evil.example' },
        'B'.repeat(43),
      ),
    ).resolves.toBe('http://localhost:5173/?canva=disabled#canva-integration');
  });
});

describe('CanvaOAuthService: confirmation (§2.3, §5.5, §5.6)', () => {
  async function pending(context = setup()) {
    await context.callback(await context.launched());
    const candidate = await context.service.getCandidate(manager);
    return { ...context, candidate };
  }

  it('shows the candidate only to the same administrator and session', async () => {
    const { service, candidate } = await pending();
    expect(candidate).toMatchObject({
      canvaDisplayName: 'Brand Studio',
      // Shortened: enough to tell accounts apart, not the full opaque ID.
      canvaUserId: '…user-1',
      capabilities: { autofill: true, brandTemplate: true },
      scopes: { reported: true, missing: [] },
      warnings: [],
    });
    await expect(
      service.getCandidate({ ...manager, sessionId: 'session-2' }),
    ).rejects.toThrow(NotFoundException);
    await expect(
      service.getCandidate({ ...manager, id: 'user-2' }),
    ).rejects.toThrow(NotFoundException);
    await expect(service.getCandidate(reader)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('activates the candidate for the same administrator and session', async () => {
    const { service, db, candidate, worker } = await pending();
    await expect(
      service.confirmCandidate(manager, { candidateId: candidate.id }),
    ).resolves.toEqual({
      status: 'CONNECTED',
      replacedPrevious: false,
      sameCanvaUser: false,
    });
    expect(db.credentials.get('org-1')?.canvaUserId).toBe('canva-user-1');
    expect(db.candidates.size).toBe(0);
    expect(db.actions()).toContain('canva.connection.connected');
    expect(worker.trigger).toHaveBeenCalled();
  });

  it('refuses another session or user', async () => {
    const { service, candidate } = await pending();
    await expect(
      service.confirmCandidate(
        { ...manager, sessionId: 'session-2' },
        { candidateId: candidate.id },
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('requires an acknowledgement for each warning and keeps the candidate otherwise', async () => {
    const context = setup();
    context.profiles.displayName.mockResolvedValueOnce(null as never);
    const { service, db, candidate } = await pending(context);
    expect(candidate.warnings).toEqual(['missingDisplayName']);
    await expect(
      service.confirmCandidate(manager, { candidateId: candidate.id }),
    ).rejects.toThrow(BadRequestException);
    expect(db.candidates.size).toBe(1);
    await expect(
      service.confirmCandidate(manager, {
        candidateId: candidate.id,
        acknowledgements: { missingDisplayName: true },
      }),
    ).resolves.toMatchObject({ status: 'CONNECTED' });
  });

  it('rejects unknown fields in the confirmation', async () => {
    const { service, candidate } = await pending();
    await expect(
      service.confirmCandidate(manager, {
        candidateId: candidate.id,
        organizationId: 'org-2',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('warns about a different Canva account and queues the replaced grant', async () => {
    const context = setup();
    const { db } = context;
    db.seedCredential({
      organizationId: 'org-1',
      connectedById: 'user-1',
      accessToken: { keyVersion: 1, iv: 'a', ciphertext: 'b', tag: 'c' },
      refreshToken: { keyVersion: 1, iv: 'd', ciphertext: 'e', tag: 'f' },
      accessTokenExpiresAt: db.now(),
      scopes: [],
      canvaUserId: 'canva-user-0',
      canvaTeamId: 'canva-team-1',
      chainId: 'chain-old',
      writeId: 'write-old',
    });
    const { service, candidate } = await pending(context);
    expect(candidate.warnings).toEqual(['differentAccount']);
    await expect(
      service.confirmCandidate(manager, {
        candidateId: candidate.id,
        acknowledgements: { differentAccount: true },
      }),
    ).resolves.toEqual({
      status: 'CONNECTED',
      replacedPrevious: true,
      sameCanvaUser: false,
    });
    expect(db.queue).toMatchObject([
      { reason: 'replaced_other_user', canvaUserId: 'canva-user-0' },
    ]);
    expect(db.accounts.get('canva-user-0')).toBeNull();
  });

  it('discards the replaced grant of a same-user reconnect', async () => {
    const context = setup();
    context.db.seedCredential({
      organizationId: 'org-1',
      connectedById: 'user-1',
      accessToken: { keyVersion: 1, iv: 'a', ciphertext: 'b', tag: 'c' },
      refreshToken: { keyVersion: 1, iv: 'd', ciphertext: 'e', tag: 'f' },
      accessTokenExpiresAt: context.db.now(),
      scopes: [],
      canvaUserId: 'canva-user-1',
      canvaTeamId: 'canva-team-1',
      chainId: 'chain-old',
      writeId: 'write-old',
    });
    const { service, db, candidate } = await pending(context);
    await expect(
      service.confirmCandidate(manager, { candidateId: candidate.id }),
    ).resolves.toMatchObject({ sameCanvaUser: true, replacedPrevious: true });
    expect(db.queue).toHaveLength(0);
  });

  it('refuses a stale generation with 409 and queues the candidate tokens', async () => {
    const { service, db, candidate } = await pending();
    db.connection('org-1').connectionGeneration += 1;
    await expect(
      service.confirmCandidate(manager, { candidateId: candidate.id }),
    ).rejects.toThrow(ConflictException);
    expect(db.candidates.size).toBe(0);
    expect(db.queue).toMatchObject([{ reason: 'connect_conflict' }]);
  });

  it('expires an unconfirmed candidate after 10 minutes and queues its tokens', async () => {
    const { service, db, candidate } = await pending();
    db.advance(10 * 60_000);
    await expect(
      service.confirmCandidate(manager, { candidateId: candidate.id }),
    ).rejects.toThrow(NotFoundException);
    expect(db.queue).toMatchObject([{ reason: 'candidate_expired' }]);
    expect(db.accounts.get('canva-user-1')).toBeNull();
  });

  it('rejects a candidate, queues its tokens, and releases the hold', async () => {
    const { service, db, candidate } = await pending();
    await expect(
      service.rejectCandidate(manager, { candidateId: candidate.id }),
    ).resolves.toEqual({ rejected: true });
    expect(db.queue).toMatchObject([{ reason: 'candidate_rejected' }]);
    expect(db.accounts.get('canva-user-1')).toBeNull();
    await expect(
      service.rejectCandidate(manager, { candidateId: candidate.id }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('CanvaOAuthService: exhausted revocations (§2.4)', () => {
  function exhausted() {
    const context = setup();
    context.db.enqueue({
      organizationId: 'org-1',
      chainId: 'chain-x',
      canvaUserId: 'canva-user-1',
      reason: 'disconnect',
      refreshToken: { keyVersion: 1, iv: 'a', ciphertext: 'b', tag: 'c' },
    });
    Object.assign(context.db.queue[0], { state: 'exhausted', attempts: 8 });
    return context;
  }

  it('lets an administrator retry an exhausted revocation', async () => {
    const { service, db, worker } = exhausted();
    await expect(
      service.retryRevocation(manager, db.queue[0].id),
    ).resolves.toEqual({ state: 'queued' });
    expect(db.queue[0]).toMatchObject({ state: 'queued', attempts: 0 });
    expect(db.actions()).toContain('canva.connection.revocation_retried');
    expect(worker.trigger).toHaveBeenCalled();
  });

  it('lets an administrator dismiss it, clearing the ciphertext', async () => {
    const { service, db } = exhausted();
    await expect(
      service.dismissRevocation(manager, db.queue[0].id),
    ).resolves.toEqual({ state: 'finished', outcome: 'dismissed' });
    expect(db.queue[0].sealedCleared).toBe(true);
  });

  it('scopes the actions to the organization and permission', async () => {
    const { service, db } = exhausted();
    await expect(
      service.retryRevocation(
        { ...manager, organizationId: 'org-2' },
        db.queue[0].id,
      ),
    ).rejects.toThrow(NotFoundException);
    await expect(
      service.dismissRevocation(reader, db.queue[0].id),
    ).rejects.toThrow(ForbiddenException);
    await expect(service.retryRevocation(manager, '../x')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('CanvaOAuthService authorize endpoint (gate G override)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sends the browser to Canva unless a checked override is wired', async () => {
    const { launched } = setup();
    const { location } = await launched();
    expect(location.origin + location.pathname).toBe(
      'https://www.canva.com/api/oauth/authorize',
    );
  });

  it('uses a loopback override only in a gate run, keeping every OAuth parameter', async () => {
    vi.stubEnv('ADFLOW_PG_GATES', 'run');
    const { launched } = setup({
      authorizeEndpoint: 'http://127.0.0.1:45678/authorize',
    });
    const { location } = await launched();
    expect(location.origin + location.pathname).toBe(
      'http://127.0.0.1:45678/authorize',
    );
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('redirect_uri')).toBe(testRedirectUri);
  });

  it.each([
    ['outside a gate run', 'http://127.0.0.1:45678/authorize', {}],
    [
      'in a production process',
      'http://127.0.0.1:45678/authorize',
      { ADFLOW_PG_GATES: 'run', NODE_ENV: 'production' },
    ],
    [
      'a remote host',
      'https://evil.example/authorize',
      { ADFLOW_PG_GATES: 'run' },
    ],
    [
      'localhost',
      'http://localhost:45678/authorize',
      { ADFLOW_PG_GATES: 'run' },
    ],
    [
      'https on loopback',
      'https://127.0.0.1:45678/authorize',
      { ADFLOW_PG_GATES: 'run' },
    ],
    [
      'a query string',
      'http://127.0.0.1:45678/authorize?x=1',
      { ADFLOW_PG_GATES: 'run' },
    ],
    ['a malformed value', 'not a url', { ADFLOW_PG_GATES: 'run' }],
  ])(
    'refuses to construct with an override %s',
    (_case, endpoint, environment) => {
      for (const [name, value] of Object.entries(environment))
        vi.stubEnv(name, value);
      expect(() => setup({ authorizeEndpoint: endpoint })).toThrow(
        /may only be overridden for a gate run/,
      );
    },
  );
});
