import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import App from './App';
import { SESSION_STORAGE_KEY } from './authStorage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const healthResponse = {
  status: 'ok',
  service: 'adflow-api',
  timestamp: '2026-01-01T00:00:00.000Z',
};

const loginResponse = {
  accessToken: 'memory-only-token',
  expiresIn: 900,
  user: {
    id: 'user-1',
    organizationId: 'org-1',
    name: 'Local Admin',
    email: 'admin@example.local',
    permissions: [
      'branches:read',
      'templates:read',
      'creatives:read',
      'canva:integration:read',
    ],
    branches: [{ id: 'branch-1', name: 'Central', code: 'CENTRAL' }],
  },
};

describe('AdFlow Sprint 1 application shell', () => {
  beforeEach(() => localStorage.clear());

  it('continues to show API availability', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => healthResponse }),
    );
    render(<App />);
    expect(await screen.findByRole('status')).toHaveTextContent('API online');
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('logs in and shows the current identity and permitted branch context', async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: string) => {
      if (input.endsWith('/health'))
        return { ok: true, json: async () => healthResponse };
      if (input.endsWith('/auth/login'))
        return { ok: true, json: async () => loginResponse };
      if (input.endsWith('/branches/branch-1'))
        return {
          ok: true,
          json: async () => ({
            id: 'branch-1',
            name: 'Central',
            code: 'CENTRAL',
            status: 'ACTIVE',
          }),
        };
      if (input.endsWith('/notifications/unread-count'))
        return { ok: true, json: async () => ({ count: 0 }) };
      if (input.endsWith('/notifications'))
        return { ok: true, json: async () => [] };
      return { ok: false, status: 404 };
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'admin@example.local' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'local-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Hello, Local Admin.')).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Central' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('navigation', { name: 'Workspace modules' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Templates' })).toHaveAttribute(
      'href',
      '#templates',
    );
    expect(screen.getByRole('link', { name: 'Creatives' })).toHaveAttribute(
      'href',
      '#creatives',
    );
    expect(screen.getByRole('link', { name: 'Canva mock' })).toHaveAttribute(
      'href',
      '#canva-integration',
    );
    expect(
      screen.queryByText('ORGANIZATION ADMINISTRATION'),
    ).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:3000/api/v1/auth/login',
      expect.objectContaining({ method: 'POST' }),
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3000/api/v1/branches/branch-1',
        expect.objectContaining({
          headers: { Authorization: 'Bearer memory-only-token' },
        }),
      ),
    );
  });

  it('shows a generic login error when credentials are rejected', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => healthResponse })
      .mockResolvedValueOnce({ ok: false, status: 401 });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'admin@example.local' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'bad-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Invalid email or password',
    );
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });
});

type MockResponse = { ok: boolean; status?: number; json?: () => unknown };
type RouteHandler = (
  init?: RequestInit,
) => MockResponse | Promise<MockResponse>;

const meResponse = {
  id: 'user-1',
  organizationId: 'org-1',
  name: 'Server Admin',
  email: 'admin@example.local',
  permissions: ['branches:read', 'templates:read'],
  branches: [{ id: 'branch-2', name: 'North', code: 'NORTH' }],
};

const meOk: RouteHandler = () => ({ ok: true, json: async () => meResponse });

function mockApi(routes: Record<string, RouteHandler>) {
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const path = input.replace('http://localhost:3000/api/v1', '');
    if (path === '/health')
      return { ok: true, json: async () => healthResponse };
    const handler = routes[path];
    if (handler) return handler(init);
    if (path.startsWith('/branches/'))
      return {
        ok: true,
        json: async () => ({
          id: path.slice('/branches/'.length),
          name: 'North',
          code: 'NORTH',
          status: 'ACTIVE',
        }),
      };
    if (path === '/notifications/unread-count')
      return { ok: true, json: async () => ({ count: 0 }) };
    if (path === '/notifications') return { ok: true, json: async () => [] };
    return { ok: false, status: 404, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function callsTo(fetchMock: ReturnType<typeof mockApi>, path: string) {
  return fetchMock.mock.calls.filter(
    ([input]) => input === `http://localhost:3000/api/v1${path}`,
  );
}

function saveSession(accessToken: string, expiresAt = Date.now() + 60_000) {
  localStorage.setItem(
    SESSION_STORAGE_KEY,
    JSON.stringify({ accessToken, expiresAt }),
  );
}

function storedSession(): unknown {
  const raw = localStorage.getItem(SESSION_STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

function notifyStorageChange(key: string | null = SESSION_STORAGE_KEY) {
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key }));
  });
}

