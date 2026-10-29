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
        return { ok: true, status: 200, json: async () => body, init };
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
    const fetchMock = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.endsWith('/validate')
          ? { valid: true, errors: [] }
          : url.endsWith('/workflows')
            ? [workflow]
            : { ...workflow, versions: workflow.versions },
    }));
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
