import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  CANVA_OAUTH_CONFIG,
  type CanvaOAuthConfig,
} from './canva-oauth.config';
import { CANVA_FETCH, type CanvaFetch } from './canva-token.client';

// Documented at https://www.canva.dev/docs/connect/api-reference/users/users-me/:
// returns the user's and team's IDs and "requires no specific scopes".
export const CANVA_CURRENT_USER_ENDPOINT =
  'https://api.canva.com/rest/v1/users/me';

const REQUEST_TIMEOUT_MS = 10_000;

export type CanvaIdentity = { canvaUserId: string; canvaTeamId: string };

// How an identity request failed. Carries only a category, HTTP status, and
// retry hint: never the access token or a response body.
// - unauthorized: 401/403; the access token is not accepted.
// - transient: 408, 425, 429, or 5xx; try again later.
// - rejected: any other 4xx.
// - network / invalid_response: no usable answer.
export type CanvaIdentityErrorKind =
  | 'disabled'
  | 'unauthorized'
  | 'transient'
  | 'rejected'
  | 'network'
  | 'invalid_response';

const MESSAGES: Record<CanvaIdentityErrorKind, string> = {
  disabled: 'Canva OAuth is disabled in mock mode',
  unauthorized: 'Canva did not accept the access token',
  transient: 'Canva is temporarily unavailable',
  rejected: 'Canva rejected the identity request',
  network: 'Canva could not be reached',
  invalid_response: 'Canva returned an unexpected identity response',
};

export class CanvaIdentityError extends Error {
  constructor(
    readonly kind: CanvaIdentityErrorKind,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(status ? `${MESSAGES[kind]} (HTTP ${status})` : MESSAGES[kind]);
    this.name = 'CanvaIdentityError';
  }

  get retryable(): boolean {
    return (
      this.kind === 'transient' ||
      this.kind === 'network' ||
      this.kind === 'invalid_response'
    );
  }
}

// IDs are opaque; bound their size and character set so nothing unexpected
// is stored or used in uniqueness checks.
const canvaId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\w-]+$/);
const currentUserSchema = z.object({
  team_user: z.object({ user_id: canvaId, team_id: canvaId }),
});

const TRANSIENT_STATUSES = new Set([408, 425, 429]);

function retryAfterSeconds(response: Response): number | undefined {
  const value = Number(response.headers.get('retry-after'));
  return Number.isInteger(value) && value >= 0 && value <= 3_600
    ? value
    : undefined;
}

// A parsed 2xx body, kept with its status for error reporting.
export type CanvaUserJson = { status: number; body: unknown };

// GETs a Canva user endpoint with the access token and parses the JSON body.
// Shared by the identity, profile, and capabilities clients so they classify
// failures the same way. Server-side only: the token never leaves the API.
export async function getCanvaUserJson(
  config: CanvaOAuthConfig,
  fetchImpl: CanvaFetch,
  url: string,
  accessToken: string,
): Promise<CanvaUserJson> {
  if (config.mode !== 'canva') throw new CanvaIdentityError('disabled');
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new CanvaIdentityError('network');
  }
  const status = response.status;
  if (!response.ok) {
    if (status === 401 || status === 403)
      throw new CanvaIdentityError('unauthorized', status);
    if (status >= 500 || TRANSIENT_STATUSES.has(status))
      throw new CanvaIdentityError(
        'transient',
        status,
        retryAfterSeconds(response),
      );
    throw new CanvaIdentityError('rejected', status);
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new CanvaIdentityError('network', status);
  }
  try {
    return { status, body: JSON.parse(text) };
  } catch {
    throw new CanvaIdentityError('invalid_response', status);
  }
}

@Injectable()
export class CanvaIdentityClient {
  constructor(
    @Inject(CANVA_OAUTH_CONFIG) private readonly config: CanvaOAuthConfig,
    @Inject(CANVA_FETCH) private readonly fetchImpl: CanvaFetch,
  ) {}

  // Server-side only: the access token never leaves the API.
  async currentUser(accessToken: string): Promise<CanvaIdentity> {
    const { status, body } = await getCanvaUserJson(
      this.config,
      this.fetchImpl,
      CANVA_CURRENT_USER_ENDPOINT,
      accessToken,
    );
    const parsed = currentUserSchema.safeParse(body);
    if (!parsed.success)
      throw new CanvaIdentityError('invalid_response', status);
    return {
      canvaUserId: parsed.data.team_user.user_id,
      canvaTeamId: parsed.data.team_user.team_id,
    };
  }
}
