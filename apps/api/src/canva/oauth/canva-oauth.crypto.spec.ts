import { describe, expect, it } from 'vitest';
import {
  OAUTH_STATE_PATTERN,
  buildAuthorizationUrl,
  codeChallengeFor,
  createCodeVerifier,
  createOAuthState,
  hashOAuthState,
} from './canva-oauth.crypto';

describe('OAuth state', () => {
  it('is 43 base64url characters (256 bits) and unique per call', () => {
    const states = new Set(Array.from({ length: 50 }, createOAuthState));
    expect(states.size).toBe(50);
    for (const state of states) expect(state).toMatch(OAUTH_STATE_PATTERN);
  });

  it('is stored only as a SHA-256 hash', () => {
    const state = createOAuthState();
    const hash = hashOAuthState(state);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(state);
    expect(hashOAuthState(state)).toBe(hash);
  });
});

describe('PKCE', () => {
  it('creates RFC 7636 verifiers: 43-128 unreserved characters, unique per call', () => {
    const verifiers = new Set(Array.from({ length: 50 }, createCodeVerifier));
    expect(verifiers.size).toBe(50);
    for (const verifier of verifiers) {
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(verifier.length).toBeLessThanOrEqual(128);
      expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    }
  });

  it('derives the S256 challenge from the RFC 7636 Appendix B example', () => {
    expect(
      codeChallengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    ).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('buildAuthorizationUrl', () => {
  it('targets Canva with S256 PKCE, the exact redirect URI, and space-separated scopes', () => {
    const url = new URL(
      buildAuthorizationUrl({
        clientId: 'OC-test-client-id',
        redirectUri:
          'http://127.0.0.1:3000/api/v1/integrations/canva/oauth/callback',
        scopes: ['brandtemplate:meta:read', 'design:content:write'],
        state: 'state-value',
        codeChallenge: 'challenge-value',
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://www.canva.com/api/oauth/authorize',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      code_challenge: 'challenge-value',
      code_challenge_method: 'S256',
      scope: 'brandtemplate:meta:read design:content:write',
      response_type: 'code',
      client_id: 'OC-test-client-id',
      state: 'state-value',
      redirect_uri:
        'http://127.0.0.1:3000/api/v1/integrations/canva/oauth/callback',
    });
  });

  it('never includes the code verifier or a client secret', () => {
    const verifier = createCodeVerifier();
    const url = buildAuthorizationUrl({
      clientId: 'OC-test-client-id',
      redirectUri:
        'https://adflow.example/api/v1/integrations/canva/oauth/callback',
      scopes: ['design:content:write'],
      state: createOAuthState(),
      codeChallenge: codeChallengeFor(verifier),
    });
    expect(url).not.toContain(verifier);
    expect(url).not.toMatch(/client_secret|code_verifier/);
  });
});
