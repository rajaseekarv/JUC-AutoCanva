// Phase 3.1 regression tests (C1, M3): form values always belong to the
// template on screen, and a field edit stays open until it is saved.
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
import type {
  AuthenticatedUserResponse,
  TemplateResponse,
} from '@adflow/shared-types';
import TemplateManager from './TemplateManager';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const user: AuthenticatedUserResponse = {
  id: 'user-1',
  organizationId: 'org-1',
  name: 'Admin',
  email: 'admin@example.local',
  permissions: ['templates:read', 'templates:edit'],
  branches: [],
};

function template(id: string, name: string): TemplateResponse {
  const version = {
    id: 'version-' + id,
    versionNumber: 1,
    name,
    description: null,
    category: null,
    formatName: 'Square',
    width: 1080,
    height: 1080,
    unit: 'PX' as const,
    immutableAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    fields: [
      {
        id: 'field-' + id,
        key: 'headline',
        label: name + ' headline',
        type: 'TEXT' as const,
        required: true,
        defaultValue: null,
        validationRules: null,
        helpText: null,
        displayOrder: 0,
        dataSource: null,
        sourceKey: null,
      },
    ],
  };
  return {
    id,
    name,
    code: id,
    description: name + ' description',
    category: name + ' category',
    status: 'DRAFT',
    formatName: 'Square',
    width: 1080,
    height: 1080,
    unit: 'PX',
    currentVersionNumber: 1,
    activeVersionNumber: null,
    updatedAt: '2026-01-01T00:00:00Z',
    currentVersion: version,
    versions: [version],
  } as TemplateResponse;
}

const ALPHA = template('tpl-a', 'Alpha');
const BRAVO = template('tpl-b', 'Bravo');

function reply(status: number, body?: unknown): Response {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    ok: status < 300,
    status,
    // Like a real response, an empty body is not JSON.
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

// A fake API: GETs return the fixtures unless `route` answers first; every
// other method is recorded and answered by `route` or with 200.
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
      if (method !== 'GET') return reply(200, {});
      if (path === '/templates') return reply(200, [ALPHA, BRAVO]);
      if (path === '/templates/tpl-a') return reply(200, ALPHA);
      if (path === '/templates/tpl-b') return reply(200, BRAVO);
      return reply(404, { message: 'Not found' });
    }),
  );
  return writes;
}

function renderManager() {
  render(
    <TemplateManager
      session={{ accessToken: 'token', user }}
      onUnauthorized={vi.fn()}
    />,
  );
}

async function choose(id: string, heading?: string) {
  fireEvent.change(
    await screen.findByRole('combobox', { name: 'Choose template' }),
    { target: { value: id } },
  );
  if (heading) await screen.findByRole('heading', { name: heading });
}

const detailsForm = () =>
  screen.getByRole('form', { name: 'Template details' });
const nameBox = () =>
  within(detailsForm()).getByRole('textbox', {
    name: 'Name',
  }) as HTMLInputElement;
const addFieldForm = () => screen.getByRole('form', { name: 'Add field' });

