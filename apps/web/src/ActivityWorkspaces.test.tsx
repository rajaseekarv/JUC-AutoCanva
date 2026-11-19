import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { AuditWorkspace, NotificationsWorkspace } from './ActivityWorkspaces';
import { useNotifications } from './useNotifications';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const session = {
  accessToken: 'test-token',
  user: {
    id: 'u1',
    organizationId: 'o1',
    name: 'User',
    email: 'user@example.local',
    permissions: ['audit:read'],
    branches: [],
  },
};

// The Notifications screen shows the shared state the app shell owns; here
// it is opened the way the shell opens it.
function OpenNotifications({ accessToken }: { accessToken: string }) {
  const notifications = useNotifications({
    accessToken,
    onUnauthorized: vi.fn(),
  });
  const { setScreenOpen } = notifications;
  useEffect(() => setScreenOpen(true), [setScreenOpen]);
  return <NotificationsWorkspace notifications={notifications} />;
}

describe('Sprint 8 activity workspaces', () => {
  it('loads unread notifications and supports marking a notice read', async () => {
    let read = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        read = true;
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (url.endsWith('/unread-count'))
        return {
          ok: true,
          status: 200,
          json: async () => ({ count: read ? 0 : 1 }),
        };
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 'n1',
            title: 'Review',
            message: 'Ready',
            type: 'REVIEW',
            createdAt: '2026-01-01T00:00:00Z',
            readAt: read ? '2026-01-02T00:00:00Z' : null,
            entityType: 'task',
            entityId: 't1',
          },
        ],
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<OpenNotifications accessToken={session.accessToken} />);
    expect(await screen.findByText('Review')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mark read' }));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/notifications/n1/read'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(
      await screen.findByText('No unread notifications'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark read' })).toBeNull();
  });

  // Phase 2A Q15: the unread count is spelled out, and Mark all read is
  // offered only when something is unread.
  it.each([
    [0, 'No unread notifications', false],
    [1, '1 unread', true],
    [3, '3 unread', true],
  ])('shows %i unread clearly', async (count, text, markAll) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () => (url.endsWith('/unread-count') ? { count } : []),
      })),
    );
    render(<OpenNotifications accessToken={session.accessToken} />);
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Mark all read' }) !== null,
    ).toBe(markAll);
    expect(
      screen.getByRole('heading', { name: 'Notifications' }),
    ).toBeInTheDocument();
  });

  it('shows audit history only when mounted for an authorized user and supports action filtering', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            id: 'a1',
            action: 'creative.created',
            entityType: 'creative',
            entityId: 'c1',
            actorUserId: 'u1',
            branchId: 'b1',
            createdAt: '2026-01-01T00:00:00Z',
            metadata: {},
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AuditWorkspace session={session} />);
    expect(await screen.findByText('creative.created')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Action'), {
      target: { value: 'creative.created' },
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining('action=creative.created'),
      expect.any(Object),
    );
  });
});
