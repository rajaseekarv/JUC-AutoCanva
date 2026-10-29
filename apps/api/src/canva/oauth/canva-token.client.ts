import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  CANVA_OAUTH_CONFIG,
  CANVA_OAUTH_ENDPOINTS,
  type CanvaOAuthConfig,
} from './canva-oauth.config';
import type { CanvaRevokeResult } from './canva-revocation';

// The network call is injected so tests never reach Canva. Production wires
// the global fetch; nothing invokes it unless real mode is configured and an
// authorization has been durably recorded.
export type CanvaFetch = (url: string, init: RequestInit) => Promise<Response>;
export const CANVA_FETCH = Symbol('CANVA_FETCH');

const REQUEST_TIMEOUT_MS = 10_000;

export type CanvaTokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scopes: string[];
};

// How a token request failed, from the caller's point of view:
// - invalid_grant: Canva confirmed the code or refresh token is no longer
//   valid. The only permanent credential failure; reconnection is required.
// - rejected: any other 4xx (for example invalid_client or invalid_request).
//   A configuration or request problem, not a dead credential; not retried.
// - transient: 408, 425, 429, or 5xx. Canva did not process the grant; retry
//   later with the same stored token.
// - network / invalid_response: no usable answer (connection failure, timeout,
//   or an unreadable 2xx). Canva may or may not have processed the request,
//   so for a refresh the outcome is unknown: retrying with the same token is
//   the only option, and if that retry returns invalid_grant the earlier
//   attempt probably rotated the token and the rotation was lost.
export type CanvaTokenErrorKind =
  | 'disabled'
  | 'invalid_grant'
  | 'rejected'
  | 'transient'
  | 'network'
  | 'invalid_response';

const MESSAGES: Record<CanvaTokenErrorKind, string> = {
  disabled: 'Canva OAuth is disabled in mock mode',
  invalid_grant: 'Canva no longer accepts this authorization',
  rejected: 'Canva rejected the token request',
  transient: 'Canva is temporarily unavailable',
  network: 'Canva token endpoint could not be reached',
  invalid_response: 'Canva returned an unexpected token response',
};

// Carries only a category, HTTP status, and retry hint: never a response
// body, token, authorization code, or client credential.
export class CanvaTokenError extends Error {
  constructor(
    readonly kind: CanvaTokenErrorKind,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(status ? `${MESSAGES[kind]} (HTTP ${status})` : MESSAGES[kind]);
    this.name = 'CanvaTokenError';
  }

  // Safe to retry later with the same stored credential.
  get retryable(): boolean {
    return (
      this.kind === 'transient' ||
      this.kind === 'network' ||
      this.kind === 'invalid_response'
    );
  }

  // Canva may have processed the request without AdFlow seeing the result.
  get outcomeUnknown(): boolean {
    return this.kind === 'network' || this.kind === 'invalid_response';
  }
}

const MAX_ERROR_BODY_CHARS = 4_096;
const TRANSIENT_STATUSES = new Set([408, 425, 429]);

function retryAfterSeconds(response: Response): number | undefined {
  const value = Number(response.headers.get('retry-after'));
  return Number.isInteger(value) && value >= 0 && value <= 3_600
    ? value
    : undefined;
}

// Reads only the OAuth `error` code (or Canva's REST `code`) from a failed
// response. The body itself is discarded and never logged, since providers
// may echo request values.
async function oauthErrorCode(response: Response): Promise<string | null> {
  try {
    const text = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS);
    const body: unknown = JSON.parse(text);
    const fields =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)
        : {};
    const code = fields.error ?? fields.code;
    return typeof code === 'string' && /^[a-z_]{1,64}$/.test(code)
      ? code
      : null;
  } catch {
    return null;
  }
}

async function failureFor(response: Response): Promise<CanvaTokenError> {
  const status = response.status;
  if (status >= 500 || TRANSIENT_STATUSES.has(status))
    return new CanvaTokenError(
      'transient',
      status,
      retryAfterSeconds(response),
    );
  if (
    (status === 400 || status === 401) &&
    (await oauthErrorCode(response)) === 'invalid_grant'
  )
    return new CanvaTokenError('invalid_grant', status);
  return new CanvaTokenError('rejected', status);
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1).max(16_384),
  refresh_token: z.string().min(1).max(16_384),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().int().positive().max(31_536_000),
  scope: z.string().max(4_096).optional(),
});

