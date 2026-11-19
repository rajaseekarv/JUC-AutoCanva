// Phase 3.1 regression tests (M4): changing a creative's template or template
// version keeps the values whose fields still exist, and asks before
// discarding any that cannot be carried over.
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
  BranchResponse,
  CreativeResponse,
  TemplateFieldResponse,
  TemplateResponse,
} from '@adflow/shared-types';
import CreativeWorkspace from './CreativeWorkspace';

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
  ],
  branches: [{ id: 'branch-1', name: 'North', code: 'NORTH' }],
};
const branch: BranchResponse = {
  id: 'branch-1',
  name: 'North',
  code: 'NORTH',
  status: 'ACTIVE',
};

function field(
  key: string,
  label: string,
  type: TemplateFieldResponse['type'] = 'TEXT',
  defaultValue: unknown = null,
): TemplateFieldResponse {
  return {
    id: 'field-' + key + '-' + label,
    key,
    label,
    type,
    required: false,
    defaultValue,
    validationRules: null,
    helpText: null,
    displayOrder: 0,
    dataSource: null,
    sourceKey: null,
  } as TemplateFieldResponse;
}
function version(
  id: string,
  templateId: string,
  versionNumber: number,
  fields: TemplateFieldResponse[],
) {
  return {
    id,
    templateId,
    versionNumber,
    name: id,
    description: null,
    category: null,
    formatName: 'Square',
    width: 1080,
    height: 1080,
    unit: 'PX' as const,
    immutableAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    fields,
  };
}
function template(
  id: string,
  name: string,
  versions: ReturnType<typeof version>[],
  activeVersionNumber = versions.length,
): TemplateResponse {
  return {
    id,
    name,
    code: id,
    description: null,
    category: null,
    status: 'ACTIVE',
    formatName: 'Square',
    width: 1080,
    height: 1080,
    unit: 'PX',
    currentVersionNumber: versions.length,
    activeVersionNumber,
    updatedAt: '2026-01-01T00:00:00Z',
    versions,
  } as TemplateResponse;
}

// Alpha v1: headline + offer; Alpha v2 (active): headline + call to action.
const ALPHA_V1 = version('alpha-v1', 'alpha', 1, [
  field('headline', 'Headline'),
  field('offer', 'Offer'),
]);
const ALPHA_V2 = version('alpha-v2', 'alpha', 2, [
  field('headline', 'Headline'),
  field('cta', 'Call to action'),
]);
const ALPHA = template('alpha', 'Alpha', [ALPHA_V1, ALPHA_V2]);
// Bravo: headline + phone. Charlie: headline + offer (everything carries).
const BRAVO = template('bravo', 'Bravo', [
  version('bravo-v1', 'bravo', 1, [
    field('headline', 'Headline'),
    field('phone', 'Phone', 'PHONE'),
  ]),
]);
const CHARLIE = template('charlie', 'Charlie', [
  version('charlie-v1', 'charlie', 1, [
    field('headline', 'Headline'),
    field('offer', 'Offer'),
  ]),
]);
// Delta: same keys as Alpha v2, but "cta" is a number there.
const DELTA = template('delta', 'Delta', [
  version('delta-v1', 'delta', 1, [
    field('headline', 'Headline'),
    field('cta', 'Call to action', 'NUMBER'),
  ]),
]);
const DETAILS: Record<string, TemplateResponse> = {
  alpha: ALPHA,
  bravo: BRAVO,
  charlie: CHARLIE,
  delta: DELTA,
};

const revision = {
  id: 'revision-1',
  revisionNumber: 1,
  templateVersionId: ALPHA_V1.id,
  values: { headline: 'Saved headline', offer: '10% off' },
  summary: null,
  createdById: 'user-1',
  createdAt: '2026-01-01T00:00:00Z',
  templateVersion: ALPHA_V1,
};
const creative = {
  id: 'creative-1',
  organizationId: 'org-1',
  branchId: 'branch-1',
  campaignId: null,
  name: 'Launch',
  status: 'DRAFT',
  currentRevisionId: revision.id,
  createdAt: revision.createdAt,
  updatedAt: revision.createdAt,
  currentRevision: revision,
} as unknown as CreativeResponse;

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

