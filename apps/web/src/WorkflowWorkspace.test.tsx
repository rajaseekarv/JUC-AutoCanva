import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type {
  AuthenticatedUserResponse,
  BranchResponse,
} from '@adflow/shared-types';
import WorkflowWorkspace from './WorkflowWorkspace';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// A successful API reply. Like the API, null is sent as an empty body, which
// a real Response's json() rejects.
const okReply = (body: unknown) => {
  const text = body === null ? '' : JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
  };
};

const user: AuthenticatedUserResponse = {
  id: 'user-1',
  organizationId: 'org-1',
  name: 'Branch operator',
  email: 'operator@example.local',
  permissions: ['workflows:read', 'workflows:start', 'workflows:transition'],
  branches: [],
};
const branch: BranchResponse = {
  id: 'branch-1',
  name: 'North',
  code: 'NORTH',
  status: 'ACTIVE',
};
const stages = [
  {
    id: 'stage-draft',
    key: 'draft',
    name: 'Draft',
    displayOrder: 0,
    isEntry: true,
    isTerminal: false,
    requiredPermission: null,
    assignedUserId: null,
    assignedPermission: null,
  },
  {
    id: 'stage-ready',
    key: 'ready',
    name: 'Ready',
    displayOrder: 1,
    isEntry: false,
    isTerminal: true,
    requiredPermission: null,
    assignedUserId: null,
    assignedPermission: null,
  },
];
const workflow = {
  id: 'workflow-1',
  name: 'Local workflow',
  description: null,
  status: 'ENABLED',
  currentVersionNumber: 1,
  enabledVersionNumber: 1,
  versions: [
    {
      id: 'version-1',
      versionNumber: 1,
      stages,
      transitions: [
        {
          id: 'transition-1',
          key: 'submit',
          label: 'Submit',
          sourceStageId: 'stage-draft',
          destinationStageId: 'stage-ready',
          requiredPermission: null,
        },
      ],
    },
  ],
};
const creative = {
  id: 'creative-1',
  name: 'Spring post',
  status: 'draft',
  currentRevisionId: 'revision-1',
};
const running = {
  id: 'instance-1',
  status: 'RUNNING',
  currentStage: stages[0],
  creativeRevisionId: 'revision-1',
  version: workflow.versions[0],
  tasks: [
    {
      id: 'task-1',
      status: 'OPEN',
      stage: stages[0],
      requiredPermission: null,
    },
  ],
  history: [
    {
      id: 'history-1',
      actionKey: 'START',
      reason: null,
      createdAt: '2026-10-22T10:00:00Z',
      fromStage: null,
      toStage: stages[0],
    },
  ],
};
const completed = {
  ...running,
  status: 'COMPLETED',
  currentStage: stages[1],
  tasks: [],
  history: [
    ...running.history,
    {
      id: 'history-2',
      actionKey: 'submit',
      reason: null,
      createdAt: '2026-10-22T10:05:00Z',
      fromStage: stages[0],
      toStage: stages[1],
    },
  ],
};

