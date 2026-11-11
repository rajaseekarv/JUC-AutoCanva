import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { AuthenticatedUserResponse } from '@adflow/shared-types';
import ApprovalsWorkspace from './ApprovalsWorkspace';
import { imageReply, statusReply, stubObjectUrls } from './assetTestUtils';

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

describe('ApprovalsWorkspace images', () => {
  let objectUrls: ReturnType<typeof stubObjectUrls>;
  beforeEach(() => {
    objectUrls = stubObjectUrls();
  });
  afterEach(() => {
    // Unmount first: images release their object URLs as they unmount.
    cleanup();
    objectUrls.restore();
  });

  const imageReview = {
    ...review,
    revision: {
      ...review.revision,
      values: { headline: 'Fresh offer', logo: 'asset-3' },
      templateVersion: {
        fields: [
          { key: 'headline', label: 'Headline', type: 'TEXT' },
          { key: 'logo', label: 'Logo', type: 'LOGO' },
        ],
      },
    },
  };

  function serveReview() {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/assets/asset-3/content')) return imageReply('asset-3');
      if (url.endsWith('/assets/asset-3'))
        return statusReply(200, {
          id: 'asset-3',
          organizationId: 'org-1',
          branchId: 'branch-1',
          originalName: 'spring-logo.webp',
          mimeType: 'image/webp',
          sizeBytes: 900,
          width: 400,
          height: 200,
          status: 'ACTIVE',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        });
      if (url.endsWith('/approvals/tasks')) return statusReply(200, [task]);
      if (url.endsWith('/approvals/tasks/task-1'))
        return statusReply(200, imageReview);
      return statusReply(200, []);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('shows the reviewed revision image and file name instead of the asset ID', async () => {
    serveReview();
    render(
      <ApprovalsWorkspace
        session={{
          accessToken: 'token',
          user: { ...user, permissions: [...user.permissions, 'assets:read'] },
        }}
        onUnauthorized={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(
      await screen.findByRole('img', { name: 'Logo: spring-logo.webp' }),
    ).toHaveAttribute('src', expect.stringMatching(/^blob:test\/asset-3\//));
    expect(screen.getByText('WebP · 400 × 200 px · 900 B')).toBeInTheDocument();
    expect(screen.queryByText('asset-3')).not.toBeInTheDocument();
  });

  it('requests no image without the asset read permission', async () => {
    const fetchMock = serveReview();
    render(
      <ApprovalsWorkspace
        session={{ accessToken: 'token', user }}
        onUnauthorized={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(
      await screen.findByText(
        'Image selected · you do not have permission to view assets',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('asset-3')).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/assets/')),
    ).toBe(false);
  });
});

describe('ApprovalsWorkspace review feedback', () => {
  function serveReview(reviewBody: unknown) {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/approvals/tasks')) return statusReply(200, [task]);
      if (url.endsWith('/approvals/tasks/task-1'))
        return statusReply(200, reviewBody);
      if (url.endsWith('/revisions/1/comments'))
        return statusReply(200, [
          {
            id: 'comment-1',
            text: 'Revision one: enlarge the logo',
            parentId: null,
            createdAt: '2026-11-05T10:00:00.000Z',
            author: { name: 'Rita Reviewer' },
          },
          {
            id: 'comment-2',
            text: 'Done in the next revision',
            parentId: 'comment-1',
            createdAt: '2026-11-05T10:05:00.000Z',
            author: { name: 'Sam Submitter' },
          },
        ]);
      return statusReply(200, []);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('lets a reviewer read an earlier revision thread while reviewing the new one', async () => {
    serveReview(review);
    render(
      <ApprovalsWorkspace
        session={{ accessToken: 'token', user }}
        onUnauthorized={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    const selector = await screen.findByRole('combobox', {
      name: 'Feedback revision',
    });
    expect(selector).toHaveValue('3');
    fireEvent.change(selector, { target: { value: '1' } });
    expect(
      await screen.findByText('Revision one: enlarge the logo'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('list', { name: 'Replies to Rita Reviewer' }),
    ).toHaveTextContent('Done in the next revision');
    expect(
      screen.getByRole('button', { name: 'Request changes' }),
    ).toBeInTheDocument();
  });

  it('hides decision controls when the viewer submitted the run', async () => {
    serveReview({ ...review, submittedByViewer: true });
    render(
      <ApprovalsWorkspace
        session={{ accessToken: 'token', user }}
        onUnauthorized={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(
      await screen.findByText(
        'You submitted this creative, so another reviewer must decide.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Request changes' }),
    ).toBeNull();
    expect(
      screen.queryByLabelText('Decision reason or requested changes'),
    ).toBeNull();
  });
});
