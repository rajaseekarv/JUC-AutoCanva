import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CANVA_CAPABILITIES_ENDPOINT,
  CANVA_PROFILE_ENDPOINT,
  CanvaCapabilitiesClient,
  CanvaProfileClient,
  grantedScopeCheck,
  sanitizeDisplayName,
} from './canva-account.clients';
import { CanvaIdentityError } from './canva-identity.client';
import { CANVA_OAUTH_SCOPES } from './canva-oauth.config';
import { testRealConfig } from './canva-oauth.test-doubles';

// Injected fetch only; the global fetch throws, so nothing reaches Canva.
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

const json = (status: number, body: unknown, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function clients(respond: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    void url;
    void init;
    return respond();
  });
  const config = testRealConfig();
  return {
    fetchMock,
    profile: new CanvaProfileClient(config, fetchMock),
    capabilities: new CanvaCapabilitiesClient(config, fetchMock),
  };
}

describe('sanitizeDisplayName', () => {
  it('removes control characters and bidirectional overrides and isolates', () => {
    expect(sanitizeDisplayName('Brand\u0000 Studio‮⁦x\u0085')).toBe(
      'Brand Studiox',
    );
  });

  it('trims, caps at 256 characters, and maps empty results to null', () => {
    expect(sanitizeDisplayName('  Name  ')).toBe('Name');
    expect(sanitizeDisplayName('a'.repeat(300))).toHaveLength(256);
    expect(sanitizeDisplayName('   ')).toBeNull();
    expect(sanitizeDisplayName('‮')).toBeNull();
    expect(sanitizeDisplayName(42)).toBeNull();
    expect(sanitizeDisplayName(undefined)).toBeNull();
  });
});

describe('grantedScopeCheck', () => {
  it('accepts a complete report, including extra scopes and duplicates', () => {
    expect(
      grantedScopeCheck(
        [...CANVA_OAUTH_SCOPES, 'design:meta:read', 'profile:read'],
        CANVA_OAUTH_SCOPES,
      ),
    ).toEqual({ reported: true, missing: [] });
  });

  it('lists missing scopes from a reported set', () => {
    expect(grantedScopeCheck(['profile:read'], CANVA_OAUTH_SCOPES)).toEqual({
      reported: true,
      missing: [
        'brandtemplate:meta:read',
        'brandtemplate:content:read',
        'design:content:write',
      ],
    });
  });

  it('treats an empty report as not reported', () => {
    expect(grantedScopeCheck([], CANVA_OAUTH_SCOPES)).toEqual({
      reported: false,
      missing: [],
    });
  });

  it('splits whitespace-separated values', () => {
    expect(
      grantedScopeCheck([CANVA_OAUTH_SCOPES.join('  ')], CANVA_OAUTH_SCOPES),
    ).toEqual({ reported: true, missing: [] });
  });
});

describe('CanvaProfileClient', () => {
  it('reads the sanitized display name with a Bearer GET, no body, and no redirects', async () => {
    const { fetchMock, profile } = clients(() =>
      json(200, { profile: { display_name: ' Brand‮ Studio ' } }),
    );
    await expect(profile.displayName('access-token')).resolves.toBe(
      'Brand Studio',
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(CANVA_PROFILE_ENDPOINT);
    expect(init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: 'Bearer access-token' },
    });
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns null for a missing name', async () => {
    const { profile } = clients(() => json(200, { profile: {} }));
    await expect(profile.displayName('t')).resolves.toBeNull();
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [429, 'transient'],
    [503, 'transient'],
    [404, 'rejected'],
  ])('classifies HTTP %i as %s', async (status, kind) => {
    const { profile } = clients(() => json(status, { message: 'secret-echo' }));
    const error = await profile.displayName('t').catch((cause) => cause);
    expect(error).toBeInstanceOf(CanvaIdentityError);
    expect(error).toMatchObject({ kind });
    expect(String(error.message)).not.toMatch(/secret-echo|Bearer|\bt\b/);
  });

  it('carries Retry-After for 429', async () => {
    const { profile } = clients(() => json(429, {}, { 'retry-after': '20' }));
    await expect(profile.displayName('t')).rejects.toMatchObject({
      retryAfterSeconds: 20,
    });
  });

  it('classifies a network failure and a malformed body', async () => {
    await expect(
      clients(() => Promise.reject(new Error('reset'))).profile.displayName(
        't',
      ),
    ).rejects.toMatchObject({ kind: 'network' });
    await expect(
      clients(
        () => new Response('<html>', { status: 200 }),
      ).profile.displayName('t'),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
    await expect(
      clients(() => json(200, { name: 'x' })).profile.displayName('t'),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('refuses in mock mode without a request', async () => {
    const fetchMock = vi.fn();
    const profile = new CanvaProfileClient(
      { mode: 'mock', webOrigin: 'http://localhost:5173' },
      fetchMock,
    );
    await expect(profile.displayName('t')).rejects.toMatchObject({
      kind: 'disabled',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('CanvaCapabilitiesClient', () => {
  it('reports both capabilities, ignoring unknown names and duplicates', async () => {
    const { fetchMock, capabilities } = clients(() =>
      json(200, {
        capabilities: ['autofill', 'resize', 'brand_template', 'autofill'],
      }),
    );
    await expect(capabilities.capabilities('t')).resolves.toEqual({
      autofill: true,
      brandTemplate: true,
    });
    expect(fetchMock.mock.calls[0][0]).toBe(CANVA_CAPABILITIES_ENDPOINT);
  });

  it('reports missing capabilities as false', async () => {
    const { capabilities } = clients(() => json(200, { capabilities: [] }));
    await expect(capabilities.capabilities('t')).resolves.toEqual({
      autofill: false,
      brandTemplate: false,
    });
  });

  it.each([{}, { capabilities: 'autofill' }, { capabilities: [1] }])(
    'refuses an unexpected shape %j as invalid_response',
    async (body) => {
      const { capabilities } = clients(() => json(200, body));
      await expect(capabilities.capabilities('t')).rejects.toMatchObject({
        kind: 'invalid_response',
      });
    },
  );

  it('classifies a missing profile:read scope (403) as unauthorized', async () => {
    const { capabilities } = clients(() => json(403, {}));
    await expect(capabilities.capabilities('t')).rejects.toMatchObject({
      kind: 'unauthorized',
      retryable: false,
    });
  });
});
