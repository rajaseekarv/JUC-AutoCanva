// Post-Phase 3 hardening (fix 4): unsaved edits in Workflows, Brand & images
// and Templates are protected like Creatives: leaving the page gets the
// browser's confirmation and Sign out asks first, only while there are real
// unsaved edits. Moving between modules (which stay mounted) asks nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import App from './App';
import { SESSION_STORAGE_KEY } from './authStorage';

const BRANCHES = [{ id: 'branch-1', name: 'North', code: 'NORTH' }];
const manager = {
  id: 'user-1',
  organizationId: 'org-1',
  name: 'Mona Manager',
  email: 'mona@example.local',
  permissions: [
    'templates:read',
    'templates:edit',
    'brand:read',
    'brand:manage',
    'organizations:update',
    'workflows:read',
    'workflows:manage',
  ],
  branches: BRANCHES,
};
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
const WORKFLOW = {
  id: 'wf-1',
  name: 'Branch review',
  description: null,
  status: 'DRAFT',
  currentVersionNumber: 1,
  enabledVersionNumber: null,
  versions: [
    {
      id: 'wf-1-v1',
      versionNumber: 1,
      stages: [
        stage('draft', 'Draft', 0, { isEntry: true }),
        stage('done', 'Done', 1, { isTerminal: true }),
      ],
      transitions: [
        {
          id: 'tr-submit',
          key: 'submit',
          label: 'Submit',
          sourceStageId: 'st-draft',
          destinationStageId: 'st-done',
          requiredPermission: null,
          reviewDecision: null,
        },
      ],
    },
  ],
};
const TEMPLATE_VERSION = {
  id: 'tv-1',
  versionNumber: 1,
  name: 'Poster',
  description: null,
  category: null,
  formatName: 'Square',
  width: 1080,
  height: 1080,
  unit: 'PX',
  immutableAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  fields: [],
};
const TEMPLATE = {
  id: 'tpl-1',
  name: 'Poster',
  code: 'poster',
  description: 'Poster description',
  category: null,
  status: 'DRAFT',
  formatName: 'Square',
  width: 1080,
  height: 1080,
  unit: 'PX',
  currentVersionNumber: 1,
  activeVersionNumber: null,
  updatedAt: '2026-01-01T00:00:00Z',
  currentVersion: TEMPLATE_VERSION,
  versions: [TEMPLATE_VERSION],
};
const ORG_BRAND = {
  displayName: 'Acme',
  primaryColor: '#111111',
  secondaryColor: null,
  accentColor: null,
  fontFamily: 'Inter',
  websiteUrl: 'https://acme.example',
  logoAssetId: null,
};

