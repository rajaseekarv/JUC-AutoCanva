import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type {
  AuthenticatedUserResponse,
  BranchResponse,
  TemplateResponse,
} from '@adflow/shared-types';
import CreativeWorkspace from './CreativeWorkspace';
import WorkflowWorkspace from './WorkflowWorkspace';
import ApprovalsWorkspace from './ApprovalsWorkspace';
import {
  noDataChange,
  useDataChanges,
  useOtherScreenChanges,
  type DataChange,
} from './dataChanges';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const user: AuthenticatedUserResponse = {
  id: 'user-1',
  organizationId: 'org-1',
  name: 'Operator',
  email: 'branch@example.local',
  permissions: [
    'creatives:read',
    'creatives:create',
    'creatives:update',
    'templates:read',
    'workflows:read',
    'workflows:start',
    'workflows:transition',
    'approvals:read',
    'approvals:decide',
    'change_requests:read',
  ],
  branches: [{ id: 'branch-1', name: 'North', code: 'NORTH' }],
};
const session = { accessToken: 'token', user };
const branch: BranchResponse = {
  id: 'branch-1',
  name: 'North',
  code: 'NORTH',
  status: 'ACTIVE',
};
const field = {
  id: 'field-1',
  key: 'headline',
  label: 'Headline',
  type: 'TEXT' as const,
  required: true,
  defaultValue: null,
  validationRules: null,
  helpText: null,
  displayOrder: 0,
  dataSource: null,
  sourceKey: null,
};
const templateVersion = {
  id: 'version-1',
  templateId: 'template-1',
  versionNumber: 1,
  name: 'Social post',
  description: null,
  category: null,
  formatName: 'Square',
  width: 1080,
  height: 1080,
  unit: 'PX' as const,
  immutableAt: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  fields: [field],
};
const template: TemplateResponse = {
  id: 'template-1',
  name: 'Social post',
  code: 'social',
  description: null,
  category: null,
  status: 'ACTIVE',
  formatName: 'Square',
  width: 1080,
  height: 1080,
  unit: 'PX',
  currentVersionNumber: 1,
  activeVersionNumber: 1,
  updatedAt: '2026-01-01T00:00:00Z',
};
const stage = (key: string, extra: object = {}) => ({
  id: 'stage-' + key,
  key,
  name: key[0]!.toUpperCase() + key.slice(1),
  displayOrder: key.length,
  isEntry: false,
  isTerminal: false,
  requiresReview: false,
  requiredPermission: null,
  assignedUserId: null,
  assignedPermission: null,
  ...extra,
});
const stages = {
  draft: stage('draft', { isEntry: true }),
  review: stage('review', {
    requiresReview: true,
    assignedPermission: 'approvals:decide',
  }),
  approved: stage('approved', { isTerminal: true }),
  changes: stage('changes', { isTerminal: true }),
};
const workflowVersion = {
  id: 'wf-version-1',
  versionNumber: 1,
  stages: Object.values(stages),
  transitions: [
    {
      id: 'transition-submit',
      key: 'submit',
      label: 'Submit for review',
      sourceStageId: 'stage-draft',
      destinationStageId: 'stage-review',
      requiredPermission: null,
      reviewDecision: null,
    },
    {
      id: 'transition-approve',
      key: 'approve',
      label: 'Approve',
      sourceStageId: 'stage-review',
      destinationStageId: 'stage-approved',
      requiredPermission: null,
      reviewDecision: 'APPROVED',
    },
    {
      id: 'transition-request',
      key: 'request_changes',
      label: 'Request changes',
      sourceStageId: 'stage-review',
      destinationStageId: 'stage-changes',
      requiredPermission: null,
      reviewDecision: 'CHANGES_REQUESTED',
    },
  ],
};
const workflow = {
  id: 'workflow-1',
  name: 'Review flow',
  description: null,
  status: 'ENABLED',
  currentVersionNumber: 1,
  enabledVersionNumber: 1,
  versions: [workflowVersion],
};

