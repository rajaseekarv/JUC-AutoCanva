import { z } from 'zod';
import { CanvaTokenKeyring, decodeEncryptionKey } from './canva-token-cipher';

// Canva Connect OAuth endpoints. Only the server uses them, and nothing calls
// them unless real mode is configured and persistence is available.
export const CANVA_OAUTH_ENDPOINTS = {
  authorize: 'https://www.canva.com/api/oauth/authorize',
  token: 'https://api.canva.com/rest/v1/oauth/token',
  revoke: 'https://api.canva.com/rest/v1/oauth/revoke',
} as const;

// Least privilege for brand-template Autofill plus administrator
// confirmation:
// - brandtemplate:meta:read, brandtemplate:content:read: find templates and
//   read their datasets.
// - design:content:write: create the Autofill job.
// - profile:read: the confirmation screen shows the Canva display name
//   (GET /v1/users/me/profile) and checks the account's autofill and
//   brand_template capabilities (GET /v1/users/me/capabilities); both
//   endpoints require it. Opaque IDs alone would not let an admin recognize
//   a foreign account. GET /v1/users/me (user and team IDs) needs no scope.
// Asset scopes are added only when image/logo fields are supported. See
// docs/integrations/canva.md.
export const CANVA_OAUTH_SCOPES = [
  'brandtemplate:meta:read',
  'brandtemplate:content:read',
  'design:content:write',
  'profile:read',
] as const;

export const CANVA_OAUTH_CALLBACK_PATH =
  '/api/v1/integrations/canva/oauth/callback';
export const CANVA_OAUTH_STATE_TTL_MS = 10 * 60_000;
// The browser posts its one-time launch token here in a top-level form
// submission, which sets the binding cookie on the callback's host.
export const CANVA_OAUTH_LAUNCH_PATH =
  '/api/v1/integrations/canva/oauth/launch';
// Host-only, HttpOnly cookie binding a launched attempt to this browser.
export const CANVA_BINDING_COOKIE = 'adflow_canva_oauth_binding';
export const CANVA_BINDING_COOKIE_PATH = '/api/v1/integrations/canva/oauth';

export const CANVA_OAUTH_CONFIG = Symbol('CANVA_OAUTH_CONFIG');

// The authorize page the browser is sent to. CanvaModule provides Canva's
// own URL as a constant; there is no environment variable for it, so only
// code can substitute it, and only gate G's browser test does (by
// overriding the provider in a Nest testing module). Even then
// checkAuthorizeEndpoint refuses it unless it is plain http on 127.0.0.1,
// in a gate run (ADFLOW_PG_GATES=run), outside production.
export const CANVA_AUTHORIZE_ENDPOINT = Symbol('CANVA_AUTHORIZE_ENDPOINT');

export class CanvaAuthorizeEndpointError extends Error {
  constructor() {
    super('The Canva authorize endpoint may only be overridden for a gate run');
    this.name = 'CanvaAuthorizeEndpointError';
  }
}

export function checkAuthorizeEndpoint(
  endpoint: string,
  environment: NodeJS.ProcessEnv,
): string {
  if (endpoint === CANVA_OAUTH_ENDPOINTS.authorize) return endpoint;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new CanvaAuthorizeEndpointError();
  }
  if (
    environment.NODE_ENV === 'production' ||
    environment.ADFLOW_PG_GATES !== 'run' ||
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new CanvaAuthorizeEndpointError();
  return url.toString();
}
// Injected so expiry and refresh decisions are testable without real time.
export const CANVA_CLOCK = Symbol('CANVA_CLOCK');
export type CanvaClock = () => Date;

// Holds a secret without letting it reach logs, JSON, or string output.
export class SecretValue {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return '[redacted]';
  }
  toJSON(): string {
    return '[redacted]';
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[redacted]';
  }
}

