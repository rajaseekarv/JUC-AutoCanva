// Phase 3.5: the structured workflow editor in the Workflows screen.
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
const PEOPLE = [
  { id: 'u-meera', name: 'Meera', email: 'meera@example.local' },
  { id: 'u-priya', name: 'Priya', email: 'priya@example.local' },
];
const stage = (key: string, name: string, order: number, extra = {}) => ({
  id: 'st-' + key,
  key,
  name,
  displayOrder: order,
  isEntry: false,
  isTerminal: false,
  requiredPermission: null,
  assignedUserId: null,
  assignedPermission: null,
  requiresReview: false,
  ...extra,
});
const step = (
  key: string,
  label: string,
  from: string,
  to: string,
  extra = {},
) => ({
  id: 'tr-' + key,
  key,
  label,
  sourceStageId: 'st-' + from,
  destinationStageId: 'st-' + to,
  requiredPermission: null,
  reviewDecision: null,
  ...extra,
});
function workflow(id: string, name: string, status: string, reviewer: string) {
  return {
    id,
    name,
    description: null,
    status,
    currentVersionNumber: 3,
    enabledVersionNumber: status === 'ENABLED' ? 3 : null,
    versions: [
      {
        id: id + '-v3',
        versionNumber: 3,
        stages: [
          stage('draft', 'Draft', 0, { isEntry: true }),
          stage('review', 'Review', 1, {
            requiresReview: true,
            assignedUserId: reviewer,
          }),
          stage('approved', 'Approved', 2, { isTerminal: true }),
          stage('changes', 'Changes needed', 3, { isTerminal: true }),
        ],
        transitions: [
          step('submit', 'Submit', 'draft', 'review', {
            requiredPermission: 'legacy:custom-permission',
          }),
          step('approve', 'Approve', 'review', 'approved', {
            reviewDecision: 'APPROVED',
          }),
          step('request_changes', 'Request changes', 'review', 'changes', {
            reviewDecision: 'CHANGES_REQUESTED',
          }),
        ],
      },
    ],
  };
}
const ENABLED = workflow('wf-1', 'Branch review', 'ENABLED', 'u-priya');
const GONE = workflow('wf-2', 'Old review', 'DRAFT', 'u-gone');

function reply(status: number, body?: unknown): Response {
  const text = body === undefined ? '' : JSON.stringify(body);
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
type Write = { method: string; path: string; body: unknown };
type Route = (method: string, path: string) => Promise<Response> | undefined;
function stubApi(route: Route = () => undefined) {
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
          body: init?.body ? (JSON.parse(String(init.body)) as unknown) : null,
        });
      const routed = route(method, path);
      if (routed) return routed;
      if (path === '/workflows') return reply(200, [ENABLED, GONE]);
      if (path === '/workflows/assignable-users') return reply(200, PEOPLE);
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as { name: string };
        return reply(200, {
          ...ENABLED,
          name: body.name,
          status: 'DRAFT',
          currentVersionNumber: 4,
          enabledVersionNumber: null,
        });
      }
      return reply(200, []);
    }),
  );
  return writes;
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
const json = () =>
  (
    screen.getByRole('textbox', {
      name: 'Workflow definition JSON',
    }) as HTMLTextAreaElement
  ).value;
const definition = () =>
  JSON.parse(json()) as {
    name: string;
    stages: Record<string, unknown>[];
    transitions: Record<string, unknown>[];
  };
const card = (name: string) =>
  within(screen.getByRole('listitem', { name: 'Stage ' + name }));
const unsaved = () => screen.queryByText(/You have unsaved changes/);

async function open(id = 'wf-1', name = 'Branch review') {
  await screen.findByRole('option', { name: new RegExp(name) });
  fireEvent.change(
    screen.getByRole('combobox', { name: 'Workflow definition' }),
    { target: { value: id } },
  );
  await waitFor(() => expect(definition().name).toBe(name));
}