type Write = { method: string; path: string; body: Record<string, unknown> };
type Route = (method: string, path: string) => Promise<Response> | undefined;

function stubApi(route: Route = () => undefined) {
  const writes: Write[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const path = url.pathname.replace(/^\/api\/v1/, '');
      const method = init?.method ?? 'GET';
      if (method !== 'GET')
        writes.push({
          method,
          path,
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
      const routed = route(method, path);
      if (routed) return routed;
      if (path === '/creatives' && method === 'GET')
        return reply(200, [creative]);
      if (path === '/creatives' && method === 'POST')
        return reply(201, creative);
      if (path === '/templates')
        return reply(200, [ALPHA, BRAVO, CHARLIE, DELTA]);
      const detail = DETAILS[path.replace('/templates/', '')];
      if (detail) return reply(200, detail);
      if (path.endsWith('/revisions')) return reply(200, [revision]);
      return reply(200, []);
    }),
  );
  return writes;
}

function renderWorkspace() {
  render(
    <CreativeWorkspace
      session={{ accessToken: 'token', user }}
      branch={branch}
      onUnauthorized={vi.fn()}
    />,
  );
}

const templateSelect = () =>
  screen.getByRole('combobox', { name: 'Template' }) as HTMLSelectElement;
const versionSelect = () =>
  screen.getByRole('combobox', {
    name: 'Template version',
  }) as HTMLSelectElement;
const box = (name: string) =>
  screen.getByRole('textbox', { name }) as HTMLInputElement;
const confirmPanel = () =>
  screen.queryByRole('group', { name: 'Values that cannot be kept' });

// A new creative on Alpha (active v2: headline + call to action), typed in.
async function newOnAlpha(values: Record<string, string>) {
  fireEvent.click(await screen.findByRole('button', { name: 'New creative' }));
  await waitFor(() => expect(templateSelect()).toBeEnabled());
  fireEvent.change(templateSelect(), { target: { value: 'alpha' } });
  await screen.findByRole('textbox', { name: 'Call to action' });
  fireEvent.change(screen.getByLabelText('Name (required)'), {
    target: { value: 'New launch' },
  });
  for (const [label, value] of Object.entries(values))
    fireEvent.change(box(label), { target: { value } });
}