export type CanvaOAuthConfig =
  | { mode: 'mock'; webOrigin: string }
  | {
      mode: 'canva';
      webOrigin: string;
      clientId: string;
      clientSecret: SecretValue;
      redirectUri: string;
      keyring: CanvaTokenKeyring;
      scopes: readonly string[];
      // Durable OAuth storage (the PostgreSQL stores). Off by default: until
      // the persistence proposal's PostgreSQL gates pass, real mode fails
      // closed even when configured.
      persistence: boolean;
      // Lets the revocation worker run when triggered. Off by default.
      revocationWorker: boolean;
    };

// Blank values in .env files count as unset.
const blankAsUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;
const optionalText = z.preprocess(
  blankAsUndefined,
  z.string().trim().optional(),
);

// "true" or "false" only, so a typo cannot silently enable anything.
const flag = z.preprocess(
  blankAsUndefined,
  z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
);

export const webOriginSchema = z
  .string()
  .url()
  .default('http://localhost:5173');

export const canvaEnvironmentShape = {
  CANVA_PROVIDER_MODE: z.preprocess(
    blankAsUndefined,
    z.enum(['mock', 'canva']).default('mock'),
  ),
  CANVA_CLIENT_ID: optionalText,
  CANVA_CLIENT_SECRET: optionalText,
  CANVA_REDIRECT_URI: optionalText,
  CANVA_REDIRECT_ALLOWED_ORIGINS: optionalText,
  CANVA_TOKEN_ENCRYPTION_KEY: optionalText,
  CANVA_TOKEN_ENCRYPTION_KEY_VERSION: z.preprocess(
    blankAsUndefined,
    z.coerce.number().int().min(1).max(1_000_000).default(1),
  ),
  CANVA_TOKEN_ENCRYPTION_PREVIOUS_KEYS: optionalText,
  CANVA_OAUTH_PERSISTENCE_ENABLED: flag,
  CANVA_REVOCATION_WORKER_ENABLED: flag,
};

type CanvaEnvironmentValues = {
  CANVA_PROVIDER_MODE: 'mock' | 'canva';
  CANVA_CLIENT_ID?: string;
  CANVA_CLIENT_SECRET?: string;
  CANVA_REDIRECT_URI?: string;
  CANVA_REDIRECT_ALLOWED_ORIGINS?: string;
  CANVA_TOKEN_ENCRYPTION_KEY?: string;
  CANVA_TOKEN_ENCRYPTION_KEY_VERSION: number;
  CANVA_TOKEN_ENCRYPTION_PREVIOUS_KEYS?: string;
  CANVA_OAUTH_PERSISTENCE_ENABLED: boolean;
  CANVA_REVOCATION_WORKER_ENABLED: boolean;
};

// "version:key" pairs separated by commas, e.g. "1:<base64>,2:<base64>".
function parsePreviousKeys(
  raw: string | undefined,
): Map<number, Buffer> | null {
  const keys = new Map<number, Buffer>();
  if (!raw) return keys;
  for (const entry of raw.split(',')) {
    const separator = entry.indexOf(':');
    const version = Number(entry.slice(0, separator).trim());
    const key = decodeEncryptionKey(entry.slice(separator + 1));
    if (
      separator < 1 ||
      !Number.isInteger(version) ||
      version < 1 ||
      !key ||
      keys.has(version)
    )
      return null;
    keys.set(version, key);
  }
  return keys;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);

// Plain HTTP only for loopback development; Canva's local-development
// guidance uses 127.0.0.1 rather than localhost.
function isLoopbackHttp(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

// CANVA_REDIRECT_ALLOWED_ORIGINS: comma-separated origins (scheme, host,
// optional port; nothing else), each https or loopback http. Null when an
// entry is not exactly an origin.
export function parseAllowedOrigins(raw: string | undefined): string[] | null {
  if (!raw) return [];
  const origins: string[] = [];
  for (const entry of raw.split(',').map((value) => value.trim())) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      return null;
    }
    if (
      (url.protocol !== 'https:' && !isLoopbackHttp(url)) ||
      url.origin !== entry
    )
      return null;
    origins.push(url.origin);
  }
  return origins;
}

