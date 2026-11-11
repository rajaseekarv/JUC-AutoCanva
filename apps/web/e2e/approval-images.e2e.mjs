// Browser regression test for image and logo previews on the Approvals
// screen (Stage 10.4).
//
//   node apps/web/e2e/approval-images.e2e.mjs            (from the repo root)
//   pnpm --filter @adflow/web e2e:approval-images
//
// Self-contained: it builds the web app into a temporary directory (never
// apps/web/dist), serves it with `vite preview` on 127.0.0.1, and drives
// system Chrome with the Playwright library already installed for apps/api.
// Every API response is stubbed with route interception, so no API,
// database, Canva or OAuth service is used, and any request that would
// leave the loopback preview origin is blocked and fails the run. Nothing is
// downloaded: if Chrome is missing the run stops with a message.
//
// Options (environment):
//   E2E_BROWSER_CHANNEL  Playwright channel, default "chrome" (system Chrome).
//   E2E_BROWSER_PATH     Path to another installed Chromium executable,
//                        used instead of the channel.
//
// It is not a Vitest file (Vitest only collects src/**/*.test.ts[x]).

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..');
// Playwright is a dev dependency of apps/api; resolve it from there rather
// than adding a dependency to apps/web.
const { chromium } = createRequire(join(webDir, '../api/package.json'))(
  'playwright',
);
// vite does not export its CLI path, so find it next to its package.json.
const viteBin = join(
  dirname(
    createRequire(join(webDir, 'package.json')).resolve('vite/package.json'),
  ),
  'bin',
  'vite.js',
);

const HOST = '127.0.0.1';
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
// A valid 1 × 1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

// ---------------------------------------------------------------- fixtures

const reviewer = (permissions) => ({
  id: 'reviewer-1',
  organizationId: 'org-1',
  name: 'Rita Reviewer',
  email: 'reviewer@example.local',
  permissions,
  branches: [{ id: 'branch-1', name: 'North', code: 'NORTH' }],
});
const REVIEW_PERMISSIONS = [
  'approvals:read',
  'approvals:decide',
  'change_requests:read',
  'change_requests:create',
  'comments:read',
  'comments:create',
];
const assetMeta = (id, originalName) => ({
  id,
  organizationId: 'org-1',
  branchId: 'branch-1',
  originalName,
  mimeType: 'image/png',
  sizeBytes: PNG.length,
  width: 1,
  height: 1,
  status: 'ACTIVE',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});
const ASSETS = {
  'asset-hero': assetMeta('asset-hero', 'north-hero.png'),
  'asset-logo': assetMeta('asset-logo', 'north-logo.png'),
  // 'asset-gone' is referenced by the revision but returns 404.
};
// The only failed responses the browser may log.
const EXPECTED_404S = ['/api/v1/assets/asset-gone'];
const task = {
  id: 'task-1',
  status: 'OPEN',
  createdAt: '2026-01-02T00:00:00Z',
  stage: { id: 'stage-review', key: 'review', name: 'Review' },
  instance: {
    id: 'instance-1',
    branchId: 'branch-1',
    currentStageId: 'stage-review',
    creativeRevisionId: 'revision-2',
    creative: {
      id: 'creative-1',
      name: 'Spring post',
      currentRevisionId: 'revision-2',
      currentRevision: { revisionNumber: 2 },
    },
  },
};
const review = {
  task: {
    id: 'task-1',
    status: 'OPEN',
    stage: { key: 'review', name: 'Review' },
  },
  workflow: { id: 'instance-1', name: 'Branch review' },
  creative: {
    id: 'creative-1',
    name: 'Spring post',
    branchId: 'branch-1',
    currentRevisionId: 'revision-2',
  },
  revision: {
    id: 'revision-2',
    creativeId: 'creative-1',
    revisionNumber: 2,
    values: {
      headline: 'Spring offer',
      hero: 'asset-hero',
      logo: 'asset-logo',
      backdrop: 'asset-gone',
    },
    templateVersion: {
      fields: [
        { key: 'headline', label: 'Headline', type: 'TEXT', displayOrder: 0 },
        { key: 'hero', label: 'Hero image', type: 'IMAGE', displayOrder: 1 },
        { key: 'logo', label: 'Logo', type: 'LOGO', displayOrder: 2 },
        { key: 'backdrop', label: 'Backdrop', type: 'IMAGE', displayOrder: 3 },
      ],
    },
  },
  submittedByViewer: false,
  current: true,
};

