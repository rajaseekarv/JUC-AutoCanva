import { useEffect, useId, useRef, useState } from 'react';
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
import FeedbackMessage from './FeedbackMessage';
import type { ReportOpen } from './useRecordLinks';
import { returnFocusToConfirmTrigger } from './confirmFocus';

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
  openRequest = null,
  onOpenResult,
}: {
  session: Session;
  dataChange?: DataChange;
  onDataChanged?: (source: DataChangeSource) => void;
  onUnauthorized: () => void;
  // A request (from a notification) to open the user's pending review of
  // one workflow run.
  openRequest?: { key: number; workflowInstanceId: string } | null;
  onOpenResult?: ReportOpen;
}) {
  const permissions = session.user.permissions;
  const canRead = permissions.includes('approvals:read');
  const canDecide = permissions.includes('approvals:decide');
  // Requesting changes also creates a change request, which the API allows
  // only with change_requests:create. The API still checks both.
  const canRequestChanges =
    canDecide && permissions.includes('change_requests:create');
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
  // The reviewer picks a decision first; each decision keeps its own text,
  // so an approval comment can never be sent as requested changes (or the
  // other way round).
  const [decisionChoice, setDecisionChoice] = useState<
    'APPROVED' | 'CHANGES_REQUESTED' | ''
  >('');
  const [approveComment, setApproveComment] = useState('');
  const [requestedChanges, setRequestedChanges] = useState('');
  const [changesExplanation, setChangesExplanation] = useState('');
  const [changesMissing, setChangesMissing] = useState(false);
  // The decision awaiting confirmation before it is sent.
  const [confirmingDecision, setConfirmingDecision] = useState(false);
  // Set while a decision is being sent, so a second click before the busy
  // state renders sends nothing.
  const decisionInFlight = useRef(false);
  const requestedChangesRef = useRef<HTMLTextAreaElement>(null);
  const decisionFieldsId = useId();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  // The change request awaiting confirmation before it is withdrawn.
  const [confirmingWithdrawId, setConfirmingWithdrawId] = useState('');
  const changesErrorId = useId();
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

  // A notification asked to open a review: reload the user's pending review
  // tasks, find the one for that workflow run and open it exactly as its
  // Review button does. Only the pending list is searched, so a review that
  // was decided or reassigned is reported as not found. A newer request
  // replaces an older one still loading.
  const latestOpen = useRef(0);
  useEffect(() => {
    if (!openRequest || latestOpen.current === openRequest.key) return;
    const { key, workflowInstanceId } = openRequest;
    latestOpen.current = key;
    void loadTasks().then((loaded) => {
      if (latestOpen.current !== key) return;
      if (!loaded) {
        onOpenResult?.(key, 'unavailable');
        return;
      }
      const task = loaded.find(
        (item) => item.instance.id === workflowInstanceId,
      );
      if (!task) {
        onOpenResult?.(key, 'not-found');
        return;
      }
      setConfirmingWithdrawId('');
      if (task.id !== taskId) resetDecisionForm();
      setTaskId(task.id);
      onOpenResult?.(key, 'opened');
    });
    // Runs once per request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest]);

  // Clears the decision form, for example after a decision was recorded or
  // when another review is opened, so no text carries over.
  function resetDecisionForm(): void {
    setDecisionChoice('');
    setApproveComment('');
    setRequestedChanges('');
    setChangesExplanation('');
    setChangesMissing(false);
    setConfirmingDecision(false);
  }

  function chooseDecision(choice: 'APPROVED' | 'CHANGES_REQUESTED'): void {
    setDecisionChoice(choice);
    setChangesMissing(false);
    // A confirmation always shows the decision it will send.
    setConfirmingDecision(false);
  }

  // "Review decision": checks the required text, then opens the
  // confirmation. Nothing is sent yet.
  function reviewDecision(): void {
    if (!decisionChoice) return;
    if (decisionChoice === 'CHANGES_REQUESTED' && !requestedChanges.trim()) {
      setChangesMissing(true);
      requestedChangesRef.current?.focus();
      return;
    }
    setConfirmingDecision(true);
  }

  // What the API receives: the request shape is unchanged. An approval sends
  // only its optional comment as `reason`; a change request sends what needs
  // to change as `reason` and its optional `explanation`.
  function decisionBody(): Record<string, string> {
    if (decisionChoice === 'APPROVED') {
      const comment = approveComment.trim();
      return { decision: 'APPROVED', ...(comment ? { reason: comment } : {}) };
    }
    const explanation = changesExplanation.trim();
    return {
      decision: 'CHANGES_REQUESTED',
      reason: requestedChanges.trim(),
      ...(explanation ? { explanation } : {}),
    };
  }

  async function sendDecision(): Promise<void> {
    if (!review || !decisionChoice || decisionInFlight.current) return;
    if (decisionChoice === 'CHANGES_REQUESTED' && !requestedChanges.trim())
      return;
    const decision = decisionChoice;
    decisionInFlight.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await request(
        `/approvals/tasks/${encodeURIComponent(review.task.id)}/decision`,
        { method: 'POST', body: JSON.stringify(decisionBody()) },
      );
      setMessage(
        decision === 'APPROVED' ? 'Review approved.' : 'Changes requested.',
      );
      resetDecisionForm();
      onDataChanged?.('approvals');
      await loadTasks();
      await loadDetail(review.task.id);
    } catch (cause) {
      // The confirmation stays open with the entered text, so the decision
      // can be sent again or edited.
      setError(
        cause instanceof Error ? cause.message : 'Unable to record decision.',
      );
    } finally {
      decisionInFlight.current = false;
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
          : 'Change request withdrawn.',
      );
      setConfirmingWithdrawId('');
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
          <p className="card-label">REVIEWS</p>
          <h2 id="approvals-title">Approvals & comments</h2>
          <p className="service-copy">
            Review creatives waiting for your decision, and read or add
            comments.
          </p>
        </div>
      </div>
      <FeedbackMessage tone="error" message={error} />
      <FeedbackMessage tone="success" message={message} />
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
                    <button
                      type="button"
                      onClick={() => {
                        // A withdrawal or decision prepared for one review
                        // must not carry over to the next. Focus stays on
                        // this button.
                        setConfirmingWithdrawId('');
                        if (task.id !== taskId) resetDecisionForm();
                        setTaskId(task.id);
                      }}
                    >
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
            <p className="card-label">YOU ARE REVIEWING</p>
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
              <p className="info-message">
                You submitted this creative, so another reviewer must decide.
              </p>
            )}
            {canDecide &&
              review.current &&
              !review.submittedByViewer &&
              review.task.status === 'OPEN' && (
                <div className="template-preview decision-form">
                  <fieldset className="decision-choice" disabled={busy}>
                    <legend>Your decision</legend>
                    <label className="checkbox-label">
                      <input
                        type="radio"
                        name={decisionFieldsId + '-decision'}
                        value="APPROVED"
                        checked={decisionChoice === 'APPROVED'}
                        onChange={() => chooseDecision('APPROVED')}
                      />
                      Approve
                    </label>
                    {canRequestChanges && (
                      <label className="checkbox-label">
                        <input
                          type="radio"
                          name={decisionFieldsId + '-decision'}
                          value="CHANGES_REQUESTED"
                          checked={decisionChoice === 'CHANGES_REQUESTED'}
                          onChange={() => chooseDecision('CHANGES_REQUESTED')}
                        />
                        Request changes
                      </label>
                    )}
                  </fieldset>
                  {!canRequestChanges && (
                    <p className="field-hint">
                      You can approve this revision. Requesting changes needs
                      permission to create change requests.
                    </p>
                  )}
                  {decisionChoice === 'APPROVED' && (
                    <>
                      <label>
                        <span>
                          Comment
                          <span className="field-hint"> (optional)</span>
                        </span>
                        <textarea
                          value={approveComment}
                          onChange={(event) =>
                            setApproveComment(event.target.value)
                          }
                          maxLength={5000}
                          disabled={busy}
                          aria-describedby={decisionFieldsId + '-comment-help'}
                        />
                      </label>
                      {/* Outside the label, so it describes the field
                          without becoming part of its name. */}
                      <small id={decisionFieldsId + '-comment-help'}>
                        Saved with your decision. To discuss the creative with
                        others, use Comments below.
                      </small>
                    </>
                  )}
                  {decisionChoice === 'CHANGES_REQUESTED' && (
                    <>
                      <label>
                        <span>
                          What needs to change
                          <span className="field-hint"> (required)</span>
                        </span>
                        <textarea
                          ref={requestedChangesRef}
                          value={requestedChanges}
                          onChange={(event) => {
                            setRequestedChanges(event.target.value);
                            if (event.target.value.trim())
                              setChangesMissing(false);
                          }}
                          maxLength={5000}
                          disabled={busy}
                          aria-required="true"
                          aria-invalid={changesMissing || undefined}
                          aria-describedby={
                            changesMissing ? changesErrorId : undefined
                          }
                        />
                      </label>
                      {changesMissing && (
                        <small id={changesErrorId} className="field-error">
                          Describe what needs to change before requesting
                          changes.
                        </small>
                      )}
                      <label>
                        <span>
                          Explanation
                          <span className="field-hint"> (optional)</span>
                        </span>
                        <textarea
                          value={changesExplanation}
                          onChange={(event) =>
                            setChangesExplanation(event.target.value)
                          }
                          maxLength={5000}
                          disabled={busy}
                        />
                      </label>
                    </>
                  )}
                  <div className="template-actions">
                    <button
                      type="button"
                      disabled={busy || !decisionChoice}
                      aria-expanded={confirmingDecision}
                      aria-describedby={
                        decisionChoice
                          ? undefined
                          : decisionFieldsId + '-choose-hint'
                      }
                      onClick={reviewDecision}
                    >
                      Review decision
                    </button>
                  </div>
                  {!decisionChoice && (
                    <p
                      id={decisionFieldsId + '-choose-hint'}
                      className="field-hint"
                    >
                      Choose a decision to continue.
                    </p>
                  )}
                  {confirmingDecision && decisionChoice && (
                    <div
                      className="confirm-panel"
                      role="group"
                      aria-label={
                        (decisionChoice === 'APPROVED'
                          ? 'Confirm approving revision '
                          : 'Confirm requesting changes to revision ') +
                        review.revision.revisionNumber
                      }
                    >
                      {decisionChoice === 'APPROVED' ? (
                        <p>
                          Approve revision {review.revision.revisionNumber} of “
                          {review.creative.name}”? Your decision is final and
                          moves the creative on in its workflow.
                        </p>
                      ) : (
                        <p>
                          Request changes to revision{' '}
                          {review.revision.revisionNumber} of “
                          {review.creative.name}”? Your decision is final. A
                          change request is opened, and whoever submitted the
                          creative is asked to save a new revision.
                        </p>
                      )}
                      <dl className="decision-summary">
                        {decisionChoice === 'APPROVED' ? (
                          <>
                            <dt>Comment</dt>
                            <dd>{approveComment.trim() || 'No comment'}</dd>
                          </>
                        ) : (
                          <>
                            <dt>What needs to change</dt>
                            <dd>{requestedChanges.trim()}</dd>
                            <dt>Explanation</dt>
                            <dd>{changesExplanation.trim() || 'None'}</dd>
                          </>
                        )}
                      </dl>
                      <div className="template-actions">
                        <button
                          type="button"
                          className={
                            decisionChoice === 'APPROVED'
                              ? undefined
                              : 'warning-button'
                          }
                          disabled={busy}
                          onClick={() => void sendDecision()}
                        >
                          {decisionChoice === 'APPROVED'
                            ? 'Approve revision '
                            : 'Request changes to revision '}
                          {review.revision.revisionNumber}
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={busy}
                          onClick={(event) => {
                            returnFocusToConfirmTrigger(event.currentTarget);
                            setConfirmingDecision(false);
                          }}
                        >
                          Back to edit
                        </button>
                      </div>
                    </div>
                  )}
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
                          Mark as in progress
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
                            aria-expanded={confirmingWithdrawId === item.id}
                            onClick={() => setConfirmingWithdrawId(item.id)}
                          >
                            Withdraw request
                          </button>
                        </>
                      )}
                    {confirmingWithdrawId === item.id &&
                      permissions.includes('change_requests:resolve') &&
                      ['OPEN', 'IN_PROGRESS'].includes(item.status) && (
                        <span
                          className="confirm-panel"
                          role="group"
                          aria-label={
                            'Confirm withdrawing the change request on revision ' +
                            item.revisionNumber
                          }
                        >
                          <span>
                            Withdraw this change request? It will be marked
                            Cancelled and will no longer stop revision{' '}
                            {item.revisionNumber} from being resubmitted. The
                            request and its history are kept.
                          </span>
                          <span className="template-actions">
                            <button
                              type="button"
                              className="danger-button"
                              disabled={busy}
                              aria-label={
                                'Withdraw request on revision ' +
                                item.revisionNumber
                              }
                              onClick={() =>
                                void updateRequest(item.id, 'cancel')
                              }
                            >
                              Withdraw request
                            </button>
                            <button
                              type="button"
                              className="secondary-button"
                              disabled={busy}
                              onClick={(event) => {
                                returnFocusToConfirmTrigger(
                                  event.currentTarget,
                                );
                                setConfirmingWithdrawId('');
                              }}
                            >
                              Keep request
                            </button>
                          </span>
                        </span>
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
