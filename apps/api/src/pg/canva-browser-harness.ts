import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

// Gate G infrastructure (browser binding and confirmation, §10.2): isolated
// temporary browser profiles, a fake Canva authorize page, a stand-in for
// the web origin, and a loader for a headless browser driver.
//
// No browser driver is installed in this repository. loadBrowserDriver()
// returns null until one is approved and installed (see
// docs/integrations/canva.md, "Gate G"), and gate G stays blocked until then.
// Everything else here works without a browser or a database and is unit
// tested in canva-browser-harness.spec.ts.

// ---------------------------------------------------------------------------
// Isolated browser profiles
// ---------------------------------------------------------------------------

const PROFILE_PREFIX = 'adflow-gate-g-profile-';
// Path fragments of real browser profiles; a profile path containing any of
// them is refused even inside the temp directory.
const USER_PROFILE_MARKERS = [
  /google[\\/]+chrome/i,
  /chrome[\\/]+user data/i,
  /chromium/i,
  /google-chrome/i,
  /microsoft[\\/]+edge/i,
  /application support[\\/]+google/i,
  /mozilla|firefox/i,
];

export function assertIsolatedProfile(
  path: string,
  tempRoot: string = tmpdir(),
): string {
  const absolute = resolve(path);
  if (
    dirname(absolute) !== resolve(tempRoot) ||
    !basename(absolute).startsWith(PROFILE_PREFIX) ||
    USER_PROFILE_MARKERS.some((marker) => marker.test(absolute))
  )
    throw new Error(
      'Refusing to use a browser profile that is not a fresh gate G temporary profile',
    );
  return absolute;
}

// A fresh, empty profile directory in the OS temp directory; never the
// user's own browser profile. remove() deletes it, and only it.
export class TempBrowserProfile {
  private constructor(readonly path: string) {}

  static create(tempRoot: string = tmpdir()): TempBrowserProfile {
    const path = mkdtempSync(resolve(tempRoot, PROFILE_PREFIX));
    return new TempBrowserProfile(assertIsolatedProfile(path, tempRoot));
  }

