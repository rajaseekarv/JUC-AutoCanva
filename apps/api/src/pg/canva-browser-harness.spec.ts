import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeAuthorizeServer,
  TempBrowserProfile,
  WebOriginStandIn,
  assertIsolatedProfile,
  browserDriverInstalled,
  loadBrowserDriver,
} from './canva-browser-harness';

// Gate G infrastructure without a browser or a database: profile isolation,
// the fake authorize page, and the web-origin stand-in, over loopback HTTP.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// A GET that does not follow redirects.
function get(
  url: string,
): Promise<{ status: number; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let body = '';
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            location: response.headers.location,
            body,
          }),
        );
      })
      .on('error', reject);
  });
}

const registered =
  'http://127.0.0.1:3000/api/v1/integrations/canva/oauth/callback';

function authorizeUrl(base: string, overrides: Record<string, string> = {}) {
  const url = new URL(base);
  const params = {
    response_type: 'code',
    code_challenge_method: 'S256',
    code_challenge: 'challenge',
    state: 'S'.repeat(43),
    redirect_uri: registered,
    ...overrides,
  };
  for (const [name, value] of Object.entries(params))
    url.searchParams.set(name, value);
  return url.toString();
}

describe('gate G isolated browser profiles', () => {
  it('creates a fresh profile in the temp directory and removes only it', () => {
    const profile = TempBrowserProfile.create();
    expect(profile.path.startsWith(tmpdir())).toBe(true);
    expect(existsSync(profile.path)).toBe(true);
    profile.remove();
    expect(existsSync(profile.path)).toBe(false);
  });

  it.each([
    [
      'the user’s Chrome profile (Windows)',
      join(homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
    ],
    [
      'the user’s Chrome profile (Linux)',
      join(homedir(), '.config', 'google-chrome'),
    ],
    [
      'the user’s Chrome profile (macOS)',
      join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
    ],
    ['the home directory', homedir()],
    ['the temp directory itself', tmpdir()],
    ['a nested temp path', join(tmpdir(), 'adflow-gate-g-profile-x', 'nested')],
    ['a temp directory with another prefix', join(tmpdir(), 'other-profile')],
    [
      'a profile named like Chrome',
      join(tmpdir(), 'adflow-gate-g-profile-Google', 'Chrome'),
    ],
  ])('refuses %s', (_case, path) => {
    expect(() => assertIsolatedProfile(path)).toThrow(/Refusing/);
  });

  it('never removes a directory that is not a gate profile', () => {
    const other = mkdtempSync(join(tmpdir(), 'adflow-not-a-profile-'));
    cleanups.push(() => rmSync(other, { recursive: true, force: true }));
    const forged = Object.assign(
      Object.create(TempBrowserProfile.prototype) as TempBrowserProfile,
      { path: other },
    );
    expect(() => forged.remove()).toThrow(/Refusing/);
    expect(existsSync(other)).toBe(true);
  });
});

describe('gate G fake authorize page', () => {
  async function start() {
    let issued = 0;
    const fake = await FakeAuthorizeServer.start({
      registeredRedirectUri: registered,
      code: () => `code-${(issued += 1)}`,
    });
    cleanups.push(() => fake.close());
    return fake;
  }

  it('listens on loopback and redirects back with a code and the same state', async () => {
    const fake = await start();
    expect(new URL(fake.url).hostname).toBe('127.0.0.1');
    const response = await get(authorizeUrl(fake.url));
    expect(response.status).toBe(302);
    const callback = new URL(response.location!);
    expect(callback.origin + callback.pathname).toBe(registered);
    expect(callback.searchParams.get('code')).toBe('code-1');
    expect(callback.searchParams.get('state')).toBe('S'.repeat(43));
    expect(fake.requests).toHaveLength(1);
  });

  it('captures the callback URL instead of redirecting, for replay in another profile', async () => {
    const fake = await start();
    fake.mode = 'capture';
    const response = await get(authorizeUrl(fake.url));
    expect(response.status).toBe(200);
    expect(fake.captured).toHaveLength(1);
    expect(new URL(fake.captured[0]).searchParams.get('code')).toBe('code-1');
  });

  it.each([
    [
      'an unregistered redirect_uri',
      { redirect_uri: 'https://evil.example/cb' },
    ],
    ['plain PKCE', { code_challenge_method: 'plain' }],
    ['another response type', { response_type: 'token' }],
    ['no state', { state: '' }],
  ])('refuses %s, like Canva', async (_case, overrides) => {
    const fake = await start();
    const response = await get(authorizeUrl(fake.url, overrides));
    expect(response.status).toBe(400);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('gate G web-origin stand-in', () => {
  it('serves a page that posts the launch token in a top-level form', async () => {
    const web = await WebOriginStandIn.start();
    cleanups.push(() => web.close());
    const token = 'T'.repeat(43);
    const start = web.prepare(
      'http://127.0.0.1:3000/api/v1/integrations/canva/oauth/launch',
      token,
    );
    const page = await get(start);
    expect(page.body).toContain('method="POST"');
    expect(page.body).toContain(
      'action="http://127.0.0.1:3000/api/v1/integrations/canva/oauth/launch"',
    );
    expect(page.body).toContain(`value="${token}"`);
    expect((await get(`${web.origin}/?canva=denied`)).status).toBe(200);
  });

  it('refuses a malformed token or a non-loopback launch URL', async () => {
    const web = await WebOriginStandIn.start();
    cleanups.push(() => web.close());
    expect(() =>
      web.prepare('http://127.0.0.1:3000/launch', '"><script>'),
    ).toThrow(/token/);
    expect(() =>
      web.prepare('https://evil.example/launch', 'T'.repeat(43)),
    ).toThrow(/loopback/);
  });
});

describe('gate G browser driver', () => {
  it('reports the driver as unavailable instead of failing when it is not installed', async () => {
    const driver = await loadBrowserDriver();
    expect(driver === null).toBe(!browserDriverInstalled());
  });
});
