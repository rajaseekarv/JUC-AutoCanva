// Phase 3.1 regression tests (M2): Validate checks what is in the definition
// editor, and nothing (Validate, Refresh, a list reload, choosing another
// workflow) silently replaces unsaved JSON.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { AuthenticatedUserResponse } from '@adflow/shared-types';
import WorkflowWorkspace from './WorkflowWorkspace';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const user: AuthenticatedUserResponse = {
  id: 'user-1',
  organizationId: 'org-1',
  name: 'Manager',
  email: 'manager@example.local',
  permissions: ['workflows:read', 'workflows:manage'],
  branches: [],
};

const stage = (id: string, key: string, order: number) => ({
  id,
  key,
  name: key[0]!.toUpperCase() + key.slice(1),
  displayOrder: order,
  isEntry: key === 'draft',
  isTerminal: key === 'done',
  requiredPermission: null,
  assignedUserId: null,
  assignedPermission: null,
  requiresReview: false,
});
function workflow(id: string, name: string, versionNumber = 1) {
  return {
    id,
    name,
    description: null,
    status: 'DRAFT',
    currentVersionNumber: versionNumber,
    enabledVersionNumber: null,
    versions: [
      {
        id: id + '-v' + versionNumber,
        versionNumber,
        stages: [stage('s1', 'draft', 0), stage('s2', 'done', 1)],
        transitions: [
          {
            id: 't1',
            key: 'submit',
            label: 'Submit',
            sourceStageId: 's1',
            destinationStageId: 's2',
            requiredPermission: null,
            reviewDecision: null,
          },
        ],
      },
    ],
  };
}

function reply(status: number, body?: unknown): Response {
  const text = body === undefined || body === null ? '' : JSON.stringify(body);
  return {
    ok: status < 300,
    status,
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
  } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

type Write = { method: string; path: string; body: string | null };
type Route = (method: string, path: string) => Promise<Response> | undefined;

// `list` is what GET /workflows returns now; tests change it to simulate a
// version saved elsewhere.
function stubApi(route: Route = () => undefined) {
  const state = {
    list: [workflow('wf-1', 'Saved workflow'), workflow('wf-2', 'Other')],
  };
  const writes: Write[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname.replace(/^\/api\/v1/, '');
      const method = init?.method ?? 'GET';
      if (method !== 'GET')
        writes.push({
          method,
          path,
          body: typeof init?.body === 'string' ? init.body : null,
        });
      const routed = route(method, path);
      if (routed) return routed;
      if (path === '/workflows' && method === 'GET')
        return reply(200, structuredClone(state.list));
      if (path.endsWith('/validate'))
        return reply(200, { valid: true, errors: [] });
      return reply(200, []);
    }),
  );
  return { state, writes };
}

function renderWorkspace() {
  render(
    <WorkflowWorkspace
      session={{ accessToken: 'token', user }}
      branch={null}
      onUnauthorized={vi.fn()}
    />,
  );
}

const editor = () =>
  screen.getByRole('textbox', {
    name: 'Workflow definition JSON',
  }) as HTMLTextAreaElement;
const picker = () =>
  screen.getByRole('combobox', { name: 'Workflow definition' });

async function openWorkflow(id = 'wf-1', name = 'Saved workflow') {
  await screen.findByRole('option', { name: new RegExp(name) });
  fireEvent.change(picker(), { target: { value: id } });
  await waitFor(() => expect(editor().value).toContain(`"name": "${name}"`));
}

function edit(from: string, to: string) {
  fireEvent.change(editor(), {
    target: { value: editor().value.replace(from, to) },
  });
}

