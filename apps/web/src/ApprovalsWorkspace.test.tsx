import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
    fireEvent.click(screen.getByRole('radio', { name: 'Request changes' }));
    fireEvent.change(screen.getByLabelText(/^What needs to change/), {
      target: { value: 'Please update the offer' },
    });
    fireEvent.change(screen.getByLabelText(/^Explanation/), {
      target: { value: 'Keep the price label aligned with the approved copy.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review decision' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Request changes to revision 3' }),
    );
    expect(await screen.findByText(/Revision 3 · Open:/)).toBeInTheDocument();
    expect(
      await screen.findByText(/Keep the price label aligned/),
    ).toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Mark as in progress' }),
    );
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

// Phase 2A Q4: withdrawing a change request is confirmed first.
describe('ApprovalsWorkspace change request withdrawal', () => {
  // A second review task of the same creative (a later run) shows the same
  // change request.
  const secondTask = { ...task, id: 'task-2' };
  const secondReview = { ...review, task: { ...review.task, id: 'task-2' } };
  function serveOpenRequest(options: { failCancel?: boolean } = {}) {
    let requestStatus = 'OPEN';
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/approvals/tasks'))
        return statusReply(200, [task, secondTask]);
      if (url.endsWith('/approvals/tasks/task-1'))
        return statusReply(200, review);
      if (url.endsWith('/approvals/tasks/task-2'))
        return statusReply(200, secondReview);
      if (url.endsWith('/change-requests'))
        return statusReply(200, [
          {
            id: 'request-1',
            revisionNumber: 2,
            requestedChanges: 'Bigger logo',
            explanation: null,
            status: requestStatus,
          },
        ]);
      if (url.endsWith('/change-requests/request-1/cancel')) {
        expect(init?.method).toBe('POST');
        if (options.failCancel)
          return statusReply(409, {
            message: 'Change request is no longer open',
          });
        requestStatus = 'CANCELLED';
        return statusReply(200, {});
      }
      return statusReply(200, []);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  const cancelCalls = (fetchMock: ReturnType<typeof serveOpenRequest>) =>
    fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/cancel'));
  function renderApprovals() {
    render(
      <ApprovalsWorkspace
        session={{ accessToken: 'token', user }}
        onUnauthorized={vi.fn()}
      />,
    );
  }
  async function openFirstReview() {
    fireEvent.click(
      (await screen.findAllByRole('button', { name: 'Review' }))[0],
    );
    return screen.findByRole('button', { name: 'Withdraw request' });
  }

  it('explains the consequence and withdraws only after confirmation', async () => {
    const fetchMock = serveOpenRequest();
    renderApprovals();
    const withdraw = await openFirstReview();
    fireEvent.click(withdraw);
    expect(withdraw).toHaveAttribute('aria-expanded', 'true');
    const confirm = screen.getByRole('group', {
      name: 'Confirm withdrawing the change request on revision 2',
    });
    expect(confirm).toHaveTextContent(
      'Withdraw this change request? It will be marked Cancelled and will no longer stop revision 2 from being resubmitted. The request and its history are kept.',
    );
    expect(cancelCalls(fetchMock)).toHaveLength(0);

    // Keep request closes the confirmation, sends nothing and returns focus
    // to the button that opened it.
    fireEvent.click(screen.getByRole('button', { name: 'Keep request' }));
    expect(
      screen.queryByRole('group', { name: /Confirm withdrawing/ }),
    ).not.toBeInTheDocument();
    expect(cancelCalls(fetchMock)).toHaveLength(0);
    expect(withdraw).toHaveFocus();

    fireEvent.click(withdraw);
    const group = screen.getByRole('group', { name: /Confirm withdrawing/ });
    fireEvent.click(
      within(group).getByRole('button', {
        name: 'Withdraw request on revision 2',
      }),
    );
    expect(
      await screen.findByText('Change request withdrawn.'),
    ).toHaveAttribute('role', 'status');
    expect(cancelCalls(fetchMock)).toHaveLength(1);
    expect(
      await screen.findByText(/Revision 2 · Cancelled:/),
    ).toBeInTheDocument();
  });

  it('names the confirm button differently from the button that opens it', async () => {
    serveOpenRequest();
    renderApprovals();
    fireEvent.click(await openFirstReview());
    // The visible text stays "Withdraw request"; only the trigger has that
    // exact accessible name.
    expect(
      screen.getAllByRole('button', { name: 'Withdraw request' }),
    ).toHaveLength(1);
    const confirm = screen.getByRole('button', {
      name: 'Withdraw request on revision 2',
    });
    expect(confirm).toHaveTextContent('Withdraw request');
  });

  it('keeps the confirmation open with the reason when withdrawing fails', async () => {
    const fetchMock = serveOpenRequest({ failCancel: true });
    renderApprovals();
    fireEvent.click(await openFirstReview());
    fireEvent.click(
      screen.getByRole('button', { name: 'Withdraw request on revision 2' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Change request is no longer open',
    );
    expect(cancelCalls(fetchMock)).toHaveLength(1);
    expect(
      screen.getByRole('group', { name: /Confirm withdrawing/ }),
    ).toBeInTheDocument();
  });

  it('closes an open withdrawal confirmation when another review is opened', async () => {
    const fetchMock = serveOpenRequest();
    renderApprovals();
    fireEvent.click(await openFirstReview());
    expect(
      screen.getByRole('group', { name: /Confirm withdrawing/ }),
    ).toBeInTheDocument();
    const second = screen.getAllByRole('button', { name: 'Review' })[1];
    second.focus();
    fireEvent.click(second);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/approvals/tasks/task-2'),
        expect.anything(),
      ),
    );
    // The same request is listed for the second review, but its
    // confirmation is not carried over, and focus stays where the user is.
    expect(
      await screen.findByRole('button', { name: 'Withdraw request' }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.queryByRole('group', { name: /Confirm withdrawing/ }),
    ).not.toBeInTheDocument();
    expect(second).toHaveFocus();
    expect(cancelCalls(fetchMock)).toHaveLength(0);
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
      screen.getByRole('radio', { name: 'Request changes' }),
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
    expect(screen.queryByRole('radio', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Request changes' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Review decision' }),
    ).toBeNull();
    expect(screen.queryByRole('group', { name: 'Your decision' })).toBeNull();
    // An explanation, not an error (Phase 2A Q12).
    expect(
      screen.getByText(
        'You submitted this creative, so another reviewer must decide.',
      ),
    ).toHaveClass('info-message');
  });

  // The Phase 2A hint on a disabled Request changes button is replaced by
  // the decision form's own required-field check (see the Phase 2B tests).
});

// Phase 2B step 1: the reviewer chooses a decision first, sees only that
// decision's fields, and confirms before anything is sent.
describe('ApprovalsWorkspace decision form', () => {
  const secondTask = {
    ...task,
    id: 'task-2',
    instance: {
      ...task.instance,
      id: 'instance-2',
      creative: {
        ...task.instance.creative,
        id: 'creative-2',
        name: 'Autumn post',
      },
    },
  };
  const secondReview = {
    ...review,
    task: { ...review.task, id: 'task-2' },
    creative: { ...review.creative, id: 'creative-2', name: 'Autumn post' },
  };
  type DecisionReply = () => Promise<Response> | Response;
  // Serves two pending reviews. Each decision POST is answered by the next
  // reply in `decisionReplies` (success by default).
  function serveDecisions(decisionReplies: DecisionReply[] = []) {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/approvals/tasks'))
        return statusReply(200, [task, secondTask]);
      if (url.endsWith('/approvals/tasks/task-1'))
        return statusReply(200, review);
      if (url.endsWith('/approvals/tasks/task-2'))
        return statusReply(200, secondReview);
      if (url.endsWith('/decision') && init?.method === 'POST') {
        const next = decisionReplies.shift();
        return next ? next() : statusReply(200, {});
      }
      return statusReply(200, []);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  const decisionCalls = (fetchMock: ReturnType<typeof serveDecisions>) =>
    fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/decision'))
      .map(([url, init]) => ({
        url: String(url),
        body: JSON.parse(String((init as RequestInit).body)) as Record<
          string,
          string
        >,
      }));
  function renderAs(permissions = user.permissions, onDataChanged = vi.fn()) {
    render(
      <ApprovalsWorkspace
        session={{ accessToken: 'token', user: { ...user, permissions } }}
        onDataChanged={onDataChanged}
        onUnauthorized={vi.fn()}
      />,
    );
    return onDataChanged;
  }
  async function openReview(index = 0) {
    fireEvent.click(
      (await screen.findAllByRole('button', { name: 'Review' }))[index],
    );
    await screen.findByRole('heading', {
      name:
        index === 0 ? 'Spring post · Revision 3' : 'Autumn post · Revision 3',
    });
  }
  const reviewDecision = () =>
    screen.getByRole('button', { name: 'Review decision' });

  describe('permissions', () => {
    const without = (...codes: string[]) =>
      user.permissions.filter((code) => !codes.includes(code));
    it.each([
      ['approvals:decide and change_requests:create', without(), true, true],
      ['approvals:decide only', without('change_requests:create'), true, false],
      [
        'change_requests:create only',
        without('approvals:decide'),
        false,
        false,
      ],
      [
        'neither permission',
        without('approvals:decide', 'change_requests:create'),
        false,
        false,
      ],
    ])('with %s', async (_case, permissions, canApprove, canRequestChanges) => {
      serveDecisions();
      renderAs(permissions);
      await openReview();
      expect(screen.queryByRole('radio', { name: 'Approve' }) !== null).toBe(
        canApprove,
      );
      expect(
        screen.queryByRole('radio', { name: 'Request changes' }) !== null,
      ).toBe(canRequestChanges);
      expect(
        screen.queryByText(
          'You can approve this revision. Requesting changes needs permission to create change requests.',
        ) !== null,
      ).toBe(canApprove && !canRequestChanges);
      expect(
        screen.queryByRole('button', { name: 'Review decision' }) !== null,
      ).toBe(canApprove);
    });
  });

  it('asks for a decision first and then shows only its fields', async () => {
    serveDecisions();
    renderAs();
    await openReview();
    expect(
      screen.getByRole('group', { name: 'Your decision' }),
    ).toBeInTheDocument();
    // No decision fields until a decision is chosen (the Comments panel
    // below has its own box).
    expect(screen.queryByLabelText(/^Comment \(optional\)/)).toBeNull();
    expect(screen.queryByLabelText(/What needs to change/)).toBeNull();
    expect(screen.queryByLabelText(/^Explanation/)).toBeNull();
    expect(reviewDecision()).toBeDisabled();
    expect(reviewDecision()).toHaveAccessibleDescription(
      'Choose a decision to continue.',
    );

    fireEvent.click(screen.getByRole('radio', { name: 'Approve' }));
    expect(screen.getByLabelText('Comment (optional)')).toBeInTheDocument();
    expect(screen.queryByLabelText(/What needs to change/)).toBeNull();
    expect(screen.queryByLabelText(/^Explanation/)).toBeNull();
    expect(reviewDecision()).toBeEnabled();

    fireEvent.click(screen.getByRole('radio', { name: 'Request changes' }));
    expect(screen.queryByLabelText(/^Comment \(optional\)/)).toBeNull();
    expect(
      screen.getByLabelText('What needs to change (required)'),
    ).toHaveAttribute('aria-required', 'true');
    expect(screen.getByLabelText('Explanation (optional)')).toBeInTheDocument();
  });

  it('keeps separate text for each decision and sends an approval comment only as reason', async () => {
    const fetchMock = serveDecisions();
    renderAs();
    await openReview();
    fireEvent.click(screen.getByRole('radio', { name: 'Approve' }));
    fireEvent.change(screen.getByLabelText('Comment (optional)'), {
      target: { value: '  Looks great  ' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Request changes' }));
    expect(
      screen.getByLabelText('What needs to change (required)'),
    ).toHaveValue('');
    fireEvent.change(screen.getByLabelText('What needs to change (required)'), {
      target: { value: 'Bigger logo' },
    });
    fireEvent.change(screen.getByLabelText('Explanation (optional)'), {
      target: { value: 'Brand guide' },
    });
    // Back to Approve: the comment is still there, the change text is not
    // shown and is not sent.
    fireEvent.click(screen.getByRole('radio', { name: 'Approve' }));
    expect(screen.getByLabelText('Comment (optional)')).toHaveValue(
      '  Looks great  ',
    );
    fireEvent.click(reviewDecision());
    const confirm = screen.getByRole('group', {
      name: 'Confirm approving revision 3',
    });
    expect(confirm).toHaveTextContent(
      'Approve revision 3 of “Spring post”? Your decision is final and moves the creative on in its workflow.',
    );
    expect(confirm).toHaveTextContent('CommentLooks great');
    expect(confirm).not.toHaveTextContent('Bigger logo');
    fireEvent.click(
      within(confirm).getByRole('button', { name: 'Approve revision 3' }),
    );
    expect(await screen.findByText('Review approved.')).toHaveAttribute(
      'role',
      'status',
    );
    expect(decisionCalls(fetchMock)).toEqual([
      {
        url: expect.stringContaining('/approvals/tasks/task-1/decision'),
        body: { decision: 'APPROVED', reason: 'Looks great' },
      },
    ]);
  });

  it('approves without a comment by sending the decision alone', async () => {
    const fetchMock = serveDecisions();
    renderAs();
    await openReview();
    fireEvent.click(screen.getByRole('radio', { name: 'Approve' }));
    fireEvent.click(reviewDecision());
    expect(
      screen.getByRole('group', { name: 'Confirm approving revision 3' }),
    ).toHaveTextContent('CommentNo comment');
    fireEvent.click(screen.getByRole('button', { name: 'Approve revision 3' }));
    await screen.findByText('Review approved.');
    expect(decisionCalls(fetchMock).map((call) => call.body)).toEqual([
      { decision: 'APPROVED' },
    ]);
  });

  it.each([
    [
      'with an explanation',
      '  Use the new price.  ',
      {
        decision: 'CHANGES_REQUESTED',
        reason: 'Bigger logo',
        explanation: 'Use the new price.',
      },
      'Use the new price.',
    ],
    [
      'without an explanation',
      '   ',
      { decision: 'CHANGES_REQUESTED', reason: 'Bigger logo' },
      'None',
    ],
  ])(
    'requests changes %s',
    async (_case, explanation, expectedBody, shownExplanation) => {
      const onDataChanged = vi.fn();
      const fetchMock = serveDecisions();
      renderAs(user.permissions, onDataChanged);
      await openReview();
      fireEvent.click(screen.getByRole('radio', { name: 'Request changes' }));
      fireEvent.change(
        screen.getByLabelText('What needs to change (required)'),
        { target: { value: ' Bigger logo ' } },
      );
      fireEvent.change(screen.getByLabelText('Explanation (optional)'), {
        target: { value: explanation },
      });
      fireEvent.click(reviewDecision());
      const confirm = screen.getByRole('group', {
        name: 'Confirm requesting changes to revision 3',
      });
      expect(confirm).toHaveTextContent(
        'Request changes to revision 3 of “Spring post”? Your decision is final. A change request is opened, and whoever submitted the creative is asked to save a new revision.',
      );
      expect(confirm).toHaveTextContent('What needs to changeBigger logo');
      expect(confirm).toHaveTextContent('Explanation' + shownExplanation);
      fireEvent.click(
        within(confirm).getByRole('button', {
          name: 'Request changes to revision 3',
        }),
      );
      expect(await screen.findByText('Changes requested.')).toHaveAttribute(
        'role',
        'status',
      );
      expect(decisionCalls(fetchMock).map((call) => call.body)).toEqual([
        expectedBody,
      ]);
      expect(onDataChanged).toHaveBeenCalledWith('approvals');
    },
  );

  it('requires a description of the changes before confirming', async () => {
    const fetchMock = serveDecisions();
    renderAs();
    await openReview();
    fireEvent.click(screen.getByRole('radio', { name: 'Request changes' }));
    const changes = screen.getByLabelText('What needs to change (required)');
    fireEvent.change(changes, { target: { value: '   ' } });
    fireEvent.click(reviewDecision());
    expect(screen.queryByRole('group', { name: /^Confirm/ })).toBeNull();
    expect(changes).toHaveFocus();
    expect(changes).toHaveAttribute('aria-invalid', 'true');
    expect(changes).toHaveAccessibleDescription(
      'Describe what needs to change before requesting changes.',
    );
    fireEvent.change(changes, { target: { value: 'Bigger logo' } });
    expect(changes).not.toHaveAttribute('aria-invalid');
    expect(
      screen.queryByText(
        'Describe what needs to change before requesting changes.',
      ),
    ).toBeNull();
    expect(decisionCalls(fetchMock)).toHaveLength(0);
  });

  it('Back to edit closes the confirmation, sends nothing and returns focus', async () => {
    const fetchMock = serveDecisions();
    renderAs();
    await openReview();
    fireEvent.click(screen.getByRole('radio', { name: 'Approve' }));
    fireEvent.click(reviewDecision());
    expect(reviewDecision()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Back to edit' }));
    expect(screen.queryByRole('group', { name: /^Confirm/ })).toBeNull();
    expect(reviewDecision()).toHaveFocus();
    expect(reviewDecision()).toHaveAttribute('aria-expanded', 'false');
    expect(decisionCalls(fetchMock)).toHaveLength(0);

    // Changing the decision also closes an open confirmation.
    fireEvent.click(reviewDecision());
    fireEvent.click(screen.getByRole('radio', { name: 'Request changes' }));
    expect(screen.queryByRole('group', { name: /^Confirm/ })).toBeNull();
  });

  it('sends a decision only once while it is in flight', async () => {
    let answer: (response: Response) => void = () => undefined;
    const fetchMock = serveDecisions([
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    ]);
    renderAs();
    await openReview();
    fireEvent.click(screen.getByRole('radio', { name: 'Approve' }));
    fireEvent.click(reviewDecision());
    const confirm = screen.getByRole('button', { name: 'Approve revision 3' });
    // Several clicks before the busy state renders (one batch), then one
    // more once it has: only one decision is sent.
    act(() => {
      confirm.click();
      confirm.click();
    });
    fireEvent.click(confirm);
    expect(decisionCalls(fetchMock)).toHaveLength(1);
    await waitFor(() => expect(confirm).toBeDisabled());
    expect(screen.getByRole('radio', { name: 'Approve' })).toBeDisabled();
    answer(statusReply(200, {}) as unknown as Response);
    expect(await screen.findByText('Review approved.')).toBeInTheDocument();
    expect(decisionCalls(fetchMock)).toHaveLength(1);
  });

  it('keeps the confirmation and text after a failure, and can send again', async () => {
    const fetchMock = serveDecisions([
      () =>
        statusReply(409, {
          message: 'Review task is no longer active',
        }) as unknown as Response,
    ]);
    renderAs();
    await openReview();
    fireEvent.click(screen.getByRole('radio', { name: 'Request changes' }));
    fireEvent.change(screen.getByLabelText('What needs to change (required)'), {
      target: { value: 'Bigger logo' },
    });
    fireEvent.click(reviewDecision());
    fireEvent.click(
      screen.getByRole('button', { name: 'Request changes to revision 3' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Review task is no longer active',
    );
    const confirm = screen.getByRole('group', {
      name: 'Confirm requesting changes to revision 3',
    });
    expect(confirm).toHaveTextContent('What needs to changeBigger logo');
    expect(screen.queryByText('Changes requested.')).toBeNull();

    fireEvent.click(
      within(confirm).getByRole('button', {
        name: 'Request changes to revision 3',
      }),
    );
    expect(await screen.findByText('Changes requested.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(decisionCalls(fetchMock).map((call) => call.body)).toEqual([
      { decision: 'CHANGES_REQUESTED', reason: 'Bigger logo' },
      { decision: 'CHANGES_REQUESTED', reason: 'Bigger logo' },
    ]);
  });

  it('after a decision, clears the form and moves focus to the result', async () => {
    serveDecisions();
    renderAs();
    await openReview();
    fireEvent.click(screen.getByRole('radio', { name: 'Approve' }));
    fireEvent.change(screen.getByLabelText('Comment (optional)'), {
      target: { value: 'Nice' },
    });
    fireEvent.click(reviewDecision());
    const confirm = screen.getByRole('button', { name: 'Approve revision 3' });
    // A real click focuses the button; it disappears with the confirmation.
    confirm.focus();
    fireEvent.click(confirm);
    const result = await screen.findByText('Review approved.');
    await waitFor(() => expect(result).toHaveFocus());
    expect(screen.getByRole('radio', { name: 'Approve' })).not.toBeChecked();
    expect(screen.queryByLabelText('Comment (optional)')).toBeNull();
    expect(screen.queryByRole('group', { name: /^Confirm/ })).toBeNull();
  });

  it('does not carry a prepared decision over to another review', async () => {
    const fetchMock = serveDecisions();
    renderAs();
    await openReview(0);
    fireEvent.click(screen.getByRole('radio', { name: 'Request changes' }));
    fireEvent.change(screen.getByLabelText('What needs to change (required)'), {
      target: { value: 'Bigger logo' },
    });
    fireEvent.click(reviewDecision());
    await openReview(1);
    expect(screen.queryByRole('group', { name: /^Confirm/ })).toBeNull();
    expect(
      screen.getByRole('radio', { name: 'Request changes' }),
    ).not.toBeChecked();
    expect(screen.queryByLabelText(/What needs to change/)).toBeNull();
    expect(decisionCalls(fetchMock)).toHaveLength(0);
  });
});