describe('Structured workflow editor (Phase 3.5)', () => {
  it('shows the saved workflow as stage cards without changing the definition', async () => {
    stubApi();
    renderWorkspace();
    await open();
    const original = json();
    const names = screen
      .getAllByRole('listitem', { name: /^Stage / })
      .map((item) => item.getAttribute('aria-label'));
    expect(names).toEqual([
      'Stage Draft',
      'Stage Review',
      'Stage Approved',
      'Stage Changes needed',
    ]);
    await waitFor(() =>
      expect(
        card('Review').getByRole('combobox', { name: 'Person for Review' }),
      ).toHaveDisplayValue('Priya · priya@example.local'),
    );
    expect(
      card('Draft').getByRole('combobox', {
        name: 'Permission for step Submit',
      }),
    ).toHaveDisplayValue(
      'Other permission (legacy:custom-permission) (kept as saved)',
    );
    expect(json()).toBe(original);
    expect(unsaved()).toBeNull();
    expect(
      screen.getByText(/No problems found in the form/),
    ).toBeInTheDocument();
  });

  it('renames a stage without changing its key, so its steps stay connected', async () => {
    stubApi();
    renderWorkspace();
    await open();
    fireEvent.change(
      card('Review').getByRole('textbox', { name: 'Name of stage Review' }),
      { target: { value: 'Legal review' } },
    );
    const review = definition().stages[1]!;
    expect(review).toMatchObject({ key: 'review', name: 'Legal review' });
    expect(
      definition().transitions.filter((item) => item.from === 'review'),
    ).toHaveLength(2);
    expect(
      card('Legal review').getAllByRole('textbox', { name: /^Label of step/ }),
    ).toHaveLength(2);
    expect(unsaved()).toBeInTheDocument();
  });

  it('moves a stage by swapping positions with its neighbour, keeping steps connected', async () => {
    stubApi();
    renderWorkspace();
    await open();
    const before = definition().transitions;
    fireEvent.click(
      card('Changes needed').getByRole('button', {
        name: 'Move Changes needed up',
      }),
    );
    expect(
      definition().stages.map((item) => [item.key, item.displayOrder]),
    ).toEqual([
      ['draft', 0],
      ['review', 1],
      ['approved', 3],
      ['changes', 2],
    ]);
    expect(definition().transitions).toEqual(before);
    expect(
      screen
        .getAllByRole('listitem', { name: /^Stage / })
        .map((item) => item.getAttribute('aria-label'))
        .slice(2),
    ).toEqual(['Stage Changes needed', 'Stage Approved']);
  });

  it('adds a stage with a key from its name and explains what it still needs', async () => {
    stubApi();
    renderWorkspace();
    await open();
    fireEvent.change(screen.getByRole('textbox', { name: 'New stage name' }), {
      target: { value: 'Legal check' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add stage' }));
    expect(definition().stages.at(-1)).toMatchObject({
      key: 'legal_check',
      name: 'Legal check',
      displayOrder: 4,
    });
    const legal = card('Legal check');
    expect(legal.getByText(/Key: legal_check/)).toBeInTheDocument();
    expect(
      legal.getByText(
        'Add a step out of this stage, or make it a finishing stage.',
      ),
    ).toBeInTheDocument();
    expect(
      legal.getByText('No step leads here from the starting stage Draft.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/2 problems shown above/)).toBeInTheDocument();
  });

  it('asks before removing a stage, and removing it also removes its steps', async () => {
    stubApi();
    renderWorkspace();
    await open();
    fireEvent.click(
      card('Approved').getByRole('button', { name: 'Remove stage Approved' }),
    );
    const confirm = screen.getByRole('group', {
      name: 'Confirm removing Approved',
    });
    expect(confirm).toHaveTextContent(
      'This also removes the 1 step into or out of it.',
    );
    fireEvent.click(
      within(confirm).getByRole('button', { name: 'Keep stage' }),
    );
    expect(definition().stages).toHaveLength(4);
    fireEvent.click(
      card('Approved').getByRole('button', { name: 'Remove stage Approved' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove stage and its steps' }),
    );
    expect(definition().stages.map((item) => item.key)).toEqual([
      'draft',
      'review',
      'changes',
    ]);
    expect(definition().transitions.map((item) => item.key)).toEqual([
      'submit',
      'request_changes',
    ]);
    expect(
      card('Review').getByText(
        'A review needs one step for reviewers who approve.',
      ),
    ).toBeInTheDocument();
    // The form offers to add the missing decision step.
    fireEvent.click(
      card('Review').getByRole('button', {
        name: 'Add the missing review steps for Review',
      }),
    );
    expect(definition().transitions.at(-1)).toMatchObject({
      key: 'approve',
      from: 'review',
      reviewDecision: 'APPROVED',
    });
  });

  it('edits a step: destination, review decision and label', async () => {
    stubApi();
    renderWorkspace();
    await open();
    const review = card('Review');
    fireEvent.change(
      review.getByRole('combobox', { name: 'Destination of step Approve' }),
      { target: { value: 'changes' } },
    );
    fireEvent.change(
      review.getByRole('combobox', { name: 'Review decision of step Approve' }),
      { target: { value: '' } },
    );
    fireEvent.change(
      review.getByRole('textbox', { name: 'Label of step Approve' }),
      { target: { value: 'Sign off' } },
    );
    expect(definition().transitions[1]).toEqual({
      key: 'approve',
      label: 'Sign off',
      from: 'review',
      to: 'changes',
      requiredPermission: null,
      reviewDecision: null,
    });
    expect(
      card('Review').getByText(
        'Every step out of a review must be for approving or for requesting changes.',
      ),
    ).toBeInTheDocument();
  });

  it('picks a reviewer by name, or a permission, and never picks someone for the user', async () => {
    stubApi();
    renderWorkspace();
    await open();
    const person = () =>
      card('Review').getByRole('combobox', { name: 'Person for Review' });
    await waitFor(() =>
      expect(person()).toHaveDisplayValue('Priya · priya@example.local'),
    );
    expect(
      card('Review').getByText(/must also have access to each branch/),
    ).toBeInTheDocument();
    fireEvent.change(person(), { target: { value: 'u-meera' } });
    expect(definition().stages[1]).toMatchObject({
      assignedUserId: 'u-meera',
      assignedPermission: null,
    });
    fireEvent.click(
      card('Review').getByRole('radio', { name: 'Everyone with a permission' }),
    );
    expect(definition().stages[1]).toMatchObject({
      assignedUserId: null,
      assignedPermission: 'approvals:decide',
    });
    fireEvent.click(card('Review').getByRole('radio', { name: 'One person' }));
    expect(definition().stages[1]).toMatchObject({
      assignedUserId: null,
      assignedPermission: null,
    });
    expect(person()).toHaveDisplayValue('Choose a person');
    expect(
      card('Review').getByText(
        'Choose who reviews this stage: one person, or everyone with a permission.',
      ),
    ).toBeInTheDocument();
  });

  it('keeps an unavailable saved reviewer, says so, and does not replace them', async () => {
    stubApi();
    renderWorkspace();
    await open('wf-2', 'Old review');
    await waitFor(() =>
      expect(
        card('Review').getByRole('combobox', { name: 'Person for Review' }),
      ).toHaveDisplayValue('Unavailable person (not an active user)'),
    );
    expect(
      card('Review').getByText(/not an active user of this organization/),
    ).toBeInTheDocument();
    fireEvent.change(
      card('Draft').getByRole('textbox', { name: 'Name of stage Draft' }),
      { target: { value: 'Draft copy' } },
    );
    expect(definition().stages[1]).toMatchObject({ assignedUserId: 'u-gone' });
  });

  it('keeps the saved reviewer while people load slowly, and when they cannot be loaded', async () => {
    const people = deferred<Response>();
    let fail = true;
    stubApi((_method, path) => {
      if (path !== '/workflows/assignable-users') return undefined;
      if (fail) {
        fail = false;
        return people.promise;
      }
      return undefined;
    });
    renderWorkspace();
    await open();
    const person = () =>
      card('Review').getByRole('combobox', { name: 'Person for Review' });
    expect(person()).toHaveDisplayValue('Loading people…');
    expect(definition().stages[1]).toMatchObject({ assignedUserId: 'u-priya' });
    await act(async () => people.resolve(reply(500, { message: 'down' })));
    expect(person()).toHaveDisplayValue(
      'Saved person (people could not be loaded)',
    );
    expect(definition().stages[1]).toMatchObject({ assignedUserId: 'u-priya' });
    fireEvent.click(card('Review').getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(person()).toHaveDisplayValue('Priya · priya@example.local'),
    );
  });

  it('asks before saving an enabled workflow, which takes it offline', async () => {
    const writes = stubApi();
    renderWorkspace();
    await open();
    expect(
      screen.getByText(/takes this workflow offline until it is enabled again/),
    ).toBeInTheDocument();
    fireEvent.change(
      card('Review').getByRole('textbox', { name: 'Name of stage Review' }),
      { target: { value: 'Legal review' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save new version' }));
    const confirm = screen.getByRole('group', {
      name: 'Confirm saving Branch review',
    });
    expect(confirm).toHaveTextContent(
      'Saving creates version 4 and takes Branch review offline: no new reviews can start with it until you enable it again.',
    );
    fireEvent.click(
      within(confirm).getByRole('button', { name: 'Keep editing' }),
    );
    expect(writes).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Save new version' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Save and take offline' }),
    );
    expect(
      await screen.findByText(
        'A new editable workflow version was saved. Branch review is now a draft: enable it again so new reviews can start.',
      ),
    ).toBeInTheDocument();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      method: 'PATCH',
      path: '/workflows/wf-1',
    });
    expect(
      (writes[0]!.body as { stages: { name: string }[] }).stages[1]?.name,
    ).toBe('Legal review');
  });

  it('saves a draft workflow without asking, and keeps the edits when the save fails', async () => {
    let fail = true;
    const writes = stubApi((method) =>
      method === 'PATCH' && fail
        ? Promise.resolve(
            reply(400, {
              message: ['Stage assignee must be an active organization user'],
            }),
          )
        : undefined,
    );
    renderWorkspace();
    await open('wf-2', 'Old review');
    fireEvent.change(
      card('Draft').getByRole('textbox', { name: 'Name of stage Draft' }),
      { target: { value: 'Draft copy' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save new version' }));
    expect(screen.queryByRole('group', { name: /^Confirm saving/ })).toBeNull();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Stage assignee must be an active organization user. Nothing was saved; your edits are still in the editor.',
    );
    expect(definition().stages[0]).toMatchObject({ name: 'Draft copy' });
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Save new version' }));
    await screen.findByText('A new editable workflow version was saved.');
    expect(writes).toHaveLength(2);
  });

  it('Validate reports the rules the API would refuse, from the form edits', async () => {
    const writes = stubApi();
    renderWorkspace();
    await open();
    fireEvent.click(
      card('Approved').getByRole('checkbox', { name: /Finishing stage/ }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Your unsaved edits have \d+ problems? the API would refuse/,
    );
    expect(writes).toHaveLength(0);
  });

  it('shares the same unsaved definition with the Advanced JSON view', async () => {
    stubApi();
    renderWorkspace();
    await open();
    const textarea = screen.getByRole('textbox', {
      name: 'Workflow definition JSON',
    });
    fireEvent.change(textarea, {
      target: {
        value: json().replace('"name": "Approved"', '"name": "Signed off"'),
      },
    });
    expect(
      screen.getByRole('listitem', { name: 'Stage Signed off' }),
    ).toBeInTheDocument();
    fireEvent.change(textarea, { target: { value: json() + ',' } });
    expect(
      screen.getByText(/The definition isn't valid JSON\./),
    ).toBeInTheDocument();
    expect(screen.queryByRole('listitem', { name: /^Stage / })).toBeNull();
    fireEvent.change(textarea, { target: { value: json().slice(0, -1) } });
    expect(
      screen.getByRole('listitem', { name: 'Stage Signed off' }),
    ).toBeInTheDocument();
  });

  it('asks before another workflow replaces unsaved form edits', async () => {
    stubApi();
    renderWorkspace();
    await open();
    fireEvent.change(
      card('Review').getByRole('textbox', { name: 'Name of stage Review' }),
      { target: { value: 'Legal review' } },
    );
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Workflow definition' }),
      { target: { value: 'wf-2' } },
    );
    expect(
      screen.getByRole('group', { name: 'Unsaved workflow definition' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(definition().stages[1]).toMatchObject({ name: 'Legal review' });
  });
});

// Hardening fix 1: the editor starts fresh for each workflow.
describe('Structured workflow editor: switching workflows', () => {
  it('does not carry an open confirmation, a pending choice or a half-typed stage into another workflow', async () => {
    stubApi();
    renderWorkspace();
    await open();
    // An open Remove confirmation, a pending "One person" choice and a
    // half-typed new stage, none of which changes the definition.
    fireEvent.click(
      card('Review').getByRole('button', { name: 'Remove stage Review' }),
    );
    expect(
      screen.getByRole('group', { name: 'Confirm removing Review' }),
    ).toBeInTheDocument();
    fireEvent.click(card('Draft').getByRole('radio', { name: 'One person' }));
    expect(
      card('Draft').getByRole('combobox', { name: 'Person for Draft' }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'New stage name' }), {
      target: { value: 'Half typed' },
    });
    expect(unsaved()).toBeNull();
    // Another workflow with stages of the same keys.
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Workflow definition' }),
      { target: { value: 'wf-2' } },
    );
    await waitFor(() => expect(definition().name).toBe('Old review'));
    expect(
      screen.queryByRole('group', { name: 'Confirm removing Review' }),
    ).toBeNull();
    expect(
      card('Draft').getByRole('radio', {
        name: 'Anyone allowed to take its steps',
      }),
    ).toBeChecked();
    expect(
      card('Draft').queryByRole('combobox', { name: 'Person for Draft' }),
    ).toBeNull();
    expect(screen.getByRole('textbox', { name: 'New stage name' })).toHaveValue(
      '',
    );
    expect(unsaved()).toBeNull();
  });
});
