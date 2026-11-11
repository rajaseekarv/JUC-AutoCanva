import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { AuthenticatedUserResponse } from '@adflow/shared-types';
import ReviewFeedback, { type FeedbackComment } from './ReviewFeedback';
import { statusReply } from './assetTestUtils';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const allPermissions = [
  'comments:read',
  'comments:create',
  'approvals:read',
  'change_requests:read',
];
const sessionWith = (permissions: string[]) => ({
  accessToken: 'token',
  user: {
    id: 'user-1',
    organizationId: 'org-1',
    name: 'Submitter',
    email: 'submitter@example.local',
    permissions,
    branches: [],
  } as AuthenticatedUserResponse,
});

const comment = (
  id: string,
  text: string,
  minute: number,
  parentId: string | null = null,
  author = 'Rita Reviewer',
): FeedbackComment => ({
  id,
  text,
  parentId,
  createdAt: `2026-11-05T10:${String(minute).padStart(2, '0')}:00.000Z`,
  author: { name: author },
});

// Serves comments per revision number, decisions and change requests;
// `overrides` replaces the reply for a path suffix with an HTTP status.
function serve(
  options: {
    comments?: Record<number, FeedbackComment[]>;
    decisions?: unknown[];
    requests?: unknown[];
    overrides?: Record<string, number>;
  } = {},
) {
  const comments = options.comments ?? {};
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    for (const [suffix, status] of Object.entries(options.overrides ?? {}))
      if (url.endsWith(suffix) && (init?.method ?? 'GET') !== 'POST')
        return statusReply(status, { message: 'failure ' + status });
    const match = /\/revisions\/(\d+)\/comments$/.exec(url);
    if (match && init?.method === 'POST') {
      const status = options.overrides?.['POST'];
      if (status)
        return statusReply(status, {
          message: status === 404 ? 'Comment thread not found' : 'Bad input',
        });
      const body = JSON.parse(String(init.body)) as {
        text: string;
        parentId?: string;
      };
      const revision = Number(match[1]);
      const created = comment(
        'new-' + (comments[revision]?.length ?? 0),
        body.text,
        59,
        body.parentId ?? null,
        'Submitter',
      );
      comments[revision] = [...(comments[revision] ?? []), created];
      return statusReply(201, created);
    }
    if (match) return statusReply(200, comments[Number(match[1])] ?? []);
    if (url.endsWith('/decisions'))
      return statusReply(200, options.decisions ?? []);
    if (url.endsWith('/change-requests'))
      return statusReply(200, options.requests ?? []);
    return statusReply(404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const calls = (fetchMock: ReturnType<typeof vi.fn>, pattern: RegExp) =>
  fetchMock.mock.calls.filter(([url]) => pattern.test(String(url)));

function renderFeedback(
  props: Partial<Parameters<typeof ReviewFeedback>[0]> = {},
) {
  const onUnauthorized = vi.fn();
  render(
    <ReviewFeedback
      session={sessionWith(allPermissions)}
      creativeId="creative-1"
      latestRevisionNumber={2}
      onUnauthorized={onUnauthorized}
      {...props}
    />,
  );
  return { onUnauthorized };
}

describe('ReviewFeedback threads', () => {
  it('shows top-level comments in time order with one level of replies, author and timestamp', async () => {
    serve({
      comments: {
        2: [
          comment('reply-b', 'Fixed now', 4, 'root-a', 'Sam Submitter'),
          comment('root-b', 'Second thread', 3),
          comment('root-a', 'Logo is too small', 1),
          // Older data: a reply to a reply still belongs to root-a.
          comment('reply-c', 'Thanks', 5, 'reply-b'),
          // A reply whose parent is missing is shown, not hidden.
          comment('orphan', 'Lost reply', 6, 'deleted-root'),
        ],
      },
    });
    renderFeedback();
    const threads = await screen.findAllByRole('article', {
      name: /^Comment by/,
    });
    expect(threads.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Logo is too small'),
      expect.stringContaining('Fixed now'),
      expect.stringContaining('Thanks'),
      expect.stringContaining('Second thread'),
      expect.stringContaining('Lost reply'),
    ]);
    const replies = screen.getByRole('list', {
      name: 'Replies to Rita Reviewer',
    });
    expect(
      within(replies)
        .getAllByRole('article')
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining('Fixed now'),
      expect.stringContaining('Thanks'),
    ]);
    const first = threads[0]!;
    expect(within(first).getByText('Rita Reviewer')).toBeInTheDocument();
    expect(first.querySelector('time')).toHaveAttribute(
      'datetime',
      '2026-11-05T10:01:00.000Z',
    );
  });

  it('replies to the top-level comment of a thread', async () => {
    const fetchMock = serve({
      comments: { 2: [comment('root-a', 'Logo is too small', 1)] },
    });
    renderFeedback();
    fireEvent.click(
      await screen.findByRole('button', {
        name: "Reply to Rita Reviewer's comment",
      }),
    );
    fireEvent.change(screen.getByLabelText('Reply to Rita Reviewer'), {
      target: { value: '  Made it larger  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Post reply' }));
    const replies = await screen.findByRole('list', {
      name: 'Replies to Rita Reviewer',
    });
    expect(within(replies).getByText('Made it larger')).toBeInTheDocument();
    const [, init] = calls(fetchMock, /\/revisions\/2\/comments$/).find(
      ([, request]) => (request as RequestInit | undefined)?.method === 'POST',
    )!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      text: 'Made it larger',
      parentId: 'root-a',
    });
    expect(
      screen.queryByLabelText('Reply to Rita Reviewer'),
    ).not.toBeInTheDocument();
  });

  it('adds a top-level comment to the selected revision', async () => {
    const fetchMock = serve();
    renderFeedback();
    expect(
      await screen.findByText('No comments on this revision.'),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Add a comment'), {
      target: { value: 'Ready for another look' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    expect(
      await screen.findByText('Ready for another look'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Add a comment')).toHaveValue('');
    const post = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    )!;
    expect(String(post[0])).toMatch(
      /\/creatives\/creative-1\/revisions\/2\/comments$/,
    );
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({
      text: 'Ready for another look',
    });
  });

  it('switches revisions and shows only that revision comments', async () => {
    const fetchMock = serve({
      comments: {
        1: [comment('old', 'Revision one feedback', 1)],
        2: [comment('new', 'Revision two feedback', 2)],
      },
    });
    renderFeedback();
    expect(
      await screen.findByText('Revision two feedback'),
    ).toBeInTheDocument();
    const selector = screen.getByRole('combobox', {
      name: 'Feedback revision',
    });
    expect(selector).toHaveValue('2');
    expect(
      within(selector)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Revision 2 (current)', 'Revision 1']);
    fireEvent.change(selector, { target: { value: '1' } });
    expect(
      await screen.findByText('Revision one feedback'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Revision two feedback')).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Comments on revision 1' }),
    ).toBeInTheDocument();
    expect(calls(fetchMock, /\/revisions\/1\/comments$/)).toHaveLength(1);
  });

  it('ignores a late response for a revision that is no longer selected', async () => {
    let releaseRevisionTwo: () => void = () => {};
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/revisions/2/comments')) {
        await new Promise<void>((resolve) => {
          releaseRevisionTwo = resolve;
        });
        return statusReply(200, [comment('late', 'Late revision two', 1)]);
      }
      if (url.endsWith('/revisions/1/comments'))
        return statusReply(200, [comment('one', 'Revision one only', 1)]);
      return statusReply(200, []);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderFeedback();
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Feedback revision' }),
      { target: { value: '1' } },
    );
    expect(await screen.findByText('Revision one only')).toBeInTheDocument();
    releaseRevisionTwo();
    await waitFor(() =>
      expect(calls(fetchMock, /\/revisions\/2\/comments$/)).toHaveLength(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('Late revision two')).not.toBeInTheDocument();
    expect(screen.getByText('Revision one only')).toBeInTheDocument();
  });

  it('opens on the revision the caller asks for', async () => {
    const fetchMock = serve({
      comments: { 1: [comment('old', 'Revision one feedback', 1)] },
    });
    renderFeedback({ initialRevisionNumber: 1 });
    expect(
      await screen.findByText('Revision one feedback'),
    ).toBeInTheDocument();
    expect(calls(fetchMock, /\/revisions\/2\/comments$/)).toHaveLength(0);
  });
});