function fakeApi() {
  const calls: string[] = [];
  const respond = (status: number, body: unknown) =>
    ({
      ok: status < 300,
      status,
      json: async () => body,
      text: async () => (body === null ? '' : JSON.stringify(body)),
    }) as Response;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const path = url.pathname.replace(/^\/api\/v1/, '');
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${path}`);
      if (path === '/health') return respond(200, { status: 'ok', checks: {} });
      if (path === '/auth/me') return respond(200, manager);
      if (path === '/auth/logout') return respond(204, null);
      if (path === '/branches/branch-1')
        return respond(200, { ...BRANCHES[0], status: 'ACTIVE' });
      if (path === '/notifications/unread-count')
        return respond(200, { count: 0 });
      if (path === '/workflows') return respond(200, [WORKFLOW]);
      if (path === '/templates') return respond(200, [TEMPLATE]);
      if (path === '/templates/tpl-1') return respond(200, TEMPLATE);
      if (path === '/organization/brand') return respond(200, ORG_BRAND);
      if (path === '/branches/branch-1/brand/effective')
        return respond(200, {
          ...ORG_BRAND,
          branchId: 'branch-1',
          overriddenFields: [],
        });
      return respond(200, method === 'GET' ? [] : {});
    }),
  );
  return calls;
}

beforeEach(() => {
  localStorage.setItem(
    SESSION_STORAGE_KEY,
    JSON.stringify({
      accessToken: 'token-1',
      expiresAt: Date.now() + 3600_000,
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

async function start(hash: string) {
  window.history.replaceState(null, '', '/' + hash);
  const calls = fakeApi();
  render(<App />);
  await screen.findByText('Hello, Mona Manager.');
  return calls;
}
async function navigate(hash: string) {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}
function leavingIsBlocked(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
const signOutButton = () => screen.getByRole('button', { name: 'Sign out' });
const signOutArea = () => signOutButton().parentElement as HTMLElement;
const signOutPanel = () => within(signOutArea()).queryByRole('group');

// Opens the workflow and renames its first stage (an unsaved edit).
async function editWorkflow() {
  const picker = await screen.findByRole('combobox', {
    name: 'Workflow definition',
  });
  await screen.findByRole('option', { name: /Branch review/ });
  fireEvent.change(picker, { target: { value: 'wf-1' } });
  const name = await screen.findByRole('textbox', {
    name: 'Name of stage Draft',
  });
  fireEvent.change(name, { target: { value: 'Draft copy' } });
}
// The renamed first stage's name field.
const workflowStageName = () =>
  screen.getByRole('textbox', {
    name: 'Name of stage Draft copy',
  }) as HTMLInputElement;

describe('Unsaved edits on other screens (hardening fix 4)', () => {
  it('asks nothing while no screen has unsaved edits', async () => {
    const calls = await start('#workflows');
    await screen.findByRole('combobox', { name: 'Workflow definition' });
    expect(leavingIsBlocked()).toBe(false);
    fireEvent.click(signOutButton());
    expect(
      screen.queryByRole('group', { name: /^Unsaved changes/ }),
    ).toBeNull();
    await waitFor(() => expect(calls).toContain('POST /auth/logout'));
  });

  it('protects unsaved workflow edits on leaving and signing out; Keep keeps them', async () => {
    const calls = await start('#workflows');
    await editWorkflow();
    expect(leavingIsBlocked()).toBe(true);
    fireEvent.click(signOutButton());
    const panel = signOutPanel()!;
    expect(panel).toHaveAccessibleName('Unsaved changes in Workflows');
    expect(panel).toHaveTextContent(
      'You have unsaved changes in Workflows. Signing out discards them.',
    );
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Keep my changes' }),
    );
    expect(signOutPanel()).toBeNull();
    expect(workflowStageName()).toHaveValue('Draft copy');
    expect(calls).not.toContain('POST /auth/logout');
  });

  it('stops asking once the workflow edits are discarded, then signs out at once', async () => {
    const calls = await start('#workflows');
    await editWorkflow();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(leavingIsBlocked()).toBe(false);
    fireEvent.click(signOutButton());
    expect(
      screen.queryByRole('group', { name: /^Unsaved changes/ }),
    ).toBeNull();
    await waitFor(() => expect(calls).toContain('POST /auth/logout'));
  });

  it('signs out after Discard changes and continue', async () => {
    const calls = await start('#workflows');
    await editWorkflow();
    fireEvent.click(signOutButton());
    fireEvent.click(
      within(signOutPanel()!).getByRole('button', {
        name: 'Discard changes and continue',
      }),
    );
    await waitFor(() => expect(calls).toContain('POST /auth/logout'));
    expect(calls.filter((call) => call === 'POST /auth/logout')).toHaveLength(
      1,
    );
  });

  it('asks nothing when moving between modules, and the edits are still there', async () => {
    await start('#workflows');
    await editWorkflow();
    await navigate('#templates');
    expect(screen.queryByRole('group', { name: /^Unsaved/ })).toBeNull();
    await navigate('#workflows');
    expect(workflowStageName()).toHaveValue('Draft copy');
  });

  it('protects organization brand edits, and stops when the value is changed back', async () => {
    await start('#brand-assets');
    // The shell opens Brand & images on the current branch; use the organization.
    const scope = await screen.findByRole('combobox', { name: 'Brand scope' });
    fireEvent.change(scope, { target: { value: '' } });
    const name = await screen.findByRole('textbox', { name: 'Display name' });
    await waitFor(() => expect(name).toHaveValue('Acme'));
    expect(leavingIsBlocked()).toBe(false);
    fireEvent.change(name, { target: { value: 'Acme Group' } });
    expect(leavingIsBlocked()).toBe(true);
    fireEvent.click(signOutButton());
    expect(signOutPanel()).toHaveTextContent(
      'You have unsaved changes in Brand & images.',
    );
    fireEvent.change(name, { target: { value: 'Acme' } });
    expect(leavingIsBlocked()).toBe(false);
    expect(signOutPanel()).toBeNull();
  });

  it('counts only real branch brand changes: typing the inherited value is not a change', async () => {
    await start('#brand-assets');
    const font = await screen.findByRole('textbox', { name: 'Font family' });
    await waitFor(() => expect(font).toHaveValue('Inter'));
    fireEvent.change(font, { target: { value: 'Inte' } });
    expect(leavingIsBlocked()).toBe(true);
    fireEvent.change(font, { target: { value: 'Inter' } });
    expect(leavingIsBlocked()).toBe(false);
  });

  it('protects template form edits, and names every screen with unsaved edits', async () => {
    await start('#templates');
    fireEvent.change(
      await screen.findByRole('combobox', { name: 'Choose template' }),
      { target: { value: 'tpl-1' } },
    );
    const details = await screen.findByRole('form', {
      name: 'Template details',
    });
    const name = within(details).getByRole('textbox', { name: 'Name' });
    expect(leavingIsBlocked()).toBe(false);
    fireEvent.change(name, { target: { value: 'Poster 2' } });
    expect(leavingIsBlocked()).toBe(true);
    await navigate('#workflows');
    await editWorkflow();
    fireEvent.click(signOutButton());
    expect(signOutPanel()).toHaveAccessibleName(
      'Unsaved changes in Workflows and Templates',
    );
    fireEvent.click(
      within(signOutPanel()!).getByRole('button', { name: 'Keep my changes' }),
    );
    await navigate('#templates');
    expect(within(details).getByRole('textbox', { name: 'Name' })).toHaveValue(
      'Poster 2',
    );
    fireEvent.change(name, { target: { value: 'Poster' } });
    await navigate('#workflows');
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(leavingIsBlocked()).toBe(false);
  });

  it('uses one page-leave handler however many screens have unsaved edits', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    await start('#templates');
    fireEvent.change(
      await screen.findByRole('combobox', { name: 'Choose template' }),
      { target: { value: 'tpl-1' } },
    );
    const details = await screen.findByRole('form', {
      name: 'Template details',
    });
    fireEvent.change(within(details).getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Poster 2' },
    });
    await navigate('#workflows');
    await editWorkflow();
    const handlers = add.mock.calls.filter(([type]) => type === 'beforeunload');
    expect(handlers).toHaveLength(1);
    expect(leavingIsBlocked()).toBe(true);
  });
});
