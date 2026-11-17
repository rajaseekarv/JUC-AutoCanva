import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import type {
  AuthenticatedUserResponse,
  BranchResponse,
  CreativeResponse,
  CreativeRevisionResponse,
  TemplateFieldResponse,
  TemplateResponse,
} from '@adflow/shared-types';
import type { AssetSource } from './assetFiles';
import { AssetReference } from './AssetImage';
import ReviewFeedback, { type FeedbackChangeRequest } from './ReviewFeedback';
import StatusBadge from './StatusBadge';
import {
  useOtherScreenChanges,
  type DataChange,
  type DataChangeSource,
} from './dataChanges';
import ApprovalSummary from './ApprovalSummary';
import FeedbackMessage from './FeedbackMessage';
import { returnFocusToConfirmTrigger } from './confirmFocus';
import type { CreativeFormState, ReportOpen } from './useRecordLinks';

const apiBase =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000/api/v1';
type Session = { accessToken: string; user: AuthenticatedUserResponse };
// The creative's latest workflow run, as GET /creatives/:id/workflow returns it.
type LatestRun = {
  id: string;
  status: string;
  workflowId: string;
  creativeRevisionId: string;
  currentStage?: { name: string } | null;
  workflow?: { name: string } | null;
};
// A failed API request, keeping the HTTP status for callers that need it.
class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
type AssetOption = {
  id: string;
  originalName: string;
  branchId: string | null;
};

// Template values compared as saved: empty values (null, undefined or '')
// count as absent, and key order does not matter.
function comparableValues(values: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(values)
      .filter(
        (key) =>
          values[key] !== null &&
          values[key] !== undefined &&
          values[key] !== '',
      )
      .sort()
      .map((key) => [key, values[key]]),
  );
}

