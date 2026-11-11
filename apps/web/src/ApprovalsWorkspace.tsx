import { useEffect, useState } from 'react';
import type { AuthenticatedUserResponse } from '@adflow/shared-types';
import type { AssetSource } from './assetFiles';
import { AssetReference } from './AssetImage';
import ReviewFeedback from './ReviewFeedback';
import { statusLabel } from './statusDisplay';
import {
  useOtherScreenChanges,
  type DataChange,
  type DataChangeSource,
} from './dataChanges';

const apiBase =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000/api/v1';
type Session = { accessToken: string; user: AuthenticatedUserResponse };
type Task = {
  id: string;
  status: string;
  stage: { key: string; name: string };
  instance: {
    id: string;
    creative: {
      id: string;
      name: string;
      currentRevision: { revisionNumber: number } | null;
    };
  };
};
type Review = {
  task: { id: string; status: string; stage: { key: string; name: string } };
  workflow: { id: string; name: string };
  creative: { id: string; name: string; currentRevisionId: string | null };
  revision: {
    id: string;
    revisionNumber: number;
    values: Record<string, unknown>;
    templateVersion: { fields: { key: string; label: string; type: string }[] };
  };
  current: boolean;
  submittedByViewer?: boolean;
};
type ChangeRequest = {
  id: string;
  revisionNumber: number;
  requestedChanges: string;
  explanation: string | null;
  status: string;
};
type Decision = {
  id: string;
  revisionNumber: number;
  decision: string;
  reason: string | null;
  createdAt: string;
  reviewer: { name: string };
};

