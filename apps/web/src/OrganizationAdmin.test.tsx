import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
    expect(screen.getByLabelText('Organization user')).toBeInTheDocument();
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