// The stubbed API for one browser context. Unknown API paths fail the run
// so a new request cannot go unnoticed.
function apiReply(path, user) {
  const json = (body, status = 200) => ({ status, json: body });
  if (path === '/health')
    return json({ status: 'ok', service: 'adflow-api', checks: {} });
  if (path === '/auth/me') return json(user);
  if (path === '/branches/branch-1')
    return json({
      id: 'branch-1',
      name: 'North',
      code: 'NORTH',
      status: 'ACTIVE',
    });
  if (path === '/approvals/tasks') return json([task]);
  if (path === '/approvals/tasks/task-1') return json(review);
  if (path === '/creatives/creative-1/decisions') return json([]);
  if (path === '/creatives/creative-1/change-requests') return json([]);
  if (/^\/creatives\/creative-1\/revisions\/\d+\/comments$/.test(path))
    return json([]);
  if (path.startsWith('/notifications')) return json(notificationsReply(path));
  const asset = /^\/assets\/([^/]+)(\/content)?$/.exec(path);
  if (asset) {
    const meta = ASSETS[asset[1]];
    if (!meta) return json({ message: 'Asset not found' }, 404);
    return asset[2]
      ? { status: 200, body: PNG, contentType: 'image/png' }
      : json(meta);
  }
  return null;
}
function notificationsReply(path) {
  return path.includes('unread') ? { count: 0 } : [];
}

// ------------------------------------------------------------------ helpers

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' :: ' + detail}`);
  if (!ok) failures.push(name);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, HOST, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [viteBin, ...args], {
      cwd: webDir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolve(output)
        : reject(new Error(`vite ${args[0]} exited with ${code}\n${output}`)),
    );
  });
}

function startPreview(outDir, port) {
  const child = spawn(
    process.execPath,
    [
      viteBin,
      'preview',
      '--outDir',
      outDir,
      '--host',
      HOST,
      '--port',
      String(port),
      '--strictPort',
    ],
    { cwd: webDir, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const ready = new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => reject(new Error('vite preview did not start\n' + output)),
      30000,
    );
    const onData = (chunk) => {
      // The banner is coloured; compare it without ANSI escape codes.
      // eslint-disable-next-line no-control-regex
      output += String(chunk).replace(/\u001b\[[0-9;]*m/g, '');
      if (output.includes(`${HOST}:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`vite preview exited with ${code}\n${output}`));
    });
  });
  return { child, ready };
}

async function launchBrowser() {
  const options = {
    headless: true,
    args: [
      '--disable-extensions',
      '--no-first-run',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
    ],
  };
  const executablePath = process.env.E2E_BROWSER_PATH;
  try {
    return await chromium.launch(
      executablePath
        ? { ...options, executablePath }
        : { ...options, channel: process.env.E2E_BROWSER_CHANNEL || 'chrome' },
    );
  } catch (error) {
    throw new Error(
      'No usable browser. Install Google Chrome, or set E2E_BROWSER_PATH to an ' +
        'installed Chromium executable. Nothing is downloaded by this test.\n' +
        String(error?.message ?? error).split('\n')[0],
    );
  }
}

// A context whose every request is either served by the preview server,
// answered by the stubbed API, or blocked and recorded.
async function openContext(browser, origin, { permissions, viewport }) {
  const user = reviewer(permissions);
  const context = await browser.newContext({
    viewport,
    serviceWorkers: 'block',
  });
  const traffic = {
    blocked: [],
    unhandled: [],
    assetRequests: [],
    errors: [],
    expected404s: [],
  };
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      traffic.blocked.push(url.href);
      return route.abort('blockedbyclient');
    }
    if (!url.pathname.startsWith('/api/v1/')) return route.continue();
    const path = url.pathname.slice('/api/v1'.length);
    if (path.startsWith('/assets/')) traffic.assetRequests.push(path);
    const reply = apiReply(path, user);
    if (!reply) {
      traffic.unhandled.push(`${route.request().method()} ${path}`);
      return route.fulfill({ status: 500, json: { message: 'Unstubbed' } });
    }
    return route.fulfill(reply);
  });
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // Chrome logs every failed response itself. The deliberate 404 for the
    // missing-asset fixture is expected; any other error fails the run.
    if (
      message.text().startsWith('Failed to load resource') &&
      EXPECTED_404S.includes(new URL(message.location().url).pathname)
    )
      traffic.expected404s.push(message.location().url);
    else traffic.errors.push(message.text());
  });
  page.on('pageerror', (error) => traffic.errors.push(String(error)));
  // The app restores a saved session through GET /auth/me.
  await context.addInitScript(() => {
    window.localStorage.setItem(
      'adflow.session',
      JSON.stringify({
        accessToken: 'e2e-token',
        expiresAt: Date.now() + 3600000,
      }),
    );
  });
  await page.goto(origin + '/#approvals');
  await page
    .getByRole('heading', { level: 1, name: /^Hello,/ })
    .waitFor({ timeout: 15000 });
  return { context, page, traffic };
}

async function openReview(page) {
  const region = page.getByRole('region', { name: 'Approvals & comments' });
  await region
    .getByRole('listitem')
    .filter({ hasText: 'Spring post' })
    .getByRole('button', { name: 'Review' })
    .click();
  await page
    .getByRole('heading', { name: 'Spring post · Revision 2' })
    .waitFor({ timeout: 10000 });
  return page.getByRole('region', { name: 'Review detail' });
}