// The callback URL that Canva redirects to, and from which the launch URL
// and the binding cookie's host are derived (canvaLaunchUrl). It comes only
// from server configuration and must be:
// - in canonical form (exactly what URL parsing produces), so the value sent
//   to Canva is the value checked here;
// - https, or http on 127.0.0.1 or [::1];
// - exactly the callback path, with no query, fragment, or credentials;
// - on an origin in CANVA_REDIRECT_ALLOWED_ORIGINS. When that list is unset,
//   only loopback http origins (local development) are accepted, so an
//   https deployment host must always be listed explicitly.
export function isAllowedRedirectUri(
  raw: string,
  allowedOrigins: readonly string[],
): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const shapeOk =
    url.href === raw &&
    (url.protocol === 'https:' || isLoopbackHttp(url)) &&
    url.pathname === CANVA_OAUTH_CALLBACK_PATH &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password;
  if (!shapeOk) return false;
  return allowedOrigins.length
    ? allowedOrigins.includes(url.origin)
    : isLoopbackHttp(url);
}

// Issue messages name the setting but never include its value.
export function checkCanvaEnvironment(
  values: CanvaEnvironmentValues,
  context: z.RefinementCtx,
): void {
  if (values.CANVA_PROVIDER_MODE !== 'canva') return;
  const issue = (path: keyof CanvaEnvironmentValues, message: string) =>
    context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

  if (!values.CANVA_CLIENT_ID)
    issue('CANVA_CLIENT_ID', 'is required in canva mode');
  else if (!/^[A-Za-z0-9_-]{4,128}$/.test(values.CANVA_CLIENT_ID))
    issue('CANVA_CLIENT_ID', 'must be the Canva app client ID');

  if (!values.CANVA_CLIENT_SECRET)
    issue('CANVA_CLIENT_SECRET', 'is required in canva mode');
  else if (!/^\S{16,512}$/.test(values.CANVA_CLIENT_SECRET))
    issue('CANVA_CLIENT_SECRET', 'must be the Canva app client secret');

  const allowedOrigins = parseAllowedOrigins(
    values.CANVA_REDIRECT_ALLOWED_ORIGINS,
  );
  if (!allowedOrigins)
    issue(
      'CANVA_REDIRECT_ALLOWED_ORIGINS',
      'must be comma-separated https origins (or http on 127.0.0.1) with no path',
    );
  if (!values.CANVA_REDIRECT_URI)
    issue('CANVA_REDIRECT_URI', 'is required in canva mode');
  else if (
    allowedOrigins &&
    !isAllowedRedirectUri(values.CANVA_REDIRECT_URI, allowedOrigins)
  )
    issue(
      'CANVA_REDIRECT_URI',
      `must be a canonical https URL on an origin in CANVA_REDIRECT_ALLOWED_ORIGINS (or http on 127.0.0.1) ending in ${CANVA_OAUTH_CALLBACK_PATH} with no query or fragment`,
    );

  if (!values.CANVA_TOKEN_ENCRYPTION_KEY)
    issue('CANVA_TOKEN_ENCRYPTION_KEY', 'is required in canva mode');
  else if (!decodeEncryptionKey(values.CANVA_TOKEN_ENCRYPTION_KEY))
    issue('CANVA_TOKEN_ENCRYPTION_KEY', 'must be 32 bytes encoded as base64');
  else if (values.CANVA_TOKEN_ENCRYPTION_KEY === values.CANVA_CLIENT_SECRET)
    issue(
      'CANVA_TOKEN_ENCRYPTION_KEY',
      'must be separate from the client secret',
    );

  const previous = parsePreviousKeys(
    values.CANVA_TOKEN_ENCRYPTION_PREVIOUS_KEYS,
  );
  if (!previous)
    issue(
      'CANVA_TOKEN_ENCRYPTION_PREVIOUS_KEYS',
      'must be comma-separated version:base64-key pairs with distinct versions',
    );
  else if (previous.has(values.CANVA_TOKEN_ENCRYPTION_KEY_VERSION))
    issue(
      'CANVA_TOKEN_ENCRYPTION_PREVIOUS_KEYS',
      'must not reuse the current key version',
    );

  if (
    values.CANVA_REVOCATION_WORKER_ENABLED &&
    !values.CANVA_OAUTH_PERSISTENCE_ENABLED
  )
    issue(
      'CANVA_REVOCATION_WORKER_ENABLED',
      'requires CANVA_OAUTH_PERSISTENCE_ENABLED=true',
    );
}

