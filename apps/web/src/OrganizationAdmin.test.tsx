import { afterEach, describe, expect, it, vi } from 'vitest';
import {
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

const adminSession = {
  accessToken: 'test-token',
  user: {
    permissions: [
      'organizations:update',
      'branches:manage',
      'users:branch-access:manage',
    ],
  },
};

describe('OrganizationAdmin', () => {
  it('loads the organization and shows administration controls only to permitted users', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/organization')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            id: 'org-1',
            name: 'AdFlow Local',
            code: 'ADFLOW',
            status: 'ACTIVE',
          }),
        });
      }
      if (url.endsWith('/branches'))
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      if (url.endsWith('/users'))
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      return Promise.resolve({ ok: true, status: 200, json: async () => [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <OrganizationAdmin session={adminSession} onUnauthorized={vi.fn()} />,
    );

    await waitFor(() =>
      expect(
        screen.getByLabelText('Name', { selector: '#organization-name' }),
      ).toHaveValue('AdFlow Local'),
    );
    // No users: an empty state instead of an empty user picker (Phase 3.3).
    expect(
      screen.getByText(
        'There are no users in this organization to give branch access to.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Organization user')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Create branch' }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/organization$/),
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
  });

  it('renders no administration controls without management permissions', () => {
    const view = render(
      <OrganizationAdmin
        session={{
          accessToken: 'test-token',
          user: { permissions: ['branches:read'] },
        }}
        onUnauthorized={vi.fn()}
      />,
    );
    expect(view.container).toBeEmptyDOMElement();
  });
});

