// Phase 3.3 regression tests: administration loading, errors, empty states
// and retries, and user branch access that always belongs to the user shown.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import OrganizationAdmin from './OrganizationAdmin';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const session = {
  accessToken: 'token',
  user: {
    permissions: [
      'organizations:update',
      'branches:manage',
      'users:branch-access:manage',
    ],
  },
};
const branchOf = (id: string, name: string) => ({
  id,
  name,
  code: name.toUpperCase(),
  status: 'ACTIVE',
  address: null,
  city: null,
  state: null,
  pincode: null,
  phone: null,
  whatsapp: null,
  email: null,
  googleMapsUrl: null,
  timezone: 'Asia/Kolkata',
});
const NORTH = branchOf('b-north', 'North');
const SOUTH = branchOf('b-south', 'South');
const USERS = [
  { id: 'u-priya', name: 'Priya', email: 'priya@example.local' },
  { id: 'u-arjun', name: 'Arjun', email: 'arjun@example.local' },
  { id: 'u-meera', name: 'Meera', email: 'meera@example.local' },
];

function reply(status: number, body?: unknown): Response {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    ok: status < 300,
    status,
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
  } as Response;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

type Route = (method: string, path: string) => Promise<Response> | undefined;
// A fake administration API; `access` holds each user's granted branches.
function stubApi(route: Route = () => undefined) {
  const state = {
    organization: { id: 'org', name: 'Acme', code: 'ACME', status: 'ACTIVE' },
    branches: [NORTH, SOUTH],
    users: USERS,
    access: {
      'u-priya': [NORTH],
      'u-arjun': [SOUTH],
      'u-meera': [],
    } as Record<string, (typeof NORTH)[]>,
  };
  const writes: { method: string; path: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname.replace(/^\/api\/v1/, '');
      const method = init?.method ?? 'GET';
      if (method !== 'GET') writes.push({ method, path });
      const routed = route(method, path);
      if (routed) return routed;
      if (path === '/organization') return reply(200, state.organization);
      if (path === '/branches' && method === 'GET')
        return reply(200, state.branches);
      if (path === '/users') return reply(200, state.users);
      const list = /^\/users\/([^/]+)\/branches$/.exec(path);
      if (list)
        return reply(
          200,
          (state.access[list[1]!] ?? []).map((branch) => ({ branch })),
        );
      const one = /^\/users\/([^/]+)\/branches\/([^/]+)$/.exec(path);
      if (one) {
        const branch = state.branches.find((item) => item.id === one[2])!;
        const current = state.access[one[1]!] ?? [];
        if (method === 'POST') {
          state.access[one[1]!] = [...current, branch];
          return reply(201, { userId: one[1], branchId: one[2] });
        }
        const had = current.some((item) => item.id === one[2]);
        state.access[one[1]!] = current.filter((item) => item.id !== one[2]);
        return reply(200, { userId: one[1], branchId: one[2], revoked: had });
      }
      return reply(404, { message: 'Not found' });
    }),
  );
  return { state, writes };
}

const renderAdmin = () =>
  render(<OrganizationAdmin session={session} onUnauthorized={vi.fn()} />);
const accessRegion = () =>
  within(screen.getByRole('region', { name: 'User branch access' }));
const chooseUser = (id: string) =>
  fireEvent.change(screen.getByLabelText('Organization user'), {
    target: { value: id },
  });
// The row for a branch in the user access list.
const accessRow = (name: string) =>
  within(
    accessRegion()
      .getAllByRole('listitem')
      .find((item) => within(item).queryByText(name))!,
  );

