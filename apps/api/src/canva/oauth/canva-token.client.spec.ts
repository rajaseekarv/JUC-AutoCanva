import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseCanvaEnvironment,
  type CanvaOAuthConfig,
} from './canva-oauth.config';
import {
  CanvaTokenClient,
  CanvaTokenError,
  type CanvaFetch,
} from './canva-token.client';

// Test-only placeholders; none of these are real Canva credentials.
const clientSecret = 'test-only-client-secret-value';
const realConfig = parseCanvaEnvironment({
  CANVA_PROVIDER_MODE: 'canva',
  CANVA_CLIENT_ID: 'OC-test-client-id',
  CANVA_CLIENT_SECRET: clientSecret,
  CANVA_REDIRECT_URI:
    'http://127.0.0.1:3000/api/v1/integrations/canva/oauth/callback',
  CANVA_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
});

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const tokenBody = {
  access_token: 'test-access-token',
  refresh_token: 'test-refresh-token',
  token_type: 'Bearer',
  expires_in: 14_400,
  scope: 'brandtemplate:meta:read design:content:write',
};

function client(
  respond: () => Response | Promise<Response>,
  config: CanvaOAuthConfig = realConfig,
) {
  const fetchMock = vi.fn<CanvaFetch>(async () => respond());
  return { fetchMock, client: new CanvaTokenClient(config, fetchMock) };
}

