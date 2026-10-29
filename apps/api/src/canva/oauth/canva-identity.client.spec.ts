import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CANVA_CURRENT_USER_ENDPOINT,
  CanvaIdentityClient,
  CanvaIdentityError,
} from './canva-identity.client';
import { testRealConfig } from './canva-oauth.test-doubles';
import type { CanvaFetch } from './canva-token.client';

const accessToken = 'test-only-access-token-value';

function client(respond: () => Response | Promise<Response>) {
  const fetchMock = vi.fn<CanvaFetch>(async () => respond());
  return {
    fetchMock,
    identity: new CanvaIdentityClient(testRealConfig(), fetchMock),
  };
}

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

async function failure(respond: () => Response | Promise<Response>) {
  return client(respond)
    .identity.currentUser(accessToken)
    .catch((cause: unknown) => cause);
}

describe('CanvaIdentityClient', () => {
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

  it('reads the Canva user and team IDs from GET /v1/users/me with the bearer token', async () => {
    const { fetchMock, identity } = client(() =>
      json(200, {
        team_user: {
          user_id: 'oUnPjZ2k2yuhftbWF7873o',
          team_id: 'oBpVhLW22VrqtwKgaayRbP',
        },
      }),
    );
    await expect(identity.currentUser(accessToken)).resolves.toEqual({
      canvaUserId: 'oUnPjZ2k2yuhftbWF7873o',
      canvaTeamId: 'oBpVhLW22VrqtwKgaayRbP',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(CANVA_CURRENT_USER_ENDPOINT);
    expect(url).toBe('https://api.canva.com/rest/v1/users/me');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${accessToken}`,
    );
  });

  it.each([
    ['a missing team_user', { user: { id: 'u' } }],
    ['a missing team_id', { team_user: { user_id: 'oUnPjZ2k2yuhftbWF7873o' } }],
    ['an empty user_id', { team_user: { user_id: '', team_id: 't' } }],
    [
      'an ID with unexpected characters',
      { team_user: { user_id: 'a b<c>', team_id: 't' } },
    ],
    ['a non-string ID', { team_user: { user_id: 42, team_id: 't' } }],
  ])('rejects a response with %s', async (_case, body) => {
    expect(await failure(() => json(200, body))).toMatchObject({
      kind: 'invalid_response',
      retryable: true,
    });
  });

  it('rejects a non-JSON response', async () => {
    expect(
      await failure(() => new Response('<html>', { status: 200 })),
    ).toMatchObject({ kind: 'invalid_response' });
  });

  it.each([401, 403])(
    'reports HTTP %i as an authorization error, not retryable',
    async (status) => {
      expect(
        await failure(() => json(status, { code: 'invalid_access_token' })),
      ).toMatchObject({ kind: 'unauthorized', status, retryable: false });
    },
  );

  it('reports a rate limit as transient with a bounded Retry-After hint', async () => {
    expect(
      await failure(() =>
        json(429, { code: 'too_many_requests' }, { 'Retry-After': '12' }),
      ),
    ).toMatchObject({
      kind: 'transient',
      status: 429,
      retryAfterSeconds: 12,
      retryable: true,
    });
  });

  it.each([500, 502, 503, 504])(
    'reports HTTP %i as transient',
    async (status) => {
      expect(await failure(() => json(status, {}))).toMatchObject({
        kind: 'transient',
        status,
        retryable: true,
      });
    },
  );

  it('reports other 4xx responses as rejections', async () => {
    expect(await failure(() => json(404, { code: 'not_found' }))).toMatchObject(
      {
        kind: 'rejected',
        status: 404,
        retryable: false,
      },
    );
  });

  it('reports a connection failure or timeout as a network error', async () => {
    for (const cause of [
      new TypeError('fetch failed'),
      new DOMException('timed out', 'TimeoutError'),
    ])
      expect(
        await failure(() => {
          throw cause;
        }),
      ).toMatchObject({ kind: 'network', retryable: true });
  });

  it('never includes the access token or a response body in its errors', async () => {
    const error = await failure(() =>
      json(401, { code: 'invalid_access_token', message: accessToken }),
    );
    expect(error).toBeInstanceOf(CanvaIdentityError);
    expect(JSON.stringify(error) + String(error)).not.toMatch(
      /test-only-access-token|invalid_access_token/,
    );
  });

  it('refuses to run in mock mode without touching the network', async () => {
    const fetchMock = vi.fn<CanvaFetch>();
    const identity = new CanvaIdentityClient(
      { mode: 'mock', webOrigin: 'http://localhost:5173' },
      fetchMock,
    );
    await expect(identity.currentUser(accessToken)).rejects.toMatchObject({
      kind: 'disabled',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