  remove(tempRoot: string = tmpdir()): void {
    rmSync(assertIsolatedProfile(this.path, tempRoot), {
      recursive: true,
      force: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Fake Canva authorize page
// ---------------------------------------------------------------------------

export type AuthorizeRequest = {
  state: string;
  redirectUri: string;
  codeChallenge: string;
};

// Stands in for https://www.canva.com/api/oauth/authorize on 127.0.0.1.
// Like Canva, it refuses an unregistered redirect_uri and a request without
// S256 PKCE. In 'redirect' mode it sends the browser straight back to the
// callback with a code (consent granted); in 'capture' mode it shows the
// callback URL instead, so a test can replay it in another browser profile.
export class FakeAuthorizeServer {
  readonly requests: AuthorizeRequest[] = [];
  readonly captured: string[] = [];
  mode: 'redirect' | 'capture' = 'redirect';

  private constructor(
    private readonly server: http.Server,
    readonly url: string,
  ) {}

  static async start(options: {
    registeredRedirectUri: string;
    // The authorization code to issue (for example FakeCanva.code(user)).
    code: () => string;
  }): Promise<FakeAuthorizeServer> {
    const holder: { fake?: FakeAuthorizeServer } = {};
    const server = http.createServer((request, response) => {
      const fake = holder.fake;
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const params = url.searchParams;
      const redirectUri = params.get('redirect_uri') ?? '';
      if (
        !fake ||
        url.pathname !== '/authorize' ||
        redirectUri !== options.registeredRedirectUri ||
        params.get('response_type') !== 'code' ||
        params.get('code_challenge_method') !== 'S256' ||
        !params.get('code_challenge') ||
        !params.get('state')
      ) {
        response.writeHead(400, { 'content-type': 'text/plain' });
        response.end('invalid_request');
        return;
      }
      fake.requests.push({
        state: params.get('state')!,
        redirectUri,
        codeChallenge: params.get('code_challenge')!,
      });
      const callback = new URL(redirectUri);
      callback.searchParams.set('code', options.code());
      callback.searchParams.set('state', params.get('state')!);
      if (fake.mode === 'capture') {
        fake.captured.push(callback.toString());
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('captured');
        return;
      }
      response.writeHead(302, { location: callback.toString() });
      response.end();
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as AddressInfo).port;
    holder.fake = new FakeAuthorizeServer(
      server,
      `http://127.0.0.1:${port}/authorize`,
    );
    return holder.fake;
  }

  close(): Promise<void> {
    return new Promise((done) => this.server.close(() => done()));
  }
}

// ---------------------------------------------------------------------------
// Web origin stand-in
// ---------------------------------------------------------------------------

// Plays the web app's part on 127.0.0.1: /start serves a page that posts the
// one-time launch token to the launch URL in a top-level form (exactly what
// CanvaConnection does), and every other path answers 200, so the browser
// can land on the callback's return URL (/?canva=<outcome>).
export class WebOriginStandIn {
  private launch: { url: string; token: string } | null = null;

  private constructor(
    private readonly server: http.Server,
    readonly origin: string,
  ) {}

  static async start(): Promise<WebOriginStandIn> {
    const holder: { web?: WebOriginStandIn } = {};
    const server = http.createServer((request, response) => {
      const launch = holder.web?.launch;
      if (request.url?.startsWith('/start') && launch) {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(
          `<!doctype html><form method="POST" action="${encodeURI(launch.url)}">` +
            `<input type="hidden" name="launch_token" value="${launch.token}"></form>` +
            '<script>document.forms[0].submit()</script>',
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>web origin</title>');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as AddressInfo).port;
    holder.web = new WebOriginStandIn(server, `http://127.0.0.1:${port}`);
    return holder.web;
  }

  // The launch the next /start page submits. The token is a base64url
  // string and the URL comes from the API, so neither needs escaping beyond
  // encodeURI; both are validated here anyway.
  prepare(launchUrl: string, launchToken: string): string {
    if (!/^[A-Za-z0-9_-]{43}$/.test(launchToken))
      throw new Error('unexpected launch token shape');
    const url = new URL(launchUrl);
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname)
    )
      throw new Error('gate G launches only on loopback');
    this.launch = { url: url.toString(), token: launchToken };
    return `${this.origin}/start`;
  }

  close(): Promise<void> {
    return new Promise((done) => this.server.close(() => done()));
  }
}

// ---------------------------------------------------------------------------
// Browser driver
// ---------------------------------------------------------------------------

// The small part of a headless browser the gate needs.
export type BrowserSession = {
  goto(url: string): Promise<void>;
  // Waits until the page URL matches, then returns it.
  waitForUrl(match: RegExp, timeoutMs?: number): Promise<string>;
  close(): Promise<void>;
};

export type BrowserDriver = {
  // A headless browser with its own persistent profile directory.
  open(profile: TempBrowserProfile): Promise<BrowserSession>;
};

// The proposed driver package (see docs/integrations/canva.md, "Gate G").
export const BROWSER_DRIVER_PACKAGE = 'playwright';

export function browserDriverInstalled(): boolean {
  try {
    require.resolve(BROWSER_DRIVER_PACKAGE);
    return true;
  } catch {
    return false;
  }
}

type PlaywrightLike = {
  chromium: {
    launchPersistentContext(
      userDataDir: string,
      options: { headless: boolean },
    ): Promise<{
      newPage(): Promise<{
        goto(url: string): Promise<unknown>;
        waitForURL(
          match: RegExp,
          options: { timeout: number },
        ): Promise<unknown>;
        url(): string;
      }>;
      close(): Promise<void>;
    }>;
  };
};

// Null when the driver is not installed. The package is loaded by name at
// runtime, so this repository builds and typechecks without it.
export async function loadBrowserDriver(): Promise<BrowserDriver | null> {
  if (!browserDriverInstalled()) return null;
  const playwright = (await import(BROWSER_DRIVER_PACKAGE)) as PlaywrightLike;
  return {
    async open(profile) {
      assertIsolatedProfile(profile.path);
      const context = await playwright.chromium.launchPersistentContext(
        profile.path,
        { headless: true },
      );
      const page = await context.newPage();
      return {
        goto: async (url) => {
          await page.goto(url);
        },
        waitForUrl: async (match, timeoutMs = 15_000) => {
          await page.waitForURL(match, { timeout: timeoutMs });
          return page.url();
        },
        close: () => context.close(),
      };
    },
  };
}
