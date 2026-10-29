import { createHash, randomBytes } from 'node:crypto';
import { CANVA_OAUTH_ENDPOINTS } from './canva-oauth.config';

// 32 random bytes as base64url: 43 characters, 256 bits of entropy.
export const OAUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function createOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

// RFC 7636: 43-128 characters from the unreserved set. 64 random bytes as
// base64url gives 86 characters.
export function createCodeVerifier(): string {
  return randomBytes(64).toString('base64url');
}

// S256 code challenge: BASE64URL(SHA256(ASCII(code_verifier))).
export function codeChallengeFor(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
}

// Only this hash is stored, so a leaked state table cannot be replayed.
export function hashOAuthState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

export function buildAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  codeChallenge: string;
  // Canva's authorize page unless a checked gate override is wired.
  endpoint?: string;
}): string {
  const url = new URL(input.endpoint ?? CANVA_OAUTH_ENDPOINTS.authorize);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('scope', input.scopes.join(' '));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('state', input.state);
  url.searchParams.set('redirect_uri', input.redirectUri);
  return url.toString();
}