async function signIn() {
  fireEvent.change(screen.getByLabelText('Email'), {
    target: { value: 'admin@example.local' },
  });
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: 'local-password' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByText('Hello, Local Admin.');
}

describe('session persistence across reloads and tabs', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('stores only the access token and its expiry after login', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    mockApi({
      '/auth/login': () => ({ ok: true, json: async () => loginResponse }),
    });
    render(<App />);
    await signIn();
    expect(storedSession()).toEqual({
      accessToken: 'memory-only-token',
      expiresAt: 1_000_000 + 900_000,
    });
    expect(localStorage.length).toBe(1);
  });

  it('restores a saved session from /auth/me after a reload', async () => {
    saveSession('saved-token');
    const fetchMock = mockApi({ '/auth/me': meOk });
    render(<App />);
    expect(screen.getByText('Restoring your session…')).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(await screen.findByText('Hello, Server Admin.')).toBeInTheDocument();
    expect(callsTo(fetchMock, '/auth/me')).toEqual([
      [
        'http://localhost:3000/api/v1/auth/me',
        expect.objectContaining({
          headers: { Authorization: 'Bearer saved-token' },
        }),
      ],
    ]);
    await waitFor(() =>
      expect(callsTo(fetchMock, '/branches/branch-2')).toHaveLength(1),
    );
    expect(callsTo(fetchMock, '/auth/login')).toHaveLength(0);
    expect(storedSession()).toMatchObject({ accessToken: 'saved-token' });
  });

  it('takes identity, permissions, and branches from /auth/me, not storage', async () => {
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        accessToken: 'saved-token',
        expiresAt: Date.now() + 60_000,
        user: {
          name: 'Tampered Name',
          permissions: ['audit:read', 'organizations:update'],
          branches: [{ id: 'branch-9', name: 'Injected', code: 'INJ' }],
        },
      }),
    );
    const fetchMock = mockApi({ '/auth/me': meOk });
    render(<App />);
    expect(await screen.findByText('Hello, Server Admin.')).toBeInTheDocument();
    expect(screen.queryByText(/Tampered Name/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Audit' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Administration' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: 'North · NORTH' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: /Injected/ }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(callsTo(fetchMock, '/branches/branch-2')).toHaveLength(1),
    );
    expect(callsTo(fetchMock, '/branches/branch-9')).toHaveLength(0);
  });

  it.each([
    [
      'an expired entry',
      JSON.stringify({ accessToken: 't', expiresAt: Date.now() - 1 }),
    ],
    ['malformed JSON', '{not json'],
    ['a missing token', JSON.stringify({ expiresAt: Date.now() + 60_000 })],
    [
      'a non-numeric expiry',
      JSON.stringify({ accessToken: 't', expiresAt: 'later' }),
    ],
  ])('removes %s without an authenticated request', async (_label, raw) => {
    localStorage.setItem(SESSION_STORAGE_KEY, raw);
    const fetchMock = mockApi({ '/auth/me': meOk });
    render(<App />);
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/health',
      expect.anything(),
    );
  });

  it('clears the saved session when /auth/me returns 401', async () => {
    saveSession('revoked-token');
    mockApi({ '/auth/me': () => ({ ok: false, status: 401 }) });
    render(<App />);
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(
      screen.getByText('Your session expired. Please sign in again.'),
    ).toBeInTheDocument();
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  it('does not remove a newer session saved by another tab when a stale token is rejected', async () => {
    saveSession('stale-token');
    mockApi({
      '/auth/me': () => {
        // Another tab signs in while this tab's restoration is in flight.
        saveSession('newer-token');
        return { ok: false, status: 401 };
      },
    });
    render(<App />);
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(storedSession()).toMatchObject({ accessToken: 'newer-token' });
  });

  it('keeps the token on a server or network failure and allows retry', async () => {
    saveSession('saved-token');
    const meHandler = vi
      .fn<RouteHandler>()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: true, json: async () => meResponse });
    mockApi({ '/auth/me': meHandler });
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to restore your session (HTTP 503). Your saved sign-in was kept.',
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('saved-token');
    expect(storedSession()).toMatchObject({ accessToken: 'saved-token' });
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to reach the API to restore your session.',
    );
    expect(storedSession()).toMatchObject({ accessToken: 'saved-token' });

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Hello, Server Admin.')).toBeInTheDocument();
    expect(meHandler).toHaveBeenCalledTimes(3);
  });

  it('clears the session on logout even when the logout request fails', async () => {
    saveSession('saved-token');
    const fetchMock = mockApi({
      '/auth/me': meOk,
      '/auth/logout': () => Promise.reject(new TypeError('Failed to fetch')),
    });
    render(<App />);
    await screen.findByText('Hello, Server Admin.');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(
      screen.queryByText('Your session expired. Please sign in again.'),
    ).not.toBeInTheDocument();
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(callsTo(fetchMock, '/auth/logout')).toEqual([
      [
        'http://localhost:3000/api/v1/auth/logout',
        expect.objectContaining({
          method: 'POST',
          headers: { Authorization: 'Bearer saved-token' },
        }),
      ],
    ]);
  });

  it('clears the saved session when a child workspace reports 401', async () => {
    saveSession('saved-token');
    mockApi({
      '/auth/me': meOk,
      '/templates': () => ({ ok: false, status: 401 }),
    });
    render(<App />);
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(
      screen.getByText('Your session expired. Please sign in again.'),
    ).toBeInTheDocument();
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  it('clears the saved session when the branch request returns 401', async () => {
    saveSession('saved-token');
    mockApi({
      '/auth/me': () => ({
        ok: true,
        json: async () => ({ ...meResponse, permissions: ['branches:read'] }),
      }),
      '/branches/branch-2': () => ({ ok: false, status: 401 }),
    });
    render(<App />);
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  it('validates a sign-in from another tab through /auth/me before restoring it', async () => {
    const fetchMock = mockApi({ '/auth/me': meOk });
    render(<App />);
    await screen.findByLabelText('Password');
    expect(callsTo(fetchMock, '/auth/me')).toHaveLength(0);

    saveSession('other-tab-token');
    notifyStorageChange();
    expect(await screen.findByText('Hello, Server Admin.')).toBeInTheDocument();
    expect(callsTo(fetchMock, '/auth/me')).toEqual([
      [
        'http://localhost:3000/api/v1/auth/me',
        expect.objectContaining({
          headers: { Authorization: 'Bearer other-tab-token' },
        }),
      ],
    ]);

    // Repeated events for the same token do not start another restoration.
    notifyStorageChange();
    expect(screen.getByText('Hello, Server Admin.')).toBeInTheDocument();
    expect(callsTo(fetchMock, '/auth/me')).toHaveLength(1);
  });

  it('signs out when another tab logs out or clears the token', async () => {
    saveSession('saved-token');
    const fetchMock = mockApi({ '/auth/me': meOk });
    render(<App />);
    await screen.findByText('Hello, Server Admin.');

    localStorage.removeItem(SESSION_STORAGE_KEY);
    notifyStorageChange();
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(
      screen.queryByText('Your session expired. Please sign in again.'),
    ).not.toBeInTheDocument();
    // The tab that signed out already revoked the server session.
    expect(callsTo(fetchMock, '/auth/logout')).toHaveLength(0);
  });

  it('signs out when another tab clears all storage', async () => {
    saveSession('saved-token');
    mockApi({ '/auth/me': meOk });
    render(<App />);
    await screen.findByText('Hello, Server Admin.');
    localStorage.clear();
    notifyStorageChange(null);
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
  });

  it('ignores unrelated storage keys', async () => {
    saveSession('saved-token');
    const fetchMock = mockApi({ '/auth/me': meOk });
    render(<App />);
    await screen.findByText('Hello, Server Admin.');
    notifyStorageChange('unrelated-key');
    expect(screen.getByText('Hello, Server Admin.')).toBeInTheDocument();
    expect(callsTo(fetchMock, '/auth/me')).toHaveLength(1);
  });

  it('makes one restoration request and aborts it on unmount', async () => {
    saveSession('saved-token');
    let resolveMe: (response: MockResponse) => void = () => undefined;
    let meSignal: AbortSignal | null | undefined;
    const fetchMock = mockApi({
      '/auth/me': (init) => {
        meSignal = init?.signal;
        return new Promise<MockResponse>((resolve) => {
          resolveMe = resolve;
        });
      },
    });
    const consoleError = vi.spyOn(console, 'error');
    const { unmount } = render(<App />);
    await waitFor(() => expect(callsTo(fetchMock, '/auth/me')).toHaveLength(1));
    unmount();
    expect(meSignal?.aborted).toBe(true);
    await act(async () => {
      resolveMe({ ok: true, json: async () => meResponse });
    });
    expect(callsTo(fetchMock, '/auth/me')).toHaveLength(1);
    expect(consoleError).not.toHaveBeenCalled();
    expect(storedSession()).toMatchObject({ accessToken: 'saved-token' });
  });
});