export default function ApprovalsWorkspace({
  session,
  dataChange,
  onDataChanged,
  onUnauthorized,
}: {
  session: Session;
  dataChange?: DataChange;
  onDataChanged?: (source: DataChangeSource) => void;
  onUnauthorized: () => void;
}) {
  const permissions = session.user.permissions;
  const canRead = permissions.includes('approvals:read');
  const canDecide = permissions.includes('approvals:decide');
  const canReadComments = permissions.includes('comments:read');
  const assetSource: AssetSource = {
    apiBase,
    accessToken: session.accessToken,
    onUnauthorized,
  };
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskId, setTaskId] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  // Bumped after each detail load so the feedback panel reloads too.
  const [feedbackKey, setFeedbackKey] = useState(0);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [requests, setRequests] = useState<ChangeRequest[]>([]);
  const [reason, setReason] = useState('');
  const [explanation, setExplanation] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [loadingReview, setLoadingReview] = useState(false);

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(apiBase + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
    if (response.status === 401) {
      onUnauthorized();
      throw new Error('Your session expired. Sign in again.');
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        message?: string | string[];
      } | null;
      throw new Error(
        Array.isArray(body?.message)
          ? body.message.join(' ')
          : (body?.message ?? 'Unable to complete review request.'),
      );
    }
    return response.json() as Promise<T>;
  }

  async function loadTasks(): Promise<Task[] | null> {
    if (!canRead) return null;
    setLoadingTasks(true);
    try {
      const loaded = await request<Task[]>('/approvals/tasks');
      setTasks(loaded);
      setError('');
      return loaded;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Unable to load reviews.',
      );
      return null;
    } finally {
      setLoadingTasks(false);
    }
  }

  // Another screen changed review data (for example a run reached review or
  // a creative was resubmitted): refresh the assignments, and the open review
  // while it is still pending. The selection is kept.
  async function refreshFromOtherScreen(): Promise<void> {
    const loaded = await loadTasks();
    if (taskId && loaded?.some((task) => task.id === taskId))
      await loadDetail(taskId);
  }
  useOtherScreenChanges(
    dataChange,
    'approvals',
    () => void refreshFromOtherScreen(),
  );

  async function loadDetail(id: string): Promise<void> {
    if (!id) return;
    setLoadingReview(true);
    try {
      const detail = await request<Review>(
        `/approvals/tasks/${encodeURIComponent(id)}`,
      );
      setReview(detail);
      const creativeId = encodeURIComponent(detail.creative.id);
      const jobs: Promise<void>[] = [];
      if (permissions.includes('approvals:read'))
        jobs.push(
          request<Decision[]>(`/creatives/${creativeId}/decisions`).then(
            setDecisions,
          ),
        );
      if (permissions.includes('change_requests:read'))
        jobs.push(
          request<ChangeRequest[]>(
            `/creatives/${creativeId}/change-requests`,
          ).then(setRequests),
        );
      await Promise.all(jobs);
      setFeedbackKey((key) => key + 1);
      setError('');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Unable to load review details.',
      );
    } finally {
      setLoadingReview(false);
    }
  }

  useEffect(() => {
    void loadTasks(); /* Scoped to session identity. */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.accessToken]);
  useEffect(() => {
    if (taskId) void loadDetail(taskId);
    else setReview(null); /* Scoped to selected task. */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, session.accessToken]);

  async function decide(
    decision: 'APPROVED' | 'CHANGES_REQUESTED',
  ): Promise<void> {
    if (!review || (decision === 'CHANGES_REQUESTED' && !reason.trim())) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await request(
        `/approvals/tasks/${encodeURIComponent(review.task.id)}/decision`,
        {
          method: 'POST',
          body: JSON.stringify({
            decision,
            ...(reason.trim() ? { reason: reason.trim() } : {}),
            ...(decision === 'CHANGES_REQUESTED' && explanation.trim()
              ? { explanation: explanation.trim() }
              : {}),
          }),
        },
      );
      setMessage(
        decision === 'APPROVED' ? 'Review approved.' : 'Changes requested.',
      );
      setReason('');
      setExplanation('');
      onDataChanged?.('approvals');
      await loadTasks();
      await loadDetail(review.task.id);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Unable to record decision.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function resolve(id: string): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await request(`/change-requests/${encodeURIComponent(id)}/resolve`, {
        method: 'POST',
      });
      onDataChanged?.('approvals');
      await loadDetail(review!.task.id);
      setMessage('Change request resolved.');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Unable to resolve change request.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function updateRequest(
    id: string,
    action: 'start' | 'cancel',
  ): Promise<void> {
    if (!review) return;
    setBusy(true);
    setError('');
    try {
      await request(`/change-requests/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
      });
      onDataChanged?.('approvals');
      await loadDetail(review.task.id);
      setMessage(
        action === 'start'
          ? 'Change request moved to in progress.'
          : 'Change request cancelled.',
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Unable to update change request.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (!canRead && !canReadComments) return null;
  const fields = review?.revision.templateVersion.fields ?? [];
  return (
    <section
      className="admin-panel"
      id="approvals"
      aria-labelledby="approvals-title"
    >
      <div className="admin-heading">
        <div>
          <p className="card-label">REVISION-AWARE REVIEW</p>
          <h2 id="approvals-title">Approvals & comments</h2>
        </div>
      </div>
      {error && (
        <p role="alert" className="form-message">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="success-message">
          {message}
        </p>
      )}
      <div className="creative-layout">
        {canRead && (
          <section className="admin-card">
            <h3>Pending review assignments</h3>
            {loadingTasks && <p role="status">Loading assignments…</p>}
            {!loadingTasks && tasks.length ? (
              <ul className="admin-list">
                {tasks.map((task) => (
                  <li key={task.id}>
                    <div>
                      <strong>{task.instance.creative.name}</strong>
                      <span>
                        {task.stage.name} · revision{' '}
                        {task.instance.creative.currentRevision
                          ?.revisionNumber ?? 'unknown'}
                      </span>
                    </div>
                    <button type="button" onClick={() => setTaskId(task.id)}>
                      Review
                    </button>
                  </li>
                ))}
              </ul>
            ) : !loadingTasks ? (
              <p className="empty-state">No pending reviews.</p>
            ) : null}
          </section>
        )}
        {loadingReview && (
          <section className="admin-card" role="status">
            Loading revision context…
          </section>
        )}
        {review && !loadingReview && (
          <section className="admin-card" aria-label="Review detail">
            <p className="card-label">EXACT CREATIVE REVISION</p>
            <h3>
              {review.creative.name} · Revision {review.revision.revisionNumber}
            </h3>
            <p>
              {review.workflow.name} · {review.task.stage.name}
            </p>
            {!review.current && (
              <p role="alert" className="form-message">
                This review is closed or stale. Decisions are disabled.
              </p>
            )}
            <dl className="preview-results">
              {fields.map((field) => (
                <div key={field.key}>
                  <dt>{field.label}</dt>
                  <dd>
                    {field.type === 'IMAGE' || field.type === 'LOGO' ? (
                      <AssetReference
                        assetId={review.revision.values[field.key]}
                        label={field.label}
                        source={assetSource}
                        canReadAssets={permissions.includes('assets:read')}
                      />
                    ) : (
                      formatValue(review.revision.values[field.key])
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            {review.submittedByViewer && (
              <p className="form-message">
                You submitted this creative, so another reviewer must decide.
              </p>
            )}
            {canDecide &&
              review.current &&
              !review.submittedByViewer &&
              review.task.status === 'OPEN' && (
                <div className="template-preview">
                  <label htmlFor="review-reason">
                    Decision reason or requested changes
                  </label>
                  <textarea
                    id="review-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    maxLength={5000}
                  />
                  <label htmlFor="review-explanation">
                    Optional explanation
                  </label>
                  <textarea
                    id="review-explanation"
                    value={explanation}
                    onChange={(event) => setExplanation(event.target.value)}
                    maxLength={5000}
                  />
                  <div className="template-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void decide('APPROVED')}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="warning-button"
                      disabled={busy || !reason.trim()}
                      onClick={() => void decide('CHANGES_REQUESTED')}
                    >
                      Request changes
                    </button>
                  </div>
                </div>
              )}
            <ReviewFeedback
              session={session}
              creativeId={review.creative.id}
              latestRevisionNumber={review.revision.revisionNumber}
              onUnauthorized={onUnauthorized}
              showHistory={false}
              refreshKey={feedbackKey}
              title="Comments"
            />
            {decisions.length > 0 && (
              <div className="creative-inspection">
                <h4>Review history</h4>
                {decisions.map((item) => (
                  <p key={item.id}>
                    Revision {item.revisionNumber} ·{' '}
                    {statusLabel(item.decision)} by {item.reviewer.name}
                    {item.reason ? ` — ${item.reason}` : ''}
                  </p>
                ))}
              </div>
            )}
            {requests.length > 0 && (
              <div className="creative-inspection">
                <h4>Change requests</h4>
                {requests.map((item) => (
                  <p key={item.id}>
                    Revision {item.revisionNumber} · {statusLabel(item.status)}:{' '}
                    {item.requestedChanges}
                    {item.explanation ? ` (${item.explanation})` : ''}
                    {item.status === 'OPEN' &&
                      permissions.includes('change_requests:create') && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void updateRequest(item.id, 'start')}
                        >
                          Start work
                        </button>
                      )}
                    {permissions.includes('change_requests:resolve') &&
                      ['OPEN', 'IN_PROGRESS'].includes(item.status) && (
                        <>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void resolve(item.id)}
                          >
                            Resolve
                          </button>
                          <button
                            type="button"
                            className="danger-button"
                            disabled={busy}
                            onClick={() =>
                              void updateRequest(item.id, 'cancel')
                            }
                          >
                            Cancel
                          </button>
                        </>
                      )}
                  </p>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </section>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
