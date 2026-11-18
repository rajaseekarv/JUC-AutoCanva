// Phase 3.4 regression tests: the Creative form checks values in the browser
// with the API's own rules (TemplatesService.validateCreativeValues) and
// explains problems beside their fields before anything is sent.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
    'assets:read',
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
  type: TemplateFieldResponse['type'],
  extra: Partial<TemplateFieldResponse> = {},
): TemplateFieldResponse {
  return {
    id: 'f-' + key,
    key,
    label,
    type,
    required: false,
    defaultValue: null,
    validationRules: null,
    helpText: null,
    displayOrder: 0,
    dataSource: null,
    sourceKey: null,
    ...extra,
  } as TemplateFieldResponse;
}
const FIELDS = [
  field('headline', 'Headline', 'TEXT', {
    required: true,
    validationRules: { minLength: 3, maxLength: 20 },
  }),
  field('body', 'Body', 'MULTILINE_TEXT', {
    validationRules: { minLength: 5 },
  }),
  field('price', 'Price', 'NUMBER', { validationRules: { min: 1, max: 100 } }),
  field('site', 'Website', 'URL'),
  field('phone', 'Phone', 'PHONE'),
  field('launch', 'Launch date', 'DATE'),
  field('tint', 'Tint', 'COLOR'),
];
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
const PROMO_V1 = version('promo-v1', 'promo', 1, FIELDS);
// Version 2 allows a headline of at most 5 characters.
const PROMO_V2 = version('promo-v2', 'promo', 2, [
  field('headline', 'Headline', 'TEXT', {
    required: true,
    validationRules: { maxLength: 5 },
  }),
]);
const PROMO = template('promo', 'Promo', [PROMO_V1, PROMO_V2], 1);
// A required yes/no answer and a required image.
const POSTER = template('poster', 'Poster', [
  version('poster-v1', 'poster', 1, [
    field('featured', 'Featured', 'BOOLEAN', { required: true }),
    field('logo', 'Logo', 'LOGO', { required: true }),
  ]),
]);
const DETAILS: Record<string, TemplateResponse> = {
  promo: PROMO,
  poster: POSTER,
};

