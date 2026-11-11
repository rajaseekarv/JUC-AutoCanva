import { useEffect, useId, useRef, useState } from 'react';
import type { AuthenticatedUserResponse } from '@adflow/shared-types';
import { statusLabel } from './statusDisplay';

const apiBase =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000/api/v1';
type Session = { accessToken: string; user: AuthenticatedUserResponse };

export type FeedbackComment = {
  id: string;
  text: string;
  createdAt: string;
  parentId?: string | null;
  author: { name: string };
};
export type FeedbackDecision = {
  id: string;
  revisionNumber: number;
  decision: string;
  reason: string | null;
  createdAt: string;
  reviewer: { name: string };
};
export type FeedbackChangeRequest = {
  id: string;
  revisionNumber: number;
  requestedChanges: string;
  explanation: string | null;
  status: string;
};

type Loadable<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; data: T };

class FeedbackError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly serverMessage: string | null,
  ) {
    super(message);
  }
}

function loadFailure(cause: unknown, subject: string): string {
  if (!(cause instanceof FeedbackError))
    return 'Unable to load ' + subject + '.';
  if (cause.status === 401) return cause.message;
  if (cause.status === 403)
    return 'You do not have permission to view ' + subject + '.';
  if (cause.status === 404)
    return 'This creative or revision is no longer available.';
  return 'Unable to load ' + subject + '.';
}

function postFailure(cause: unknown): string {
  if (!(cause instanceof FeedbackError)) return 'Unable to add comment.';
  if (cause.status === 401) return cause.message;
  if (cause.status === 403)
    return 'You do not have permission to comment on this creative.';
  if (cause.status === 404)
    return cause.serverMessage === 'Comment thread not found'
      ? 'The comment you replied to is no longer available.'
      : 'This creative or revision is no longer available.';
  if (cause.status === 400 && cause.serverMessage) return cause.serverMessage;
  return 'Unable to add comment.';
}

