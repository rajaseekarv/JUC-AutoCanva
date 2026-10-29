import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AuditWorkspace, NotificationsWorkspace } from './ActivityWorkspaces';

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

describe('Sprint 8 activity workspaces', () => {
  it('loads unread notifications and supports marking a notice read', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: 'n1',
            title: 'Review',
            message: 'Ready',
            type: 'REVIEW',
            createdAt: '2026-01-01T00:00:00Z',
            readAt: null,
            entityType: 'task',
            entityId: 't1',
          },
        ],
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ count: 1 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ count: 0 }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<NotificationsWorkspace session={session} />);
    expect(await screen.findByText('Review')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mark read' }));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/notifications/n1/read'),
      expect.objectContaining({ method: 'POST' }),
    );
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