describe('CanvaTokenClient', () => {
  // Any accidental use of the real network fails the test.
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Network access is not allowed in tests');
      }),
    );
  });
  afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('exchanges an authorization code with PKCE using Basic client authentication', async () => {
    const { fetchMock, client: tokens } = client(() =>
      jsonResponse(200, tokenBody),
    );
    await expect(
      tokens.exchangeAuthorizationCode('test-code', 'test-verifier'),
    ).resolves.toEqual({
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      expiresInSeconds: 14_400,
      scopes: ['brandtemplate:meta:read', 'design:content:write'],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.canva.com/rest/v1/oauth/token');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from(`OC-test-client-id:${clientSecret}`).toString('base64')}`,
    );
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      grant_type: 'authorization_code',
      code: 'test-code',
      code_verifier: 'test-verifier',
      redirect_uri:
        'http://127.0.0.1:3000/api/v1/integrations/canva/oauth/callback',
    });
    // The secret travels only in the Authorization header.
    expect(String(init.body)).not.toContain(clientSecret);
  });

  it('refreshes with the refresh-token grant', async () => {
    const { fetchMock, client: tokens } = client(() =>
      jsonResponse(200, { ...tokenBody, refresh_token: 'rotated-refresh' }),
    );
    await expect(tokens.refresh('old-refresh')).resolves.toMatchObject({
      refreshToken: 'rotated-refresh',
    });
    expect(
      Object.fromEntries(
        new URLSearchParams(String(fetchMock.mock.calls[0][1].body)),
      ),
    ).toEqual({ grant_type: 'refresh_token', refresh_token: 'old-refresh' });
  });

  it('revokes a token at the revocation endpoint', async () => {
    const { fetchMock, client: tokens } = client(() => jsonResponse(200, {}));
    await expect(tokens.revoke('old-refresh')).resolves.toEqual({
      kind: 'revoked',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.canva.com/rest/v1/oauth/revoke');
    expect(String(init.body)).toBe('token=old-refresh');
  });

  // The worker's policy depends on this classification (§2.4). revoke()
  // never throws, so no error path can become a different action.
  describe('revocation classification', () => {
    async function revoke(respond: () => Response | Promise<Response>) {
      const { client: tokens } = client(respond);
      return tokens.revoke('old-refresh');
    }

    it('reports an unusable token (400 bad_request_params) as not revocable', async () => {
      await expect(
        revoke(() => jsonResponse(400, { code: 'bad_request_params' })),
      ).resolves.toEqual({ kind: 'not_revocable' });
    });

    // The first two are Canva's documented revoke responses (code and
    // message fields): https://www.canva.dev/docs/connect/api-reference/authentication/revoke-token/
    it.each([
      [
        401,
        {
          code: 'invalid_access_token',
          message: 'Client secret is invalid for OC-test-client-id',
        },
      ],
      [
        401,
        { code: 'invalid_access_token', message: 'Access token is missing' },
      ],
      [401, { error: 'invalid_client' }],
      [400, { error: 'unauthorized_client' }],
    ])('reports a configuration rejection (%i %j)', async (status, body) => {
      await expect(revoke(() => jsonResponse(status, body))).resolves.toEqual({
        kind: 'configuration',
        status,
      });
    });

    it('does not treat invalid_access_token on another status as configuration', async () => {
      await expect(
        revoke(() => jsonResponse(400, { code: 'invalid_access_token' })),
      ).resolves.toEqual({ kind: 'rejected', status: 400 });
    });

    it('keeps an unrecognized 401 as an ordinary rejection', async () => {
      await expect(
        revoke(() => jsonResponse(401, { code: 'something_else' })),
      ).resolves.toEqual({ kind: 'rejected', status: 401 });
    });

    it('reports 429 with its Retry-After', async () => {
      await expect(
        revoke(
          () =>
            new Response(null, {
              status: 429,
              headers: { 'retry-after': '30' },
            }),
        ),
      ).resolves.toEqual({ kind: 'rate_limited', retryAfterSeconds: 30 });
    });

    it('reports another 4xx as rejected', async () => {
      await expect(
        revoke(() => jsonResponse(403, { error: 'forbidden' })),
      ).resolves.toEqual({ kind: 'rejected', status: 403 });
    });

    it.each([500, 503, 408])(
      'reports HTTP %i as an unknown outcome',
      async (status) => {
        await expect(
          revoke(() => new Response(null, { status })),
        ).resolves.toEqual({ kind: 'unknown', status });
      },
    );

    it('reports a network failure or timeout as an unknown outcome', async () => {
      await expect(
        revoke(() => Promise.reject(new Error('socket hang up'))),
      ).resolves.toEqual({ kind: 'unknown' });
    });
  });

  describe('error classification', () => {
    async function failure(respond: () => Response | Promise<Response>) {
      const { client: tokens } = client(respond);
      return tokens.refresh('old-refresh').catch((cause: unknown) => cause);
    }

    it.each([400, 401])(
      'treats invalid_grant (HTTP %i) as the only permanent credential failure',
      async (status) => {
        const error = await failure(() =>
          jsonResponse(status, { error: 'invalid_grant' }),
        );
        expect(error).toBeInstanceOf(CanvaTokenError);
        expect(error).toMatchObject({
          kind: 'invalid_grant',
          status,
          retryable: false,
          outcomeUnknown: false,
        });
      },
    );

    it.each([
      ['invalid_client', 401],
      ['invalid_request', 400],
      ['unauthorized_client', 400],
    ])(
      'treats %s as a non-retryable configuration rejection, not a dead credential',
      async (code, status) => {
        expect(
          await failure(() => jsonResponse(status, { error: code })),
        ).toMatchObject({ kind: 'rejected', status, retryable: false });
      },
    );

    it('treats a 4xx without a readable OAuth error as a rejection', async () => {
      expect(
        await failure(() => new Response('<html>bad', { status: 400 })),
      ).toMatchObject({ kind: 'rejected', status: 400 });
    });

    it.each([408, 425, 429, 500, 502, 503, 504])(
      'treats HTTP %i as transient and retryable',
      async (status) => {
        expect(
          await failure(() => jsonResponse(status, { error: 'invalid_grant' })),
        ).toMatchObject({
          kind: 'transient',
          status,
          retryable: true,
          outcomeUnknown: false,
        });
      },
    );

    it('passes on a bounded Retry-After hint and ignores invalid ones', async () => {
      expect(
        await failure(
          () =>
            new Response(null, {
              status: 429,
              headers: { 'Retry-After': '30' },
            }),
        ),
      ).toMatchObject({ kind: 'transient', retryAfterSeconds: 30 });
      expect(
        await failure(
          () =>
            new Response(null, {
              status: 503,
              headers: { 'Retry-After': '99999' },
            }),
        ),
      ).toMatchObject({ kind: 'transient', retryAfterSeconds: undefined });
    });

    it.each([
      ['a connection failure', new TypeError('fetch failed: secret detail')],
      ['a request timeout', new DOMException('timed out', 'TimeoutError')],
    ])(
      'treats %s as retryable with an unknown outcome',
      async (_case, cause) => {
        const error = await failure(() => {
          throw cause;
        });
        expect(error).toMatchObject({
          kind: 'network',
          retryable: true,
          outcomeUnknown: true,
        });
        expect(String(error)).not.toContain('secret detail');
      },
    );

    it('treats a timeout while reading a 2xx body as an unknown outcome', async () => {
      const error = await failure(
        () =>
          ({
            ok: true,
            status: 200,
            headers: new Headers(),
            text: async () => {
              throw new DOMException('timed out', 'TimeoutError');
            },
          }) as unknown as Response,
      );
      expect(error).toMatchObject({ kind: 'network', outcomeUnknown: true });
    });

    it('never exposes response bodies, tokens, or credentials', async () => {
      const error = await failure(() =>
        jsonResponse(400, {
          error: 'invalid_grant',
          error_description: 'refresh token old-refresh is spent',
          echoed: clientSecret,
        }),
      );
      const rendered = JSON.stringify(error) + String(error);
      expect(rendered).not.toMatch(
        /old-refresh|spent|test-only-client-secret|error_description/,
      );
    });
  });

  it.each([
    ['missing a refresh token', { ...tokenBody, refresh_token: undefined }],
    ['a non-bearer token type', { ...tokenBody, token_type: 'mac' }],
    ['a non-positive lifetime', { ...tokenBody, expires_in: 0 }],
  ])(
    'treats a 2xx token response %s as an unknown outcome',
    async (_case, body) => {
      const { client: tokens } = client(() => jsonResponse(200, body));
      await expect(tokens.refresh('old-refresh')).rejects.toMatchObject({
        kind: 'invalid_response',
        outcomeUnknown: true,
      });
    },
  );

  it('treats a non-JSON 2xx token response as an unknown outcome', async () => {
    const { client: tokens } = client(
      () => new Response('<html>', { status: 200 }),
    );
    await expect(tokens.refresh('old-refresh')).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('refuses every call in mock mode without touching the network', async () => {
    const { fetchMock, client: tokens } = client(
      () => jsonResponse(200, tokenBody),
      { mode: 'mock', webOrigin: 'http://localhost:5173' },
    );
    await expect(
      tokens.exchangeAuthorizationCode('code', 'verifier'),
    ).rejects.toMatchObject({ kind: 'disabled' });
    await expect(tokens.refresh('token')).rejects.toMatchObject({
      kind: 'disabled',
    });
    // Never sent; reported as unknown (the worker never runs in mock mode).
    await expect(tokens.revoke('token')).resolves.toEqual({ kind: 'unknown' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