describe('WorkflowWorkspace', () => {
  // Regression (Stage 11 E2E): the API answers 200 with an empty body for a
  // creative that never had a run, and the screen showed the JSON parse
  // error "Unexpected end of JSON input" instead of offering a first run.
  it('offers a first run for a creative that has never had one, without an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async (url: string) =>
          okReply(
            url.endsWith('/workflows')
              ? [workflow]
              : url.includes('/creatives?branchId=')
                ? [creative]
                : url.endsWith('/creatives/creative-1/workflow')
                  ? null
                  : [],
          ),
        ),
    );
    render(
      <WorkflowWorkspace
        session={{ accessToken: 'token', user }}
        branch={branch}
        onUnauthorized={vi.fn()}
      />,
    );
    fireEvent.change(
      await screen.findByRole('combobox', { name: 'Branch creative' }),
      { target: { value: creative.id } },
    );
    expect(
      await screen.findByRole('combobox', { name: 'Workflow to start' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Start workflow' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the authorized next transition and append-only history after it succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async (url: string, init?: RequestInit) => {
        let body: unknown = [];
        if (url.endsWith('/workflows')) body = [workflow];
        else if (url.includes('/creatives?branchId=')) body = [creative];
        else if (url.endsWith('/creatives/creative-1/workflow')) body = running;
        else if (url.endsWith('/workflow-instances/instance-1/transitions'))
          body = completed;
        return { ...okReply(body), init };
      });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <WorkflowWorkspace
        session={{ accessToken: 'token', user }}
        branch={branch}
        onUnauthorized={vi.fn()}
      />,
    );
    fireEvent.change(
      await screen.findByRole('combobox', { name: 'Branch creative' }),
      { target: { value: creative.id } },
    );
    // The friendly status label renders as a badge inside the stage heading.
    expect(
      await screen.findByRole('heading', { name: 'Draft · In progress' }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/Start → Draft/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(
      await screen.findByRole('heading', { name: 'Ready · Completed' }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/Draft → Ready/)).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/workflow-instances/instance-1/transitions'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('loads a workflow version into the definition editor and validates it through the API', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async (url: string) =>
        okReply(
          url.endsWith('/validate')
            ? { valid: true, errors: [] }
            : url.endsWith('/workflows')
              ? [workflow]
              : { ...workflow, versions: workflow.versions },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    render(
      <WorkflowWorkspace
        session={{
          accessToken: 'token',
          user: {
            ...user,
            permissions: [...user.permissions, 'workflows:manage'],
          },
        }}
        branch={null}
        onUnauthorized={vi.fn()}
      />,
    );
    fireEvent.change(
      await screen.findByRole('combobox', { name: 'Workflow definition' }),
      {
        target: { value: workflow.id },
      },
    );
    const definitionEditor = await screen.findByRole('textbox', {
      name: 'Workflow definition JSON',
    });
    await waitFor(() =>
      expect((definitionEditor as HTMLTextAreaElement).value).toContain(
        '"key": "submit"',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    expect(
      await screen.findByText(
        'Workflow definition is valid: saved version 1, which the editor shows, was checked.',
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/workflows/workflow-1/validate'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });
});

// Regression (Stage 8 E2E): after a run completed (for example with changes
// requested), the UI never offered "Start workflow" again although the API
// allows one running instance at a time, so a revised creative could not be
// resubmitted from the browser.
// Regression (Stage 11 E2E): the creative picker labelled a creative whose
// newer revision was never reviewed as "Approved".
describe('WorkflowWorkspace revision-specific approval', () => {
  it('labels a creative with the current revision status and the approved revision', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) =>
        okReply(
          url.endsWith('/workflows')
            ? [workflow]
            : url.includes('/creatives?branchId=')
              ? [
                  {
                    ...creative,
                    status: 'DRAFT',
                    currentRevision: { revisionNumber: 2 },
                    approvedRevision: {
                      revisionId: 'revision-1',
                      revisionNumber: 1,
                      approvedAt: '2026-11-05T10:00:00.000Z',
                      reviewer: { id: 'reviewer-1', name: 'Rita Reviewer' },
                    },
                    currentRevisionApproved: false,
                  },
                ]
              : null,
        ),
      ),
    );
    render(
      <WorkflowWorkspace
        session={{ accessToken: 'token', user }}
        branch={branch}
        onUnauthorized={vi.fn()}
      />,
    );
    const picker = await screen.findByRole('combobox', {
      name: 'Branch creative',
    });
    await waitFor(() =>
      expect(picker).toHaveTextContent(
        creative.name +
          ' · Draft · Revision 1 approved · current revision 2 not yet approved',
      ),
    );
    expect(picker).not.toHaveTextContent('Approved ·');
  });
});

describe('WorkflowWorkspace starting another run', () => {
  function serve(latest: unknown) {
    let current = latest;
    const fetchMock = vi
      .fn()
      .mockImplementation(async (url: string, init?: RequestInit) => {
        let body: unknown = [];
        // Most specific first: the start URL also ends with "/workflows".
        if (
          url.endsWith('/creatives/creative-1/workflows') &&
          init?.method === 'POST'
        ) {
          current = { ...running, id: 'instance-2' };
          body = current;
        } else if (url.endsWith('/workflows')) body = [workflow];
        else if (url.endsWith('/workflows/workflow-1')) body = workflow;
        else if (url.includes('/creatives?branchId=')) body = [creative];
        else if (url.endsWith('/creatives/creative-1/workflow')) body = current;
        return okReply(body);
      });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <WorkflowWorkspace
        session={{ accessToken: 'token', user }}
        branch={branch}
        onUnauthorized={vi.fn()}
      />,
    );
    return fetchMock;
  }
  const chooseCreative = async () =>
    fireEvent.change(
      await screen.findByRole('combobox', { name: 'Branch creative' }),
      { target: { value: creative.id } },
    );

  it('offers a new run after the latest one completed, and starts it', async () => {
    const fetchMock = serve(completed);
    await chooseCreative();
    expect(
      await screen.findByRole('heading', { name: 'Ready · Completed' }),
    ).toBeInTheDocument();
    fireEvent.change(
      await screen.findByRole('combobox', { name: 'Workflow to start' }),
      { target: { value: workflow.id } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start workflow' }));
    expect(
      await screen.findByRole('heading', { name: 'Draft · In progress' }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/creatives/creative-1/workflows'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ workflowId: workflow.id }),
      }),
    );
  });

  it('does not offer a second run while one is running', async () => {
    serve(running);
    await chooseCreative();
    expect(
      await screen.findByRole('heading', { name: 'Draft · In progress' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Start workflow' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: 'Workflow to start' }),
    ).not.toBeInTheDocument();
  });

  it('still offers the first run when the creative has none', async () => {
    serve(null);
    await chooseCreative();
    expect(
      await screen.findByRole('button', { name: 'Start workflow' }),
    ).toBeInTheDocument();
  });
});

// Stage 10.3: cancelling a running run from the Workflows screen.
describe('WorkflowWorkspace run cancellation', () => {
  const managerUser: AuthenticatedUserResponse = {
    ...user,
    id: 'manager-1',
    permissions: ['workflows:read', 'workflows:manage', 'creatives:read'],
  };
  const runningRun = (extra: Record<string, unknown> = {}) => ({
    ...running,
    startedById: 'user-1',
    _count: { approvalDecisions: 0 },
    ...extra,
  });
  const cancelledRun = {
    ...runningRun(),
    status: 'CANCELLED',
    tasks: [],
    history: [
      ...running.history,
      {
        id: 'history-cancel',
        actionKey: 'CANCEL',
        reason: 'Reviewer is away',
        createdAt: '2026-10-22T11:00:00Z',
        fromStage: stages[0],
        toStage: stages[0],
      },
    ],
  };
  const errorReply = (status: number, message: string) => ({
    ok: false,
    status,
    json: async () => ({ message }),
    text: async () => JSON.stringify({ message }),
  });

  function serve(
    options: {
      run?: Record<string, unknown>;
      cancelStatus?: number;
      cancelMessage?: string;
      holdCancel?: boolean;
    } = {},
  ) {
    let run: Record<string, unknown> = options.run ?? runningRun();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/workflow-instances/instance-1/cancel')) {
        if (options.holdCancel) await held;
        if (options.cancelStatus)
          return errorReply(
            options.cancelStatus,
            options.cancelMessage ?? 'Workflow is not running',
          );
        run = cancelledRun;
        return { ...okReply(cancelledRun), status: 201 };
      }
      if (url.endsWith('/workflows')) return okReply([workflow]);
      if (url.includes('/creatives?branchId=')) return okReply([creative]);
      if (url.endsWith('/creatives/creative-1/workflow')) return okReply(run);
      if (url.endsWith('/transitions') && !init?.method) return okReply([]);
      return okReply(null);
    });
    vi.stubGlobal('fetch', fetchMock);
    const cancels = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/cancel'));
    return { fetchMock, cancels, release: () => release() };
  }

  async function openRun(
    sessionUser: AuthenticatedUserResponse = managerUser,
    onDataChanged = vi.fn(),
  ) {
    render(
      <WorkflowWorkspace
        session={{ accessToken: 'token', user: sessionUser }}
        branch={branch}
        onDataChanged={onDataChanged}
        onUnauthorized={vi.fn()}
      />,
    );
    fireEvent.change(
      await screen.findByRole('combobox', { name: 'Branch creative' }),
      { target: { value: 'creative-1' } },
    );
    await screen.findByRole('heading', { name: /^Draft/ });
    return onDataChanged;
  }
  const cancelButton = () =>
    screen.queryByRole('button', { name: 'Cancel run' });
  const reasonBox = () =>
    screen.getByRole('textbox', { name: 'Reason for cancelling (required)' });
  const confirm = () =>
    screen.getByRole('button', { name: /Confirm cancellation|Cancelling…/ });

  it('offers Cancel run to a workflow manager for a running run, even after decisions', async () => {
    serve({ run: runningRun({ _count: { approvalDecisions: 2 } }) });
    await openRun();
    expect(cancelButton()).toBeInTheDocument();
  });

  it('offers Cancel run to the starter while the run has no decision', async () => {
    serve();
    await openRun(user);
    expect(cancelButton()).toBeInTheDocument();
  });

  it.each([
    [
      'the starter once a decision is recorded',
      user,
      { _count: { approvalDecisions: 1 } },
    ],
    [
      'the starter when the decision count is unknown',
      user,
      { _count: undefined },
    ],
    ['a user who did not start the run', { ...user, id: 'user-9' }, {}],
    [
      'the starter without workflows:start',
      {
        ...user,
        permissions: [
          'workflows:read',
          'workflows:transition',
          'creatives:read',
        ],
      },
      {},
    ],
  ])('does not offer Cancel run to %s', async (_label, sessionUser, extra) => {
    serve({ run: runningRun(extra) });
    await openRun(sessionUser);
    expect(cancelButton()).not.toBeInTheDocument();
  });

  it('does not offer Cancel run for a run that is not running', async () => {
    serve({ run: { ...completed, startedById: 'user-1' } });
    render(
      <WorkflowWorkspace
        session={{ accessToken: 'token', user: managerUser }}
        branch={branch}
        onUnauthorized={vi.fn()}
      />,
    );
    fireEvent.change(
      await screen.findByRole('combobox', { name: 'Branch creative' }),
      { target: { value: 'creative-1' } },
    );
    await screen.findByRole('heading', { name: /^Ready/ });
    expect(cancelButton()).not.toBeInTheDocument();
  });

  it('requires a reason and sends nothing without one', async () => {
    const { cancels } = serve();
    await openRun();
    fireEvent.click(cancelButton()!);
    fireEvent.change(reasonBox(), { target: { value: '   ' } });
    fireEvent.click(confirm());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter a reason for cancelling this run.',
    );
    expect(reasonBox()).toHaveAttribute('aria-invalid', 'true');
    expect(reasonBox()).toHaveAttribute('maxLength', '1000');
    expect(cancels()).toEqual([]);
  });

  it('shows a server error next to the reason and keeps the form for a retry', async () => {
    serve({
      cancelStatus: 409,
      cancelMessage: 'Workflow changed concurrently; reload and retry',
    });
    await openRun();
    fireEvent.click(cancelButton()!);
    fireEvent.change(reasonBox(), { target: { value: 'Stuck' } });
    fireEvent.click(confirm());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Workflow changed concurrently; reload and retry',
    );
    expect(reasonBox()).toHaveValue('Stuck');
    expect(confirm()).toBeEnabled();
  });

  it('cancels with the trimmed reason, shows the cancelled run and its reason, and tells other screens', async () => {
    const { cancels } = serve();
    const onDataChanged = await openRun({
      ...managerUser,
      permissions: [...managerUser.permissions, 'workflows:start'],
    });
    fireEvent.click(cancelButton()!);
    fireEvent.change(reasonBox(), {
      target: { value: '  Reviewer is away  ' },
    });
    fireEvent.click(confirm());
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Run cancelled. The creative can be revised and submitted again.',
    );
    expect(cancels()).toHaveLength(1);
    expect(JSON.parse(String((cancels()[0]![1] as RequestInit).body))).toEqual({
      reason: 'Reviewer is away',
    });
    expect(
      screen.getByRole('heading', { name: /^Draft · Cancelled/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Cancelled at Draft · .* · Reason: Reviewer is away/),
    ).toBeInTheDocument();
    expect(cancelButton()).not.toBeInTheDocument();
    expect(onDataChanged).toHaveBeenCalledWith('workflows');
    // A new run can be started for the recovered creative.
    expect(
      screen.getByRole('button', { name: 'Start workflow' }),
    ).toBeInTheDocument();
  });

  it('sends one request when Confirm is clicked twice', async () => {
    const { cancels, release } = serve({ holdCancel: true });
    await openRun();
    fireEvent.click(cancelButton()!);
    fireEvent.change(reasonBox(), { target: { value: 'Stuck' } });
    fireEvent.click(confirm());
    fireEvent.click(confirm());
    expect(confirm()).toBeDisabled();
    expect(confirm()).toHaveTextContent('Cancelling…');
    release();
    await screen.findByRole('status');
    expect(cancels()).toHaveLength(1);
  });

  it('closes the form without cancelling when Keep running is chosen', async () => {
    const { cancels } = serve();
    await openRun();
    fireEvent.click(cancelButton()!);
    fireEvent.change(reasonBox(), { target: { value: 'Maybe' } });
    fireEvent.click(screen.getByRole('button', { name: 'Keep running' }));
    expect(
      screen.queryByRole('textbox', {
        name: 'Reason for cancelling (required)',
      }),
    ).not.toBeInTheDocument();
    expect(cancelButton()).toBeInTheDocument();
    expect(cancels()).toEqual([]);
  });
});