// Polls a freshly resolved locator, so a re-render cannot leave a stale
// element behind.
async function imageLoaded(locator) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const loaded = await locator.evaluate(
        (img) => img.complete && img.naturalWidth > 0,
        null,
        { timeout: 500 },
      );
      if (loaded) return true;
    } catch {
      // Not rendered yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function checkTraffic(label, traffic) {
  check(
    `${label}: no request left the loopback preview origin`,
    traffic.blocked.length === 0,
    traffic.blocked.join(', '),
  );
  check(
    `${label}: every API request was an expected stub`,
    traffic.unhandled.length === 0,
    traffic.unhandled.join(', '),
  );
  check(
    `${label}: no browser console errors` +
      (traffic.expected404s.length
        ? ` (besides ${traffic.expected404s.length} logged 404 for the missing-asset fixture)`
        : ''),
    traffic.errors.length === 0,
    traffic.errors.join(' | '),
  );
}

// ---------------------------------------------------------------- scenarios

async function previewsWithAssetAccess(browser, origin, viewport, label) {
  const { context, page, traffic } = await openContext(browser, origin, {
    permissions: [...REVIEW_PERMISSIONS, 'assets:read'],
    viewport,
  });
  try {
    const detail = await openReview(page);
    const hero = detail.getByRole('img', {
      name: 'Hero image: north-hero.png',
    });
    const logo = detail.getByRole('img', { name: 'Logo: north-logo.png' });
    check(
      `${label}: IMAGE preview loads (naturalWidth > 0)`,
      await imageLoaded(hero),
    );
    check(
      `${label}: LOGO preview loads (naturalWidth > 0)`,
      await imageLoaded(logo),
    );
    const text = await detail.innerText();
    check(
      `${label}: file names are shown instead of asset IDs`,
      text.includes('north-hero.png') &&
        text.includes('north-logo.png') &&
        !text.includes('asset-hero') &&
        !text.includes('asset-logo'),
      text.slice(0, 300),
    );
    const missing = detail.getByText(
      'Image unavailable — the asset was removed or cannot be found',
    );
    await missing.waitFor({ timeout: 10000 }).catch(() => undefined);
    check(
      `${label}: a 404 asset shows the unavailable state`,
      await missing.isVisible(),
    );
    check(
      `${label}: only the referenced assets were requested`,
      traffic.assetRequests.every((path) =>
        [
          '/assets/asset-hero',
          '/assets/asset-hero/content',
          '/assets/asset-logo',
          '/assets/asset-logo/content',
          '/assets/asset-gone',
        ].includes(path),
      ) && !traffic.assetRequests.includes('/assets/asset-gone/content'),
      traffic.assetRequests.join(', '),
    );
    if (viewport.width === PHONE.width) {
      const overflow = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      check(
        `${label}: no horizontal overflow at ${PHONE.width}px`,
        overflow.scroll <= overflow.client,
        `${overflow.scroll}px content in ${overflow.client}px`,
      );
    }
    checkTraffic(label, traffic);
  } finally {
    await context.close();
  }
}

async function previewsWithoutAssetAccess(browser, origin) {
  const label = 'without assets:read';
  const { context, page, traffic } = await openContext(browser, origin, {
    permissions: REVIEW_PERMISSIONS,
    viewport: DESKTOP,
  });
  try {
    const detail = await openReview(page);
    const fallback = detail.getByText(
      'Image selected · you do not have permission to view assets',
    );
    await fallback.first().waitFor({ timeout: 10000 });
    check(
      `${label}: every image field shows the permission fallback`,
      (await fallback.count()) === 3,
      `${await fallback.count()} fallbacks`,
    );
    check(
      `${label}: no image is rendered`,
      (await detail.locator('img').count()) === 0,
    );
    check(
      `${label}: no asset request is made`,
      traffic.assetRequests.length === 0,
      traffic.assetRequests.join(', '),
    );
    checkTraffic(label, traffic);
  } finally {
    await context.close();
  }
}

// --------------------------------------------------------------------- main

async function main() {
  const outDir = mkdtempSync(join(tmpdir(), 'adflow-e2e-web-'));
  let preview;
  let browser;
  const stop = () => {
    preview?.child.kill();
  };
  process.once('SIGINT', () => {
    stop();
    process.exit(130);
  });
  try {
    const port = await freePort();
    const origin = `http://${HOST}:${port}`;
    console.log(`Building the web app into ${outDir}`);
    // Same-origin API base, so every API call is intercepted without CORS.
    await run(
      ['build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn'],
      {
        VITE_API_BASE_URL: `${origin}/api/v1`,
      },
    );
    preview = startPreview(outDir, port);
    await preview.ready;
    console.log(`Serving on ${origin}`);
    browser = await launchBrowser();
    console.log(`Browser: ${browser.version()}`);
    await previewsWithAssetAccess(browser, origin, DESKTOP, 'desktop');
    await previewsWithAssetAccess(browser, origin, PHONE, `${PHONE.width}px`);
    await previewsWithoutAssetAccess(browser, origin);
  } finally {
    await browser?.close().catch(() => undefined);
    stop();
    rmSync(outDir, { recursive: true, force: true });
  }
  if (failures.length) {
    console.log(`\n${failures.length} check(s) failed.`);
    process.exitCode = 1;
  } else console.log('\nAll approval image checks passed.');
}

main().catch((error) => {
  console.error(String(error?.stack ?? error));
  process.exitCode = 1;
});
