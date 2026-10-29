import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { AuthenticatedUserResponse } from '@adflow/shared-types';
import ApprovalsWorkspace from './ApprovalsWorkspace';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const user: AuthenticatedUserResponse = {
  id: 'reviewer-1',
  organizationId: 'org-1',
  name: 'Reviewer',
  email: 'reviewer@example.local',
  permissions: [
    'approvals:read',
    'approvals:decide',
    'change_requests:read',
    'change_requests:create',
    'change_requests:resolve',
    'comments:read',
    'comments:create',
  ],
  branches: [],
};
const task = {
  id: 'task-1',
  status: 'OPEN',
  stage: { key: 'review', name: 'Review' },
  instance: {
    id: 'instance-1',
    creative: {
      id: 'creative-1',
      name: 'Spring post',
      currentRevision: { revisionNumber: 3 },
    },
  },
};
const review = {
  task: {
    id: 'task-1',
    status: 'OPEN',
    stage: { key: 'review', name: 'Review' },
  },
  workflow: { id: 'workflow-1', name: 'Branch workflow' },
  creative: {
    id: 'creative-1',
    name: 'Spring post',
    currentRevisionId: 'revision-3',
  },
  revision: {
    id: 'revision-3',
    revisionNumber: 3,
    values: { headline: 'Fresh offer' },
    templateVersion: {
      fields: [{ key: 'headline', label: 'Headline', type: 'TEXT' }],
    },
  },
  current: true,
};

describe('ApprovalsWorkspace', () => {
  it('shows the exact revision, requests changes, comments, and resolves a linked request', async () => {
    let decisionSaved = false;
    let commentSaved = false;
    let requestStatus = 'OPEN';
    let requestExplanation: string | null = null;
    const fetchMock = vi
      .fn()
      .mockImplementation(async (url: string, init?: RequestInit) => {
        let body: unknown = {};
        if (url.endsWith('/approvals/tasks'))
          body = decisionSaved ? [] : [task];
        else if (url.endsWith('/approvals/tasks/task-1'))
          body = {
            ...review,
            current: !decisionSaved,
            task: {
              ...review.task,
              status: decisionSaved ? 'COMPLETED' : 'OPEN',
            },
          };
        else if (url.endsWith('/comments') && init?.method === 'POST') {
          commentSaved = true;
          body = {};
        } else if (url.endsWith('/comments'))
          body = commentSaved
            ? [
                {
                  id: 'comment-1',
                  text: 'Looks good',
                  createdAt: '2026-10-22',
                  author: { name: 'Reviewer' },
                },
              ]
            : [];
        else if (url.endsWith('/decisions'))
          body = decisionSaved
            ? [
                {
                  id: 'decision-1',
                  revisionNumber: 3,
                  decision: 'CHANGES_REQUESTED',
                  reason: 'Please update the offer',
                  createdAt: '2026-10-22',
                  reviewer: { name: 'Reviewer' },
                },
              ]
            : [];
        else if (url.endsWith('/change-requests'))
          body = decisionSaved
            ? [
                {
                  id: 'request-1',
                  revisionNumber: 3,
                  requestedChanges: 'Please update the offer',
                  explanation: requestExplanation,
                  status: requestStatus,
                },
              ]
            : [];
        else if (url.endsWith('/decision')) {
          requestExplanation =
            JSON.parse(String(init?.body)).explanation ?? null;
          decisionSaved = true;
          body = {};
        } else if (url.endsWith('/start')) {
          requestStatus = 'IN_PROGRESS';
          body = {};
        } else if (url.endsWith('/resolve')) {
          requestStatus = 'RESOLVED';
          body = {};
        }
        return { ok: true, status: 200, json: async () => body };
      });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ApprovalsWorkspace
        session={{ accessToken: 'token', user }}
        onUnauthorized={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(
      await screen.findByRole('heading', { name: 'Spring post · Revision 3' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Fresh offer')).toBeInTheDocument();
    fireEvent.change(
      screen.getByLabelText('Decision reason or requested changes'),
      { target: { value: 'Please update the offer' } },
    );
    fireEvent.change(screen.getByLabelText('Optional explanation'), {
      target: { value: 'Keep the price label aligned with the approved copy.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    expect(await screen.findByText(/Revision 3 · Open:/)).toBeInTheDocument();
    expect(
      await screen.findByText(/Keep the price label aligned/),
    ).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Start work' }));
    expect(
      await screen.findByText(/Revision 3 · In progress:/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(
      await screen.findByText(/Revision 3 · Resolved:/),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Add a comment'), {
      target: { value: 'Looks good' },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add comment' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/revisions/3/comments'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(await screen.findByText(/Looks good/)).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/approvals/tasks/task-1/decision'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });
});