// Phase 2A: deactivating a branch and revoking access are confirmed first,
// and the branch form marks required and optional fields.
describe('OrganizationAdmin Phase 2A', () => {
  const branch = {
    id: 'branch-1',
    name: 'North',
    code: 'NORTH',
    status: 'ACTIVE',
    address: null,
    city: 'Chennai',
    state: null,
    pincode: null,
    phone: null,
    whatsapp: null,
    email: null,
    googleMapsUrl: null,
    timezone: 'Asia/Kolkata',
  };
  function serve(options: { failRevoke?: boolean } = {}) {
    let branchStatus = 'ACTIVE';
    let granted = true;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const reply = (body: unknown, status = 200) => ({
          ok: true,
          status,
          json: async () => body,
        });
        if (url.endsWith('/organization'))
          return reply({
            id: 'org-1',
            name: 'Org',
            code: 'ORG',
            status: 'ACTIVE',
          });
        if (url.endsWith('/branches/branch-1/deactivate')) {
          branchStatus = 'INACTIVE';
          return reply({ ...branch, status: branchStatus });
        }
        if (url.endsWith('/users'))
          return reply([
            { id: 'user-2', name: 'Priya', email: 'priya@example.local' },
          ]);
        if (
          url.endsWith('/users/user-2/branches/branch-1') &&
          init?.method === 'DELETE'
        ) {
          if (options.failRevoke)
            return { ok: false, status: 500, json: async () => ({}) };
          granted = false;
          return reply(undefined, 204);
        }
        if (url.endsWith('/users/user-2/branches'))
          return reply(
            granted
              ? [{ branch: { id: 'branch-1', name: 'North', code: 'NORTH' } }]
              : [],
          );
        if (url.endsWith('/branches'))
          return reply([{ ...branch, status: branchStatus }]);
        return reply([]);
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  const calls = (fetchMock: ReturnType<typeof serve>, pattern: RegExp) =>
    fetchMock.mock.calls.filter(([url, init]) =>
      pattern.test(String(url) + ' ' + ((init as RequestInit)?.method ?? '')),
    );

  it('deactivates a branch only after explaining the consequence', async () => {
    const fetchMock = serve();
    render(
      <OrganizationAdmin session={adminSession} onUnauthorized={vi.fn()} />,
    );
    const branches = within(
      await screen.findByRole('region', { name: 'Branches' }),
    );
    fireEvent.click(
      await branches.findByRole('button', { name: 'Deactivate' }),
    );
    const group = screen.getByRole('group', {
      name: 'Confirm deactivating North',
    });
    expect(group).toHaveTextContent(
      'Deactivate North? Nobody can choose or work in this branch until it is activated again. Its creatives, brand settings and history are kept, and you can activate it again at any time.',
    );
    fireEvent.click(within(group).getByRole('button', { name: 'Keep active' }));
    expect(branches.getByRole('button', { name: 'Deactivate' })).toHaveFocus();
    expect(calls(fetchMock, /deactivate/)).toHaveLength(0);

    fireEvent.click(branches.getByRole('button', { name: 'Deactivate' }));
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Confirm deactivating North' }),
      ).getByRole('button', { name: 'Deactivate branch' }),
    );
    expect(await screen.findByText('Branch deactivated.')).toBeInTheDocument();
    expect(calls(fetchMock, /deactivate/)).toHaveLength(1);
    // Activating is not destructive and needs no confirmation.
    expect(
      await branches.findByRole('button', { name: 'Activate' }),
    ).toBeInTheDocument();
  });

  it('revokes branch access only after confirmation', async () => {
    const fetchMock = serve();
    render(
      <OrganizationAdmin session={adminSession} onUnauthorized={vi.fn()} />,
    );
    const access = within(
      await screen.findByRole('region', { name: 'User branch access' }),
    );
    fireEvent.click(
      await access.findByRole('button', { name: 'Revoke access' }),
    );
    const group = screen.getByRole('group', {
      name: 'Confirm revoking access to North',
    });
    // Administrators whose role manages every branch are not restricted by
    // revoking an assigned branch, and the text says so.
    expect(group).toHaveTextContent(
      "Revoke Priya's access to North? The branch is removed from the branches assigned to them, so they can no longer see or work on its creatives, brand or workflows through this access. If their role lets them manage every branch (as administrators' roles usually do), they keep access to all branches through that role. You can grant access again at any time.",
    );
    // The confirm button keeps the visible text "Revoke access" but has its
    // own accessible name, distinct from the button that opened it.
    expect(
      screen.getAllByRole('button', { name: 'Revoke access' }),
    ).toHaveLength(1);
    expect(
      within(group).getByRole('button', { name: 'Revoke access to North' }),
    ).toHaveTextContent('Revoke access');
    fireEvent.click(within(group).getByRole('button', { name: 'Keep access' }));
    expect(calls(fetchMock, /branches\/branch-1 DELETE/)).toHaveLength(0);
    expect(access.getByRole('button', { name: 'Revoke access' })).toHaveFocus();

    fireEvent.click(access.getByRole('button', { name: 'Revoke access' }));
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Confirm revoking access to North' }),
      ).getByRole('button', { name: 'Revoke access to North' }),
    );
    expect(
      await screen.findByText(
        'Branch access revoked: Priya no longer has assigned access to North.',
      ),
    ).toBeInTheDocument();
    expect(calls(fetchMock, /branches\/branch-1 DELETE/)).toHaveLength(1);
    expect(
      await access.findByRole('button', { name: 'Grant access' }),
    ).toBeInTheDocument();
  });

  it('keeps the revoke confirmation open with an error when revoking fails', async () => {
    const fetchMock = serve({ failRevoke: true });
    render(
      <OrganizationAdmin session={adminSession} onUnauthorized={vi.fn()} />,
    );
    const access = within(
      await screen.findByRole('region', { name: 'User branch access' }),
    );
    fireEvent.click(
      await access.findByRole('button', { name: 'Revoke access' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Revoke access to North' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to complete the request.',
    );
    expect(calls(fetchMock, /branches\/branch-1 DELETE/)).toHaveLength(1);
    expect(
      screen.getByRole('group', { name: 'Confirm revoking access to North' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/^Branch access revoked/),
    ).not.toBeInTheDocument();
  });

  it('marks required and optional branch fields', async () => {
    serve();
    render(
      <OrganizationAdmin session={adminSession} onUnauthorized={vi.fn()} />,
    );
    expect(
      await screen.findByLabelText('Name (required)', {
        selector: '#branch-name',
      }),
    ).toBeRequired();
    expect(screen.getByLabelText('Time zone (required)')).toBeRequired();
    expect(screen.getByLabelText('PIN code (optional)')).not.toBeRequired();
    expect(screen.getByLabelText('WhatsApp (optional)')).not.toBeRequired();
    expect(
      screen.getByLabelText('Google Maps link (optional)'),
    ).toHaveAttribute('type', 'url');
  });
});