// Stage 10.6: the API refuses a run for a revision whose change requests
// are still OPEN or IN_PROGRESS; the screen explains it before Start.
describe('WorkflowWorkspace start with unresolved change requests', () => {
  const reader: AuthenticatedUserResponse = {
    ...user,
    permissions: [...user.permissions, 'change_requests:read'],
  };
  // The creative's current revision is 2.
  const atRevisionTwo = { ...creative, currentRevision: { revisionNumber: 2 } };
  const errorReply = (status: number, message: string) => ({
    ok: false,
    status,
    json: async () => ({ message }),
    text: async () => JSON.stringify({ message }),
  });

  function serve(
    requests: { status: string; revisionNumber: number }[],
    options: { startStatus?: number } = {},
  ) {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.endsWith('/creatives/creative-1/workflows') &&
        init?.method === 'POST'
      )
        return options.startStatus
          ? errorReply(
              options.startStatus,
              'Save a new revision with the requested changes before resubmitting.',
            )
          : okReply({ ...running, id: 'instance-2' });
      if (url.endsWith('/creatives/creative-1/change-requests'))
        return okReply(requests);
      if (url.endsWith('/workflows')) return okReply([workflow]);
      if (url.includes('/creatives?branchId=')) return okReply([atRevisionTwo]);
      if (url.endsWith('/creatives/creative-1/workflow'))
        return okReply(completed);
      return okReply([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  async function openStart(sessionUser = reader) {
    render(
      <WorkflowWorkspace
        session={{ accessToken: 'token', user: sessionUser }}
        branch={branch}
        onUnauthorized={vi.fn()}
      />,
    );
    fireEvent.change(
      await screen.findByRole('combobox', { name: 'Branch creative' }),
      { target: { value: creative.id } },
    );
    fireEvent.change(
      await screen.findByRole('combobox', { name: 'Workflow to start' }),
      { target: { value: workflow.id } },
    );
  }
  const startButton = () =>
    screen.getByRole('button', { name: 'Start workflow' });
  const explanation =
    'Revision 2 has unresolved change requests. Save a new revision with the requested changes in Creatives before resubmitting it for review.';
  const starts = (fetchMock: ReturnType<typeof serve>) =>
    fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith('/workflows') &&
        (init as RequestInit | undefined)?.method === 'POST',
    );

  it.each(['OPEN', 'IN_PROGRESS'])(
    'disables Start and explains why while the current revision has an %s request',
    async (status) => {
      const fetchMock = serve([{ status, revisionNumber: 2 }]);
      await openStart();
      const note = await screen.findByText(explanation);
      await waitFor(() => expect(startButton()).toBeDisabled());
      expect(startButton()).toHaveAttribute('aria-describedby', note.id);
      fireEvent.click(startButton());
      expect(starts(fetchMock)).toEqual([]);
    },
  );

  it.each([
    ['a resolved request on the current revision', 'RESOLVED', 2],
    ['a cancelled request on the current revision', 'CANCELLED', 2],
    ['an open request on an older revision', 'OPEN', 1],
  ])('keeps Start available for %s', async (_label, status, revisionNumber) => {
    serve([{ status, revisionNumber }]);
    await openStart();
    await waitFor(() => expect(startButton()).toBeEnabled());
    expect(screen.queryByText(explanation)).not.toBeInTheDocument();
  });

  it('without change_requests:read, requests none and shows the API 409, keeping the chosen workflow', async () => {
    const fetchMock = serve([{ status: 'OPEN', revisionNumber: 2 }], {
      startStatus: 409,
    });
    await openStart(user);
    await waitFor(() => expect(startButton()).toBeEnabled());
    fireEvent.click(startButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Save a new revision with the requested changes before resubmitting.',
    );
    expect(
      screen.getByRole('combobox', { name: 'Workflow to start' }),
    ).toHaveValue(workflow.id);
    expect(starts(fetchMock)).toHaveLength(1);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith('/change-requests'),
      ),
    ).toBe(false);
  });

  it('reloads the requests after a refused start, so a request added meanwhile is explained', async () => {
    let requests: { status: string; revisionNumber: number }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/creatives/creative-1/workflows') && init?.method)
        return errorReply(
          409,
          'Save a new revision with the requested changes before resubmitting.',
        );
      if (url.endsWith('/change-requests')) return okReply(requests);
      if (url.endsWith('/workflows')) return okReply([workflow]);
      if (url.includes('/creatives?branchId=')) return okReply([atRevisionTwo]);
      if (url.endsWith('/creatives/creative-1/workflow'))
        return okReply(completed);
      return okReply([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    await openStart();
    await waitFor(() => expect(startButton()).toBeEnabled());
    requests = [{ status: 'OPEN', revisionNumber: 2 }];
    fireEvent.click(startButton());
    expect(await screen.findByText(explanation)).toBeInTheDocument();
    expect(startButton()).toBeDisabled();
  });
});

// Phase 2A Q4/Q5: Disable is confirmed first, and a run is described in
// words, with the raw identifiers kept for administrators.
describe('WorkflowWorkspace Phase 2A', () => {
  const manager: AuthenticatedUserResponse = {
    ...user,
    permissions: [...user.permissions, 'workflows:manage'],
  };
  // Running at Ready with an open task (Phase 2B: only a running run says
  // what it is waiting for).
  const reviewRun = {
    ...completed,
    status: 'RUNNING',
    tasks: [
      {
        id: 'task-2',
        status: 'OPEN',
        stage: stages[1],
        requiredPermission: 'approvals:decide',
      },
    ],
  };
  function serve() {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/workflows/workflow-1/disable'))
        return okReply({ ...workflow, status: 'DISABLED' });
      if (url.endsWith('/workflows')) return okReply([workflow]);
      if (url.endsWith('/workflows/workflow-1')) return okReply(workflow);
      if (url.includes('/creatives?branchId='))
        return okReply([
          { ...creative, currentRevision: { revisionNumber: 2 } },
        ]);
      if (url.endsWith('/creatives/creative-1/workflow'))
        return okReply(reviewRun);
      return okReply([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('describes the run in words and keeps raw details for administrators', async () => {
    serve();
    render(
      <WorkflowWorkspace
        session={{ accessToken: 'token', user: manager }}
        branch={branch}
        onUnauthorized={vi.fn()}
      />,
    );
    fireEvent.change(
      await screen.findByRole('combobox', { name: 'Branch creative' }),
      { target: { value: creative.id } },
    );
    expect(
      await screen.findByText(
        'This run is for revision 2, the current revision.',
      ),
    ).toBeInTheDocument();
    const waiting = screen.getByText(/^Waiting for:/);
    expect(waiting).toHaveTextContent(
      'Waiting for: Ready (anyone who can approve creatives)',
    );
    expect(waiting).not.toHaveTextContent('approvals:decide');
    expect(screen.getByText(/Start → Draft · Started/)).toBeInTheDocument();
    expect(screen.getByText(/Draft → Ready · Submit ·/)).toBeInTheDocument();
    const details = screen
      .getByText('Technical details for administrators')
      .closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(details).toHaveTextContent('revision-1');
    expect(details).toHaveTextContent('Ready: approvals:decide');
    expect(details).toHaveTextContent('START, submit');
  });

  it('describes an earlier revision and hides the raw details from non-managers', async () => {
    serve();
    vi.mocked(fetch).mockImplementation((async (url: string) => {
      if (url.includes('/creatives?branchId='))
        return okReply([
          {
            ...creative,
            currentRevisionId: 'revision-3',
            currentRevision: { revisionNumber: 3 },
          },
        ]);
      if (url.endsWith('/creatives/creative-1/workflow'))
        return okReply(reviewRun);
      if (url.endsWith('/workflows')) return okReply([workflow]);
      return okReply([]);
    }) as typeof fetch);
    render(
      <WorkflowWorkspace
        session={{ accessToken: 'token', user }}
        branch={branch}
        onUnauthorized={vi.fn()}
      />,
    );
    fireEvent.change(
      await screen.findByRole('combobox', { name: 'Branch creative' }),
      { target: { value: creative.id } },
    );
    expect(
      await screen.findByText(
        'This run is for an earlier revision; the creative has been changed since it started.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Technical details for administrators'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/revision-1/)).not.toBeInTheDocument();
  });

  // Missing data must not be described as a change to the creative.
  it.each([
    [
      'the current revision is unknown',
      { currentRevisionId: null, currentRevision: null },
      "This run is for the revision it started with. The creative's current revision isn't available right now, so it can't be compared.",
    ],
    [
      'the current revision number is missing',
      { currentRevisionId: 'revision-1', currentRevision: null },
      "This run is for the creative's current revision.",
    ],
  ])(
    'describes the run neutrally when %s',
    async (_case, revisionData, expected) => {
      serve();
      vi.mocked(fetch).mockImplementation((async (url: string) => {
        if (url.includes('/creatives?branchId='))
          return okReply([{ ...creative, ...revisionData }]);
        if (url.endsWith('/creatives/creative-1/workflow'))
          return okReply(reviewRun);
        if (url.endsWith('/workflows')) return okReply([workflow]);
        return okReply([]);
      }) as typeof fetch);
      render(
        <WorkflowWorkspace
          session={{ accessToken: 'token', user }}
          branch={branch}
          onUnauthorized={vi.fn()}
        />,
      );
      fireEvent.change(
        await screen.findByRole('combobox', { name: 'Branch creative' }),
        { target: { value: creative.id } },
      );
      expect(await screen.findByText(expected)).toBeInTheDocument();
      expect(
        screen.queryByText(/has been changed since it started/),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/revision-1/)).not.toBeInTheDocument();
    },
  );

  it('disables a workflow only after explaining the consequence', async () => {
    const fetchMock = serve();
    render(
      <WorkflowWorkspace
        session={{ accessToken: 'token', user: manager }}
        branch={null}
        onUnauthorized={vi.fn()}
      />,
    );
    fireEvent.change(
      await screen.findByRole('combobox', { name: 'Workflow definition' }),
      { target: { value: workflow.id } },
    );
    const disable = await screen.findByRole('button', { name: 'Disable' });
    fireEvent.click(disable);
    expect(disable).toHaveAttribute('aria-expanded', 'true');
    const group = screen.getByRole('group', {
      name: 'Confirm disabling Local workflow',
    });
    expect(group).toHaveTextContent(
      'Disable Local workflow? No new reviews can start with this workflow until it is enabled again. Reviews that are already running carry on.',
    );
    const disableCalls = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/disable'));
    fireEvent.click(
      within(group).getByRole('button', { name: 'Keep enabled' }),
    );
    expect(disableCalls()).toHaveLength(0);
    expect(
      screen.queryByRole('group', { name: /Confirm disabling/ }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    fireEvent.click(
      within(
        screen.getByRole('group', { name: /Confirm disabling/ }),
      ).getByRole('button', { name: 'Disable workflow' }),
    );
    expect(await screen.findByText('Workflow disabled.')).toBeInTheDocument();
    expect(disableCalls()).toHaveLength(1);
  });
});

// Phase 2B step 6: the run shown always belongs to the selected creative,
// its status is described in words with permission-aware actions, missing
// data has empty, loading and error states, and cancelling follows the
// shared confirmation pattern.
describe('WorkflowWorkspace Phase 2B step 6', () => {
  const second = { ...creative, id: 'creative-2', name: 'Summer post' };
  const managerUser: AuthenticatedUserResponse = {
    ...user,
    id: 'manager-1',
    permissions: [
      'workflows:read',
      'workflows:start',
      'workflows:transition',
      'workflows:manage',
      'creatives:read',
    ],
  };
  const reviewStage = {
    ...stages[1],
    id: 'stage-review',
    key: 'review',
    name: 'Review',
    isTerminal: false,
    requiresReview: true,
  };
  const atReview = {
    ...running,
    currentStage: reviewStage,
    tasks: [
      {
        id: 'task-r',
        status: 'OPEN',
        stage: reviewStage,
        requiredPermission: 'approvals:decide',
      },
    ],
  };
  const cancelled = {
    ...running,
    status: 'CANCELLED',
    tasks: [],
    history: [
      ...running.history,
      {
        id: 'history-cancel',
        actionKey: 'CANCEL',
        reason: 'Reviewer is away',
        createdAt: '2026-10-22T11:00:00Z',
        fromStage: stages[0],
        toStage: stages[0],
      },
    ],
  };
  type Reply = { status: number; body: unknown };

  // A stubbed API. Run replies come from `runs` (per creative), can be held
  // until released, or fail.
  function serve(
    options: {
      runs?: Record<string, unknown>;
      creatives?: unknown[];
      workflows?: unknown[];
      hold?: string[];
      fail?: string[];
      holdPaths?: string[];
    } = {},
  ) {
    const runs: Record<string, unknown> = {
      'creative-1': running,
      'creative-2': null,
      ...options.runs,
    };
    const hold = new Set(options.hold ?? []);
    const fail = new Set(options.fail ?? []);
    const heldPaths = new Set(options.holdPaths ?? []);
    const waiting = new Map<string, (() => void)[]>();
    const reply = ({ status, body }: Reply) =>
      status === 200
        ? okReply(body)
        : {
            ok: false,
            status,
            json: async () => ({ message: 'Server error' }),
            text: async () => JSON.stringify({ message: 'Server error' }),
          };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const run = /\/creatives\/([^/]+)\/workflow$/.exec(url);
      if (run) {
        const id = run[1]!;
        if (hold.has(id))
          await new Promise<void>((resolve) =>
            waiting.set(id, [...(waiting.get(id) ?? []), resolve]),
          );
        if (fail.has(id)) return reply({ status: 500, body: null });
        return reply({ status: 200, body: runs[id] ?? null });
      }
      const path = new URL(url).pathname;
      const heldPath = (options.holdPaths ?? []).find((held) =>
        path.endsWith(held),
      );
      if (heldPath && heldPaths.has(heldPath))
        await new Promise<void>((resolve) =>
          waiting.set(heldPath, [...(waiting.get(heldPath) ?? []), resolve]),
        );
      if (url.endsWith('/creatives/creative-1/workflows') && init?.method)
        return reply({ status: 200, body: running });
      if (url.endsWith('/workflow-instances/instance-1/transitions'))
        return reply({ status: 200, body: completed });
      if (url.endsWith('/workflows'))
        return reply({ status: 200, body: options.workflows ?? [workflow] });
      if (url.includes('/creatives?branchId='))
        return reply({
          status: 200,
          body: options.creatives ?? [creative, second],
        });
      return reply({ status: 200, body: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    return {
      fetchMock,
      runs,
      hold,
      fail,
      release(key: string) {
        hold.delete(key);
        heldPaths.delete(key);
        for (const resolve of waiting.get(key) ?? []) resolve();
        waiting.delete(key);
      },
      runCalls: (id: string) =>
        fetchMock.mock.calls.filter(([url]) =>
          String(url).endsWith(`/creatives/${id}/workflow`),
        ).length,
    };
  }
  function show(sessionUser: AuthenticatedUserResponse = managerUser) {
    render(
      <WorkflowWorkspace
        session={{ accessToken: 'token', user: sessionUser }}
        branch={branch}
        onUnauthorized={vi.fn()}
      />,
    );
  }
  async function choose(id: string) {
    fireEvent.change(
      await screen.findByRole('combobox', { name: 'Branch creative' }),
      { target: { value: id } },
    );
  }
  const loading = () => screen.queryByText("Loading this creative's workflow…");
  const noRun = () =>
    screen.queryByText('No workflow has been started for this creative yet.');
  const runHeading = () =>
    screen.queryByRole('heading', { level: 4, name: / · / });
  const button = (name: string | RegExp) =>
    screen.queryByRole('button', { name });

  describe('the run always belongs to the selected creative', () => {
    it("clears the previous creative's run and its actions while the next one loads", async () => {
      const api = serve({ hold: ['creative-2'] });
      show();
      await choose('creative-1');
      expect(
        await screen.findByRole('heading', { level: 4, name: / · / }),
      ).toHaveTextContent('Draft');
      expect(button('Cancel run')).toBeInTheDocument();
      expect(button('Submit')).toBeInTheDocument();

      await choose('creative-2');
      // At once: nothing of creative-1's run, and no action for it.
      expect(runHeading()).toBeNull();
      expect(button('Cancel run')).toBeNull();
      expect(button('Submit')).toBeNull();
      expect(button('Start workflow')).toBeNull();
      expect(screen.queryByText(/This run is for/)).toBeNull();
      expect(screen.queryByText(/^Waiting for/)).toBeNull();
      expect(loading()).toBeInTheDocument();

      api.release('creative-2');
      expect(
        await screen.findByText(
          'No workflow has been started for this creative yet.',
        ),
      ).toBeInTheDocument();
      expect(loading()).toBeNull();
      expect(button('Start workflow')).toBeInTheDocument();
    });

    it('ignores a slower reply for a creative that is no longer selected', async () => {
      const api = serve({
        runs: { 'creative-2': completed },
        hold: ['creative-1', 'creative-2'],
      });
      show();
      await choose('creative-1');
      await choose('creative-2');
      api.release('creative-2');
      expect(
        await screen.findByText(/^Finished at the Ready stage/),
      ).toBeInTheDocument();
      // creative-1's running run arrives last and is ignored.
      api.release('creative-1');
      await waitFor(() => expect(api.runCalls('creative-1')).toBe(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(
        screen.getByText(/^Finished at the Ready stage/),
      ).toBeInTheDocument();
      expect(button('Cancel run')).toBeNull();
      expect(runHeading()).toHaveTextContent('Ready');
    });

    it('shows a failed load inline with nothing about the run, and Try again reloads only the run', async () => {
      const api = serve({ fail: ['creative-1'] });
      show();
      await choose('creative-1');
      expect(
        await screen.findByText(
          "We couldn't load this creative's workflow, so nothing about it is shown. Please try again.",
        ),
      ).toHaveAttribute('role', 'alert');
      expect(runHeading()).toBeNull();
      expect(button('Cancel run')).toBeNull();
      expect(button('Start workflow')).toBeNull();
      expect(noRun()).toBeNull();
      const workflowListCalls = () =>
        api.fetchMock.mock.calls.filter(([url]) =>
          String(url).endsWith('/workflows'),
        ).length;
      const listsBefore = workflowListCalls();
      api.fail.delete('creative-1');
      fireEvent.click(button('Try again')!);
      expect(
        await screen.findByRole('heading', { level: 4, name: / · / }),
      ).toHaveTextContent('Draft');
      expect(api.runCalls('creative-1')).toBe(2);
      expect(workflowListCalls()).toBe(listsBefore);
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('clears a shown run when reloading it fails, instead of leaving it on screen', async () => {
      const api = serve();
      show();
      await choose('creative-1');
      await screen.findByRole('heading', { level: 4, name: / · / });
      // A failed cancellation reloads the run; that reload fails too.
      api.fetchMock.mockImplementation((async (url: string) => {
        if (url.endsWith('/cancel'))
          return {
            ok: false,
            status: 409,
            json: async () => ({ message: 'Workflow is not running' }),
            text: async () => '',
          };
        if (url.endsWith('/creatives/creative-1/workflow'))
          return {
            ok: false,
            status: 500,
            json: async () => ({}),
            text: async () => '',
          };
        return okReply([]);
      }) as never);
      fireEvent.click(button('Cancel run')!);
      fireEvent.change(
        screen.getByRole('textbox', {
          name: 'Reason for cancelling (required)',
        }),
        { target: { value: 'Stuck' } },
      );
      fireEvent.click(button('Confirm cancellation')!);
      expect(
        await screen.findByText(/We couldn't load this creative's workflow/),
      ).toBeInTheDocument();
      expect(runHeading()).toBeNull();
      expect(button('Cancel run')).toBeNull();
    });

    it('does not attach a started run to a creative chosen while starting', async () => {
      const api = serve({
        runs: { 'creative-1': null },
        holdPaths: ['/creatives/creative-1/workflows'],
      });
      show();
      await choose('creative-1');
      fireEvent.change(
        await screen.findByRole('combobox', { name: 'Workflow to start' }),
        { target: { value: 'workflow-1' } },
      );
      fireEvent.click(button('Start workflow')!);
      await choose('creative-2');
      await screen.findByText(
        'No workflow has been started for this creative yet.',
      );
      api.release('/creatives/creative-1/workflows');
      await waitFor(() =>
        expect(
          api.fetchMock.mock.calls.filter(
            ([url, init]) =>
              String(url).endsWith('/creatives/creative-1/workflows') &&
              (init as RequestInit | undefined)?.method === 'POST',
          ),
        ).toHaveLength(1),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(noRun()).toBeInTheDocument();
      expect(runHeading()).toBeNull();
      expect(
        screen.queryByText(
          'Workflow started against the selected creative revision.',
        ),
      ).toBeNull();
    });

    it('clears the creative and its run when the branch changes', async () => {
      serve();
      const view = render(
        <WorkflowWorkspace
          session={{ accessToken: 'token', user: managerUser }}
          branch={branch}
          onUnauthorized={vi.fn()}
        />,
      );
      await choose('creative-1');
      await screen.findByRole('heading', { level: 4, name: / · / });
      expect(button('Cancel run')).toBeInTheDocument();
      view.rerender(
        <WorkflowWorkspace
          session={{ accessToken: 'token', user: managerUser }}
          branch={{ ...branch, id: 'branch-2', name: 'South' }}
          onUnauthorized={vi.fn()}
        />,
      );
      // At once, before the new branch's creatives arrive.
      expect(runHeading()).toBeNull();
      expect(button('Cancel run')).toBeNull();
      expect(button('Submit')).toBeNull();
      expect(
        await screen.findByRole('combobox', { name: 'Branch creative' }),
      ).toHaveValue('');
      expect(runHeading()).toBeNull();
    });

    it('does not offer Start until the run is known', async () => {
      const api = serve({ runs: { 'creative-1': null }, hold: ['creative-1'] });
      show();
      await choose('creative-1');
      expect(loading()).toBeInTheDocument();
      expect(button('Start workflow')).toBeNull();
      api.release('creative-1');
      expect(
        await screen.findByRole('button', { name: 'Start workflow' }),
      ).toBeInTheDocument();
    });
  });

  describe('status in words and permission-aware actions', () => {
    it('says a review stage waits for a reviewer and links to Approvals', async () => {
      serve({ runs: { 'creative-1': atReview } });
      show({
        ...managerUser,
        permissions: [...managerUser.permissions, 'approvals:read'],
      });
      await choose('creative-1');
      const summary = await screen.findByText(
        /^Waiting for a reviewer's decision\./,
      );
      expect(summary).toHaveTextContent(
        "Waiting for a reviewer's decision. Reviewers record it in Approvals.",
      );
      expect(
        within(summary).getByRole('link', { name: 'Approvals' }),
      ).toHaveAttribute('href', '#approvals');
      // Decisions are made in Approvals, not with transition buttons here.
      expect(button('Submit')).toBeNull();
    });

    it('does not link to Approvals without permission to open it', async () => {
      serve({ runs: { 'creative-1': atReview } });
      show();
      await choose('creative-1');
      const summary = await screen.findByText(
        /^Waiting for a reviewer's decision\./,
      );
      expect(within(summary).queryByRole('link')).toBeNull();
    });

    it('describes a run in progress, a finished run and a cancelled run', async () => {
      const api = serve({
        runs: { 'creative-1': running, 'creative-2': completed },
      });
      show();
      await choose('creative-1');
      expect(
        await screen.findByText('In progress at the Draft stage.'),
      ).toBeInTheDocument();
      expect(screen.getByText(/^Waiting for:/)).toBeInTheDocument();

      await choose('creative-2');
      expect(
        await screen.findByText(
          `Finished at the Ready stage on ${new Date('2026-10-22T10:05:00Z').toLocaleString()}.`,
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/^Waiting for/)).toBeNull();
      expect(button('Cancel run')).toBeNull();

      api.runs['creative-2'] = cancelled;
      await choose('creative-1');
      await screen.findByText('In progress at the Draft stage.');
      await choose('creative-2');
      expect(
        await screen.findByText(
          `Cancelled at the Draft stage on ${new Date('2026-10-22T11:00:00Z').toLocaleString()}.`,
        ),
      ).toBeInTheDocument();
      expect(screen.getByText('Reason: Reviewer is away')).toBeInTheDocument();
      // A cancelled run offers no transitions, even from a stage that has them.
      expect(button('Submit')).toBeNull();
      expect(screen.queryByText(/^Waiting for/)).toBeNull();
    });

    it('explains, without permission codes, why a transition cannot be taken', async () => {
      const guarded = {
        ...running,
        version: {
          ...running.version,
          transitions: [
            {
              ...running.version.transitions[0]!,
              requiredPermission: 'workflows:manage',
            },
          ],
        },
      };
      serve({ runs: { 'creative-1': guarded } });
      show(user);
      await choose('creative-1');
      const submit = await screen.findByRole('button', { name: 'Submit' });
      expect(submit).toBeDisabled();
      expect(submit).toHaveAccessibleDescription(
        "Submit: You can't take this step: it is for a workflow manager.",
      );
      expect(screen.queryByText(/workflows:manage/)).toBeNull();
    });

    it('explains a step assigned to someone else, and leaves allowed steps undescribed', async () => {
      const assigned = {
        ...running,
        currentStage: { ...stages[0], assignedUserId: 'someone-else' },
      };
      const api = serve({ runs: { 'creative-1': assigned } });
      show(user);
      await choose('creative-1');
      const submit = await screen.findByRole('button', { name: 'Submit' });
      expect(submit).toHaveAccessibleDescription(
        "Submit: You can't take this step: it is assigned to someone else.",
      );
      api.runs['creative-2'] = running;
      await choose('creative-2');
      const allowed = await screen.findByRole('button', { name: 'Submit' });
      expect(allowed).toBeEnabled();
      expect(allowed).not.toHaveAttribute('aria-describedby');
    });
  });

  describe('empty states', () => {
    it('says the branch has no creatives yet and points to Creatives', async () => {
      serve({ creatives: [] });
      show();
      const empty = await screen.findByText(
        /^No creatives in this branch yet\./,
      );
      expect(
        within(empty).getByRole('link', { name: 'Creatives' }),
      ).toHaveAttribute('href', '#creatives');
      expect(
        screen.queryByRole('combobox', { name: 'Branch creative' }),
      ).toBeNull();
    });

    it('says when no workflow is enabled, instead of an empty choice', async () => {
      serve({
        runs: { 'creative-1': null },
        workflows: [{ ...workflow, status: 'DISABLED' }],
      });
      show();
      await choose('creative-1');
      expect(
        await screen.findByText(
          'No workflow is enabled yet. A workflow manager needs to enable one before this creative can be sent for review.',
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('combobox', { name: 'Workflow to start' }),
      ).toBeNull();
      expect(button('Start workflow')).toBeNull();
    });

    it('explains that starting needs permission to see workflows', async () => {
      serve({ runs: { 'creative-1': null } });
      show({ ...user, permissions: ['workflows:start', 'creatives:read'] });
      await choose('creative-1');
      expect(
        await screen.findByText(/You can't see the organization's workflows/),
      ).toBeInTheDocument();
    });

    it('says why Start is disabled until an enabled workflow is chosen', async () => {
      serve({ runs: { 'creative-1': null } });
      show();
      await choose('creative-1');
      const start = await screen.findByRole('button', {
        name: 'Start workflow',
      });
      expect(start).toBeDisabled();
      expect(start).toHaveAccessibleDescription(
        'Choose an enabled workflow to start.',
      );
      fireEvent.change(
        screen.getByRole('combobox', { name: 'Workflow to start' }),
        {
          target: { value: 'workflow-1' },
        },
      );
      expect(start).toBeEnabled();
      expect(start).not.toHaveAttribute('aria-describedby');
    });

    it('says a creative has no run yet, also to users who cannot start one', async () => {
      serve({ runs: { 'creative-1': null } });
      show({ ...user, permissions: ['workflows:read', 'creatives:read'] });
      await choose('creative-1');
      expect(
        await screen.findByText(
          'No workflow has been started for this creative yet.',
        ),
      ).toBeInTheDocument();
      expect(button('Start workflow')).toBeNull();
    });
  });

  describe('cancellation confirmation', () => {
    it('moves focus into the confirmation and back to Cancel run on Keep running', async () => {
      serve();
      show();
      await choose('creative-1');
      const cancel = await screen.findByRole('button', { name: 'Cancel run' });
      expect(cancel).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(cancel);
      const panel = screen.getByRole('group', { name: 'Cancel run' });
      expect(panel).toHaveClass('confirm-panel');
      expect(cancel).toHaveAttribute('aria-expanded', 'true');
      const reason = within(panel).getByRole('textbox', {
        name: 'Reason for cancelling (required)',
      });
      await waitFor(() => expect(reason).toHaveFocus());
      // The trigger stays in place while the confirmation is open.
      expect(screen.getByRole('button', { name: 'Cancel run' })).toBe(cancel);
      fireEvent.click(
        within(panel).getByRole('button', { name: 'Keep running' }),
      );
      expect(screen.queryByRole('group', { name: 'Cancel run' })).toBeNull();
      expect(cancel).toHaveFocus();
      expect(cancel).toHaveAttribute('aria-expanded', 'false');
    });

    it('says Cancelling… only while a cancellation is sent, not during other actions', async () => {
      const api = serve({
        holdPaths: ['/workflow-instances/instance-1/transitions'],
      });
      show();
      await choose('creative-1');
      fireEvent.click(
        await screen.findByRole('button', { name: 'Cancel run' }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
      const confirm = screen.getByRole('button', {
        name: /Confirm cancellation|Cancelling…/,
      });
      expect(confirm).toBeDisabled();
      expect(confirm).toHaveTextContent('Confirm cancellation');
      api.release('/workflow-instances/instance-1/transitions');
      await screen.findByText(/^Finished at the Ready stage/);
    });
  });
});