// One in-memory API for all three screens, applying writes the way the API
// does, so each screen only shows a change if it fetched it again.
function serveApi() {
  let revisionNumber = 1;
  let status = 'DRAFT';
  let run: {
    stage: keyof typeof stages;
    revisionNumber: number;
    cancelReason?: string;
  } | null = null;
  let approvedRevision: number | null = null;
  // Change requests, as GET /creatives/:id/change-requests returns them.
  const changeRequests: Array<{
    id: string;
    status: string;
    revisionNumber: number;
    requestedChanges: string;
    explanation: string | null;
  }> = [];
  const revisionOf = (number: number) => ({
    id: 'revision-' + number,
    revisionNumber: number,
    templateVersionId: templateVersion.id,
    values: { headline: 'Headline ' + number },
    summary: null,
    createdById: 'user-1',
    createdAt: '2026-01-01T00:00:00Z',
    templateVersion,
  });
  const creative = () => ({
    id: 'creative-1',
    organizationId: 'org-1',
    branchId: 'branch-1',
    campaignId: null,
    name: 'Launch',
    status,
    currentRevisionId: 'revision-' + revisionNumber,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    currentRevision: revisionOf(revisionNumber),
    approvedRevision:
      approvedRevision === null
        ? null
        : {
            revisionId: 'revision-' + approvedRevision,
            revisionNumber: approvedRevision,
            approvedAt: '2026-01-02T00:00:00Z',
            reviewer: { id: 'user-2', name: 'Rita Reviewer' },
          },
    currentRevisionApproved: approvedRevision === revisionNumber,
  });
  const instance = () =>
    run && {
      id: 'instance-1',
      status:
        run.cancelReason !== undefined
          ? 'CANCELLED'
          : run.stage === 'approved' || run.stage === 'changes'
            ? 'COMPLETED'
            : 'RUNNING',
      startedById: 'user-1',
      workflow: { id: 'workflow-1', name: 'Review flow' },
      _count: { approvalDecisions: run.stage === 'approved' ? 1 : 0 },
      workflowId: 'workflow-1',
      creativeRevisionId: 'revision-' + run.revisionNumber,
      currentStage: stages[run.stage],
      version: workflowVersion,
      tasks:
        run.stage === 'review'
          ? [
              {
                id: 'task-1',
                status: 'OPEN',
                stage: stages.review,
                requiredPermission: 'approvals:decide',
              },
            ]
          : [],
      history:
        run.cancelReason !== undefined
          ? [
              {
                id: 'history-cancel',
                actionKey: 'CANCEL',
                reason: run.cancelReason,
                createdAt: '2026-01-03T00:00:00Z',
                fromStage: stages[run.stage],
                toStage: stages[run.stage],
              },
            ]
          : [],
    };
  const reply = (body: unknown, code = 200) => {
    const text = body === null ? '' : JSON.stringify(body);
    return {
      ok: code >= 200 && code < 300,
      status: code,
      json: async () => JSON.parse(text) as unknown,
      text: async () => text,
    };
  };
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const path = url.replace(/^https?:\/\/[^/]+\/api\/v1/, '');
    if (method === 'POST' && path === '/creatives/creative-1/workflows') {
      // A run for a newer revision resolves older requests, as the API does.
      for (const request of changeRequests)
        if (request.revisionNumber < revisionNumber)
          request.status = 'RESOLVED';
      run = { stage: 'draft', revisionNumber };
      status = 'draft';
      return reply(instance(), 201);
    }
    if (
      method === 'POST' &&
      path === '/workflow-instances/instance-1/transitions'
    ) {
      run!.stage = 'review';
      status = 'review';
      return reply(instance());
    }
    if (method === 'POST' && path === '/workflow-instances/instance-1/cancel') {
      run!.cancelReason = (
        JSON.parse(String(init!.body)) as { reason: string }
      ).reason;
      status = 'DRAFT';
      return reply(instance(), 201);
    }
    if (method === 'POST' && path === '/approvals/tasks/task-1/decision') {
      const body = JSON.parse(String(init!.body)) as {
        decision: string;
        reason?: string;
      };
      if (body.decision === 'CHANGES_REQUESTED') {
        run!.stage = 'changes';
        status = 'changes';
        changeRequests.push({
          id: 'request-' + (changeRequests.length + 1),
          status: 'OPEN',
          revisionNumber: run!.revisionNumber,
          requestedChanges: body.reason ?? '',
          explanation: null,
        });
        return reply({ id: 'decision-cr' }, 201);
      }
      run!.stage = 'approved';
      status = 'approved';
      approvedRevision = run!.revisionNumber;
      return reply({ id: 'decision-1' }, 201);
    }
    if (method === 'PATCH' && path === '/creatives/creative-1') {
      revisionNumber += 1;
      status = 'DRAFT';
      return reply(creative());
    }
    if (path.startsWith('/creatives?branchId=')) return reply([creative()]);
    if (path === '/templates') return reply([template]);
    if (path === '/templates/template-1')
      return reply({ ...template, versions: [templateVersion] });
    if (path === '/creatives/creative-1/revisions')
      return reply(
        Array.from({ length: revisionNumber }, (_, index) =>
          revisionOf(revisionNumber - index),
        ),
      );
    if (path === '/creatives/creative-1/workflow') return reply(instance());
    if (path === '/creatives/creative-1/change-requests')
      return reply(changeRequests.map((request) => ({ ...request })));
    if (path === '/workflows') return reply([workflow]);
    if (path === '/approvals/tasks')
      return reply(
        run?.stage === 'review'
          ? [
              {
                id: 'task-1',
                status: 'OPEN',
                stage: stages.review,
                instance: {
                  id: 'instance-1',
                  creative: {
                    id: 'creative-1',
                    name: 'Launch',
                    currentRevision: { revisionNumber },
                  },
                },
              },
            ]
          : [],
      );
    if (path === '/approvals/tasks/task-1')
      return reply({
        task: { id: 'task-1', status: 'OPEN', stage: stages.review },
        workflow: { id: 'workflow-1', name: 'Review flow' },
        creative: {
          id: 'creative-1',
          name: 'Launch',
          currentRevisionId: 'revision-' + revisionNumber,
        },
        revision: revisionOf(run?.revisionNumber ?? revisionNumber),
        current: true,
        submittedByViewer: false,
      });
    return reply([]);
  });
  vi.stubGlobal('fetch', fetchMock);
  const calls = (match: (path: string, method: string) => boolean) =>
    fetchMock.mock.calls.filter(([input, init]) =>
      match(
        String(input).replace(/^https?:\/\/[^/]+\/api\/v1/, ''),
        (init as RequestInit | undefined)?.method ?? 'GET',
      ),
    ).length;
  return { calls };
}