@Injectable()
export class CanvaTokenClient {
  constructor(
    @Inject(CANVA_OAUTH_CONFIG) private readonly config: CanvaOAuthConfig,
    @Inject(CANVA_FETCH) private readonly fetchImpl: CanvaFetch,
  ) {}

  async exchangeAuthorizationCode(
    code: string,
    codeVerifier: string,
  ): Promise<CanvaTokenSet> {
    const config = this.realConfig();
    return this.requestTokens({
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      redirect_uri: config.redirectUri,
    });
  }

  // Canva rotates refresh tokens: the returned refresh token replaces the
  // one sent, which must not be used again.
  async refresh(refreshToken: string): Promise<CanvaTokenSet> {
    return this.requestTokens({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  }

  // Called only by the revocation worker, after its same-user guard (see
  // canva-revocation.ts). Never throws: every outcome is classified, and an
  // unreadable or missing answer is "unknown" because Canva may have
  // processed the request.
  async revoke(token: string): Promise<CanvaRevokeResult> {
    let response: Response;
    try {
      response = await this.post(CANVA_OAUTH_ENDPOINTS.revoke, { token });
    } catch {
      return { kind: 'unknown' };
    }
    const status = response.status;
    if (response.ok) {
      try {
        await response.text();
      } catch {
        return { kind: 'unknown', status };
      }
      return { kind: 'revoked' };
    }
    if (status === 429)
      return {
        kind: 'rate_limited',
        retryAfterSeconds: retryAfterSeconds(response),
      };
    if (status >= 500 || TRANSIENT_STATUSES.has(status))
      return { kind: 'unknown', status };
    const code = await oauthErrorCode(response);
    if (status === 400 && code === 'bad_request_params')
      return { kind: 'not_revocable' };
    // Client authentication failures. Canva's revoke reference documents
    // 401 invalid_access_token ("Client secret is invalid for …" and
    // "Access token is missing"; the token itself travels in the body, so
    // both concern the client credentials). invalid_client and
    // unauthorized_client are the RFC 6749 codes, kept as before although
    // the revoke reference does not list them.
    if (
      (status === 401 &&
        (code === 'invalid_access_token' || code === 'invalid_client')) ||
      (status === 400 && code === 'unauthorized_client')
    )
      return { kind: 'configuration', status };
    return { kind: 'rejected', status };
  }

  private realConfig() {
    if (this.config.mode !== 'canva') throw new CanvaTokenError('disabled');
    return this.config;
  }

  private async requestTokens(
    form: Record<string, string>,
  ): Promise<CanvaTokenSet> {
    const response = await this.post(CANVA_OAUTH_ENDPOINTS.token, form);
    if (!response.ok) throw await failureFor(response);
    // A 2xx means Canva processed the grant: from here on, a failure to read
    // the tokens leaves the outcome unknown rather than "not rotated".
    let text: string;
    try {
      text = await response.text();
    } catch {
      // The request timeout can also abort while the body is being read.
      throw new CanvaTokenError('network', response.status);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new CanvaTokenError('invalid_response', response.status);
    }
    const parsed = tokenResponseSchema.safeParse(body);
    if (!parsed.success)
      throw new CanvaTokenError('invalid_response', response.status);
    return {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      expiresInSeconds: parsed.data.expires_in,
      scopes: parsed.data.scope?.split(' ').filter(Boolean) ?? [],
    };
  }

  private async post(
    url: string,
    form: Record<string, string>,
  ): Promise<Response> {
    const config = this.realConfig();
    const credentials = Buffer.from(
      `${config.clientId}:${config.clientSecret.reveal()}`,
      'utf8',
    ).toString('base64');
    try {
      return await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams(form).toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new CanvaTokenError('network');
    }
  }
}
