import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
      await screen.findByText('Workflow definition is valid.'),
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