const canvaEnvironmentSchema = z
  .object({ WEB_ORIGIN: webOriginSchema, ...canvaEnvironmentShape })
  .superRefine(checkCanvaEnvironment);

export class CanvaConfigurationError extends Error {
  constructor(readonly fields: string[]) {
    super(`Invalid Canva configuration: ${fields.join(', ')}`);
    this.name = 'CanvaConfigurationError';
  }
}

// Builds the runtime configuration. Mock mode carries no Canva values at all,
// even when some are present in the environment.
export function parseCanvaEnvironment(
  source: NodeJS.ProcessEnv,
): CanvaOAuthConfig {
  const result = canvaEnvironmentSchema.safeParse(source);
  if (!result.success)
    throw new CanvaConfigurationError([
      ...new Set(result.error.issues.map((issue) => issue.path.join('.'))),
    ]);
  const values = result.data;
  const webOrigin = new URL(values.WEB_ORIGIN).origin;
  if (values.CANVA_PROVIDER_MODE === 'mock') return { mode: 'mock', webOrigin };
  return {
    mode: 'canva',
    webOrigin,
    clientId: values.CANVA_CLIENT_ID!,
    clientSecret: new SecretValue(values.CANVA_CLIENT_SECRET!),
    redirectUri: values.CANVA_REDIRECT_URI!,
    keyring: new CanvaTokenKeyring(
      {
        version: values.CANVA_TOKEN_ENCRYPTION_KEY_VERSION,
        key: decodeEncryptionKey(values.CANVA_TOKEN_ENCRYPTION_KEY!)!,
      },
      parsePreviousKeys(values.CANVA_TOKEN_ENCRYPTION_PREVIOUS_KEYS)!,
    ),
    scopes: CANVA_OAUTH_SCOPES,
    persistence: values.CANVA_OAUTH_PERSISTENCE_ENABLED,
    revocationWorker: values.CANVA_REVOCATION_WORKER_ENABLED,
  };
}

// Outcomes reported back to the web app. Fixed values only, so nothing from
// the callback request is ever reflected into the redirect.
export type CanvaOAuthOutcome =
  | 'connected'
  | 'denied'
  | 'invalid_request'
  | 'expired_or_used'
  | 'not_authorized'
  | 'conflict'
  | 'account_unavailable'
  | 'pending_confirmation'
  | 'account_ineligible'
  | 'insufficient_scope'
  | 'retry_connect'
  | 'unavailable'
  | 'disabled'
  | 'failed';

// The only post-callback destination: the configured web origin's Canva
// module. Never derived from request input.
export function canvaReturnUrl(
  webOrigin: string,
  outcome: CanvaOAuthOutcome,
): string {
  const url = new URL('/', webOrigin);
  url.searchParams.set('canva', outcome);
  url.hash = 'canva-integration';
  return url.toString();
}

// The launch endpoint must live on exactly the callback's host: the binding
// cookie is host-only, and the web app may reach the API under another name
// (for example localhost versus 127.0.0.1). It is derived only from the
// validated CANVA_REDIRECT_URI, never from a request Host header.
export function canvaLaunchUrl(config: { redirectUri: string }): string {
  return new URL(
    CANVA_OAUTH_LAUNCH_PATH,
    new URL(config.redirectUri).origin,
  ).toString();
}