describe('CreativeWorkspace template change (M4)', () => {
  it('keeps every value and asks nothing when all of them fit the new template', async () => {
    stubApi();
    renderWorkspace();
    await newOnAlpha({ Headline: 'My headline' });
    fireEvent.change(templateSelect(), { target: { value: 'bravo' } });
    await screen.findByRole('textbox', { name: 'Phone' });
    expect(confirmPanel()).toBeNull();
    expect(box('Headline').value).toBe('My headline');
    expect(templateSelect().value).toBe('bravo');
  });

  it('switches without asking when nothing has been typed', async () => {
    stubApi();
    renderWorkspace();
    fireEvent.click(
      await screen.findByRole('button', { name: 'New creative' }),
    );
    await waitFor(() => expect(templateSelect()).toBeEnabled());
    fireEvent.change(templateSelect(), { target: { value: 'alpha' } });
    await screen.findByRole('textbox', { name: 'Call to action' });
    fireEvent.change(templateSelect(), { target: { value: 'bravo' } });
    await screen.findByRole('textbox', { name: 'Phone' });
    expect(confirmPanel()).toBeNull();
  });

  it('asks before discarding values the new template has no field for; Keep changes nothing', async () => {
    const writes = stubApi();
    renderWorkspace();
    await newOnAlpha({ Headline: 'My headline', 'Call to action': 'Buy now' });
    fireEvent.change(templateSelect(), { target: { value: 'bravo' } });
    const panel = await screen.findByRole('group', {
      name: 'Values that cannot be kept',
    });
    expect(panel).toHaveTextContent('Bravo has no field for: Call to action.');
    expect(panel).toHaveTextContent('Headline will be kept.');
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Keep current template' }),
    );
    expect(confirmPanel()).toBeNull();
    expect(templateSelect().value).toBe('alpha');
    expect(box('Headline').value).toBe('My headline');
    expect(box('Call to action').value).toBe('Buy now');
    expect(writes).toHaveLength(0);
  });

  it('carries matching values over once the user confirms, and saves only them', async () => {
    const writes = stubApi();
    renderWorkspace();
    await newOnAlpha({ Headline: 'My headline', 'Call to action': 'Buy now' });
    fireEvent.change(templateSelect(), { target: { value: 'bravo' } });
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Switch and discard 1 value',
      }),
    );
    await screen.findByRole('textbox', { name: 'Phone' });
    expect(templateSelect().value).toBe('bravo');
    expect(box('Headline').value).toBe('My headline');
    expect(
      screen.queryByRole('textbox', { name: 'Call to action' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create creative' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.body).toMatchObject({
      templateVersionId: 'bravo-v1',
      values: { headline: 'My headline' },
    });
    expect(writes[0]?.body.values).not.toHaveProperty('cta');
  });

  it('does not carry a value into a field of a different type', async () => {
    stubApi();
    renderWorkspace();
    await newOnAlpha({ 'Call to action': 'Buy now' });
    fireEvent.change(templateSelect(), { target: { value: 'delta' } });
    expect(
      await screen.findByRole('group', { name: 'Values that cannot be kept' }),
    ).toHaveTextContent('Delta has no field for: Call to action.');
  });

  it('asks when an open creative changes to a version without some of its fields; Keep leaves the version and values', async () => {
    stubApi();
    renderWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    await waitFor(() => expect(box('Offer').value).toBe('10% off'));
    expect(versionSelect().value).toBe('alpha-v1');
    fireEvent.change(versionSelect(), { target: { value: 'alpha-v2' } });
    const panel = screen.getByRole('group', {
      name: 'Values that cannot be kept',
    });
    expect(panel).toHaveTextContent('Version 2 has no field for: Offer.');
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Keep current version' }),
    );
    expect(versionSelect().value).toBe('alpha-v1');
    expect(box('Offer').value).toBe('10% off');
    expect(box('Headline').value).toBe('Saved headline');
  });

  it('changes the version and keeps matching values once confirmed', async () => {
    stubApi();
    renderWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    await waitFor(() => expect(box('Offer').value).toBe('10% off'));
    fireEvent.change(box('Headline'), { target: { value: 'Edited headline' } });
    fireEvent.change(versionSelect(), { target: { value: 'alpha-v2' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Switch and discard 1 value' }),
    );
    expect(versionSelect().value).toBe('alpha-v2');
    expect(box('Headline').value).toBe('Edited headline');
    expect(box('Call to action').value).toBe('');
    expect(screen.queryByRole('textbox', { name: 'Offer' })).toBeNull();
  });

  it('keeps the template and values when the new template cannot be loaded', async () => {
    stubApi((_method, path) =>
      path === '/templates/bravo'
        ? Promise.resolve(reply(500, { message: 'Template service down' }))
        : undefined,
    );
    renderWorkspace();
    await newOnAlpha({ Headline: 'My headline', 'Call to action': 'Buy now' });
    fireEvent.change(templateSelect(), { target: { value: 'bravo' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Bravo couldn't be loaded/,
    );
    expect(templateSelect().value).toBe('alpha');
    expect(box('Call to action').value).toBe('Buy now');
    expect(confirmPanel()).toBeNull();
  });

  it('ignores a late answer for a template the user has since moved away from', async () => {
    const bravo = deferred<Response>();
    stubApi((_method, path) =>
      path === '/templates/bravo' ? bravo.promise : undefined,
    );
    renderWorkspace();
    await newOnAlpha({ Headline: 'My headline', 'Call to action': 'Buy now' });
    fireEvent.change(templateSelect(), { target: { value: 'bravo' } });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Checking which values Bravo can keep…',
    );
    fireEvent.change(templateSelect(), { target: { value: 'charlie' } });
    // Charlie has no call to action either.
    await screen.findByRole('group', { name: 'Values that cannot be kept' });
    fireEvent.click(
      screen.getByRole('button', { name: 'Switch and discard 1 value' }),
    );
    await waitFor(() => expect(templateSelect().value).toBe('charlie'));
    await act(async () => bravo.resolve(reply(200, BRAVO)));
    expect(templateSelect().value).toBe('charlie');
    expect(confirmPanel()).toBeNull();
    expect(box('Headline').value).toBe('My headline');
    expect(screen.queryByRole('textbox', { name: 'Phone' })).toBeNull();
  });
});
