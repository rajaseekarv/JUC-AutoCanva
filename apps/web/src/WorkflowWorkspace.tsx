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
import FeedbackMessage from './FeedbackMessage';
import type { ReportOpen } from './useRecordLinks';
import { returnFocusToConfirmTrigger } from './confirmFocus';
import WorkflowStructuredEditor, {
  type AssignableUser,
  type AssignableUsers,
} from './WorkflowStructuredEditor';
import { checkDefinition, parseDefinition } from './workflowModel';
import { useReportUnsaved } from './useReportUnsaved';

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

// Who a task waits for, in words. The permission code itself is kept in the
// administrator details below the run.
const taskAudience: Record<string, string> = {
  'approvals:decide': 'anyone who can approve creatives',
  'workflows:transition': 'anyone who can move workflows on',
  'workflows:manage': 'a workflow manager',
};
function waitingFor(permission: string | null): string {
  if (!permission) return '';
  return taskAudience[permission] ?? 'someone with the required permission';
}

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

// The saved current version of a workflow as the editor shows it, or null
// when that version is missing from the reply.
function savedDefinitionText(workflow: Workflow): string | null {
  const version = workflow.versions.find(
    (item) => item.versionNumber === workflow.currentVersionNumber,
  );
  if (!version) return null;
  return JSON.stringify(
    {
      name: workflow.name,
      description: workflow.description,
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
  );
}

const plural = (count: number, noun: string) =>
  count + ' ' + noun + (count === 1 ? '' : 's');
const asSentence = (text: string) =>
  /[.!?]$/.test(text.trim()) ? text.trim() : text.trim() + '.';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown) =>
  typeof value === 'string' && value.trim().length > 0;

// What the browser can check in the editor's text without saving it: that
// it is JSON with the parts every definition needs. The workflow rules
// themselves (one entry stage, reviewers, transitions between known stages,
// …) are the API's, and are checked when the definition is saved.
function checkDefinitionText(
  text: string,
):
  | { ok: true; stages: number; transitions: number }
  | { ok: false; problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return {
      ok: false,
      problem:
        "The definition isn't valid JSON (" +
        (cause instanceof Error ? cause.message : 'it could not be read') +
        ').',
    };
  }
  if (!isRecord(parsed))
    return { ok: false, problem: 'The definition must be a JSON object.' };
  if (!isText(parsed.name))
    return { ok: false, problem: '"name" must be a non-empty text value.' };
  const { stages, transitions } = parsed;
  if (!Array.isArray(stages))
    return { ok: false, problem: '"stages" must be a list.' };
  if (!Array.isArray(transitions))
    return { ok: false, problem: '"transitions" must be a list.' };
  const badStage = stages.findIndex(
    (stage) => !isRecord(stage) || !isText(stage.key) || !isText(stage.name),
  );
  if (badStage >= 0)
    return {
      ok: false,
      problem: `Stage ${badStage + 1} needs a "key" and a "name".`,
    };
  const badTransition = transitions.findIndex(
    (transition) =>
      !isRecord(transition) ||
      !['key', 'label', 'from', 'to'].every((part) => isText(transition[part])),
  );
  if (badTransition >= 0)
    return {
      ok: false,
      problem: `Transition ${badTransition + 1} needs a "key", "label", "from" and "to".`,
    };
  return { ok: true, stages: stages.length, transitions: transitions.length };
}

