import { useEffect, useId, useRef, useState } from 'react';
import type {
  AuthenticatedUserResponse,
  CreativeResponse,
  BranchResponse,
} from '@adflow/shared-types';
import StatusBadge from './StatusBadge';
import {
  useOtherScreenChanges,
  type DataChange,
  type DataChangeSource,
} from './dataChanges';
import { statusLabel } from './statusDisplay';
import { approvalSummaryText } from './approvalText';

const apiBase =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000/api/v1';
// Mirrors the API's limit for POST /workflow-instances/:id/cancel.
const CANCEL_REASON_MAX_LENGTH = 1000;
type Session = { accessToken: string; user: AuthenticatedUserResponse };
type Stage = {
  id: string;
  key: string;
  name: string;
  displayOrder: number;
  isEntry: boolean;
  isTerminal: boolean;
  requiredPermission: string | null;
  assignedUserId: string | null;
  assignedPermission: string | null;
  requiresReview?: boolean;
};
type Transition = {
  id: string;
  key: string;
  label: string;
  sourceStageId: string;
  destinationStageId: string;
  requiredPermission: string | null;
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | null;
};
type Version = {
  id: string;
  versionNumber: number;
  stages: Stage[];
  transitions: Transition[];
};
type Workflow = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  currentVersionNumber: number;
  enabledVersionNumber: number | null;
  versions: Version[];
};
type Creative = Pick<
  CreativeResponse,
  | 'id'
  | 'name'
  | 'status'
  | 'currentRevisionId'
  | 'currentRevision'
  | 'approvedRevision'
  | 'currentRevisionApproved'
>;
type Instance = {
  id: string;
  status: string;
  currentStage: Stage;
  creativeRevisionId: string;
  startedById?: string;
  // Review decisions recorded in this run; the starter may cancel only
  // while there are none.
  _count?: { approvalDecisions: number };
  version: Version;
  tasks: {
    id: string;
    status: string;
    stage: Stage;
    requiredPermission: string | null;
  }[];
  history: {
    id: string;
    actionKey: string;
    reason: string | null;
    createdAt: string;
    fromStage: Stage | null;
    toStage: Stage;
  }[];
};

function defaultDefinition(): string {
  return JSON.stringify(
    {
      name: 'Branch creative workflow',
      description: '',
      stages: [
        { key: 'draft', name: 'Draft', displayOrder: 0, isEntry: true },
        {
          key: 'ready',
          name: 'Ready',
          displayOrder: 1,
          isTerminal: true,
          requiredPermission: 'workflows:transition',
        },
      ],
      transitions: [
        {
          key: 'submit',
          label: 'Submit',
          from: 'draft',
          to: 'ready',
          requiredPermission: 'workflows:transition',
        },
      ],
    },
    null,
    2,
  );
}