// Groups comments into top-level threads with one level of replies, oldest
// first. Replies are attached to their top-level comment even when older
// data replied to a reply; a reply whose parent is missing is shown as its
// own thread rather than hidden.
function commentThreads(comments: FeedbackComment[]) {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const rootOf = (comment: FeedbackComment): string => {
    let current = comment;
    const seen = new Set<string>();
    while (
      current.parentId &&
      byId.has(current.parentId) &&
      !seen.has(current.id)
    ) {
      seen.add(current.id);
      current = byId.get(current.parentId)!;
    }
    return current.id;
  };
  const byTime = (a: FeedbackComment, b: FeedbackComment) =>
    a.createdAt.localeCompare(b.createdAt);
  const sorted = [...comments].sort(byTime);
  return sorted
    .filter((comment) => rootOf(comment) === comment.id)
    .map((root) => ({
      root,
      replies: sorted.filter(
        (comment) => comment.id !== root.id && rootOf(comment) === root.id,
      ),
    }));
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

// Review feedback for one creative: comments on a selected revision as
// threads with one level of replies, plus decision history and change
// requests across all revisions. Every request is authorized by the API;
// sections the user has no permission for are not requested or shown.
export default function ReviewFeedback({
  session,
  creativeId,
  latestRevisionNumber,
  initialRevisionNumber,
  onUnauthorized,
  showHistory = true,
  refreshKey = 0,
  onChangeRequests,
  title = 'Review feedback',
}: {
  session: Session;
  creativeId: string;
  latestRevisionNumber: number;
  initialRevisionNumber?: number;
  onUnauthorized: () => void;
  // Approvals keeps its own decision and change-request controls.
  showHistory?: boolean;
  refreshKey?: number;
  onChangeRequests?: (requests: FeedbackChangeRequest[]) => void;
  title?: string;
}) {
  const permissions = session.user.permissions;
  const canReadComments = permissions.includes('comments:read');
  const canComment = permissions.includes('comments:create');
  const canReadDecisions =
    showHistory && permissions.includes('approvals:read');
  const canReadRequests =
    permissions.includes('change_requests:read') &&
    (showHistory || onChangeRequests !== undefined);
  const id = useId();
  const [revisionNumber, setRevisionNumber] = useState(
    initialRevisionNumber ?? latestRevisionNumber,
  );
  const [comments, setComments] = useState<Loadable<FeedbackComment[]>>({
    status: 'loading',
  });
  const [decisions, setDecisions] = useState<Loadable<FeedbackDecision[]>>({
    status: 'loading',
  });
  const [requests, setRequests] = useState<Loadable<FeedbackChangeRequest[]>>({
    status: 'loading',
  });
  const [commentText, setCommentText] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [replyText, setReplyText] = useState('');
  const [busy, setBusy] = useState(false);
  const [postError, setPostError] = useState('');
  // Responses for a revision or creative that is no longer shown are dropped.
  const commentsRequest = useRef(0);
  const historyRequest = useRef(0);

  useEffect(() => {
    setRevisionNumber(initialRevisionNumber ?? latestRevisionNumber);
  }, [creativeId, initialRevisionNumber, latestRevisionNumber]);

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(apiBase + path, {
      ...init,
      headers: {
        Authorization: 'Bearer ' + session.accessToken,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (response.status === 401) {
      onUnauthorized();
      throw new FeedbackError(
        'Your session expired. Please sign in again.',
        401,
        null,
      );
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        message?: unknown;
      } | null;
      throw new FeedbackError(
        'Request failed',
        response.status,
        typeof body?.message === 'string' ? body.message : null,
      );
    }
    return response.json() as Promise<T>;
  }

  const creativePath = '/creatives/' + encodeURIComponent(creativeId);

  async function loadComments(): Promise<void> {
    if (!canReadComments) return;
    const requestId = ++commentsRequest.current;
    setComments({ status: 'loading' });
    let next: Loadable<FeedbackComment[]>;
    try {
      next = {
        status: 'loaded',
        data: await call<FeedbackComment[]>(
          creativePath + '/revisions/' + revisionNumber + '/comments',
        ),
      };
    } catch (cause) {
      next = { status: 'error', message: loadFailure(cause, 'comments') };
    }
    if (commentsRequest.current === requestId) setComments(next);
  }

  async function loadHistory(): Promise<void> {
    const requestId = ++historyRequest.current;
    const load = async <T,>(
      allowed: boolean,
      path: string,
      subject: string,
    ): Promise<Loadable<T> | null> => {
      if (!allowed) return null;
      try {
        return { status: 'loaded', data: await call<T>(creativePath + path) };
      } catch (cause) {
        return { status: 'error', message: loadFailure(cause, subject) };
      }
    };
    setDecisions({ status: 'loading' });
    setRequests({ status: 'loading' });
    const [nextDecisions, nextRequests] = await Promise.all([
      load<FeedbackDecision[]>(
        canReadDecisions,
        '/decisions',
        'review decisions',
      ),
      load<FeedbackChangeRequest[]>(
        canReadRequests,
        '/change-requests',
        'change requests',
      ),
    ]);
    if (historyRequest.current !== requestId) return;
    if (nextDecisions) setDecisions(nextDecisions);
    if (nextRequests) {
      setRequests(nextRequests);
      if (nextRequests.status === 'loaded')
        onChangeRequests?.(nextRequests.data);
    }
  }

  useEffect(() => {
    void loadComments();
    // Reload when the creative, revision, session or caller's key changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creativeId, revisionNumber, session.accessToken, refreshKey]);
  useEffect(() => {
    void loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creativeId, session.accessToken, refreshKey]);
  useEffect(() => {
    setReplyTo('');
    setReplyText('');
    setPostError('');
  }, [creativeId, revisionNumber]);

  async function post(text: string, parentId?: string): Promise<boolean> {
    setBusy(true);
    setPostError('');
    try {
      await call(creativePath + '/revisions/' + revisionNumber + '/comments', {
        method: 'POST',
        body: JSON.stringify({
          text: text.trim(),
          ...(parentId ? { parentId } : {}),
        }),
      });
      await loadComments();
      return true;
    } catch (cause) {
      setPostError(postFailure(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (
    !canReadComments &&
    !canReadDecisions &&
    !(showHistory && canReadRequests)
  )
    return null;
  const revisionNumbers = Array.from(
    { length: Math.max(latestRevisionNumber, 1) },
    (_, index) => latestRevisionNumber - index,
  ).filter((value) => value > 0);
  const headingId = id + '-heading';
  return (
    <section className="review-feedback" aria-labelledby={headingId}>
      <div className="review-feedback-heading">
        <h3 id={headingId}>{title}</h3>
        {canReadComments && revisionNumbers.length > 1 && (
          <label>
            Revision
            <select
              aria-label="Feedback revision"
              value={revisionNumber}
              onChange={(event) =>
                setRevisionNumber(Number(event.target.value))
              }
            >
              {revisionNumbers.map((value) => (
                <option key={value} value={value}>
                  {'Revision ' +
                    value +
                    (value === latestRevisionNumber ? ' (current)' : '')}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {canReadComments && (
        <section
          className="feedback-block"
          aria-label={'Comments on revision ' + revisionNumber}
          aria-busy={comments.status === 'loading'}
        >
          <h4>Comments on revision {revisionNumber}</h4>
          {comments.status === 'loading' && (
            <p className="empty-state" aria-live="polite">
              Loading comments…
            </p>
          )}
          {comments.status === 'error' && (
            <div className="inline-actions">
              <p role="alert" className="form-message">
                {comments.message}
              </p>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void loadComments()}
              >
                Try again
              </button>
            </div>
          )}
          {comments.status === 'loaded' &&
            (comments.data.length ? (
              <ol className="comment-threads">
                {commentThreads(comments.data).map(({ root, replies }) => (
                  <li key={root.id}>
                    <CommentItem comment={root} />
                    {replies.length > 0 && (
                      <ol
                        className="comment-replies"
                        aria-label={'Replies to ' + root.author.name}
                      >
                        {replies.map((reply) => (
                          <li key={reply.id}>
                            <CommentItem comment={reply} />
                          </li>
                        ))}
                      </ol>
                    )}
                    {canComment &&
                      (replyTo === root.id ? (
                        <div className="comment-reply-form">
                          <label htmlFor={id + '-reply-' + root.id}>
                            Reply to {root.author.name}
                          </label>
                          <textarea
                            id={id + '-reply-' + root.id}
                            value={replyText}
                            maxLength={5000}
                            onChange={(event) =>
                              setReplyText(event.target.value)
                            }
                          />
                          <div className="inline-actions">
                            <button
                              type="button"
                              disabled={busy || !replyText.trim()}
                              onClick={() =>
                                void post(replyText, root.id).then((posted) => {
                                  if (posted) {
                                    setReplyTo('');
                                    setReplyText('');
                                  }
                                })
                              }
                            >
                              Post reply
                            </button>
                            <button
                              type="button"
                              className="secondary-button"
                              disabled={busy}
                              onClick={() => {
                                setReplyTo('');
                                setReplyText('');
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="secondary-button"
                          aria-label={
                            'Reply to ' + root.author.name + "'s comment"
                          }
                          onClick={() => {
                            setReplyTo(root.id);
                            setReplyText('');
                          }}
                        >
                          Reply
                        </button>
                      ))}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="empty-state">No comments on this revision.</p>
            ))}
          {postError && (
            <p role="alert" className="form-message">
              {postError}
            </p>
          )}
          {canComment && (
            <div className="template-preview">
              <label htmlFor={id + '-comment'}>Add a comment</label>
              <textarea
                id={id + '-comment'}
                value={commentText}
                maxLength={5000}
                onChange={(event) => setCommentText(event.target.value)}
              />
              <button
                type="button"
                disabled={busy || !commentText.trim()}
                onClick={() =>
                  void post(commentText).then((posted) => {
                    if (posted) setCommentText('');
                  })
                }
              >
                Add comment
              </button>
            </div>
          )}
        </section>
      )}
      {canReadDecisions && (
        <section className="feedback-block" aria-label="Decision history">
          <h4>Decision history</h4>
          <HistoryState state={decisions} empty="No review decisions yet.">
            {(items) => (
              <ul className="feedback-history">
                {items.map((item) => (
                  <li key={item.id}>
                    Revision {item.revisionNumber} ·{' '}
                    {statusLabel(item.decision)} by {item.reviewer.name} ·{' '}
                    <time dateTime={item.createdAt}>
                      {formatTime(item.createdAt)}
                    </time>
                    {item.reason ? ' — ' + item.reason : ''}
                  </li>
                ))}
              </ul>
            )}
          </HistoryState>
        </section>
      )}
      {showHistory && canReadRequests && (
        <section className="feedback-block" aria-label="Change requests">
          <h4>Change requests</h4>
          <HistoryState state={requests} empty="No change requests.">
            {(items) => (
              <ul className="feedback-history">
                {items.map((item) => (
                  <li key={item.id}>
                    Revision {item.revisionNumber} · {statusLabel(item.status)}:{' '}
                    {item.requestedChanges}
                    {item.explanation ? ' (' + item.explanation + ')' : ''}
                  </li>
                ))}
              </ul>
            )}
          </HistoryState>
        </section>
      )}
    </section>
  );
}

function CommentItem({ comment }: { comment: FeedbackComment }) {
  return (
    <article
      className="comment"
      aria-label={'Comment by ' + comment.author.name}
    >
      <p className="comment-meta">
        <strong>{comment.author.name}</strong> ·{' '}
        <time dateTime={comment.createdAt}>
          {formatTime(comment.createdAt)}
        </time>
      </p>
      <p className="comment-text">{comment.text}</p>
    </article>
  );
}

function HistoryState<T>({
  state,
  empty,
  children,
}: {
  state: Loadable<T[]>;
  empty: string;
  children: (items: T[]) => JSX.Element;
}) {
  if (state.status === 'loading')
    return (
      <p className="empty-state" aria-live="polite">
        Loading…
      </p>
    );
  if (state.status === 'error')
    return (
      <p role="alert" className="form-message">
        {state.message}
      </p>
    );
  return state.data.length ? (
    children(state.data)
  ) : (
    <p className="empty-state">{empty}</p>
  );
}