describe('ReviewFeedback history', () => {
  it('shows decision history and change-request status across revisions', async () => {
    const onChangeRequests = vi.fn();
    serve({
      decisions: [
        {
          id: 'decision-1',
          revisionNumber: 1,
          decision: 'CHANGES_REQUESTED',
          reason: 'Logo is too small',
          createdAt: '2026-11-05T10:00:00.000Z',
          reviewer: { name: 'Rita Reviewer' },
        },
      ],
      requests: [
        {
          id: 'request-1',
          revisionNumber: 1,
          requestedChanges: 'Logo is too small',
          explanation: 'Use the large variant',
          status: 'RESOLVED',
        },
      ],
    });
    renderFeedback({ onChangeRequests });
    const decisions = await screen.findByRole('region', {
      name: 'Decision history',
    });
    expect(
      await within(decisions).findByText(
        /Revision 1 · Changes requested by Rita Reviewer/,
      ),
    ).toHaveTextContent('— Logo is too small');
    const requests = screen.getByRole('region', { name: 'Change requests' });
    expect(
      await within(requests).findByText(
        'Revision 1 · Resolved: Logo is too small (Use the large variant)',
      ),
    ).toBeInTheDocument();
    expect(onChangeRequests).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'request-1', status: 'RESOLVED' }),
    ]);
  });

  it('leaves history out when the caller keeps its own, but still reports change requests', async () => {
    const onChangeRequests = vi.fn();
    const fetchMock = serve({ requests: [] });
    renderFeedback({ showHistory: false, onChangeRequests });
    await waitFor(() => expect(onChangeRequests).toHaveBeenCalledWith([]));
    expect(calls(fetchMock, /\/decisions$/)).toHaveLength(0);
    expect(
      screen.queryByRole('region', { name: 'Decision history' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Change requests' }),
    ).not.toBeInTheDocument();
  });
});