describe('WorkflowWorkspace definition editor (M2)', () => {
  it('checks the edited JSON, not the saved version, and keeps the edits (probe D)', async () => {
    const { writes } = stubApi();
    renderWorkspace();
    await openWorkflow();
    edit('Saved workflow', 'EDITED NOT SAVED');
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    const result = await screen.findByRole('status');
    expect(result).toHaveTextContent(/unsaved edits/i);
    expect(result).toHaveTextContent(/2 stages and 1 transition/);
    expect(result).toHaveTextContent(
      /follow the workflow rules.*The API checks them again when you save/i,
    );
    // The saved version's validate endpoint is not called: its answer would
    // describe a different definition.
    expect(writes).toHaveLength(0);
    expect(editor().value).toContain('EDITED NOT SAVED');
  });

  it('reports a JSON syntax error in the edits without sending anything', async () => {
    const { writes } = stubApi();
    renderWorkspace();
    await openWorkflow();
    edit('"stages": [', '"stages": [,');
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /isn't valid JSON/,
    );
    expect(writes).toHaveLength(0);
    expect(editor().value).toContain('"stages": [,');
  });

  it('reports a definition without stages', async () => {
    stubApi();
    renderWorkspace();
    await openWorkflow();
    fireEvent.change(editor(), {
      target: { value: JSON.stringify({ name: 'x', transitions: [] }) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /"stages" must be a list/,
    );
  });

  it('validates the saved version through the API when the editor matches it, and shows problems as an error', async () => {
    const { writes } = stubApi((_method, path) =>
      path.endsWith('/validate')
        ? Promise.resolve(
            reply(200, {
              valid: false,
              errors: ['A workflow must have exactly one entry stage.'],
            }),
          )
        : undefined,
    );
    renderWorkspace();
    await openWorkflow();
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Saved version 1 has problems/);
    expect(alert).toHaveTextContent(
      'A workflow must have exactly one entry stage.',
    );
    expect(writes).toEqual([
      { method: 'POST', path: '/workflows/wf-1/validate', body: null },
    ]);
  });

  it('keeps unsaved edits through Refresh and marks them as unsaved', async () => {
    stubApi();
    renderWorkspace();
    await openWorkflow();
    edit('Saved workflow', 'EDITED AGAIN');
    expect(screen.getByText(/You have unsaved changes/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(editor().value).toContain('EDITED AGAIN');
    expect(screen.getByText(/You have unsaved changes/)).toBeInTheDocument();
  });

  it('keeps edits typed while a reload was in flight', async () => {
    let listCalls = 0;
    const lateList = deferred<Response>();
    stubApi((method, path) => {
      if (method !== 'GET' || path !== '/workflows') return undefined;
      listCalls += 1;
      return listCalls === 2 ? lateList.promise : undefined;
    });
    renderWorkspace();
    await openWorkflow();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    edit('Saved workflow', 'TYPED DURING RELOAD');
    await act(async () =>
      lateList.resolve(reply(200, [workflow('wf-1', 'Saved workflow')])),
    );
    expect(editor().value).toContain('TYPED DURING RELOAD');
  });

  it('loads a newer saved version into a clean editor on Refresh', async () => {
    const { state } = stubApi();
    renderWorkspace();
    await openWorkflow();
    state.list = [workflow('wf-1', 'Saved elsewhere', 2)];
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(editor().value).toContain('"name": "Saved elsewhere"'),
    );
    expect(screen.queryByText(/You have unsaved changes/)).toBeNull();
  });

  it('keeps edits when a newer version was saved elsewhere, and says so', async () => {
    const { state } = stubApi();
    renderWorkspace();
    await openWorkflow();
    edit('Saved workflow', 'MY EDIT');
    state.list = [workflow('wf-1', 'Saved elsewhere', 2)];
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(
      await screen.findByText(/saved again \(version 2\)/),
    ).toBeInTheDocument();
    expect(editor().value).toContain('MY EDIT');
  });

  it('asks before another workflow replaces unsaved edits; Keep leaves everything as it was', async () => {
    stubApi();
    renderWorkspace();
    await openWorkflow();
    edit('Saved workflow', 'MY EDIT');
    fireEvent.change(picker(), { target: { value: 'wf-2' } });
    const confirm = screen.getByRole('group', {
      name: 'Unsaved workflow definition',
    });
    expect(picker()).toHaveValue('wf-1');
    fireEvent.click(
      within(confirm).getByRole('button', { name: 'Keep editing' }),
    );
    expect(
      screen.queryByRole('group', { name: 'Unsaved workflow definition' }),
    ).toBeNull();
    expect(picker()).toHaveValue('wf-1');
    expect(editor().value).toContain('MY EDIT');
  });

  it('opens the other workflow once the user discards the edits', async () => {
    stubApi();
    renderWorkspace();
    await openWorkflow();
    edit('Saved workflow', 'MY EDIT');
    fireEvent.change(picker(), { target: { value: 'wf-2' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Discard edits and switch' }),
    );
    expect(picker()).toHaveValue('wf-2');
    await waitFor(() => expect(editor().value).toContain('"name": "Other"'));
    expect(screen.queryByText(/You have unsaved changes/)).toBeNull();
  });

  it('switches without asking when the editor has no unsaved edits', async () => {
    stubApi();
    renderWorkspace();
    await openWorkflow();
    fireEvent.change(picker(), { target: { value: 'wf-2' } });
    expect(
      screen.queryByRole('group', { name: 'Unsaved workflow definition' }),
    ).toBeNull();
    await waitFor(() => expect(editor().value).toContain('"name": "Other"'));
  });

  it('keeps the edits and explains a failed save', async () => {
    const { writes } = stubApi((method) =>
      method === 'PATCH'
        ? Promise.resolve(
            reply(400, { message: ['Duplicate stage key: draft.'] }),
          )
        : undefined,
    );
    renderWorkspace();
    await openWorkflow();
    edit('Saved workflow', 'MY EDIT');
    fireEvent.click(screen.getByRole('button', { name: 'Save new version' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Duplicate stage key: draft.');
    expect(alert).toHaveTextContent(
      /Nothing was saved; your edits are still in the editor/,
    );
    expect(writes).toHaveLength(1);
    expect(editor().value).toContain('MY EDIT');
    expect(screen.getByText(/You have unsaved changes/)).toBeInTheDocument();
  });

  it('refuses to save JSON it cannot read, and keeps it', async () => {
    const { writes } = stubApi();
    renderWorkspace();
    await openWorkflow();
    edit('"stages": [', '"stages": [,');
    fireEvent.click(screen.getByRole('button', { name: 'Save new version' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /isn't valid JSON/,
    );
    expect(writes).toHaveLength(0);
    expect(editor().value).toContain('"stages": [,');
  });

  it('shows the saved definition as clean after a successful save', async () => {
    stubApi((method) =>
      method === 'PATCH'
        ? Promise.resolve(reply(200, workflow('wf-1', 'MY EDIT', 2)))
        : undefined,
    );
    renderWorkspace();
    await openWorkflow();
    edit('Saved workflow', 'MY EDIT');
    fireEvent.click(screen.getByRole('button', { name: 'Save new version' }));
    await screen.findByText('A new editable workflow version was saved.');
    expect(editor().value).toContain('"name": "MY EDIT"');
    expect(screen.queryByText(/You have unsaved changes/)).toBeNull();
  });

  it('restores the saved definition with Discard changes', async () => {
    stubApi();
    renderWorkspace();
    await openWorkflow();
    edit('Saved workflow', 'MY EDIT');
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(editor().value).toContain('"name": "Saved workflow"');
    expect(screen.queryByText(/You have unsaved changes/)).toBeNull();
  });
});