describe('TemplateManager record switching (C1)', () => {
  it('shows each template its own details after a clean switch', async () => {
    stubApi();
    renderManager();
    await choose('tpl-a', 'Alpha');
    expect(nameBox().value).toBe('Alpha');
    await choose('tpl-b', 'Bravo');
    expect(nameBox().value).toBe('Bravo');
    expect(
      within(detailsForm()).getByRole('textbox', { name: 'Description' }),
    ).toHaveValue('Bravo description');
    await choose('tpl-a', 'Alpha');
    expect(nameBox().value).toBe('Alpha');
  });

  it("never saves one template's unsaved name into another (probe A)", async () => {
    const writes = stubApi();
    renderManager();
    await choose('tpl-a', 'Alpha');
    fireEvent.change(nameBox(), {
      target: { value: 'Alpha renamed (unsaved)' },
    });
    await choose('tpl-b', 'Bravo');
    expect(nameBox().value).toBe('Bravo');
    fireEvent.click(
      within(detailsForm()).getByRole('button', { name: 'Save details' }),
    );
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      method: 'PATCH',
      path: '/templates/tpl-b',
      body: {
        name: 'Bravo',
        description: 'Bravo description',
        category: 'Bravo category',
      },
    });
  });

  it('does not carry a half-typed new field over to another template', async () => {
    const writes = stubApi();
    renderManager();
    await choose('tpl-a', 'Alpha');
    fireEvent.change(
      within(addFieldForm()).getByRole('textbox', { name: 'Key' }),
      { target: { value: 'alpha_only' } },
    );
    await choose('tpl-b', 'Bravo');
    expect(
      within(addFieldForm()).getByRole('textbox', { name: 'Key' }),
    ).toHaveValue('');
    expect(writes).toHaveLength(0);
  });

  it('closes an open field edit when another template is chosen', async () => {
    stubApi();
    renderManager();
    await choose('tpl-a', 'Alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Edit field' }));
    expect(
      screen.getByRole('form', { name: 'Edit Alpha headline' }),
    ).toBeInTheDocument();
    await choose('tpl-b', 'Bravo');
    expect(screen.queryByRole('form', { name: /^Edit / })).toBeNull();
  });

  it('ignores a late response for a template that is no longer chosen', async () => {
    const alphaDetail = deferred<Response>();
    const writes = stubApi((method, path) =>
      method === 'GET' && path === '/templates/tpl-a'
        ? alphaDetail.promise
        : undefined,
    );
    renderManager();
    await choose('tpl-a');
    await choose('tpl-b', 'Bravo');
    await act(async () => alphaDetail.resolve(reply(200, ALPHA)));
    expect(screen.getByRole('heading', { name: 'Bravo' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Alpha' })).toBeNull();
    expect(nameBox().value).toBe('Bravo');
    fireEvent.click(
      within(detailsForm()).getByRole('button', { name: 'Save details' }),
    );
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.path).toBe('/templates/tpl-b');
  });

  it("keeps the newly chosen template when an earlier template's save finishes late", async () => {
    const alphaSave = deferred<Response>();
    const writes = stubApi((method, path) =>
      method === 'PATCH' && path === '/templates/tpl-a'
        ? alphaSave.promise
        : undefined,
    );
    renderManager();
    await choose('tpl-a', 'Alpha');
    fireEvent.change(nameBox(), { target: { value: 'Alpha 2' } });
    fireEvent.click(
      within(detailsForm()).getByRole('button', { name: 'Save details' }),
    );
    await waitFor(() => expect(writes).toHaveLength(1));
    await choose('tpl-b', 'Bravo');
    await act(async () => alphaSave.resolve(reply(200, {})));
    await screen.findByText('Template details saved.');
    expect(writes[0]).toMatchObject({
      path: '/templates/tpl-a',
      body: { name: 'Alpha 2' },
    });
    expect(screen.getByRole('heading', { name: 'Bravo' })).toBeInTheDocument();
    expect(nameBox().value).toBe('Bravo');
    expect(
      screen.getByRole('combobox', { name: 'Choose template' }),
    ).toHaveValue('tpl-b');
  });
});

describe('TemplateManager field edit (M3)', () => {
  const editForm = () =>
    screen.getByRole('form', { name: 'Edit Alpha headline' });

  async function openEdit() {
    await choose('tpl-a', 'Alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Edit field' }));
    fireEvent.change(
      within(editForm()).getByRole('textbox', { name: 'Label' }),
      { target: { value: 'Main headline (typed)' } },
    );
    fireEvent.change(
      within(editForm()).getByRole('textbox', { name: 'Help text' }),
      { target: { value: 'Keep it short' } },
    );
  }

  it('keeps the form open with every typed value and an actionable error when the save is refused (probe B)', async () => {
    const writes = stubApi((method, path) =>
      method === 'PATCH' && path.includes('/fields/')
        ? Promise.resolve(reply(409, { message: 'Field key already exists' }))
        : undefined,
    );
    renderManager();
    await openEdit();
    fireEvent.click(
      within(editForm()).getByRole('button', { name: 'Save field' }),
    );
    await waitFor(() => expect(writes).toHaveLength(1));
    const alert = await within(editForm()).findByRole('alert');
    expect(alert).toHaveTextContent('Field key already exists');
    expect(alert).toHaveTextContent(/Your changes are still in the form/);
    expect(
      within(editForm()).getByRole('textbox', { name: 'Label' }),
    ).toHaveValue('Main headline (typed)');
    expect(
      within(editForm()).getByRole('textbox', { name: 'Help text' }),
    ).toHaveValue('Keep it short');
    expect(screen.queryByText('Field updated.')).toBeNull();
  });

  it('closes the form only once the save succeeds, and can be retried after a failure', async () => {
    let attempt = 0;
    const second = deferred<Response>();
    const writes = stubApi((method, path) => {
      if (method !== 'PATCH' || !path.includes('/fields/')) return undefined;
      attempt += 1;
      return attempt === 1
        ? Promise.resolve(reply(500, { message: 'Database unavailable' }))
        : second.promise;
    });
    renderManager();
    await openEdit();
    const save = () => within(editForm()).getByRole('button', { name: /^Sav/ });
    fireEvent.click(save());
    await within(editForm()).findByRole('alert');
    fireEvent.click(save());
    await waitFor(() => expect(writes).toHaveLength(2));
    // Still open while the retry is in flight.
    expect(editForm()).toBeInTheDocument();
    expect(writes[1]?.body).toMatchObject({
      label: 'Main headline (typed)',
      helpText: 'Keep it short',
    });
    await act(async () => second.resolve(reply(200, {})));
    await screen.findByText('Field updated.');
    expect(screen.queryByRole('form', { name: /^Edit / })).toBeNull();
  });

  it('closes on Cancel without sending anything', async () => {
    const writes = stubApi();
    renderManager();
    await openEdit();
    fireEvent.click(within(editForm()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: /^Edit / })).toBeNull();
    expect(writes).toHaveLength(0);
  });
});