export default function WorkflowWorkspace({
  session,
  branch,
  dataChange,
  onDataChanged,
  onUnauthorized,
}: {
  session: Session;
  branch: BranchResponse | null;
  dataChange?: DataChange;
  onDataChanged?: (source: DataChangeSource) => void;
  onUnauthorized: () => void;
}) {
  // Bumped to reload the selected creative's run after another screen
  // changed it.
  const [instanceKey, setInstanceKey] = useState(0);
  const canRead = session.user.permissions.includes('workflows:read');
  const canManage = session.user.permissions.includes('workflows:manage');
  const canStart = session.user.permissions.includes('workflows:start');
  const canTransition = session.user.permissions.includes(
    'workflows:transition',
  );
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflowId, setWorkflowId] = useState('');
  const [definitionText, setDefinitionText] = useState(defaultDefinition());
  const [creatives, setCreatives] = useState<Creative[]>([]);
  const [creativeId, setCreativeId] = useState('');
  const [instance, setInstance] = useState<Instance | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  // Cancellation of the selected run: the reason form, and a guard against a
  // second submission before the first one's busy state has rendered.
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelError, setCancelError] = useState('');
  const cancelInFlight = useRef(false);
  const cancelReasonId = useId();
  const startBlockedId = useId();
  const instanceId = instance?.id;
  useEffect(() => {
    // A different run (or none) is shown: drop any half-entered reason.
    setCancelOpen(false);
    setCancelReason('');
    setCancelError('');
  }, [instanceId]);
  const selected = workflows.find((item) => item.id === workflowId) ?? null;

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
          : (body?.message ?? 'Unable to complete workflow request.'),
      );
    }
    // The API sends an empty body for null, for example a creative that has
    // never had a workflow run.
    const text = await response.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  async function reload(): Promise<void> {
    try {
      const [definitions, branchCreatives] = await Promise.all([
        canRead ? request<Workflow[]>('/workflows') : Promise.resolve([]),
        branch &&
        (canStart || session.user.permissions.includes('creatives:read'))
          ? request<Creative[]>(
              `/creatives?branchId=${encodeURIComponent(branch.id)}`,
            )
          : Promise.resolve([]),
      ]);
      setWorkflows(definitions);
      setCreatives(branchCreatives);
      if (workflowId && !definitions.some((item) => item.id === workflowId))
        setWorkflowId('');
      setError('');
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Unable to load workflows.',
      );
    }
  }

  useEffect(() => {
    void reload(); /* Reload is scoped to user and selected branch. */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.accessToken, branch?.id]);
  useEffect(() => {
    if (!selected) return;
    const version = selected.versions.find(
      (item) => item.versionNumber === selected.currentVersionNumber,
    );
    if (!version) return;
    setDefinitionText(
      JSON.stringify(
        {
          name: selected.name,
          description: selected.description,
          stages: version.stages.map(
            ({
              key,
              name,
              displayOrder,
              isEntry,
              isTerminal,
              requiredPermission,
              assignedUserId,
              assignedPermission,
              requiresReview,
            }) => ({
              key,
              name,
              displayOrder,
              isEntry,
              isTerminal,
              requiredPermission,
              assignedUserId,
              assignedPermission,
              requiresReview,
            }),
          ),
          transitions: version.transitions.map((transition) => ({
            key: transition.key,
            label: transition.label,
            from: version.stages.find(
              (stage) => stage.id === transition.sourceStageId,
            )?.key,
            to: version.stages.find(
              (stage) => stage.id === transition.destinationStageId,
            )?.key,
            requiredPermission: transition.requiredPermission,
            reviewDecision: transition.reviewDecision,
          })),
        },
        null,
        2,
      ),
    );
  }, [selected, workflowId, workflows]);
  // Revision numbers with an OPEN or IN_PROGRESS change request for the
  // selected creative. The API refuses a run for such a revision (409); this
  // only explains it before Start is pressed, so it is loaded only for users
  // who may read change requests.
  const [unresolvedRevisions, setUnresolvedRevisions] = useState<number[]>([]);
  const [requestsKey, setRequestsKey] = useState(0);
  const canReadRequests = session.user.permissions.includes(
    'change_requests:read',
  );
  useEffect(() => {
    setUnresolvedRevisions([]);
    if (!creativeId || !canReadRequests) return;
    let cancelled = false;
    void request<{ status: string; revisionNumber: number }[] | null>(
      `/creatives/${encodeURIComponent(creativeId)}/change-requests`,
    )
      .then((requests) => {
        if (cancelled) return;
        setUnresolvedRevisions(
          (requests ?? [])
            .filter(
              (item) => item.status === 'OPEN' || item.status === 'IN_PROGRESS',
            )
            .map((item) => item.revisionNumber),
        );
      })
      .catch(() => {
        // Without them Start stays available and the API still decides.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creativeId, session.accessToken, instanceKey, requestsKey]);
  const selectedCreative =
    creatives.find((item) => item.id === creativeId) ?? null;
  const currentRevisionNumber =
    selectedCreative?.currentRevision?.revisionNumber;
  const startBlockedByRequests =
    currentRevisionNumber !== undefined &&
    unresolvedRevisions.includes(currentRevisionNumber);

  useEffect(() => {
    if (!creativeId) {
      setInstance(null);
      return;
    }
    void request<Instance | null>(
      `/creatives/${encodeURIComponent(creativeId)}/workflow`,
    )
      .then(setInstance)
      .catch((cause: unknown) =>
        setError(
          cause instanceof Error
            ? cause.message
            : 'Unable to load workflow state.',
        ),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creativeId, session.accessToken, instanceKey]);

  // Another screen changed review data: refresh the creative picker and the
  // selected creative's run. Definitions and selections are kept.
  async function refreshFromOtherScreen(): Promise<void> {
    if (
      branch &&
      (canStart || session.user.permissions.includes('creatives:read'))
    ) {
      try {
        setCreatives(
          await request<Creative[]>(
            `/creatives?branchId=${encodeURIComponent(branch.id)}`,
          ),
        );
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : 'Unable to load workflows.',
        );
      }
    }
    if (creativeId) setInstanceKey((key) => key + 1);
  }
  useOtherScreenChanges(
    dataChange,
    'workflows',
    () => void refreshFromOtherScreen(),
  );

  async function saveDefinition(): Promise<void> {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const definition: unknown = JSON.parse(definitionText);
      const saved = await request<Workflow>(
        workflowId
          ? `/workflows/${encodeURIComponent(workflowId)}`
          : '/workflows',
        {
          method: workflowId ? 'PATCH' : 'POST',
          body: JSON.stringify(definition),
        },
      );
      setWorkflows((current) => [
        saved,
        ...current.filter((item) => item.id !== saved.id),
      ]);
      setWorkflowId(saved.id);
      setMessage('A new editable workflow version was saved.');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Definition must be valid JSON.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function mutateDefinition(
    action: 'validate' | 'enable' | 'disable',
  ): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await request<
        { valid?: boolean; errors?: string[] } | Workflow
      >(`/workflows/${encodeURIComponent(selected.id)}/${action}`, {
        method: 'POST',
      });
      if (action === 'validate')
        setMessage(
          (result as { valid: boolean; errors: string[] }).valid
            ? 'Workflow definition is valid.'
            : (result as { errors: string[] }).errors.join(' '),
        );
      else {
        const updated = result as Workflow;
        setWorkflows((current) =>
          current.map((item) =>
            item.id === updated.id ? { ...item, ...updated } : item,
          ),
        );
        setMessage(`Workflow ${action}d.`);
      }
      await reload();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Unable to update workflow.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function startWorkflow(): Promise<void> {
    if (!creativeId || !selected) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const started = await request<Instance>(
        `/creatives/${encodeURIComponent(creativeId)}/workflows`,
        { method: 'POST', body: JSON.stringify({ workflowId: selected.id }) },
      );
      setInstance(started);
      setMessage('Workflow started against the selected creative revision.');
      await reload();
      onDataChanged?.('workflows');
    } catch (cause) {
      // The chosen workflow stays selected. A refusal may come from change
      // requests added since they were loaded, so reload them.
      setError(
        cause instanceof Error ? cause.message : 'Unable to start workflow.',
      );
      setRequestsKey((key) => key + 1);
    } finally {
      setBusy(false);
    }
  }

  // A workflow manager may cancel any running run; whoever started it only
  // while no review decision is recorded. The API enforces both rules.
  const canCancel =
    instance?.status === 'RUNNING' &&
    (canManage ||
      (canStart &&
        instance.startedById === session.user.id &&
        instance._count?.approvalDecisions === 0));

  async function cancelRun(): Promise<void> {
    if (!instance || cancelInFlight.current) return;
    const reason = cancelReason.trim();
    if (!reason) {
      setCancelError('Enter a reason for cancelling this run.');
      return;
    }
    if (reason.length > CANCEL_REASON_MAX_LENGTH) {
      setCancelError(
        `The reason must be at most ${CANCEL_REASON_MAX_LENGTH} characters.`,
      );
      return;
    }
    cancelInFlight.current = true;
    setBusy(true);
    setCancelError('');
    setError('');
    setMessage('');
    try {
      const cancelled = await request<Instance>(
        `/workflow-instances/${encodeURIComponent(instance.id)}/cancel`,
        { method: 'POST', body: JSON.stringify({ reason }) },
      );
      setInstance(cancelled);
      setCancelOpen(false);
      setCancelReason('');
      setMessage(
        'Run cancelled. The creative can be revised and submitted again.',
      );
      await reload();
      onDataChanged?.('workflows');
    } catch (cause) {
      // Kept next to the reason so it can be corrected or retried; the run
      // is reloaded in case it changed meanwhile.
      setCancelError(
        cause instanceof Error ? cause.message : 'Unable to cancel the run.',
      );
      setInstanceKey((key) => key + 1);
    } finally {
      cancelInFlight.current = false;
      setBusy(false);
    }
  }

  async function transition(key: string): Promise<void> {
    if (!instance) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const changed = await request<Instance>(
        `/workflow-instances/${encodeURIComponent(instance.id)}/transitions`,
        { method: 'POST', body: JSON.stringify({ transitionKey: key }) },
      );
      setInstance(changed);
      setMessage('Workflow moved to ' + changed.currentStage.name + '.');
      await reload();
      onDataChanged?.('workflows');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Unable to transition workflow.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (!canRead && !canStart) return null;
  const outgoing =
    instance?.version.transitions.filter(
      (item) => item.sourceStageId === instance.currentStage.id,
    ) ?? [];
  function canTakeTransition(item: Transition): boolean {
    if (!instance) return false;
    const destination = instance.version.stages.find(
      (stage) => stage.id === item.destinationStageId,
    );
    const required = [
      instance.currentStage.requiredPermission,
      item.requiredPermission,
      destination?.requiredPermission,
    ].filter((permission): permission is string => Boolean(permission));
    const hasRequiredPermissions = required.every((permission) =>
      session.user.permissions.includes(permission),
    );
    const currentStage = instance.currentStage;
    const eligibleForAssignment =
      (!currentStage.assignedUserId && !currentStage.assignedPermission) ||
      currentStage.assignedUserId === session.user.id ||
      Boolean(
        currentStage.assignedPermission &&
        session.user.permissions.includes(currentStage.assignedPermission),
      );
    return hasRequiredPermissions && eligibleForAssignment;
  }
  return (
    <section
      className="admin-panel"
      id="workflows"
      aria-labelledby="workflow-title"
    >
      <div className="admin-heading">
        <div>
          <p className="eyebrow">CONFIGURABLE OPERATIONS</p>
          <h2 id="workflow-title">Creative workflows</h2>
        </div>
        <button className="secondary-button" onClick={() => void reload()}>
          Refresh
        </button>
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
            <h3>Organization definitions</h3>
            <label>
              Workflow
              <select
                aria-label="Workflow definition"
                value={workflowId}
                onChange={(event) => setWorkflowId(event.target.value)}
              >
                <option value="">Choose workflow</option>
                {workflows.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {statusLabel(item.status)} · v
                    {item.currentVersionNumber}
                  </option>
                ))}
              </select>
            </label>
            {canManage && (
              <>
                <label>
                  Validated declarative definition (JSON)
                  <textarea
                    aria-label="Workflow definition JSON"
                    rows={18}
                    spellCheck={false}
                    value={definitionText}
                    onChange={(event) => setDefinitionText(event.target.value)}
                  />
                </label>
                <div className="button-row">
                  <button disabled={busy} onClick={() => void saveDefinition()}>
                    {workflowId ? 'Save new version' : 'Create workflow'}
                  </button>
                  {selected && (
                    <>
                      <button
                        className="secondary-button"
                        disabled={busy}
                        onClick={() => void mutateDefinition('validate')}
                      >
                        Validate
                      </button>
                      {selected.status === 'ENABLED' ? (
                        <button
                          className="secondary-button"
                          disabled={busy}
                          onClick={() => void mutateDefinition('disable')}
                        >
                          Disable
                        </button>
                      ) : (
                        <button
                          className="secondary-button"
                          disabled={busy}
                          onClick={() => void mutateDefinition('enable')}
                        >
                          Enable
                        </button>
                      )}
                    </>
                  )}
                </div>
              </>
            )}
          </section>
        )}
        <section className="admin-card">
          <h3>Branch creative state</h3>
          {branch ? (
            <label>
              Creative
              <select
                aria-label="Branch creative"
                value={creativeId}
                onChange={(event) => setCreativeId(event.target.value)}
              >
                <option value="">Choose creative</option>
                {creatives.map((item) => (
                  <option key={item.id} value={item.id}>
                    {[
                      item.name,
                      statusLabel(item.status),
                      approvalSummaryText(item),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p>Select a branch to view its creatives.</p>
          )}
          {/* Only one run may be active per creative; after a run completes
              (for example with changes requested) a new run can start
              against the creative's latest revision. */}
          {creativeId && instance?.status !== 'RUNNING' && canStart && (
            <>
              <label>
                Enabled workflow
                <select
                  aria-label="Workflow to start"
                  value={workflowId}
                  onChange={(event) => setWorkflowId(event.target.value)}
                >
                  <option value="">Choose workflow</option>
                  {workflows
                    .filter((item) => item.status === 'ENABLED')
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                </select>
              </label>
              {startBlockedByRequests && (
                <p className="empty-state" id={startBlockedId}>
                  Revision {currentRevisionNumber} has unresolved change
                  requests. Save a new revision with the requested changes in
                  Creatives before resubmitting it for review.
                </p>
              )}
              <button
                disabled={
                  busy ||
                  !selected ||
                  selected.status !== 'ENABLED' ||
                  startBlockedByRequests
                }
                aria-describedby={
                  startBlockedByRequests ? startBlockedId : undefined
                }
                onClick={() => void startWorkflow()}
              >
                Start workflow
              </button>
            </>
          )}
          {instance && (
            <>
              <h4>
                {instance.currentStage.name} ·{' '}
                <StatusBadge status={instance.status} />
              </h4>
              <p>
                Tracking creative revision{' '}
                {creatives.find((item) => item.id === creativeId)
                  ?.currentRevisionId === instance.creativeRevisionId
                  ? 'currently selected'
                  : 'snapshot retained'}{' '}
                ({instance.creativeRevisionId})
              </p>
              <p>
                Open tasks:{' '}
                {instance.tasks
                  .filter((task) => task.status === 'OPEN')
                  .map(
                    (task) =>
                      task.stage.name +
                      (task.requiredPermission
                        ? ` · ${task.requiredPermission}`
                        : ''),
                  )
                  .join(', ') || 'none'}
              </p>
              {canTransition &&
                !instance.currentStage.requiresReview &&
                outgoing.map((item) => (
                  <button
                    key={item.id}
                    disabled={busy || !canTakeTransition(item)}
                    onClick={() => void transition(item.key)}
                  >
                    {item.label}
                  </button>
                ))}
              {canCancel &&
                (cancelOpen ? (
                  <div
                    className="template-preview"
                    role="group"
                    aria-label="Cancel run"
                  >
                    <label htmlFor={cancelReasonId}>
                      Reason for cancelling (required)
                    </label>
                    <textarea
                      id={cancelReasonId}
                      value={cancelReason}
                      maxLength={CANCEL_REASON_MAX_LENGTH}
                      aria-invalid={cancelError ? true : undefined}
                      onChange={(event) => {
                        setCancelReason(event.target.value);
                        setCancelError('');
                      }}
                    />
                    <p className="empty-state">
                      Cancelling ends this run at the{' '}
                      {instance.currentStage.name} stage. Its decisions, change
                      requests and history are kept, open tasks close, and the
                      creative can be revised again.
                    </p>
                    {cancelError && (
                      <p role="alert" className="form-message">
                        {cancelError}
                      </p>
                    )}
                    <div className="template-actions">
                      <button
                        type="button"
                        className="warning-button"
                        disabled={busy}
                        onClick={() => void cancelRun()}
                      >
                        {busy ? 'Cancelling…' : 'Confirm cancellation'}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setCancelOpen(false);
                          setCancelReason('');
                          setCancelError('');
                        }}
                      >
                        Keep running
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="warning-button"
                    disabled={busy}
                    onClick={() => {
                      setCancelOpen(true);
                      setCancelError('');
                    }}
                  >
                    Cancel run
                  </button>
                ))}
              <h4>Transition history</h4>
              {instance.history.length ? (
                <ol>
                  {instance.history.map((item) => (
                    <li key={item.id}>
                      {item.actionKey === 'CANCEL' ? (
                        <>
                          Cancelled at {item.toStage.name} ·{' '}
                          {new Date(item.createdAt).toLocaleString()}
                          {item.reason ? ` · Reason: ${item.reason}` : ''}
                        </>
                      ) : (
                        <>
                          {item.fromStage?.name ?? 'Start'} →{' '}
                          {item.toStage.name} · {item.actionKey} ·{' '}
                          {new Date(item.createdAt).toLocaleString()}
                          {item.reason ? ` · ${item.reason}` : ''}
                        </>
                      )}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="empty-state">No transition history.</p>
              )}
            </>
          )}
        </section>
      </div>
    </section>
  );
}