// An existing creative whose saved values no longer pass (for example made
// before a rule, or by another client).
const savedRevision = {
  id: 'revision-1',
  revisionNumber: 1,
  templateVersionId: PROMO_V1.id,
  values: { headline: 'Saved headline', launch: '2026-02-30', tint: 'red' },
  summary: null,
  createdById: 'user-1',
  createdAt: '2026-01-01T00:00:00Z',
  templateVersion: PROMO_V1,
};
const CREATIVE = {
  id: 'creative-1',
  organizationId: 'org-1',
  branchId: 'branch-1',
  campaignId: null,
  name: 'Launch',
  status: 'DRAFT',
  currentRevisionId: savedRevision.id,
  createdAt: savedRevision.createdAt,
  updatedAt: savedRevision.createdAt,
  currentRevision: savedRevision,
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
      const path = new URL(input).pathname.replace(/^\/api\/v1/, '');
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
        return reply(200, [CREATIVE]);
      if (path === '/creatives' && method === 'POST')
        return reply(201, { ...CREATIVE, id: 'creative-new' });
      if (path === '/templates') return reply(200, [PROMO, POSTER]);
      if (path === '/assets')
        return reply(200, [
          { id: 'logo-1', originalName: 'logo.png', branchId: null },
        ]);
      const detail = DETAILS[path.replace('/templates/', '')];
      if (detail) return reply(200, detail);
      if (path.endsWith('/revisions')) return reply(200, [savedRevision]);
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

const box = (name: string) =>
  screen.getByRole('textbox', { name }) as HTMLInputElement;
const numberBox = () =>
  screen.getByRole('spinbutton', { name: 'Price' }) as HTMLInputElement;
const createButton = () =>
  screen.getByRole('button', { name: 'Create creative' });
const type = (element: HTMLElement, value: string) =>
  fireEvent.change(element, { target: { value } });
// The message shown beside a field (its accessible description).
const messageOf = (element: HTMLElement) =>
  element.getAttribute('aria-describedby')
    ? (element.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ')
    : '';

async function newPromo() {
  fireEvent.click(await screen.findByRole('button', { name: 'New creative' }));
  await waitFor(() =>
    expect(screen.getByRole('combobox', { name: 'Template' })).toBeEnabled(),
  );
  fireEvent.change(screen.getByRole('combobox', { name: 'Template' }), {
    target: { value: 'promo' },
  });
  await screen.findByRole('textbox', { name: 'Headline' });
}
async function validPromo() {
  await newPromo();
  type(screen.getByLabelText('Name (required)'), 'Summer launch');
  type(box('Headline'), 'Big sale');
}

describe('Creative browser validation (Phase 3.4)', () => {
  it('says nothing on an untouched form, and saves a valid one with optional fields left empty', async () => {
    const writes = stubApi();
    renderWorkspace();
    await newPromo();
    expect(document.querySelectorAll('.field-error')).toHaveLength(0);
    expect(document.querySelector('.form-problems')).toBeNull();
    expect(createButton()).toBeDisabled();
    type(screen.getByLabelText('Name (required)'), 'Summer launch');
    type(box('Headline'), 'Big sale');
    expect(createButton()).toBeEnabled();
    fireEvent.click(createButton());
    await screen.findByText('Creative created.');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body.values).toEqual({ headline: 'Big sale' });
  });

  it('explains a missing or whitespace-only required value beside the field and keeps Save unavailable', async () => {
    stubApi();
    renderWorkspace();
    await validPromo();
    type(box('Headline'), '   ');
    expect(box('Headline')).toHaveAttribute('aria-invalid', 'true');
    expect(messageOf(box('Headline'))).toContain('Headline is required.');
    expect(createButton()).toBeDisabled();
    expect(document.querySelector('.form-problems')).toHaveTextContent(
      'Fix this before saving: Headline.',
    );
    type(box('Headline'), '');
    expect(messageOf(box('Headline'))).toContain('Headline is required.');
    type(screen.getByLabelText('Name (required)'), '  ');
    expect(messageOf(screen.getByLabelText('Name (required)'))).toContain(
      'Enter a name for the creative.',
    );
  });

  it.each([
    ['ab', 'Headline must be at least 3 characters (it has 2).'],
    ['x'.repeat(21), 'Headline must be at most 20 characters (it has 21).'],
  ])('applies the template length rules (%s)', async (value, message) => {
    stubApi();
    renderWorkspace();
    await validPromo();
    type(box('Headline'), value);
    expect(messageOf(box('Headline'))).toContain(message);
    expect(createButton()).toBeDisabled();
  });

  it('accepts the length boundaries exactly', async () => {
    stubApi();
    renderWorkspace();
    await validPromo();
    for (const value of ['abc', 'x'.repeat(20)]) {
      type(box('Headline'), value);
      expect(box('Headline')).not.toHaveAttribute('aria-invalid');
      expect(createButton()).toBeEnabled();
    }
  });

  it('checks an optional field only once it has a value, and an emptied paragraph is sent as empty', async () => {
    const writes = stubApi();
    renderWorkspace();
    await validPromo();
    const body = screen.getByRole('textbox', { name: 'Body' });
    type(body, 'abc');
    expect(messageOf(body)).toContain(
      'Body must be at least 5 characters (it has 3).',
    );
    expect(createButton()).toBeDisabled();
    type(body, '');
    expect(body).not.toHaveAttribute('aria-invalid');
    expect(createButton()).toBeEnabled();
    fireEvent.click(createButton());
    await screen.findByText('Creative created.');
    // Sent as null (not ''), so the API skips the optional field's rules.
    expect(writes[0]?.body.values).toEqual({
      headline: 'Big sale',
      body: null,
    });
  });

  it.each([
    ['0', 'Price must be at least 1.'],
    ['101', 'Price must be at most 100.'],
  ])('checks number values and ranges (%s)', async (value, message) => {
    stubApi();
    renderWorkspace();
    await validPromo();
    type(numberBox(), value);
    expect(messageOf(numberBox())).toContain(message);
    expect(createButton()).toBeDisabled();
  });

  it('accepts the number boundaries, and explains text the browser cannot read as a number', async () => {
    stubApi();
    renderWorkspace();
    await validPromo();
    for (const value of ['1', '100']) {
      type(numberBox(), value);
      expect(numberBox()).not.toHaveAttribute('aria-invalid');
    }
    // What Chrome reports for "1e" typed into a number field.
    Object.defineProperty(numberBox(), 'validity', {
      configurable: true,
      value: { badInput: true },
    });
    type(numberBox(), '');
    expect(messageOf(numberBox())).toContain('Price must be a number.');
    expect(createButton()).toBeDisabled();
  });

  it.each([
    [
      'Website',
      'example.com',
      'Website must be a full web address starting with http:// or https://.',
    ],
    ['Website', 'ftp://example.com', 'Website must be a full web address'],
    // Whitespace in an optional field is a value, and the API checks it.
    ['Phone', '   ', 'Phone must be a phone number'],
    ['Phone', '123456', 'Phone must be a phone number of 7 to 24 digits'],
    ['Phone', 'call 1234567', 'Phone must be a phone number'],
  ])('checks %s formats (%j)', async (label, value, message) => {
    stubApi();
    renderWorkspace();
    await validPromo();
    type(box(label), value);
    expect(messageOf(box(label))).toContain(message);
    expect(createButton()).toBeDisabled();
  });

  it.each([
    ['Website', 'https://example.com/offer'],
    ['Phone', '+91 (98765) 43-210'],
  ])('accepts a valid %s', async (label, value) => {
    stubApi();
    renderWorkspace();
    await validPromo();
    type(box(label), value);
    expect(box(label)).not.toHaveAttribute('aria-invalid');
    expect(createButton()).toBeEnabled();
  });

  it('flags saved values the API would now refuse, and Show the first problem moves focus to it', async () => {
    stubApi();
    renderWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    await waitFor(() => expect(box('Headline').value).toBe('Saved headline'));
    expect(
      screen.getByRole('button', { name: 'Save new revision' }),
    ).toBeDisabled();
    // Untouched: nothing is shown until the user works on the form.
    expect(document.querySelectorAll('.field-error')).toHaveLength(0);
    type(screen.getByLabelText('Name (required)'), 'Launch 2');
    expect(document.querySelector('.form-problems')).toHaveTextContent(
      'Fix these 2 fields before saving: Launch date, Tint.',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Show the first problem' }),
    );
    const date = screen.getByLabelText('Launch date');
    expect(date).toHaveFocus();
    expect(messageOf(date)).toContain(
      'Launch date must be a real date (YYYY-MM-DD).',
    );
    expect(messageOf(screen.getByLabelText('Tint'))).toContain(
      'Tint must be a colour written as # and six hex digits',
    );
  });

  it('sends nothing when the form is submitted another way with problems, shows them, and keeps every value', async () => {
    const writes = stubApi();
    renderWorkspace();
    await validPromo();
    type(box('Website'), 'example.com');
    type(screen.getByRole('textbox', { name: 'Body' }), 'Some body text');
    fireEvent.submit(createButton().closest('form')!);
    expect(writes).toHaveLength(0);
    expect(box('Website')).toHaveFocus();
    expect(messageOf(box('Website'))).toContain(
      'Website must be a full web address',
    );
    expect(box('Website').value).toBe('example.com');
    expect(box('Headline').value).toBe('Big sale');
    expect(screen.getByRole('textbox', { name: 'Body' })).toHaveValue(
      'Some body text',
    );
    expect(screen.getByLabelText('Name (required)')).toHaveValue(
      'Summer launch',
    );
  });

  it('saves once the problem is corrected, sending the corrected value', async () => {
    const writes = stubApi();
    renderWorkspace();
    await validPromo();
    type(box('Website'), 'example.com');
    expect(createButton()).toBeDisabled();
    type(box('Website'), 'https://example.com');
    expect(document.querySelector('.form-problems')).toBeNull();
    fireEvent.click(createButton());
    await screen.findByText('Creative created.');
    expect(writes[0]?.body.values).toEqual({
      headline: 'Big sale',
      site: 'https://example.com',
    });
  });

  it('sends one request when Save is clicked again while saving', async () => {
    const pending = deferred<Response>();
    const writes = stubApi((method) =>
      method === 'POST' ? pending.promise : undefined,
    );
    renderWorkspace();
    await validPromo();
    fireEvent.click(createButton());
    fireEvent.click(screen.getByRole('button', { name: 'Saving…' }));
    fireEvent.submit(
      screen.getByRole('button', { name: 'Saving…' }).closest('form')!,
    );
    expect(writes).toHaveLength(1);
    await act(async () =>
      pending.resolve(reply(201, { ...CREATIVE, id: 'creative-new' })),
    );
    await screen.findByText('Creative created.');
    expect(writes).toHaveLength(1);
  });

  it("checks a value carried to another version against that version's rules at once", async () => {
    // Version 2 (headline at most 5 characters) is the active version here;
    // the open creative was made with version 1, so both are offered.
    stubApi((_method, path) =>
      path === '/templates/promo'
        ? Promise.resolve(reply(200, { ...PROMO, activeVersionNumber: 2 }))
        : undefined,
    );
    renderWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    await waitFor(() => expect(box('Headline').value).toBe('Saved headline'));
    expect(box('Headline')).not.toHaveAttribute('aria-invalid');
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Template version' }),
      {
        target: { value: 'promo-v2' },
      },
    );
    // Launch date and Tint cannot be carried; confirm the switch.
    fireEvent.click(
      screen.getByRole('button', { name: /^Switch and discard/ }),
    );
    expect(box('Headline').value).toBe('Saved headline');
    expect(messageOf(box('Headline'))).toContain(
      'Headline must be at most 5 characters (it has 14).',
    );
    expect(
      screen.getByRole('button', { name: 'Save new revision' }),
    ).toBeDisabled();
    type(box('Headline'), 'Sale');
    expect(box('Headline')).not.toHaveAttribute('aria-invalid');
  });

  it('explains a required yes/no answer and a required image', async () => {
    stubApi();
    renderWorkspace();
    fireEvent.click(
      await screen.findByRole('button', { name: 'New creative' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Template' })).toBeEnabled(),
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Template' }), {
      target: { value: 'poster' },
    });
    const featured = await screen.findByRole('checkbox', { name: 'Featured' });
    type(screen.getByLabelText('Name (required)'), 'Poster');
    fireEvent.click(
      screen.getByRole('button', { name: 'Show the first problem' }),
    );
    expect(featured).toHaveFocus();
    expect(messageOf(featured)).toContain(
      'Featured is required: tick the box, or tick and clear it to answer no.',
    );
    const logo = screen.getByRole('combobox', { name: 'Logo' });
    expect(messageOf(logo)).toContain('Choose an image for Logo.');
    fireEvent.click(featured);
    fireEvent.click(featured);
    expect(featured).not.toHaveAttribute('aria-invalid');
    fireEvent.change(logo, { target: { value: 'logo-1' } });
    expect(createButton()).toBeEnabled();
  });

  it("still shows the API's refusal, with the values kept, when the browser cannot know", async () => {
    stubApi((method) =>
      method === 'POST'
        ? Promise.resolve(reply(400, { message: 'Asset not found' }))
        : undefined,
    );
    renderWorkspace();
    await validPromo();
    fireEvent.click(createButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Asset not found',
    );
    expect(box('Headline').value).toBe('Big sale');
    expect(createButton()).toBeEnabled();
  });
});