describe('Administration loading and errors (Phase 3.3)', () => {
  it('shows a loading state, not empty lists, until the settings arrive', async () => {
    const organization = deferred<Response>();
    stubApi((_method, path) =>
      path === '/organization' ? organization.promise : undefined,
    );
    renderAdmin();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading organization settings…',
    );
    expect(screen.queryByRole('region', { name: 'Branches' })).toBeNull();
    expect(screen.queryByText(/No branches yet/)).toBeNull();
    await act(async () =>
      organization.resolve(
        reply(200, { id: 'org', name: 'Acme', code: 'ACME', status: 'ACTIVE' }),
      ),
    );
    expect(
      await screen.findByRole('region', { name: 'Branches' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Loading organization settings…')).toBeNull();
  });

  it('explains a failed load and loads again with Try again', async () => {
    let fail = true;
    stubApi((_method, path) =>
      path === '/branches' && fail
        ? Promise.resolve(reply(500, { message: 'boom' }))
        : undefined,
    );
    renderAdmin();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Organization settings couldn't be loaded. Please try again.",
    );
    expect(screen.queryByRole('region', { name: 'Branches' })).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('region', { name: 'Branches' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps what is shown when a refresh fails, and says it may be out of date', async () => {
    let fail = false;
    stubApi((_method, path) =>
      path === '/branches' && fail
        ? Promise.resolve(reply(503, {}))
        : undefined,
    );
    renderAdmin();
    await screen.findByRole('region', { name: 'Branches' });
    fail = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Organization settings couldn't be loaded. What is shown below may be out of date.",
    );
    expect(
      within(screen.getByRole('region', { name: 'Branches' })).getByText(
        'North',
      ),
    ).toBeInTheDocument();
  });

  it('shows empty states for no branches and no users', async () => {
    const { state } = stubApi();
    state.branches = [];
    state.users = [];
    renderAdmin();
    expect(
      await screen.findByText(
        'No branches yet. Create the first one with the form below.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'There are no users in this organization to give branch access to.',
      ),
    ).toBeInTheDocument();
  });

  it("shows the server's reason for a refused branch save and keeps the typed details", async () => {
    const { writes } = stubApi((method, path) =>
      method === 'POST' && path === '/branches'
        ? Promise.resolve(
            reply(409, { message: 'Branch code is already in use' }),
          )
        : undefined,
    );
    renderAdmin();
    await screen.findByRole('region', { name: 'Branches' });
    fireEvent.change(
      screen.getByLabelText('Name (required)', { selector: '#branch-name' }),
      {
        target: { value: 'East' },
      },
    );
    fireEvent.change(
      screen.getByLabelText('Code (required)', { selector: '#branch-code' }),
      {
        target: { value: 'NORTH' },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create branch' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Branch code is already in use.',
    );
    expect(writes).toEqual([{ method: 'POST', path: '/branches' }]);
    expect(screen.queryByText('Branch created.')).toBeNull();
    expect(
      screen.getByLabelText('Name (required)', { selector: '#branch-name' }),
    ).toHaveValue('East');
    expect(
      screen.getByLabelText('Code (required)', { selector: '#branch-code' }),
    ).toHaveValue('NORTH');
  });

  it('keeps unsaved organization details when the settings reload', async () => {
    const { state } = stubApi();
    renderAdmin();
    const name = await screen.findByLabelText('Name', {
      selector: '#organization-name',
    });
    fireEvent.change(name, { target: { value: 'Acme (typed)' } });
    state.organization = { ...state.organization, code: 'ACME2' };
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled(),
    );
    expect(name).toHaveValue('Acme (typed)');
  });
});

describe('User branch access (Phase 3.3)', () => {
  it("shows nothing actionable for the next user until that user's own access arrives", async () => {
    const arjun = deferred<Response>();
    stubApi((_method, path) =>
      path === '/users/u-arjun/branches' ? arjun.promise : undefined,
    );
    renderAdmin();
    await waitFor(() =>
      expect(
        accessRow('North').getByText(/Access granted/),
      ).toBeInTheDocument(),
    );
    chooseUser('u-arjun');
    expect(accessRegion().getByRole('status')).toHaveTextContent(
      "Loading Arjun's branch access…",
    );
    expect(accessRegion().queryByRole('button', { name: /access/ })).toBeNull();
    expect(accessRegion().queryByText(/Access granted/)).toBeNull();
    await act(async () => arjun.resolve(reply(200, [{ branch: SOUTH }])));
    expect(accessRow('South').getByText(/Access granted/)).toBeInTheDocument();
    expect(accessRow('North').getByText(/No access/)).toBeInTheDocument();
  });

  it('ignores a late reply for a user who is no longer selected', async () => {
    const arjun = deferred<Response>();
    stubApi((_method, path) =>
      path === '/users/u-arjun/branches' ? arjun.promise : undefined,
    );
    renderAdmin();
    await waitFor(() =>
      expect(
        accessRow('North').getByText(/Access granted/),
      ).toBeInTheDocument(),
    );
    chooseUser('u-arjun');
    chooseUser('u-meera');
    await waitFor(() =>
      expect(accessRow('North').getByText(/No access/)).toBeInTheDocument(),
    );
    await act(async () =>
      arjun.resolve(reply(200, [{ branch: NORTH }, { branch: SOUTH }])),
    );
    expect(accessRow('North').getByText(/No access/)).toBeInTheDocument();
    expect(accessRow('South').getByText(/No access/)).toBeInTheDocument();
    expect(
      accessRow('North').getByRole('button', { name: 'Grant access' }),
    ).toBeInTheDocument();
  });

  it('explains a failed access load for that user, offers no actions, and retries', async () => {
    let fail = true;
    stubApi((_method, path) =>
      path === '/users/u-arjun/branches' && fail
        ? Promise.resolve(reply(500, {}))
        : undefined,
    );
    renderAdmin();
    await waitFor(() =>
      expect(
        accessRow('North').getByText(/Access granted/),
      ).toBeInTheDocument(),
    );
    chooseUser('u-arjun');
    expect(await accessRegion().findByRole('alert')).toHaveTextContent(
      "Arjun's branch access couldn't be loaded, so it can't be changed right now.",
    );
    expect(accessRegion().queryByRole('button', { name: /access/ })).toBeNull();
    fail = false;
    fireEvent.click(accessRegion().getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(
        accessRow('South').getByText(/Access granted/),
      ).toBeInTheDocument(),
    );
  });

  it('reports a grant only once the API confirms it, naming the user and branch', async () => {
    const grant = deferred<Response>();
    const { state } = stubApi((method) =>
      method === 'POST' ? grant.promise : undefined,
    );
    renderAdmin();
    await waitFor(() =>
      expect(accessRow('South').getByText(/No access/)).toBeInTheDocument(),
    );
    fireEvent.click(
      accessRow('South').getByRole('button', { name: 'Grant access' }),
    );
    await act(async () => undefined);
    expect(screen.queryByText(/^Branch access granted/)).toBeNull();
    state.access['u-priya'] = [NORTH, SOUTH];
    await act(async () => grant.resolve(reply(201, {})));
    expect(
      await screen.findByText(
        'Branch access granted: Priya can now work in South.',
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        accessRow('South').getByText(/Access granted/),
      ).toBeInTheDocument(),
    );
  });

  it("does not put one user's refreshed access under another user selected meanwhile", async () => {
    const grant = deferred<Response>();
    const { state } = stubApi((method) =>
      method === 'POST' ? grant.promise : undefined,
    );
    renderAdmin();
    await waitFor(() =>
      expect(accessRow('South').getByText(/No access/)).toBeInTheDocument(),
    );
    fireEvent.click(
      accessRow('South').getByRole('button', { name: 'Grant access' }),
    );
    chooseUser('u-meera');
    await waitFor(() =>
      expect(accessRow('North').getByText(/No access/)).toBeInTheDocument(),
    );
    state.access['u-priya'] = [NORTH, SOUTH];
    await act(async () => grant.resolve(reply(201, {})));
    expect(
      await screen.findByText(
        'Branch access granted: Priya can now work in South.',
      ),
    ).toBeInTheDocument();
    // Meera is still shown with her own (empty) access.
    expect(accessRow('North').getByText(/No access/)).toBeInTheDocument();
    expect(accessRow('South').getByText(/No access/)).toBeInTheDocument();
  });

  it('says nothing changed when the API reports there was no access to revoke', async () => {
    stubApi((method) =>
      method === 'DELETE'
        ? Promise.resolve(reply(200, { revoked: false }))
        : undefined,
    );
    renderAdmin();
    await waitFor(() =>
      expect(
        accessRow('North').getByText(/Access granted/),
      ).toBeInTheDocument(),
    );
    fireEvent.click(
      accessRow('North').getByRole('button', { name: 'Revoke access' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Revoke access to North' }),
    );
    expect(
      await screen.findByText(
        'Priya had no assigned access to North, so nothing changed.',
      ),
    ).toBeInTheDocument();
  });

  it("shows the server's reason for a refused grant, with no success message", async () => {
    stubApi((method) =>
      method === 'POST'
        ? Promise.resolve(reply(404, { message: 'User or branch not found' }))
        : undefined,
    );
    renderAdmin();
    await waitFor(() =>
      expect(accessRow('South').getByText(/No access/)).toBeInTheDocument(),
    );
    fireEvent.click(
      accessRow('South').getByRole('button', { name: 'Grant access' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'User or branch not found.',
    );
    expect(screen.queryByText(/^Branch access granted/)).toBeNull();
  });

  it('keeps the selected user across a reload while they are still listed', async () => {
    stubApi();
    renderAdmin();
    await waitFor(() =>
      expect(
        accessRow('North').getByText(/Access granted/),
      ).toBeInTheDocument(),
    );
    chooseUser('u-arjun');
    await waitFor(() =>
      expect(
        accessRow('South').getByText(/Access granted/),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled(),
    );
    expect(screen.getByLabelText('Organization user')).toHaveValue('u-arjun');
  });
});