describe('ReviewFeedback permissions', () => {
  it('requests and shows only what the user may read', async () => {
    const fetchMock = serve({
      comments: { 2: [comment('root', 'Visible comment', 1)] },
    });
    renderFeedback({ session: sessionWith(['comments:read']) });
    expect(await screen.findByText('Visible comment')).toBeInTheDocument();
    expect(calls(fetchMock, /\/decisions$|\/change-requests$/)).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Reply/ })).toBeNull();
    expect(screen.queryByLabelText('Add a comment')).toBeNull();
  });

  it('shows history without requesting comments when comments:read is missing', async () => {
    const fetchMock = serve();
    renderFeedback({ session: sessionWith(['approvals:read']) });
    expect(
      await screen.findByText('No review decisions yet.'),
    ).toBeInTheDocument();
    expect(calls(fetchMock, /\/comments$/)).toHaveLength(0);
    expect(
      screen.queryByRole('combobox', { name: 'Feedback revision' }),
    ).toBeNull();
  });

  it('renders and requests nothing without any feedback permission', () => {
    const fetchMock = serve();
    const { container } = render(
      <ReviewFeedback
        session={sessionWith(['creatives:read'])}
        creativeId="creative-1"
        latestRevisionNumber={2}
        onUnauthorized={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ReviewFeedback errors', () => {
  it.each([
    [403, 'You do not have permission to view comments.'],
    [404, 'This creative or revision is no longer available.'],
    [500, 'Unable to load comments.'],
  ])('explains HTTP %i when loading comments', async (status, text) => {
    serve({ overrides: { '/revisions/2/comments': status } });
    renderFeedback();
    const region = await screen.findByRole('region', {
      name: 'Comments on revision 2',
    });
    expect(await within(region).findByRole('alert')).toHaveTextContent(text);
  });

  it('signs out on 401', async () => {
    serve({ overrides: { '/revisions/2/comments': 401 } });
    const { onUnauthorized } = renderFeedback();
    expect(
      await screen.findByText('Your session expired. Please sign in again.'),
    ).toBeInTheDocument();
    expect(onUnauthorized).toHaveBeenCalled();
  });

  it('retries a failed comment load', async () => {
    let fail = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/comments') && fail) return statusReply(500);
        return statusReply(
          200,
          url.endsWith('/comments') ? [comment('root', 'Back again', 1)] : [],
        );
      }),
    );
    renderFeedback();
    const retry = await screen.findByRole('button', { name: 'Try again' });
    fail = false;
    fireEvent.click(retry);
    expect(await screen.findByText('Back again')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('explains failed history requests separately', async () => {
    serve({ overrides: { '/decisions': 403, '/change-requests': 404 } });
    renderFeedback();
    expect(
      await within(
        await screen.findByRole('region', { name: 'Decision history' }),
      ).findByRole('alert'),
    ).toHaveTextContent('You do not have permission to view review decisions.');
    expect(
      await within(
        screen.getByRole('region', { name: 'Change requests' }),
      ).findByRole('alert'),
    ).toHaveTextContent('This creative or revision is no longer available.');
  });

  it.each([
    [404, 'The comment you replied to is no longer available.'],
    [403, 'You do not have permission to comment on this creative.'],
    [400, 'Bad input'],
  ])(
    'explains a rejected reply (HTTP %i) and keeps the text',
    async (status, text) => {
      serve({
        comments: { 2: [comment('root-a', 'Logo is too small', 1)] },
        overrides: { POST: status },
      });
      renderFeedback();
      fireEvent.click(
        await screen.findByRole('button', {
          name: "Reply to Rita Reviewer's comment",
        }),
      );
      fireEvent.change(screen.getByLabelText('Reply to Rita Reviewer'), {
        target: { value: 'Made it larger' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Post reply' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(text);
      expect(screen.getByLabelText('Reply to Rita Reviewer')).toHaveValue(
        'Made it larger',
      );
    },
  );
});