// The three screens wired exactly as the app shell wires them.
function Screens() {
  const [dataChange, onDataChanged] = useDataChanges();
  const shared = {
    session,
    dataChange,
    onDataChanged,
    onUnauthorized: vi.fn(),
  };
  return (
    <>
      <CreativeWorkspace {...shared} branch={branch} />
      <WorkflowWorkspace {...shared} branch={branch} />
      <ApprovalsWorkspace {...shared} />
    </>
  );
}

const creativesScreen = () =>
  screen.getByRole('region', { name: 'Creatives · North' });
const workflowsScreen = () =>
  screen.getByRole('region', { name: 'Creative workflows' });
const approvalsScreen = () =>
  screen.getByRole('region', { name: 'Approvals & comments' });
const creativeRow = () =>
  within(creativesScreen())
    .getByRole('button', { name: 'Open' })
    .closest('li')!;
const picker = () =>
  within(workflowsScreen()).getByRole('combobox', { name: 'Branch creative' });

// Regression (Stage 11 E2E): screens loaded their lists at sign-in only, so
// a creative created, started or approved on one screen was missing or
// showed an old status on the others until a full reload.
describe('cross-screen refresh', () => {
  it('keeps Creatives, Workflows and Approvals current through start, submit, approval and revision', async () => {
    const { calls } = serveApi();
    render(<Screens />);
    await waitFor(() => expect(creativeRow()).toHaveTextContent('Draft'));
    await waitFor(() => expect(picker()).toHaveTextContent('Launch · Draft'));
    expect(
      within(approvalsScreen()).getByText('No pending reviews.'),
    ).toBeInTheDocument();
    // Each screen loads once on mount; nothing refreshes without a change.
    expect(calls((path) => path.startsWith('/creatives?'))).toBe(2);
    expect(calls((path) => path === '/approvals/tasks')).toBe(1);

    // Workflows: start and submit the creative for review.
    fireEvent.change(picker(), { target: { value: 'creative-1' } });
    fireEvent.change(
      await within(workflowsScreen()).findByRole('combobox', {
        name: 'Workflow to start',
      }),
      { target: { value: 'workflow-1' } },
    );
    fireEvent.click(
      within(workflowsScreen()).getByRole('button', { name: 'Start workflow' }),
    );
    fireEvent.click(
      await within(workflowsScreen()).findByRole('button', {
        name: 'Submit for review',
      }),
    );
    // Creatives and Approvals follow without a reload.
    await waitFor(() => expect(creativeRow()).toHaveTextContent('Review'));
    expect(
      await within(approvalsScreen()).findByRole('button', { name: 'Review' }),
    ).toBeInTheDocument();
    // The Creatives refresh is light: templates were loaded once, at mount.
    expect(calls((path) => path === '/templates')).toBe(1);

    // Approvals: approve. Creatives and the Workflows picker and run follow,
    // and the Workflows selection is kept.
    const runLoadsBefore = calls(
      (path) => path === '/creatives/creative-1/workflow',
    );
    fireEvent.click(
      within(approvalsScreen()).getByRole('button', { name: 'Review' }),
    );
    fireEvent.click(
      await within(approvalsScreen()).findByRole('button', {
        name: 'Approve',
      }),
    );
    await waitFor(() =>
      expect(creativeRow()).toHaveTextContent('Current revision 1 approved'),
    );
    await waitFor(() =>
      expect(picker()).toHaveTextContent(
        'Launch · Approved · Current revision 1 approved',
      ),
    );
    expect((picker() as HTMLSelectElement).value).toBe('creative-1');
    await waitFor(() =>
      expect(
        calls((path) => path === '/creatives/creative-1/workflow'),
      ).toBeGreaterThan(runLoadsBefore),
    );
    expect(
      await within(workflowsScreen()).findByRole('heading', {
        name: /^Approved/,
      }),
    ).toBeInTheDocument();
    expect(
      within(approvalsScreen()).queryByRole('button', { name: 'Review' }),
    ).not.toBeInTheDocument();

    // Creatives: save revision 2. The Workflows picker shows the current
    // revision as Draft and names the approved revision.
    fireEvent.click(
      within(creativesScreen()).getByRole('button', { name: 'Open' }),
    );
    const headline = await within(creativesScreen()).findByRole('textbox', {
      name: 'Headline',
    });
    fireEvent.change(headline, { target: { value: 'Revised' } });
    fireEvent.click(
      within(creativesScreen()).getByRole('button', {
        name: 'Save new revision',
      }),
    );
    await waitFor(() =>
      expect(picker()).toHaveTextContent(
        'Launch · Draft · Revision 1 approved · current revision 2 not yet approved',
      ),
    );
    expect((picker() as HTMLSelectElement).value).toBe('creative-1');
    expect(creativeRow()).toHaveTextContent(
      'Revision 1 approved · current revision 2 not yet approved',
    );
    expect(creativeRow()).not.toHaveTextContent('Approved Revision');
  });

  // Stage 10.3: cancelling a run on Workflows releases the edit lock on
  // Creatives without a reload, keeping the edits typed while it was locked.
  it('unlocks the Creatives form when Workflows cancels the run, keeping unsaved edits', async () => {
    serveApi();
    render(<Screens />);
    await waitFor(() => expect(picker()).toHaveTextContent('Launch · Draft'));
    fireEvent.change(picker(), { target: { value: 'creative-1' } });
    fireEvent.change(
      await within(workflowsScreen()).findByRole('combobox', {
        name: 'Workflow to start',
      }),
      { target: { value: 'workflow-1' } },
    );
    fireEvent.click(
      within(workflowsScreen()).getByRole('button', { name: 'Start workflow' }),
    );
    fireEvent.click(
      await within(workflowsScreen()).findByRole('button', {
        name: 'Submit for review',
      }),
    );
    await waitFor(() => expect(creativeRow()).toHaveTextContent('Review'));

    fireEvent.click(
      within(creativesScreen()).getByRole('button', { name: 'Open' }),
    );
    expect(
      await within(creativesScreen()).findByRole('region', {
        name: 'Editing locked',
      }),
    ).toHaveTextContent('at stage Review in Review flow');
    const headline = await within(creativesScreen()).findByRole('textbox', {
      name: 'Headline',
    });
    fireEvent.change(headline, { target: { value: 'Typed while locked' } });
    const save = within(creativesScreen()).getByRole('button', {
      name: 'Save new revision',
    });
    expect(save).toBeDisabled();

    // The run's starter cancels it from Workflows (no decision yet).
    fireEvent.click(
      await within(workflowsScreen()).findByRole('button', {
        name: 'Cancel run',
      }),
    );
    fireEvent.change(
      within(workflowsScreen()).getByRole('textbox', {
        name: 'Reason for cancelling (required)',
      }),
      { target: { value: 'Wrong revision submitted' } },
    );
    fireEvent.click(
      within(workflowsScreen()).getByRole('button', {
        name: 'Confirm cancellation',
      }),
    );
    expect(
      await within(workflowsScreen()).findByText(
        /Cancelled at Review · .* · Reason: Wrong revision submitted/,
      ),
    ).toBeInTheDocument();

    await waitFor(() => expect(save).toBeEnabled());
    expect(
      within(creativesScreen()).queryByRole('region', {
        name: 'Editing locked',
      }),
    ).not.toBeInTheDocument();
    expect(headline).toHaveValue('Typed while locked');
    await waitFor(() => expect(creativeRow()).toHaveTextContent('Draft'));
    await waitFor(() => expect(picker()).toHaveTextContent('Launch · Draft'));
  });

  // Stage 12: changes requested in Approvals, one click in Creatives, and
  // the new review task appears in Approvals without a reload.
  it('resubmits with one click after changes are requested, and Approvals shows the new task', async () => {
    const { calls } = serveApi();
    render(<Screens />);
    await waitFor(() => expect(picker()).toHaveTextContent('Launch · Draft'));
    fireEvent.change(picker(), { target: { value: 'creative-1' } });
    fireEvent.change(
      await within(workflowsScreen()).findByRole('combobox', {
        name: 'Workflow to start',
      }),
      { target: { value: 'workflow-1' } },
    );
    fireEvent.click(
      within(workflowsScreen()).getByRole('button', { name: 'Start workflow' }),
    );
    fireEvent.click(
      await within(workflowsScreen()).findByRole('button', {
        name: 'Submit for review',
      }),
    );
    fireEvent.click(
      await within(approvalsScreen()).findByRole('button', { name: 'Review' }),
    );
    fireEvent.change(
      await within(approvalsScreen()).findByLabelText(
        'Decision reason or requested changes',
      ),
      { target: { value: 'Bigger logo' } },
    );
    fireEvent.click(
      within(approvalsScreen()).getByRole('button', {
        name: 'Request changes',
      }),
    );
    await waitFor(() =>
      expect(
        within(approvalsScreen()).queryByRole('button', { name: 'Review' }),
      ).not.toBeInTheDocument(),
    );

    // Creatives: the request on the current revision offers one click.
    fireEvent.click(
      within(creativesScreen()).getByRole('button', { name: 'Open' }),
    );
    expect(
      await within(creativesScreen()).findByRole('region', {
        name: 'Open change requests',
      }),
    ).toHaveTextContent('Revision 1: Bigger logo');
    fireEvent.change(
      await within(creativesScreen()).findByRole('textbox', {
        name: 'Headline',
      }),
      { target: { value: 'Headline with a bigger logo' } },
    );
    const tasksBefore = calls((path) => path === '/approvals/tasks');
    fireEvent.click(
      await within(creativesScreen()).findByRole('button', {
        name: 'Save and resubmit for review',
      }),
    );
    expect(
      await within(creativesScreen()).findByText(
        'Revision 2 was saved and resubmitted.',
        { exact: false },
      ),
    ).toBeInTheDocument();
    expect(
      calls((path, m) => m === 'PATCH' && path === '/creatives/creative-1'),
    ).toBe(1);

    // Workflows: the run is at Draft for revision 2. Submitting it sends the
    // new task to Approvals, which refreshes without a reload.
    fireEvent.click(
      await within(workflowsScreen()).findByRole('button', {
        name: 'Submit for review',
      }),
    );
    expect(
      await within(approvalsScreen()).findByRole('button', { name: 'Review' }),
    ).toBeInTheDocument();
    expect(calls((path) => path === '/approvals/tasks')).toBeGreaterThan(
      tasksBefore,
    );
    await waitFor(() =>
      expect(
        within(creativesScreen()).queryByRole('region', {
          name: 'Open change requests',
        }),
      ).not.toBeInTheDocument(),
    );
  });
});

describe('useOtherScreenChanges', () => {
  function track(initial: DataChange) {
    const refresh = vi.fn();
    const view = renderHook(
      ({ change }: { change: DataChange }) =>
        useOtherScreenChanges(change, 'creatives', refresh),
      { initialProps: { change: initial } },
    );
    return { refresh, view };
  }

  it('does not refresh on mount, even when changes happened before', () => {
    const { refresh } = track({ key: 3, source: 'workflows' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes once per change from another screen and never for its own', () => {
    const { refresh, view } = track(noDataChange);
    view.rerender({ change: { key: 1, source: 'workflows' } });
    expect(refresh).toHaveBeenCalledTimes(1);
    view.rerender({ change: { key: 1, source: 'workflows' } });
    expect(refresh).toHaveBeenCalledTimes(1);
    view.rerender({ change: { key: 2, source: 'creatives' } });
    expect(refresh).toHaveBeenCalledTimes(1);
    view.rerender({ change: { key: 3, source: 'approvals' } });
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