export default function WorkflowWorkspace({
  session,
  branch,
  dataChange,
  onDataChanged,
  onUnauthorized,
  openRequest = null,
  onOpenResult,
  onUnsavedChange,
}: {
  session: Session;
  branch: BranchResponse | null;
  dataChange?: DataChange;
  onDataChanged?: (source: DataChangeSource) => void;
  onUnauthorized: () => void;
  // A request (from a notification) to select one creative of a branch.
  openRequest?: { key: number; branchId: string; creativeId: string } | null;
  onOpenResult?: ReportOpen;
  // Told whether the definition editor holds unsaved edits.
  onUnsavedChange?: (dirty: boolean) => void;
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
  // The definition editor: its text, the saved text it started from (or the
  // starter definition), and the workflow that saved text belongs to. The
  // text differs from the baseline only through the user's own typing, so
  // only that counts as unsaved. `newerVersion` is set when the workflow was
  // saved again (elsewhere) while the editor held unsaved edits.
  const [editor, setEditor] = useState(() => {
    const starter = defaultDefinition();
    return {
      workflowId: '',
      baseline: starter,
      text: starter,
      newerVersion: null as number | null,
    };
  });
  const definitionText = editor.text;
  const editorDirty = editor.text !== editor.baseline;
  // Only managers can edit, so only their edits are unsaved work.
  useReportUnsaved(canManage && editorDirty, onUnsavedChange);
  // A workflow chosen while the editor held unsaved edits, waiting for the
  // user to discard them or keep editing; `origin` is the picker used.
  const [pendingWorkflow, setPendingWorkflow] = useState<{
    id: string;
    origin: 'definitions' | 'start';
  } | null>(null);
  const definitionPicker = useRef<HTMLSelectElement>(null);
  const startPicker = useRef<HTMLSelectElement>(null);
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
  // True only while a cancellation is being sent (not for other actions).
  const [cancelling, setCancelling] = useState(false);
  const cancelReasonId = useId();
  const cancelReasonRef = useRef<HTMLTextAreaElement>(null);
  // Opening the cancellation moves focus to its reason.
  useEffect(() => {
    if (cancelOpen) cancelReasonRef.current?.focus();
  }, [cancelOpen]);
  const startBlockedId = useId();
  const startHintId = useId();
  const transitionHintId = useId();
  const unsavedHintId = useId();
  const [confirmingDisable, setConfirmingDisable] = useState(false);
  // Saving a new version of an enabled workflow takes it offline; this is
  // the confirmation shown first.
  const [confirmingSave, setConfirmingSave] = useState(false);
  // People a stage can name as its reviewer (GET /workflows/assignable-users,
  // workflow managers only). A reply for an earlier session is ignored.
  const [assignableUsers, setAssignableUsers] = useState<AssignableUsers>({
    status: 'loading',
  });
  const [assignableKey, setAssignableKey] = useState(0);
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

  // Only the latest reload may apply its results, so a slower reply for a
  // previous branch cannot replace the current branch's creatives.
  const loadSequence = useRef(0);
  // The branch whose creatives the picker holds once its latest load
  // finished, and whether that load succeeded; null while loading.
  const [loadedBranch, setLoadedBranch] = useState<{
    branchId: string;
    ok: boolean;
  } | null>(null);

  async function reload(): Promise<void> {
    const sequence = ++loadSequence.current;
    const branchId = branch?.id ?? null;
    setLoadedBranch(null);
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
      if (sequence !== loadSequence.current) return;
      setWorkflows(definitions);
      setCreatives(branchCreatives);
      if (workflowId && !definitions.some((item) => item.id === workflowId))
        setWorkflowId('');
      setError('');
      if (branchId) setLoadedBranch({ branchId, ok: true });
    } catch (cause) {
      if (sequence !== loadSequence.current) return;
      setError(
        cause instanceof Error ? cause.message : 'Unable to load workflows.',
      );
      if (branchId) setLoadedBranch({ branchId, ok: false });
    }
  }

  useEffect(() => {
    // A creative belongs to one branch: a new branch (or session) starts with
    // none chosen, so the previous branch's creative and its run are never
    // shown under it. A notification link selects its creative once this
    // branch's creatives have loaded.
    setCreativeId('');
    void reload(); /* Reload is scoped to user and selected branch. */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.accessToken, branch?.id]);
  // The selected workflow's saved definition goes into the editor when that
  // workflow is opened, and again after a reload only while the editor has
  // no unsaved edits. Validate, Refresh and list reloads never replace what
  // the user typed; a newer saved version is only reported.
  const savedText = selected ? savedDefinitionText(selected) : null;
  const selectedVersionNumber = selected?.currentVersionNumber ?? null;
  useEffect(() => {
    if (!selected || savedText === null) return;
    setEditor((current) => {
      if (
        current.workflowId !== selected.id ||
        current.text === current.baseline
      )
        return {
          workflowId: selected.id,
          baseline: savedText,
          text: savedText,
          newerVersion: null,
        };
      if (current.baseline === savedText) return current;
      return {
        ...current,
        baseline: savedText,
        newerVersion: selectedVersionNumber,
      };
    });
    // `selected` is a new object after every reload; the saved text decides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, savedText, selectedVersionNumber]);

  // Choosing a workflow (in either picker) opens its saved definition in the
  // editor; with unsaved edits for another definition the user is asked
  // first. Choosing none keeps the editor as it is.
  function chooseWorkflow(id: string, origin: 'definitions' | 'start'): void {
    setConfirmingDisable(false);
    setConfirmingSave(false);
    if (id && editorDirty && id !== editor.workflowId) {
      setPendingWorkflow({ id, origin });
      return;
    }
    setPendingWorkflow(null);
    setWorkflowId(id);
  }
  function discardEdits(): void {
    setEditor((current) => ({
      ...current,
      text: current.baseline,
      newerVersion: null,
    }));
  }
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

  // The selected creative's latest run. It is only ever shown for the
  // creative it belongs to: choosing another creative clears it at once, a
  // reply for a creative no longer selected is ignored, and a failed load
  // clears it instead of leaving an outdated run (and its actions) on screen.
  // Reloading the same creative keeps its run visible until the reply.
  const [runState, setRunState] = useState<
    'idle' | 'loading' | 'loaded' | 'failed'
  >('idle');
  const runCreative = useRef('');
  // The creative selected now, for replies to actions started earlier.
  const selectedCreativeRef = useRef(creativeId);
  selectedCreativeRef.current = creativeId;
  useEffect(() => {
    if (!creativeId) {
      runCreative.current = '';
      setInstance(null);
      setRunState('idle');
      return;
    }
    if (runCreative.current !== creativeId) {
      runCreative.current = creativeId;
      setInstance(null);
    }
    setRunState('loading');
    let cancelled = false;
    void request<Instance | null>(
      `/creatives/${encodeURIComponent(creativeId)}/workflow`,
    )
      .then((run) => {
        if (cancelled) return;
        setInstance(run);
        setRunState('loaded');
      })
      .catch(() => {
        if (cancelled) return;
        setInstance(null);
        setRunState('failed');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creativeId, session.accessToken, instanceKey]);

  // A notification asked to open a creative: once this branch's creatives
  // have loaded, select it in the picker and report the outcome. Each
  // request is answered once.
  const answeredOpen = useRef(0);
  useEffect(() => {
    if (!openRequest || answeredOpen.current === openRequest.key) return;
    if (!branch || branch.id !== openRequest.branchId) return;
    if (!loadedBranch || loadedBranch.branchId !== branch.id) return;
    answeredOpen.current = openRequest.key;
    if (!loadedBranch.ok) {
      onOpenResult?.(openRequest.key, 'unavailable');
      return;
    }
    if (!creatives.some((item) => item.id === openRequest.creativeId)) {
      onOpenResult?.(openRequest.key, 'not-found');
      return;
    }
    if (creativeId !== openRequest.creativeId) {
      setMessage('');
      setCreativeId(openRequest.creativeId);
    }
    onOpenResult?.(openRequest.key, 'opened');
    // Runs when the request or the loaded data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest, branch?.id, loadedBranch, creatives]);

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

  // The reviewer picker's people, loaded once per session for managers.
  useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    setAssignableUsers({ status: 'loading' });
    void request<AssignableUser[] | null>('/workflows/assignable-users')
      .then((users) => {
        if (cancelled) return;
        setAssignableUsers(
          Array.isArray(users)
            ? { status: 'loaded', users }
            : { status: 'failed' },
        );
      })
      .catch(() => {
        if (!cancelled) setAssignableUsers({ status: 'failed' });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.accessToken, canManage, assignableKey]);

  // Saves exactly the text in the editor. Whatever happens, nothing typed is
  // lost: unreadable JSON is not sent, a refusal leaves the edits in place,
  // and edits typed while the save was in flight are kept.
  // `takesOffline`: the user confirmed saving an enabled workflow, which
  // the API then turns back into a draft.
  async function saveDefinition(takesOffline = false): Promise<void> {
    setError('');
    setMessage('');
    const submitted = definitionText;
    let definition: unknown;
    try {
      definition = JSON.parse(submitted);
    } catch {
      // Explains where the JSON breaks.
      const check = checkDefinitionText(submitted);
      setError(
        (check.ok ? "The definition isn't valid JSON." : check.problem) +
          ' Nothing was saved; your edits are still in the editor.',
      );
      return;
    }
    setBusy(true);
    try {
      const saved = await request<Workflow>(
        workflowId
          ? `/workflows/${encodeURIComponent(workflowId)}`
          : '/workflows',
        {
          method: workflowId ? 'PATCH' : 'POST',
          body: JSON.stringify(definition),
        },
      );
      const savedJson = savedDefinitionText(saved);
      if (savedJson !== null)
        setEditor((current) =>
          current.text === submitted
            ? {
                workflowId: saved.id,
                baseline: savedJson,
                text: savedJson,
                newerVersion: null,
              }
            : {
                ...current,
                workflowId: saved.id,
                baseline: savedJson,
                newerVersion: null,
              },
        );
      setWorkflows((current) => [
        saved,
        ...current.filter((item) => item.id !== saved.id),
      ]);
      setPendingWorkflow(null);
      setWorkflowId(saved.id);
      setMessage(
        'A new editable workflow version was saved.' +
          (takesOffline
            ? ` ${saved.name} is now a draft: enable it again so new reviews can start.`
            : ''),
      );
    } catch (cause) {
      setError(
        asSentence(
          cause instanceof Error
            ? cause.message
            : 'Unable to save the workflow definition',
        ) + ' Nothing was saved; your edits are still in the editor.',
      );
    } finally {
      setBusy(false);
    }
  }

  // Checks what the editor holds. Unsaved edits are checked here (the API
  // can only validate a saved version); when the editor matches the saved
  // version, the API validates that version with the full workflow rules.
  async function validateDefinition(): Promise<void> {
    setError('');
    setMessage('');
    if (!selected || editorDirty) {
      const check = checkDefinitionText(definitionText);
      if (!check.ok) {
        setError(check.problem + ' Your edits are kept.');
        return;
      }
      // The workflow rules, as the API applies them when saving.
      const parsed = parseDefinition(definitionText);
      const ruleProblems = parsed.ok ? checkDefinition(parsed.definition) : [];
      if (ruleProblems.length) {
        setError(
          `Your unsaved edits have ${plural(ruleProblems.length, 'problem')} the API would refuse: ` +
            ruleProblems
              .slice(0, 3)
              .map((problem) => problem.message)
              .join(' ') +
            (ruleProblems.length > 3 ? ' The form shows them all.' : '') +
            ' Your edits are kept.',
        );
        return;
      }
      setMessage(
        // Both the JSON and the workflow rules were checked here; only the
        // API knows whether permissions and reviewers exist.
        'Your unsaved edits are well-formed and follow the workflow rules: valid JSON with a name, ' +
          plural(check.stages, 'stage') +
          ' and ' +
          plural(check.transitions, 'transition') +
          ', one starting stage, finishing stages, reviewers and steps that fit together. The API checks them again when you save them as a new version, including that their permissions and reviewers exist' +
          (selected
            ? `; saved version ${selected.currentVersionNumber} has not changed.`
            : '.'),
      );
      return;
    }
    const checkedVersion = selected.currentVersionNumber;
    setBusy(true);
    try {
      const result = await request<{ valid: boolean; errors: string[] }>(
        `/workflows/${encodeURIComponent(selected.id)}/validate`,
        { method: 'POST' },
      );
      if (result.valid)
        setMessage(
          `Workflow definition is valid: saved version ${checkedVersion}, which the editor shows, was checked.`,
        );
      else
        setError(
          `Saved version ${checkedVersion} has problems: ` +
            result.errors.join(' '),
        );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Unable to validate workflow.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function mutateDefinition(action: 'enable' | 'disable'): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const updated = await request<Workflow>(
        `/workflows/${encodeURIComponent(selected.id)}/${action}`,
        { method: 'POST' },
      );
      setWorkflows((current) =>
        current.map((item) =>
          item.id === updated.id ? { ...item, ...updated } : item,
        ),
      );
      setMessage(`Workflow ${action}d.`);
      setConfirmingDisable(false);
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
    const forCreative = creativeId;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const started = await request<Instance>(
        `/creatives/${encodeURIComponent(creativeId)}/workflows`,
        { method: 'POST', body: JSON.stringify({ workflowId: selected.id }) },
      );
      // Another creative was chosen meanwhile: its own run loads instead.
      if (selectedCreativeRef.current === forCreative) {
        setInstance(started);
        setRunState('loaded');
        setMessage('Workflow started against the selected creative revision.');
      }
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
    const forCreative = creativeId;
    cancelInFlight.current = true;
    setCancelling(true);
    setBusy(true);
    setCancelError('');
    setError('');
    setMessage('');
    try {
      const cancelled = await request<Instance>(
        `/workflow-instances/${encodeURIComponent(instance.id)}/cancel`,
        { method: 'POST', body: JSON.stringify({ reason }) },
      );
      if (selectedCreativeRef.current === forCreative) {
        setInstance(cancelled);
        setRunState('loaded');
        setCancelOpen(false);
        setCancelReason('');
        setMessage(
          'Run cancelled. The creative can be revised and submitted again.',
        );
      }
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
      setCancelling(false);
      setBusy(false);
    }
  }

  async function transition(key: string): Promise<void> {
    if (!instance) return;
    const forCreative = creativeId;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const changed = await request<Instance>(
        `/workflow-instances/${encodeURIComponent(instance.id)}/transitions`,
        { method: 'POST', body: JSON.stringify({ transitionKey: key }) },
      );
      if (selectedCreativeRef.current === forCreative) {
        setInstance(changed);
        setRunState('loaded');
        setMessage('Workflow moved to ' + changed.currentStage.name + '.');
      }
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
  const openTasks =
    instance?.tasks.filter((task) => task.status === 'OPEN') ?? [];
  // The run records only its revision's ID; the creative list gives the
  // current revision's number, so an older revision is described in words.
  // A change is only claimed when the creative's current revision is known
  // and differs; missing data gets a neutral description.
  const runCurrentId = selectedCreative?.currentRevisionId;
  const runCurrentNumber = currentRevisionNumber;
  const runRevisionText = !instance
    ? ''
    : !runCurrentId
      ? "This run is for the revision it started with. The creative's current revision isn't available right now, so it can't be compared."
      : runCurrentId === instance.creativeRevisionId
        ? runCurrentNumber !== undefined
          ? 'This run is for revision ' +
            runCurrentNumber +
            ', the current revision.'
          : "This run is for the creative's current revision."
        : 'This run is for an earlier revision; the creative has been changed since it started.';
  // History entries record the transition key; show the transition's label
  // when the version still has it.
  function historyActionLabel(actionKey: string): string {
    if (actionKey === 'START') return 'Started';
    const transition = instance?.version.transitions.find(
      (item) => item.key === actionKey,
    );
    return transition?.label ?? statusLabel(actionKey);
  }
  const canOpenApprovals = session.user.permissions.includes('approvals:read');
  const enabledWorkflows = workflows.filter(
    (item) => item.status === 'ENABLED',
  );
  const needsWorkflowChoice = !selected || selected.status !== 'ENABLED';
  // The run's status in words: what it is waiting for, or how it ended and
  // when (from its history).
  const cancelRow = instance?.history.find(
    (item) => item.actionKey === 'CANCEL',
  );
  const lastStep = instance?.history[instance.history.length - 1];
  const when = (iso: string | undefined) =>
    iso ? ' on ' + new Date(iso).toLocaleString() : '';
  const runSummary = !instance
    ? ''
    : instance.status === 'RUNNING'
      ? instance.currentStage.requiresReview
        ? "Waiting for a reviewer's decision."
        : `In progress at the ${instance.currentStage.name} stage.`
      : instance.status === 'COMPLETED'
        ? `Finished at the ${instance.currentStage.name} stage${when(lastStep?.createdAt)}.`
        : instance.status === 'CANCELLED'
          ? `Cancelled at the ${instance.currentStage.name} stage${when(cancelRow?.createdAt ?? lastStep?.createdAt)}.`
          : `Status: ${statusLabel(instance.status)}.`;
  // Why the user cannot take a transition, in words (no permission codes).
  function transitionBlockReason(item: Transition): string {
    if (!instance) return '';
    const destination = instance.version.stages.find(
      (stage) => stage.id === item.destinationStageId,
    );
    const missing = [
      instance.currentStage.requiredPermission,
      item.requiredPermission,
      destination?.requiredPermission,
    ].find(
      (permission) =>
        permission && !session.user.permissions.includes(permission),
    );
    if (missing)
      return "You can't take this step: it is for " + waitingFor(missing) + '.';
    const stage = instance.currentStage;
    if (
      stage.assignedPermission &&
      !session.user.permissions.includes(stage.assignedPermission)
    )
      return (
        "You can't take this step: it is for " +
        waitingFor(stage.assignedPermission) +
        '.'
      );
    return "You can't take this step: it is assigned to someone else.";
  }
  // Asks before a chosen workflow replaces unsaved definition edits.
  const pendingName =
    workflows.find((item) => item.id === pendingWorkflow?.id)?.name ??
    'the chosen workflow';
  const pendingWorkflowPanel = pendingWorkflow && (
    <div
      className="confirm-panel"
      role="group"
      aria-label="Unsaved workflow definition"
    >
      <p role="alert">
        Your edits to the workflow definition are not saved. Opening{' '}
        {pendingName} replaces them with its saved definition.
      </p>
      <div className="template-actions">
        <button
          type="button"
          className="danger-button"
          onClick={() => {
            const id = pendingWorkflow.id;
            setPendingWorkflow(null);
            setWorkflowId(id);
          }}
        >
          Discard edits and switch
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            const picker =
              pendingWorkflow.origin === 'start'
                ? startPicker.current
                : definitionPicker.current;
            setPendingWorkflow(null);
            picker?.focus();
          }}
        >
          Keep editing
        </button>
      </div>
    </div>
  );
  return (
    <section
      className="admin-panel"
      id="workflows"
      aria-labelledby="workflow-title"
    >
      <div className="admin-heading">
        <div>
          <p className="eyebrow">REVIEW STEPS</p>
          <h2 id="workflow-title">Creative workflows</h2>
          <p className="service-copy">
            Send a creative through its review steps and follow where it is.
            Workflow managers also set up the steps here.
          </p>
        </div>
        <button className="secondary-button" onClick={() => void reload()}>
          Refresh
        </button>
      </div>
      <FeedbackMessage tone="error" message={error} />
      <FeedbackMessage tone="success" message={message} />
      <div className="creative-layout">
        {canRead && (
          <section className="admin-card">
            <h3>Organization definitions</h3>
            <label>
              Workflow
              <select
                aria-label="Workflow definition"
                ref={definitionPicker}
                value={workflowId}
                onChange={(event) =>
                  chooseWorkflow(event.target.value, 'definitions')
                }
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
            {pendingWorkflow?.origin === 'definitions' && pendingWorkflowPanel}
            {canManage && (
              <>
                <p className="field-hint workflow-version-note">
                  {selected
                    ? `Editing version ${selected.currentVersionNumber} (${statusLabel(selected.status)}). Saving creates version ${selected.currentVersionNumber + 1}` +
                      (selected.status === 'ENABLED'
                        ? ' and takes this workflow offline until it is enabled again.'
                        : '.') +
                      ' Earlier versions and running reviews are not changed.'
                    : 'A new workflow is saved as version 1, as a draft to enable.'}
                </p>
                <WorkflowStructuredEditor
                  // A fresh editor per workflow: confirmations, a pending
                  // "One person" choice or a half-typed stage name never
                  // carry over to another workflow.
                  key={workflowId || 'new-workflow'}
                  text={definitionText}
                  onChange={(text) =>
                    setEditor((current) => ({ ...current, text }))
                  }
                  users={assignableUsers}
                  onRetryUsers={() => setAssignableKey((key) => key + 1)}
                  busy={busy}
                />
                {/* The same definition as JSON: edits in either view are
                    the same unsaved edits. */}
                <details className="workflow-advanced">
                  <summary>Advanced (JSON)</summary>
                  <label>
                    Workflow definition (advanced, JSON format)
                    <textarea
                      aria-label="Workflow definition JSON"
                      aria-describedby={editorDirty ? unsavedHintId : undefined}
                      rows={18}
                      spellCheck={false}
                      value={definitionText}
                      onChange={(event) => {
                        const text = event.target.value;
                        setEditor((current) => ({ ...current, text }));
                      }}
                    />
                  </label>
                </details>
                {editorDirty && (
                  <div className="inline-actions" id={unsavedHintId}>
                    <p className="field-hint">
                      You have unsaved changes to this definition.
                      {editor.newerVersion !== null &&
                        ` The workflow was saved again (version ${editor.newerVersion}) since you started editing; your edits are kept, and saving them creates a newer version.`}
                    </p>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={discardEdits}
                    >
                      Discard changes
                    </button>
                  </div>
                )}
                <div className="button-row">
                  <button
                    disabled={busy}
                    aria-expanded={
                      selected?.status === 'ENABLED' && workflowId
                        ? confirmingSave
                        : undefined
                    }
                    onClick={() =>
                      // Saving an enabled workflow takes it offline: ask.
                      selected?.status === 'ENABLED' && workflowId
                        ? setConfirmingSave(true)
                        : void saveDefinition()
                    }
                  >
                    {workflowId ? 'Save new version' : 'Create workflow'}
                  </button>
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => void validateDefinition()}
                  >
                    Validate
                  </button>
                  {selected && (
                    <>
                      {selected.status === 'ENABLED' ? (
                        <button
                          className="secondary-button"
                          disabled={busy}
                          aria-expanded={confirmingDisable}
                          onClick={() => setConfirmingDisable(true)}
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
                {selected?.status === 'ENABLED' && confirmingSave && (
                  <div
                    className="confirm-panel"
                    role="group"
                    aria-label={'Confirm saving ' + selected.name}
                  >
                    <p>
                      Saving creates version {selected.currentVersionNumber + 1}{' '}
                      and takes {selected.name} offline: no new reviews can
                      start with it until you enable it again. Reviews already
                      running carry on with the version they started with.
                    </p>
                    <div className="template-actions">
                      <button
                        type="button"
                        className="warning-button"
                        disabled={busy}
                        onClick={() => {
                          setConfirmingSave(false);
                          void saveDefinition(true);
                        }}
                      >
                        Save and take offline
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy}
                        onClick={(event) => {
                          returnFocusToConfirmTrigger(event.currentTarget);
                          setConfirmingSave(false);
                        }}
                      >
                        Keep editing
                      </button>
                    </div>
                  </div>
                )}
                {selected?.status === 'ENABLED' && confirmingDisable && (
                  <div
                    className="confirm-panel"
                    role="group"
                    aria-label={'Confirm disabling ' + selected.name}
                  >
                    <p>
                      Disable {selected.name}? No new reviews can start with
                      this workflow until it is enabled again. Reviews that are
                      already running carry on.
                    </p>
                    <div className="template-actions">
                      <button
                        type="button"
                        className="danger-button"
                        disabled={busy}
                        onClick={() => void mutateDefinition('disable')}
                      >
                        Disable workflow
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy}
                        onClick={(event) => {
                          returnFocusToConfirmTrigger(event.currentTarget);
                          setConfirmingDisable(false);
                        }}
                      >
                        Keep enabled
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        )}
        <section className="admin-card">
          <h3>Branch creative state</h3>
          {!branch ? (
            <p>Select a branch to view its creatives.</p>
          ) : loadedBranch?.ok && !creatives.length ? (
            <p className="empty-state">
              No creatives in this branch yet.{' '}
              {session.user.permissions.includes('creatives:read') ? (
                <>
                  Create one in <a href="#creatives">Creatives</a>, then send it
                  for review here.
                </>
              ) : (
                'Once one is created it can be sent for review here.'
              )}
            </p>
          ) : (
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
          )}
          {/* The selected creative's run: loading, failed, none yet, or the
              run itself. Nothing from another creative's run is shown. */}
          {creativeId && runState === 'failed' && (
            <div className="run-load-error">
              <FeedbackMessage
                tone="error"
                message="We couldn't load this creative's workflow, so nothing about it is shown. Please try again."
              />
              <button
                type="button"
                className="secondary-button"
                onClick={() => setInstanceKey((key) => key + 1)}
              >
                Try again
              </button>
            </div>
          )}
          {creativeId && !instance && runState === 'loading' && (
            <p className="empty-state" role="status">
              Loading this creative&apos;s workflow…
            </p>
          )}
          {creativeId && !instance && runState === 'loaded' && (
            <p className="empty-state">
              No workflow has been started for this creative yet.
            </p>
          )}
          {/* Only one run may be active per creative; after a run completes
              (for example with changes requested) a new run can start
              against the creative's latest revision. Start is offered only
              once the creative's run is known. */}
          {creativeId &&
            (instance !== null || runState === 'loaded') &&
            instance?.status !== 'RUNNING' &&
            canStart &&
            (loadedBranch?.ok && !enabledWorkflows.length ? (
              <p className="empty-state">
                {canRead
                  ? 'No workflow is enabled yet. A workflow manager needs to enable one before this creative can be sent for review.'
                  : "You can't see the organization's workflows, so a workflow can't be started here. Ask a workflow manager for access."}
              </p>
            ) : (
              <>
                <label>
                  Enabled workflow
                  <select
                    aria-label="Workflow to start"
                    ref={startPicker}
                    value={workflowId}
                    onChange={(event) =>
                      chooseWorkflow(event.target.value, 'start')
                    }
                  >
                    <option value="">Choose workflow</option>
                    {enabledWorkflows.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                {pendingWorkflow?.origin === 'start' && pendingWorkflowPanel}
                {startBlockedByRequests && (
                  <p className="empty-state" id={startBlockedId}>
                    Revision {currentRevisionNumber} has unresolved change
                    requests. Save a new revision with the requested changes in
                    Creatives before resubmitting it for review.
                  </p>
                )}
                {needsWorkflowChoice && (
                  <p className="field-hint" id={startHintId}>
                    Choose an enabled workflow to start.
                  </p>
                )}
                <button
                  disabled={
                    busy || needsWorkflowChoice || startBlockedByRequests
                  }
                  aria-describedby={
                    [
                      startBlockedByRequests ? startBlockedId : '',
                      needsWorkflowChoice ? startHintId : '',
                    ]
                      .filter(Boolean)
                      .join(' ') || undefined
                  }
                  onClick={() => void startWorkflow()}
                >
                  Start workflow
                </button>
              </>
            ))}
          {instance && (
            <>
              <h4>
                {instance.currentStage.name} ·{' '}
                <StatusBadge status={instance.status} />
              </h4>
              <div className="run-summary">
                <p>
                  {runSummary}
                  {instance.status === 'RUNNING' &&
                    instance.currentStage.requiresReview &&
                    canOpenApprovals && (
                      <>
                        {' '}
                        Reviewers record it in{' '}
                        <a href="#approvals">Approvals</a>.
                      </>
                    )}
                </p>
                {instance.status === 'CANCELLED' && cancelRow?.reason && (
                  <p>Reason: {cancelRow.reason}</p>
                )}
              </div>
              <p>{runRevisionText}</p>
              {instance.status === 'RUNNING' && (
                <p>
                  Waiting for:{' '}
                  {openTasks
                    .map(
                      (task) =>
                        task.stage.name +
                        (task.requiredPermission
                          ? ' (' + waitingFor(task.requiredPermission) + ')'
                          : ''),
                    )
                    .join(', ') || 'nobody right now'}
                </p>
              )}
              {canTransition &&
                instance.status === 'RUNNING' &&
                !instance.currentStage.requiresReview &&
                outgoing.length > 0 && (
                  <div className="run-actions">
                    <div className="button-row">
                      {outgoing.map((item) => (
                        <button
                          key={item.id}
                          disabled={busy || !canTakeTransition(item)}
                          aria-describedby={
                            canTakeTransition(item)
                              ? undefined
                              : `${transitionHintId}-${item.id}`
                          }
                          onClick={() => void transition(item.key)}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                    {outgoing
                      .filter((item) => !canTakeTransition(item))
                      .map((item) => (
                        <p
                          key={item.id}
                          className="field-hint"
                          id={`${transitionHintId}-${item.id}`}
                        >
                          {item.label}: {transitionBlockReason(item)}
                        </p>
                      ))}
                  </div>
                )}
              {canCancel && (
                <div className="run-cancel">
                  <button
                    type="button"
                    className="warning-button"
                    disabled={busy}
                    aria-expanded={cancelOpen}
                    onClick={() => {
                      setCancelOpen(true);
                      setCancelError('');
                    }}
                  >
                    Cancel run
                  </button>
                  {cancelOpen && (
                    <div
                      className="confirm-panel"
                      role="group"
                      aria-label="Cancel run"
                    >
                      <p>
                        Cancelling ends this run at the{' '}
                        {instance.currentStage.name} stage. Its decisions,
                        change requests and history are kept, open tasks close,
                        and the creative can be revised again.
                      </p>
                      <label htmlFor={cancelReasonId}>
                        Reason for cancelling (required)
                      </label>
                      <textarea
                        id={cancelReasonId}
                        ref={cancelReasonRef}
                        value={cancelReason}
                        maxLength={CANCEL_REASON_MAX_LENGTH}
                        aria-invalid={cancelError ? true : undefined}
                        onChange={(event) => {
                          setCancelReason(event.target.value);
                          setCancelError('');
                        }}
                      />
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
                          {cancelling ? 'Cancelling…' : 'Confirm cancellation'}
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={busy}
                          onClick={(event) => {
                            returnFocusToConfirmTrigger(event.currentTarget);
                            setCancelOpen(false);
                            setCancelReason('');
                            setCancelError('');
                          }}
                        >
                          Keep running
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
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
                          {item.toStage.name} ·{' '}
                          {historyActionLabel(item.actionKey)} ·{' '}
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
              {canManage && (
                <details className="admin-details">
                  <summary>Technical details for administrators</summary>
                  <dl className="profile-list">
                    <dt>Revision ID</dt>
                    <dd>
                      <code>{instance.creativeRevisionId}</code>
                    </dd>
                    <dt>Run ID</dt>
                    <dd>
                      <code>{instance.id}</code>
                    </dd>
                    <dt>Open task permissions</dt>
                    <dd>
                      {openTasks
                        .map(
                          (task) =>
                            task.stage.name +
                            ': ' +
                            (task.requiredPermission ?? 'none'),
                        )
                        .join(', ') || 'none'}
                    </dd>
                    <dt>History action keys</dt>
                    <dd>
                      {instance.history
                        .map((item) => item.actionKey)
                        .join(', ') || 'none'}
                    </dd>
                  </dl>
                </details>
              )}
            </>
          )}
        </section>
      </div>
    </section>
  );
}
