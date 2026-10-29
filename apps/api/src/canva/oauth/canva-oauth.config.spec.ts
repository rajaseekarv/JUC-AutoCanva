import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  CANVA_OAUTH_CALLBACK_PATH,
  CANVA_OAUTH_SCOPES,
  CanvaConfigurationError,
  SecretValue,
  canvaLaunchUrl,
  canvaReturnUrl,
  parseCanvaEnvironment,
} from './canva-oauth.config';

// Test-only placeholders; none of these are real Canva credentials.
const testKey = Buffer.alloc(32, 7).toString('base64');
const realMode = {
  CANVA_PROVIDER_MODE: 'canva',
  CANVA_CLIENT_ID: 'OC-test-client-id',
  CANVA_CLIENT_SECRET: 'test-only-client-secret-value',
  CANVA_REDIRECT_URI: `http://127.0.0.1:3000${CANVA_OAUTH_CALLBACK_PATH}`,
  CANVA_TOKEN_ENCRYPTION_KEY: testKey,
};

function failedFields(source: NodeJS.ProcessEnv): string[] {
  try {
    parseCanvaEnvironment(source);
  } catch (error) {
    if (error instanceof CanvaConfigurationError) return error.fields;
    throw error;
  }
  return [];
}

describe('parseCanvaEnvironment', () => {
  it('defaults to mock mode with no Canva settings', () => {
    expect(parseCanvaEnvironment({})).toEqual({
      mode: 'mock',
      webOrigin: 'http://localhost:5173',
    });
  });

  it('ignores Canva values entirely in mock mode', () => {
    const config = parseCanvaEnvironment({
      ...realMode,
      CANVA_PROVIDER_MODE: 'mock',
    });
    expect(config).toEqual({
      mode: 'mock',
      webOrigin: 'http://localhost:5173',
    });
    expect(JSON.stringify(config)).not.toContain('test-only-client-secret');
  });

  it('treats blank .env values as unset', () => {
    expect(
      parseCanvaEnvironment({
        CANVA_PROVIDER_MODE: '',
        CANVA_CLIENT_SECRET: ' ',
      }),
    ).toMatchObject({ mode: 'mock' });
  });

  it('builds the real-mode configuration with the minimum scopes', () => {
    const config = parseCanvaEnvironment(realMode);
    expect(config).toMatchObject({
      mode: 'canva',
      clientId: 'OC-test-client-id',
      redirectUri: realMode.CANVA_REDIRECT_URI,
      scopes: CANVA_OAUTH_SCOPES,
    });
    expect(CANVA_OAUTH_SCOPES).toEqual([
      'brandtemplate:meta:read',
      'brandtemplate:content:read',
      'design:content:write',
      // Needed by the admin confirmation screen (display name, capabilities).
      'profile:read',
    ]);
  });

  it('keeps durable storage and the revocation worker off by default', () => {
    expect(parseCanvaEnvironment(realMode)).toMatchObject({
      persistence: false,
      revocationWorker: false,
    });
    expect(
      parseCanvaEnvironment({
        ...realMode,
        CANVA_OAUTH_PERSISTENCE_ENABLED: 'true',
        CANVA_REVOCATION_WORKER_ENABLED: 'true',
      }),
    ).toMatchObject({ persistence: true, revocationWorker: true });
  });

  it('accepts only "true" or "false" for the opt-in flags', () => {
    expect(
      failedFields({ ...realMode, CANVA_OAUTH_PERSISTENCE_ENABLED: 'yes' }),
    ).toEqual(['CANVA_OAUTH_PERSISTENCE_ENABLED']);
  });

  it('refuses the revocation worker without durable storage', () => {
    expect(
      failedFields({ ...realMode, CANVA_REVOCATION_WORKER_ENABLED: 'true' }),
    ).toEqual(['CANVA_REVOCATION_WORKER_ENABLED']);
  });

  it('never exposes the client secret or key through JSON, inspect, or strings', () => {
    const config = parseCanvaEnvironment(realMode);
    if (config.mode !== 'canva') throw new Error('expected canva mode');
    expect(config.clientSecret.reveal()).toBe(realMode.CANVA_CLIENT_SECRET);
    for (const rendered of [
      JSON.stringify(config),
      inspect(config, { depth: 5 }),
      `${config.clientSecret}`,
    ]) {
      expect(rendered).not.toContain(realMode.CANVA_CLIENT_SECRET);
      expect(rendered).not.toContain(testKey);
    }
  });

  it('requires every setting in canva mode', () => {
    expect(failedFields({ CANVA_PROVIDER_MODE: 'canva' }).sort()).toEqual([
      'CANVA_CLIENT_ID',
      'CANVA_CLIENT_SECRET',
      'CANVA_REDIRECT_URI',
      'CANVA_TOKEN_ENCRYPTION_KEY',
    ]);
  });

  it.each([
    [
      'localhost instead of 127.0.0.1',
      `http://localhost:3000${CANVA_OAUTH_CALLBACK_PATH}`,
    ],
    [
      'plain http on a public host',
      `http://adflow.example${CANVA_OAUTH_CALLBACK_PATH}`,
    ],
    ['a different path', 'https://adflow.example/api/v1/oauth/callback'],
    [
      'a query string',
      `https://adflow.example${CANVA_OAUTH_CALLBACK_PATH}?next=/`,
    ],
    [
      'embedded credentials',
      `https://user:pass@adflow.example${CANVA_OAUTH_CALLBACK_PATH}`,
    ],
    ['a non-URL', 'not a url'],
  ])('rejects a redirect URI with %s', (_case, uri) => {
    expect(failedFields({ ...realMode, CANVA_REDIRECT_URI: uri })).toEqual([
      'CANVA_REDIRECT_URI',
    ]);
  });

  it('accepts an https redirect URI only on an explicitly allowed origin', () => {
    const deployed = `https://adflow.example${CANVA_OAUTH_CALLBACK_PATH}`;
    expect(failedFields({ ...realMode, CANVA_REDIRECT_URI: deployed })).toEqual(
      ['CANVA_REDIRECT_URI'],
    );
    expect(
      failedFields({
        ...realMode,
        CANVA_REDIRECT_URI: deployed,
        CANVA_REDIRECT_ALLOWED_ORIGINS:
          'https://staging.adflow.example, https://adflow.example',
      }),
    ).toEqual([]);
  });

  it.each([
    [
      'a host that is not listed',
      `https://evil.example${CANVA_OAUTH_CALLBACK_PATH}`,
    ],
    [
      'a listed host on another port',
      `https://adflow.example:8443${CANVA_OAUTH_CALLBACK_PATH}`,
    ],
    [
      'a subdomain of a listed host',
      `https://x.adflow.example${CANVA_OAUTH_CALLBACK_PATH}`,
    ],
    [
      'a listed host with an unexpected path',
      'https://adflow.example/callback',
    ],
    [
      'a path that only normalizes to the callback',
      `https://adflow.example/api/v1/x/..${CANVA_OAUTH_CALLBACK_PATH.slice(7)}`,
    ],
    [
      'an upper-case host (not canonical)',
      `https://ADFLOW.example${CANVA_OAUTH_CALLBACK_PATH}`,
    ],
    [
      'an explicit default port (not canonical)',
      `https://adflow.example:443${CANVA_OAUTH_CALLBACK_PATH}`,
    ],
    ['a fragment', `https://adflow.example${CANVA_OAUTH_CALLBACK_PATH}#x`],
    [
      'loopback while the list omits it',
      `http://127.0.0.1:3000${CANVA_OAUTH_CALLBACK_PATH}`,
    ],
  ])('rejects an allowlisted deployment redirect URI with %s', (_case, uri) => {
    expect(
      failedFields({
        ...realMode,
        CANVA_REDIRECT_URI: uri,
        CANVA_REDIRECT_ALLOWED_ORIGINS: 'https://adflow.example',
      }),
    ).toEqual(['CANVA_REDIRECT_URI']);
  });

  it.each([
    ['a path', 'https://adflow.example/app'],
    ['a trailing slash', 'https://adflow.example/'],
    ['a query', 'https://adflow.example?x=1'],
    ['plain http on a public host', 'http://adflow.example'],
    ['localhost over http', 'http://localhost:3000'],
    ['a malformed entry', 'adflow.example'],
    ['an empty entry', 'https://adflow.example,,'],
    ['credentials', 'https://user@adflow.example'],
  ])('rejects an allowed-origins list with %s', (_case, origins) => {
    expect(
      failedFields({ ...realMode, CANVA_REDIRECT_ALLOWED_ORIGINS: origins }),
    ).toContain('CANVA_REDIRECT_ALLOWED_ORIGINS');
  });

  it('keeps the local development configuration working without a list', () => {
    for (const uri of [
      `http://127.0.0.1:3000${CANVA_OAUTH_CALLBACK_PATH}`,
      `http://[::1]:3000${CANVA_OAUTH_CALLBACK_PATH}`,
    ])
      expect(failedFields({ ...realMode, CANVA_REDIRECT_URI: uri })).toEqual(
        [],
      );
    expect(
      failedFields({
        ...realMode,
        CANVA_REDIRECT_ALLOWED_ORIGINS: 'http://127.0.0.1:3000',
      }),
    ).toEqual([]);
  });

  it('never prints a rejected redirect value', () => {
    let message = '';
    try {
      parseCanvaEnvironment({
        ...realMode,
        CANVA_REDIRECT_URI: `https://secret-host.example${CANVA_OAUTH_CALLBACK_PATH}`,
      });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/CANVA_REDIRECT_URI/);
    expect(message).not.toContain('secret-host');
  });

  it.each([
    ['too short', Buffer.alloc(16, 1).toString('base64')],
    ['too long', Buffer.alloc(48, 1).toString('base64')],
    ['not base64', 'this is not a key!'],
  ])('rejects an encryption key that is %s', (_case, key) => {
    expect(
      failedFields({ ...realMode, CANVA_TOKEN_ENCRYPTION_KEY: key }),
    ).toEqual(['CANVA_TOKEN_ENCRYPTION_KEY']);
  });

  it('rejects an encryption key equal to the client secret', () => {
    expect(failedFields({ ...realMode, CANVA_CLIENT_SECRET: testKey })).toEqual(
      ['CANVA_TOKEN_ENCRYPTION_KEY'],
    );
  });

  it('accepts previous keys for rotation but rejects duplicate or current versions', () => {
    const previous = Buffer.alloc(32, 9).toString('base64');
    expect(
      failedFields({
        ...realMode,
        CANVA_TOKEN_ENCRYPTION_KEY_VERSION: '2',
        CANVA_TOKEN_ENCRYPTION_PREVIOUS_KEYS: `1:${previous}`,
      }),
    ).toEqual([]);
    expect(
      failedFields({
        ...realMode,
        CANVA_TOKEN_ENCRYPTION_KEY_VERSION: '1',
        CANVA_TOKEN_ENCRYPTION_PREVIOUS_KEYS: `1:${previous}`,
      }),
    ).toEqual(['CANVA_TOKEN_ENCRYPTION_PREVIOUS_KEYS']);
    expect(
      failedFields({
        ...realMode,
        CANVA_TOKEN_ENCRYPTION_KEY_VERSION: '3',
        CANVA_TOKEN_ENCRYPTION_PREVIOUS_KEYS: `1:${previous},1:${previous}`,
      }),
    ).toEqual(['CANVA_TOKEN_ENCRYPTION_PREVIOUS_KEYS']);
  });

  it('reports field names without values', () => {
    let message = '';
    try {
      parseCanvaEnvironment({ ...realMode, CANVA_CLIENT_ID: 'bad id!' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('Invalid Canva configuration: CANVA_CLIENT_ID');
  });
});

describe('SecretValue', () => {
  it('reveals the value only on request', () => {
    const secret = new SecretValue('very-secret');
    expect(secret.reveal()).toBe('very-secret');
    expect(String(secret)).toBe('[redacted]');
    expect(JSON.stringify({ secret })).toBe('{"secret":"[redacted]"}');
    expect(inspect(secret)).toBe('[redacted]');
  });
});

describe('canvaReturnUrl', () => {
  it('always targets the configured origin and the Canva module', () => {
    expect(canvaReturnUrl('http://localhost:5173', 'connected')).toBe(
      'http://localhost:5173/?canva=connected#canva-integration',
    );
  });

  it('drops any path on the configured origin', () => {
    expect(
      canvaReturnUrl('https://app.adflow.example/some/path?x=1', 'denied'),
    ).toBe('https://app.adflow.example/?canva=denied#canva-integration');
  });
});

describe('canvaLaunchUrl', () => {
  it('uses exactly the configured callback origin', () => {
    expect(
      canvaLaunchUrl({
        redirectUri: `http://127.0.0.1:3000${CANVA_OAUTH_CALLBACK_PATH}`,
      }),
    ).toBe('http://127.0.0.1:3000/api/v1/integrations/canva/oauth/launch');
    expect(
      canvaLaunchUrl({
        redirectUri: `https://api.adflow.example${CANVA_OAUTH_CALLBACK_PATH}`,
      }),
    ).toBe('https://api.adflow.example/api/v1/integrations/canva/oauth/launch');
  });

  it('takes no request host, so localhost requests still launch on 127.0.0.1', () => {
    // The web app reaches the API as localhost, but the binding cookie must
    // be set on the callback host; only the configuration decides it.
    expect(canvaLaunchUrl.length).toBe(1);
    expect(
      new URL(
        canvaLaunchUrl({
          redirectUri: `http://127.0.0.1:3000${CANVA_OAUTH_CALLBACK_PATH}`,
        }),
      ).host,
    ).toBe('127.0.0.1:3000');
  });
});
