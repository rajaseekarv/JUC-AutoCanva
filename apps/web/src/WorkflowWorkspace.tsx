import { useEffect, useState } from 'react';
import type {
  AuthenticatedUserResponse,
  BranchResponse,
} from '@adflow/shared-types';
import StatusBadge from './StatusBadge';
import { statusLabel } from './statusDisplay';

const apiBase =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000/api/v1';
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
type Creative = {
  id: string;
  name: string;
  status: string;
  currentRevisionId: string | null;
};
type Instance = {
  id: string;
  status: string;
  currentStage: Stage;
  creativeRevisionId: string;
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
  onUnauthorized,
}: {
  session: Session;
  branch: BranchResponse | null;
  onUnauthorized: () => void;
}) {
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
    return response.json() as Promise<T>;
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
  }, [creativeId, session.accessToken]);

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
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Unable to start workflow.',
      );
    } finally {
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
                    {item.name} · {statusLabel(item.status)}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p>Select a branch to view its creatives.</p>
          )}
          {creativeId && !instance && canStart && (
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
              <button
                disabled={busy || !selected || selected.status !== 'ENABLED'}
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
              <h4>Transition history</h4>
              {instance.history.length ? (
                <ol>
                  {instance.history.map((item) => (
                    <li key={item.id}>
                      {item.fromStage?.name ?? 'Start'} → {item.toStage.name} ·{' '}
                      {item.actionKey} ·{' '}
                      {new Date(item.createdAt).toLocaleString()}
                      {item.reason ? ` · ${item.reason}` : ''}
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