export default function CreativeWorkspace({
  session,
  branch,
  templateRefreshKey = 0,
  dataChange,
  onDataChanged,
  onUnauthorized,
  openRequest = null,
  onOpenResult,
  onFormStateChange,
}: {
  session: Session;
  branch: BranchResponse | null;
  templateRefreshKey?: number;
  dataChange?: DataChange;
  onDataChanged?: (source: DataChangeSource) => void;
  onUnauthorized: () => void;
  // A request (from a notification) to select one creative of a branch.
  openRequest?: { key: number; branchId: string; creativeId: string } | null;
  onOpenResult?: ReportOpen;
  // Told which creative the form holds and whether it has unsaved edits.
  onFormStateChange?: (state: CreativeFormState) => void;
}) {
  const canRead = session.user.permissions.includes('creatives:read');
  const canCreate = session.user.permissions.includes('creatives:create');
  const canUpdate = session.user.permissions.includes('creatives:update');
  const canReadAssets = session.user.permissions.includes('assets:read');
  const canReadWorkflows = session.user.permissions.includes('workflows:read');
  const canStartWorkflow = session.user.permissions.includes('workflows:start');
  const canReadFeedback = [
    'comments:read',
    'approvals:read',
    'change_requests:read',
  ].some((permission) => session.user.permissions.includes(permission));
  const assetSource: AssetSource = {
    apiBase,
    accessToken: session.accessToken,
    onUnauthorized,
  };
  const [creatives, setCreatives] = useState<CreativeResponse[]>([]);
  const [templates, setTemplates] = useState<TemplateResponse[]>([]);
  const [templateDetail, setTemplateDetail] = useState<TemplateResponse | null>(
    null,
  );
  const [selectedId, setSelectedId] = useState('');
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [templateVersionId, setTemplateVersionId] = useState('');
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [history, setHistory] = useState<CreativeRevisionResponse[]>([]);
  const [inspectedRevision, setInspectedRevision] =
    useState<CreativeRevisionResponse | null>(null);
  const [assets, setAssets] = useState<AssetOption[]>([]);
  // Bumped after a save or resubmission so revision history, workflow state
  // and review feedback for the selected creative reload.
  const [reviewKey, setReviewKey] = useState(0);
  const [latestRun, setLatestRun] = useState<LatestRun | null>(null);
  // True while the selected creative's workflow state is being fetched.
  const [runLoading, setRunLoading] = useState(false);
  // The creative the loaded run belongs to, so a refresh of the same
  // creative keeps showing its run instead of flickering.
  const runCreativeId = useRef('');
  const lockNoticeId = useId();
  const fieldHelpId = useId();
  // Set while a save or resubmission is in flight, so a second click before
  // the busy state renders sends nothing.
  const actionInFlight = useRef(false);
  // What the form values were last loaded from (see the effect below).
  const appliedFormSource = useRef('');
  const [openRequests, setOpenRequests] = useState<FeedbackChangeRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const loadSequence = useRef(0);
  // The branch whose creatives the list holds once its latest load finished,
  // and whether that load succeeded; null while loading.
  const [loadedBranch, setLoadedBranch] = useState<{
    branchId: string;
    ok: boolean;
  } | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const selected =
    creatives.find((creative) => creative.id === selectedId) ?? null;
  const selectedVersion = useMemo(
    () =>
      templateDetail?.versions?.find(
        (version) => version.id === templateVersionId,
      ) ?? null,
    [templateDetail, templateVersionId],
  );
  // Mirrors the server's required-value rule; the server still validates.
  const missingRequiredValue =
    selectedVersion?.fields.some((field) => {
      if (!field.required) return false;
      const value = values[field.key];
      return (
        value === null ||
        value === undefined ||
        (typeof value === 'string' && value.trim().length === 0)
      );
    }) ?? false;
  // The API refuses a new revision while a run is RUNNING (409). With
  // workflows:read the screen knows this in advance and locks saving; until
  // the run state is known it does not offer a save that may be refused.
  // Without workflows:read the API's 409 remains the protection.
  const editLocked = !!selected && latestRun?.status === 'RUNNING';
  const awaitingRunState = !!selected && canReadWorkflows && runLoading;
  // One-click resubmission is offered when changes were requested on the
  // current revision itself (a request on an older revision is already
  // answered and uses Resubmit for review), no run is active, and the user
  // may save a revision, start workflows and read the latest run (whose
  // workflow is resubmitted). Change requests reach this screen only with
  // change_requests:read.
  const currentRevisionNumber = selected?.currentRevision?.revisionNumber;
  const oneClickResubmit =
    !!selected &&
    canUpdate &&
    canStartWorkflow &&
    canReadWorkflows &&
    latestRun !== null &&
    latestRun.status !== 'RUNNING' &&
    currentRevisionNumber !== undefined &&
    openRequests.some(
      (request) => request.revisionNumber === currentRevisionNumber,
    );
  const canSubmit =
    !!selectedVersion?.immutableAt &&
    name.trim().length > 0 &&
    !missingRequiredValue &&
    !editLocked &&
    !awaitingRunState;

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(apiBase + path, {
      ...init,
      headers: {
        Authorization: 'Bearer ' + session.accessToken,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
    if (response.status === 401) {
      onUnauthorized();
      throw new Error('Your session expired. Please sign in again.');
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        message?: string;
      } | null;
      throw new RequestError(
        response.status === 403
          ? 'You do not have permission to complete this action.'
          : (payload?.message ?? 'Unable to complete the creative request.'),
        response.status,
      );
    }
    return response.json() as Promise<T>;
  }

  async function reload(): Promise<void> {
    // A slower response for a previous branch or session must not overwrite
    // the current branch's data; only the latest reload may apply results.
    const sequence = ++loadSequence.current;
    setLoadedBranch(null);
    if (!canRead || !branch) {
      setCreatives([]);
      setTemplates([]);
      setAssets([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [creativeList, templateList, assetList] = await Promise.all([
        request<CreativeResponse[]>(
          '/creatives?branchId=' + encodeURIComponent(branch.id),
        ),
        session.user.permissions.includes('templates:read')
          ? request<TemplateResponse[]>('/templates')
          : Promise.resolve([]),
        session.user.permissions.includes('assets:read')
          ? request<AssetOption[]>(
              '/assets?branchId=' + encodeURIComponent(branch.id),
            )
          : Promise.resolve([]),
      ]);
      if (sequence !== loadSequence.current) return;
      setCreatives(creativeList);
      setTemplates(
        templateList.filter(
          (template) =>
            template.status === 'ACTIVE' &&
            template.activeVersionNumber !== null,
        ),
      );
      setAssets(assetList);
      setError('');
      setLoadedBranch({ branchId: branch.id, ok: true });
    } catch (cause) {
      if (sequence !== loadSequence.current) return;
      setError(
        cause instanceof Error ? cause.message : 'Unable to load creatives.',
      );
      setLoadedBranch({ branchId: branch.id, ok: false });
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }

  // Another screen changed review data: refresh only the creatives list and
  // the open creative's review state. Templates, assets, the selection and
  // unsaved form values are kept.
  async function refreshFromOtherScreen(): Promise<void> {
    if (!canRead || !branch) return;
    const sequence = loadSequence.current;
    try {
      const list = await request<CreativeResponse[]>(
        '/creatives?branchId=' + encodeURIComponent(branch.id),
      );
      if (sequence !== loadSequence.current) return;
      setCreatives(list);
    } catch (cause) {
      if (sequence !== loadSequence.current) return;
      setError(
        cause instanceof Error ? cause.message : 'Unable to load creatives.',
      );
    }
    if (selectedId) setReviewKey((key) => key + 1);
  }
  useOtherScreenChanges(
    dataChange,
    'creatives',
    () => void refreshFromOtherScreen(),
  );

  useEffect(() => {
    // Everything tied to the previous branch or session is cleared before the
    // reload, so no stale creative, asset, or revision can be selected or
    // submitted while the new data loads.
    setSelectedId('');
    setName('');
    setValues({});
    setSummary('');
    setMessage('');
    setSelectedTemplateId('');
    setTemplateVersionId('');
    setCreatives([]);
    setAssets([]);
    setHistory([]);
    setInspectedRevision(null);
    void reload();
    // State reload follows identity/branch changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.accessToken, branch?.id, templateRefreshKey]);
  useEffect(() => {
    if (!selectedTemplateId) {
      setTemplateDetail(null);
      return;
    }
    let cancelled = false;
    void request<TemplateResponse>(
      '/templates/' + encodeURIComponent(selectedTemplateId),
    )
      .then((detail) => {
        if (!cancelled) setTemplateDetail(detail);
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Unable to load template fields.',
          );
      });
    return () => {
      cancelled = true;
    };
    // The request is scoped to the selected template and token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTemplateId, session.accessToken]);
  useEffect(() => {
    if (!templateDetail) {
      // Choosing a template again starts from its stored values or defaults.
      appliedFormSource.current = '';
      return;
    }
    const selectedCreative = creatives.find((item) => item.id === selectedId);
    const revision = selectedCreative?.currentRevision;
    // A list refresh (for example from another screen) returns new objects
    // for the same creative and revision; the form keeps its unsaved values
    // unless the creative, its current revision, or the template changed.
    const formSource = [templateDetail.id, selectedId, revision?.id ?? ''].join(
      ':',
    );
    if (formSource === appliedFormSource.current) return;
    appliedFormSource.current = formSource;
    const active = templateDetail.versions?.find(
      (version) => version.versionNumber === templateDetail.activeVersionNumber,
    );
    const revisionVersion = templateDetail.versions?.find(
      (version) => version.id === revision?.templateVersionId,
    );
    const nextVersionId = revisionVersion?.id ?? active?.id ?? '';
    setTemplateVersionId(nextVersionId);
    if (revisionVersion && revision) {
      setValues(revision.values);
      setName(selectedCreative?.name ?? '');
    } else
      setValues(
        Object.fromEntries(
          ((revisionVersion ?? active)?.fields ?? [])
            .filter(
              (field) =>
                field.defaultValue !== null && field.defaultValue !== undefined,
            )
            .map((field) => [field.key, field.defaultValue]),
        ),
      );
  }, [templateDetail, selectedId, creatives]);
  useEffect(() => {
    if (!selected) {
      setHistory([]);
      setInspectedRevision(null);
      return;
    }
    void request<CreativeRevisionResponse[]>(
      '/creatives/' + encodeURIComponent(selected.id) + '/revisions',
    )
      .then(setHistory)
      .catch((cause: unknown) =>
        setError(
          cause instanceof Error
            ? cause.message
            : 'Unable to load revision history.',
        ),
      );
    // History reloads when the selected ID, access token, or review key changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, session.accessToken, reviewKey]);
  useEffect(() => {
    if (runCreativeId.current !== selectedId) {
      runCreativeId.current = selectedId;
      setLatestRun(null);
    }
    if (!selected || !canReadWorkflows) {
      setRunLoading(false);
      return;
    }
    let cancelled = false;
    setRunLoading(true);
    void request<LatestRun | null>(
      '/creatives/' + encodeURIComponent(selected.id) + '/workflow',
    )
      .then((run) => {
        if (!cancelled) setLatestRun(run);
      })
      .catch(() => {
        // Without the workflow state, resubmission is not offered and saving
        // falls back to the API's own check.
        if (!cancelled) setLatestRun(null);
      })
      .finally(() => {
        if (!cancelled) setRunLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Workflow state follows the selected creative, session and review key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, session.accessToken, reviewKey]);
  useEffect(() => {
    setOpenRequests([]);
  }, [selectedId, session.accessToken]);

  function chooseCreative(id: string): void {
    const creative = creatives.find((item) => item.id === id);
    setPendingOpen(null);
    setSelectedId(id);
    setInspectedRevision(null);
    setSummary('');
    if (!creative) {
      setName('');
      setValues({});
      setSelectedTemplateId('');
      setTemplateVersionId('');
      return;
    }
    setName(creative.name);
    const templateId =
      creative.currentRevision?.templateVersion.templateId ?? '';
    setSelectedTemplateId(templateId);
    setValues(creative.currentRevision?.values ?? {});
    setTemplateVersionId(creative.currentRevision?.templateVersionId ?? '');
  }

  // Whether the form holds edits that are not saved: for an open creative,
  // anything that differs from its current revision; for a new one, any
  // input at all. A form the user cannot edit is never dirty.
  const formDirty = (() => {
    if (!canRead) return false;
    if (summary.trim()) return true;
    if (!selected) return canCreate && (!!name.trim() || !!selectedTemplateId);
    if (!canUpdate) return false;
    const revision = selected.currentRevision;
    if (name !== selected.name) return true;
    if (!revision) return Object.keys(values).length > 0;
    if (templateVersionId && templateVersionId !== revision.templateVersionId)
      return true;
    return comparableValues(values) !== comparableValues(revision.values);
  })();
  const formStateChange = useRef(onFormStateChange);
  formStateChange.current = onFormStateChange;
  useEffect(() => {
    formStateChange.current?.({ creativeId: selectedId, dirty: formDirty });
  }, [selectedId, formDirty]);

  // The creative ('' for a new one) chosen with Open or New creative while
  // the form had unsaved changes: it opens only once the user confirms
  // discarding them. Null when nothing is waiting.
  const [pendingOpen, setPendingOpen] = useState<string | null>(null);
  // Nothing left to protect (saved, reverted, or reset): stop asking.
  useEffect(() => {
    if (!formDirty) setPendingOpen(null);
  }, [formDirty]);
  function requestCreative(id: string): void {
    if (!formDirty) {
      chooseCreative(id);
      return;
    }
    // The form already holds this creative (or the new one): keep editing.
    if (id === selectedId) {
      setPendingOpen(null);
      return;
    }
    setPendingOpen(id);
  }
  // Leaving the page (reload, tab close, another site) with unsaved changes
  // gets the browser's own confirmation.
  useEffect(() => {
    if (!formDirty) return;
    function onBeforeUnload(event: BeforeUnloadEvent): void {
      event.preventDefault();
      // Older browsers show the prompt only when returnValue is set.
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [formDirty]);

  // A notification asked to open a creative: once this branch's creatives
  // have loaded, select it (keeping the form when it is already open) and
  // report the outcome. Each request is answered once.
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
    if (selectedId !== openRequest.creativeId) {
      setMessage('');
      chooseCreative(openRequest.creativeId);
    }
    onOpenResult?.(openRequest.key, 'opened');
    // Runs when the request or the loaded data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest, branch?.id, loadedBranch, creatives]);

  // Whether the form may be written now. Defense in depth: the server
  // re-checks branch access, but the UI never writes to a creative from a
  // different branch than the one selected, and the disabled button is not
  // the only guard against a revision the API would refuse while locked.
  function canWriteForm(): boolean {
    if (!branch || !selectedVersion) return false;
    if (selected && selected.branchId !== branch.id) {
      setError('Select a creative from the current branch.');
      return false;
    }
    return !(selected && (editLocked || awaitingRunState));
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (actionInFlight.current || !canWriteForm()) return;
    actionInFlight.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const saved = await persistForm();
      if (saved)
        setMessage(
          selected
            ? 'A new immutable revision was saved.'
            : 'Creative created.',
        );
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  }

  // Saves the form as a new revision of the selected creative, or as a new
  // creative. Returns what the API saved, or null after showing why not.
  async function persistForm(): Promise<CreativeResponse | null> {
    if (!branch) return null;
    try {
      const saved = selected
        ? await request<CreativeResponse>(
            '/creatives/' + encodeURIComponent(selected.id),
            {
              method: 'PATCH',
              body: JSON.stringify({
                name,
                templateVersionId,
                values,
                summary: summary || null,
              }),
            },
          )
        : await request<CreativeResponse>('/creatives', {
            method: 'POST',
            body: JSON.stringify({
              name,
              branchId: branch.id,
              templateVersionId,
              values,
              summary: summary || null,
            }),
          });
      setCreatives((current) => [
        saved,
        ...current.filter((item) => item.id !== saved.id),
      ]);
      setSelectedId(saved.id);
      setSummary('');
      if (selected) setReviewKey((key) => key + 1);
      onDataChanged?.('creatives');
      return saved;
    } catch (cause) {
      if (selected && cause instanceof RequestError && cause.status === 409) {
        // For example a run started elsewhere, or the user cannot read
        // workflows: keep the API's reason and the unsaved edits.
        setError(
          cause.message +
            ' Your edits are still in the form; save them once the workflow finishes or is cancelled.',
        );
        // Reload the run so the lock explains which workflow holds it.
        if (canReadWorkflows) setReviewKey((key) => key + 1);
      } else
        setError(
          cause instanceof Error ? cause.message : 'Unable to save creative.',
        );
      return null;
    }
  }

  // Starts a new run of the latest run's workflow for one revision and says
  // where it landed. The API resolves the change requests on older
  // revisions in the same transaction, and leaves them open if the run
  // cannot be created; failures are thrown to the caller.
  async function startRun(
    creativeId: string,
    workflowId: string,
    revisionId: string,
    revisionLabel: string,
    savedFirst = false,
  ): Promise<string> {
    const run = await request<{
      currentStage?: { name: string; requiresReview?: boolean } | null;
    } | null>('/creatives/' + encodeURIComponent(creativeId) + '/workflows', {
      method: 'POST',
      body: JSON.stringify({ workflowId, creativeRevisionId: revisionId }),
    });
    const done = savedFirst ? ' was saved and resubmitted' : ' was resubmitted';
    // The run starts at the workflow's entry stage. Only a review stage
    // reaches a reviewer; otherwise say where the run is waiting.
    const stage = run?.currentStage;
    return !stage || stage.requiresReview
      ? revisionLabel + done + ' for review.'
      : revisionLabel +
          done +
          '. Its workflow is at the ' +
          stage.name +
          ' stage; move it on from Workflows to send it to a reviewer.';
  }

  // After a successful start the creative's status and requests changed.
  function afterStart(): void {
    setReviewKey((key) => key + 1);
    void reload();
    onDataChanged?.('creatives');
  }

  // Resubmits the already saved current revision.
  async function resubmit(): Promise<void> {
    if (!selected?.currentRevisionId || !latestRun) return;
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      setMessage(
        await startRun(
          selected.id,
          latestRun.workflowId,
          selected.currentRevisionId,
          'Revision ' + (selected.currentRevision?.revisionNumber ?? ''),
        ),
      );
      afterStart();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Unable to resubmit for review.',
      );
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  }

  // One click after changes were requested on the current revision: save
  // the form as a new revision, then start the latest run's workflow for
  // exactly that revision. Two existing API calls, not one transaction: if
  // the save fails nothing is started; if the start fails the saved
  // revision is kept and the Resubmit for review action retries.
  async function saveAndResubmit(): Promise<void> {
    if (!oneClickResubmit || !latestRun || actionInFlight.current) return;
    if (!canWriteForm()) return;
    const workflowId = latestRun.workflowId;
    actionInFlight.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const saved = await persistForm();
      if (!saved) return;
      const label = 'Revision ' + (saved.currentRevision?.revisionNumber ?? '');
      if (!saved.currentRevisionId) {
        setError(label + ' was saved, but it could not be resubmitted.');
        return;
      }
      try {
        setMessage(
          await startRun(
            saved.id,
            workflowId,
            saved.currentRevisionId,
            label,
            true,
          ),
        );
        afterStart();
      } catch (cause) {
        setError(
          label +
            ' was saved, but it could not be resubmitted: ' +
            (cause instanceof Error ? cause.message : 'unknown error') +
            ' Use Resubmit for review to try again.',
        );
      }
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  }

  function updateValue(field: TemplateFieldResponse, value: unknown): void {
    setValues((current) => ({ ...current, [field.key]: value }));
  }
  // "(required)" or "(optional)" after every editable field's label; the
  // input keeps the plain label as its accessible name.
  function fieldLabel(field: TemplateFieldResponse) {
    return (
      <span>
        {field.label}
        <span className="field-hint">
          {field.required ? ' (required)' : ' (optional)'}
        </span>
      </span>
    );
  }
  function helpTextId(field: TemplateFieldResponse): string | undefined {
    return field.helpText ? fieldHelpId + '-' + field.id : undefined;
  }
  function helpText(field: TemplateFieldResponse) {
    return field.helpText ? (
      <small id={helpTextId(field)}>{field.helpText}</small>
    ) : null;
  }
  function renderField(
    field: TemplateFieldResponse,
    source: Record<string, unknown>,
    readonly = false,
  ) {
    const value = source[field.key];
    if (field.type === 'IMAGE' || field.type === 'LOGO')
      return (
        <label key={field.id}>
          {readonly ? field.label : fieldLabel(field)}
          {readonly ? (
            <AssetReference
              assetId={value}
              label={field.label}
              source={assetSource}
              canReadAssets={canReadAssets}
            />
          ) : (
            <select
              aria-label={field.label}
              aria-describedby={helpTextId(field)}
              required={field.required}
              value={typeof value === 'string' ? value : ''}
              onChange={(event) =>
                updateValue(field, event.target.value || null)
              }
            >
              <option value="">Select image</option>
              {assets
                .filter(
                  (asset) =>
                    asset.branchId === null || asset.branchId === branch?.id,
                )
                .map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.originalName}
                  </option>
                ))}
            </select>
          )}
          {!readonly && helpText(field)}
          {!readonly && typeof value === 'string' && value && (
            <AssetReference
              assetId={value}
              label={field.label + ' preview'}
              source={assetSource}
              canReadAssets={canReadAssets}
            />
          )}
        </label>
      );
    if (readonly)
      return (
        <label key={field.id}>
          {field.label}
          <p>{value === undefined || value === null ? '—' : String(value)}</p>
        </label>
      );
    if (field.type === 'BOOLEAN')
      return (
        <label className="checkbox-label" key={field.id}>
          {fieldLabel(field)}
          <input
            aria-label={field.label}
            aria-describedby={helpTextId(field)}
            type="checkbox"
            checked={value === true}
            onChange={(event) => updateValue(field, event.target.checked)}
          />
          {helpText(field)}
        </label>
      );
    if (field.type === 'MULTILINE_TEXT')
      return (
        <label key={field.id}>
          {fieldLabel(field)}
          <textarea
            aria-label={field.label}
            aria-describedby={helpTextId(field)}
            required={field.required}
            maxLength={10000}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => updateValue(field, event.target.value)}
          />
          {helpText(field)}
        </label>
      );
    const inputType =
      field.type === 'NUMBER'
        ? 'number'
        : field.type === 'URL'
          ? 'url'
          : field.type === 'DATE'
            ? 'date'
            : field.type === 'COLOR'
              ? 'color'
              : 'text';
    return (
      <label key={field.id}>
        {fieldLabel(field)}
        <input
          aria-label={field.label}
          aria-describedby={helpTextId(field)}
          type={inputType}
          required={field.required}
          maxLength={field.type === 'NUMBER' ? undefined : 10000}
          value={value === null || value === undefined ? '' : String(value)}
          onChange={(event) =>
            updateValue(
              field,
              field.type === 'NUMBER'
                ? event.target.value
                  ? Number(event.target.value)
                  : null
                : event.target.value || null,
            )
          }
        />
        {helpText(field)}
      </label>
    );
  }

  if (!canRead) return null;
  const formShown = (selected && canUpdate) || (!selected && canCreate);
  const changeRequestBanner =
    selected && openRequests.length > 0 ? (
      <ChangeRequestBanner
        requests={openRequests}
        currentRevisionNumber={selected.currentRevision?.revisionNumber ?? 0}
        runActive={latestRun?.status === 'RUNNING'}
        canResubmit={
          canStartWorkflow &&
          canReadWorkflows &&
          latestRun !== null &&
          latestRun.status !== 'RUNNING'
        }
        oneClick={oneClickResubmit}
        busy={busy}
        onResubmit={() => void resubmit()}
      />
    ) : null;
  return (
    <section
      className="admin-panel creative-workspace"
      id="creatives"
      aria-labelledby="creative-workspace-title"
    >
      <div className="admin-heading">
        <div>
          <p className="eyebrow">YOUR CREATIVES</p>
          <h2 id="creative-workspace-title">
            Creatives{branch ? ' · ' + branch.name : ''}
          </h2>
          <p className="service-copy">
            Create and edit this branch&apos;s creatives. Every save keeps the
            earlier version as a revision you can look back at.
          </p>
        </div>
        <button
          className="secondary-button"
          onClick={() => void reload()}
          disabled={loading}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      <FeedbackMessage tone="error" message={error} />
      <FeedbackMessage tone="success" message={message} />
      {!branch ? (
        <p className="admin-card">
          Select an authorized branch to manage its creatives.
        </p>
      ) : (
        <div className="creative-layout">
          <section className="admin-card">
            <h3>Branch creatives</h3>
            {loading ? (
              <p className="empty-state" role="status">
                Loading branch creatives…
              </p>
            ) : creatives.length ? (
              <ul className="admin-list">
                {creatives.map((creative) => (
                  <li
                    key={creative.id}
                    className={
                      pendingOpen === creative.id ? 'has-confirm' : undefined
                    }
                  >
                    <div>
                      <strong>{creative.name}</strong>
                      <span>
                        <StatusBadge status={creative.status} /> Revision{' '}
                        {creative.currentRevision?.revisionNumber ?? 0}
                      </span>
                      <ApprovalSummary creative={creative} />
                    </div>
                    <button
                      className="secondary-button"
                      aria-expanded={
                        pendingOpen === creative.id ? true : undefined
                      }
                      onClick={() => requestCreative(creative.id)}
                    >
                      Open
                    </button>
                    {pendingOpen === creative.id && (
                      <DiscardEditsPanel
                        message={
                          'You have unsaved changes to ' +
                          (selected ? selected.name : 'the new creative') +
                          '. Opening ' +
                          creative.name +
                          ' discards them.'
                        }
                        onDiscard={() => chooseCreative(creative.id)}
                        onKeep={() => setPendingOpen(null)}
                      />
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty-state">
                No creatives for this branch yet. Start one from an active
                template.
              </p>
            )}
            {canCreate && (
              <div className="new-creative-action">
                <button
                  aria-expanded={pendingOpen === '' ? true : undefined}
                  onClick={() => requestCreative('')}
                >
                  New creative
                </button>
                {pendingOpen === '' && (
                  <DiscardEditsPanel
                    message={
                      'You have unsaved changes to ' +
                      (selected ? selected.name : 'the new creative') +
                      '. Starting a new creative discards them.'
                    }
                    onDiscard={() => chooseCreative('')}
                    onKeep={() => setPendingOpen(null)}
                  />
                )}
              </div>
            )}
          </section>
          {formShown && (
            <form
              className="admin-card admin-form"
              onSubmit={(event) => void save(event)}
            >
              <h3>{selected ? 'Edit ' + selected.name : 'Create creative'}</h3>
              {selected && (
                <p className="creative-review-state">
                  <StatusBadge status={selected.status} /> Current revision{' '}
                  {selected.currentRevision?.revisionNumber ?? 0}{' '}
                  <ApprovalSummary creative={selected} />
                </p>
              )}
              {changeRequestBanner}
              <label>
                <span>
                  Name
                  <span className="field-hint"> (required)</span>
                </span>
                <input
                  required
                  maxLength={120}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                <span>
                  Template
                  <span className="field-hint"> (required)</span>
                </span>
                <select
                  aria-label="Template"
                  required
                  value={selectedTemplateId}
                  disabled={loading || (!templates.length && !templateDetail)}
                  onChange={(event) => {
                    setSelectedTemplateId(event.target.value);
                    setTemplateVersionId('');
                    setValues({});
                  }}
                >
                  <option value="">
                    {loading
                      ? 'Loading templates…'
                      : templates.length
                        ? 'Choose template'
                        : 'No active templates'}
                  </option>
                  {templateDetail &&
                    !templates.some(
                      (item) => item.id === templateDetail.id,
                    ) && (
                      <option value={templateDetail.id}>
                        {templateDetail.name} (no longer active)
                      </option>
                    )}
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
              </label>
              {!loading && !error && !templates.length && !templateDetail && (
                <p className="empty-state template-empty-state" role="status">
                  No active templates are available. Create a draft, add a
                  field, and activate it in{' '}
                  {session.user.permissions.includes('templates:read') ? (
                    <a href="#templates">Templates</a>
                  ) : (
                    'the Templates module (template read access is required)'
                  )}{' '}
                  before creating a creative.
                </p>
              )}
              {templateDetail?.versions && (
                <label>
                  <span>
                    Template version
                    <span className="field-hint"> (required)</span>
                  </span>
                  <select
                    aria-label="Template version"
                    required
                    value={templateVersionId}
                    onChange={(event) => {
                      setTemplateVersionId(event.target.value);
                      const version = templateDetail.versions?.find(
                        (item) => item.id === event.target.value,
                      );
                      setValues(
                        Object.fromEntries(
                          (version?.fields ?? [])
                            .filter(
                              (field) =>
                                field.defaultValue !== null &&
                                field.defaultValue !== undefined,
                            )
                            .map((field) => [field.key, field.defaultValue]),
                        ),
                      );
                    }}
                  >
                    <option value="">Choose version</option>
                    {templateDetail.versions
                      .filter(
                        (version) =>
                          version.immutableAt &&
                          (version.id ===
                            selected?.currentRevision?.templateVersionId ||
                            (templateDetail.status === 'ACTIVE' &&
                              version.versionNumber ===
                                templateDetail.activeVersionNumber)),
                      )
                      .map((version) => (
                        <option key={version.id} value={version.id}>
                          Version {version.versionNumber}
                          {version.id ===
                            selected?.currentRevision?.templateVersionId &&
                          templateDetail.status === 'ARCHIVED'
                            ? ' (no longer active)'
                            : ''}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              {selectedVersion?.fields.map((field) =>
                renderField(field, values),
              )}
              <label>
                <span>
                  What changed?
                  <span className="field-hint"> (optional)</span>
                </span>
                <textarea
                  maxLength={1000}
                  value={summary}
                  onChange={(event) => setSummary(event.target.value)}
                />
              </label>
              {selected && editLocked && latestRun && (
                <EditLockNotice
                  id={lockNoticeId}
                  run={latestRun}
                  revisionNumber={
                    history.find(
                      (item) => item.id === latestRun.creativeRevisionId,
                    )?.revisionNumber ??
                    (selected.currentRevisionId === latestRun.creativeRevisionId
                      ? selected.currentRevision?.revisionNumber
                      : undefined)
                  }
                />
              )}
              {selected && !editLocked && awaitingRunState && (
                <p id={lockNoticeId} className="empty-state" aria-live="polite">
                  Checking whether a workflow is running before saving…
                </p>
              )}
              <button
                type="submit"
                disabled={busy || !canSubmit}
                aria-describedby={
                  selected && (editLocked || awaitingRunState)
                    ? lockNoticeId
                    : undefined
                }
              >
                {busy
                  ? 'Saving…'
                  : selected
                    ? 'Save new revision'
                    : 'Create creative'}
              </button>
              {oneClickResubmit && (
                <button
                  type="button"
                  disabled={busy || !canSubmit}
                  aria-describedby={
                    editLocked || awaitingRunState ? lockNoticeId : undefined
                  }
                  onClick={() => void saveAndResubmit()}
                >
                  Save and resubmit for review
                </button>
              )}
            </form>
          )}
          {selected && (
            <section className="admin-card">
              <h3>Revision history</h3>
              {history.length ? (
                <ul className="admin-list">
                  {history.map((revision) => (
                    <li key={revision.id}>
                      <div>
                        <strong>Revision {revision.revisionNumber}</strong>
                        <span>
                          {new Date(revision.createdAt).toLocaleString()} ·
                          Template version{' '}
                          {revision.templateVersion.versionNumber}
                        </span>
                      </div>
                      <button
                        className="secondary-button"
                        onClick={() => setInspectedRevision(revision)}
                      >
                        View
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="empty-state">No revisions found.</p>
              )}
              {inspectedRevision && (
                <div className="creative-inspection">
                  <h4>
                    Revision {inspectedRevision.revisionNumber} (view only)
                  </h4>
                  {inspectedRevision.summary && (
                    <p>{inspectedRevision.summary}</p>
                  )}
                  {inspectedRevision.templateVersion.fields.map((field) =>
                    renderField(field, inspectedRevision.values, true),
                  )}
                </div>
              )}
            </section>
          )}
          {!formShown && changeRequestBanner}
          {selected && canReadFeedback && (
            <section className="admin-card">
              <ReviewFeedback
                session={session}
                creativeId={selected.id}
                latestRevisionNumber={
                  selected.currentRevision?.revisionNumber ?? 1
                }
                onUnauthorized={onUnauthorized}
                refreshKey={reviewKey}
                onChangeRequests={(requests) =>
                  setOpenRequests(
                    requests.filter(
                      (request) =>
                        request.status === 'OPEN' ||
                        request.status === 'IN_PROGRESS',
                    ),
                  )
                }
              />
            </section>
          )}
        </div>
      )}
    </section>
  );
}

// Why a new revision cannot be saved while the creative's run is RUNNING,
// and where to follow the run.
function EditLockNotice({
  id,
  run,
  revisionNumber,
}: {
  id: string;
  run: LatestRun;
  revisionNumber: number | undefined;
}) {
  const stage = run.currentStage?.name;
  const workflow = run.workflow?.name;
  return (
    <section
      id={id}
      className="change-request-banner edit-lock-notice"
      aria-label="Editing locked"
    >
      <p>
        {revisionNumber !== undefined
          ? 'Revision ' + revisionNumber
          : 'This creative'}{' '}
        is currently under review
        {stage ? ' at stage ' + stage : ''}
        {workflow ? ' in ' + workflow : ''}. Editing is locked until the
        workflow finishes or is cancelled.
      </p>
      <p>
        <a href="#workflows">Open Workflows</a> to follow or move the run.
      </p>
    </section>
  );
}

// Open change requests for the selected creative and what to do next. The
// resubmit action is offered only once a newer revision than every request's
// revision is saved, no run is active, and the user may start workflows.
function ChangeRequestBanner({
  requests,
  currentRevisionNumber,
  runActive,
  canResubmit,
  oneClick,
  busy,
  onResubmit,
}: {
  requests: FeedbackChangeRequest[];
  currentRevisionNumber: number;
  runActive: boolean;
  canResubmit: boolean;
  // Save and resubmit for review is offered in the form.
  oneClick: boolean;
  busy: boolean;
  onResubmit: () => void;
}) {
  const answered = requests.every(
    (request) => request.revisionNumber < currentRevisionNumber,
  );
  return (
    <section
      className="change-request-banner"
      aria-label="Open change requests"
    >
      <h3>Changes requested</h3>
      <ul>
        {requests.map((request) => (
          <li key={request.id}>
            Revision {request.revisionNumber}: {request.requestedChanges}
            {request.explanation ? ' (' + request.explanation + ')' : ''}
          </li>
        ))}
      </ul>
      {!answered ? (
        <p>
          Save a new revision with the requested changes, then resubmit it for
          review.
          {oneClick &&
            ' Save and resubmit for review, at the end of this form, does both in one step.'}
        </p>
      ) : runActive ? (
        <p>A review is already running for this creative.</p>
      ) : canResubmit ? (
        <div className="inline-actions">
          <p>
            Revision {currentRevisionNumber} is saved. Resubmit it to send it
            for review and resolve these requests.
          </p>
          <button type="button" disabled={busy} onClick={onResubmit}>
            Resubmit for review
          </button>
        </div>
      ) : (
        <p>
          Revision {currentRevisionNumber} is saved. Someone who can start
          workflows needs to resubmit it for review.
        </p>
      )}
    </section>
  );
}

// Asks before an action in the creatives list replaces unsaved form edits.
// Keep returns focus to the button that asked (see confirmFocus).
function DiscardEditsPanel({
  message,
  onDiscard,
  onKeep,
}: {
  message: string;
  onDiscard: () => void;
  onKeep: () => void;
}) {
  return (
    <div
      className="confirm-panel"
      role="group"
      aria-label="Unsaved changes in Creatives"
    >
      <p role="alert">{message}</p>
      <div className="template-actions">
        <button type="button" className="danger-button" onClick={onDiscard}>
          Discard changes and continue
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={(event) => {
            returnFocusToConfirmTrigger(event.currentTarget);
            onKeep();
          }}
        >
          Keep my changes
        </button>
      </div>
    </div>
  );
}
