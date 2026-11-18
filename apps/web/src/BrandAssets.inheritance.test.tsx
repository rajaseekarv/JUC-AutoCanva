// Phase 3.2 brand inheritance: branch fields inherit the organization's
// values unless overridden, each field says which, and a branch save sends
// only real changes (null removes an override).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { AuthenticatedUserResponse } from '@adflow/shared-types';
import BrandAssets from './BrandAssets';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const FIELDS = [
  'displayName',
  'primaryColor',
  'secondaryColor',
  'accentColor',
  'fontFamily',
  'websiteUrl',
  'logoAssetId',
] as const;
type Field = (typeof FIELDS)[number];
type Profile = Record<Field, string | null>;

const BRANCHES = [
  { id: 'b-1', name: 'North', code: 'N' },
  { id: 'b-2', name: 'South', code: 'S' },
];
function userWith(permissions: string[]): AuthenticatedUserResponse {
  return {
    id: 'user-1',
    organizationId: 'org-1',
    name: 'Manager',
    email: 'manager@example.local',
    permissions,
    branches: BRANCHES,
  } as AuthenticatedUserResponse;
}
const manager = userWith(['brand:read', 'brand:manage']);

function reply(status: number, body?: unknown): Response {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    ok: status < 300,
    status,
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
  } as Response;
}

type Write = { method: string; path: string; body: Record<string, unknown> };
type Route = (method: string, path: string) => Response | undefined;

// A fake API with the brand service's rules: a PATCH changes only the
// fields it is sent, null removes a branch override, an empty body is
// refused, and the effective profile is override ?? organization.
function stubApi(route: Route = () => undefined) {
  const server = {
    organization: {
      displayName: 'Acme',
      primaryColor: '#111111',
      secondaryColor: '#eeeeee',
      accentColor: '#2f6fed',
      fontFamily: 'Inter',
      websiteUrl: 'https://acme.example',
      logoAssetId: 'org-logo',
    } as Profile,
    overrides: {
      'b-1': {
        displayName: 'North shop',
        websiteUrl: 'https://north.example',
        logoAssetId: 'north-logo',
      },
      'b-2': { primaryColor: '#222222' },
    } as Record<string, Partial<Profile>>,
  };
  const effective = (branchId: string) => {
    const override = server.overrides[branchId] ?? {};
    const profile = Object.fromEntries(
      FIELDS.map((field) => [
        field,
        override[field] ?? server.organization[field],
      ]),
    );
    return {
      ...profile,
      branchId,
      overriddenFields: FIELDS.filter((field) => override[field] != null),
    };
  };
  const writes: Write[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname.replace(/^\/api\/v1/, '');
      const method = init?.method ?? 'GET';
      const body =
        method === 'GET'
          ? {}
          : (JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (method !== 'GET') writes.push({ method, path, body });
      const routed = route(method, path);
      if (routed) return routed;
      if (path === '/organization/brand' && method === 'GET')
        return reply(200, server.organization);
      if (path === '/organization/brand' && method === 'PATCH') {
        Object.assign(server.organization, body);
        return reply(200, server.organization);
      }
      const eff = /^\/branches\/([^/]+)\/brand\/effective$/.exec(path);
      if (eff) return reply(200, effective(eff[1]!));
      const patch = /^\/branches\/([^/]+)\/brand$/.exec(path);
      if (patch && method === 'PATCH') {
        if (!Object.keys(body).length)
          return reply(400, { message: 'Invalid brand profile' });
        const override = (server.overrides[patch[1]!] ??= {});
        for (const [field, value] of Object.entries(body))
          override[field as Field] = value as string | null;
        // Like the API: the raw override row, nulls for inherited fields.
        return reply(200, {
          branchId: patch[1],
          ...Object.fromEntries(FIELDS.map((f) => [f, override[f] ?? null])),
        });
      }
      return reply(404, { message: 'Not found' });
    }),
  );
  return { server, writes };
}

function renderBrand(user = manager, branchId = 'b-1') {
  const branch = BRANCHES.find((item) => item.id === branchId);
  render(
    <BrandAssets
      session={{ accessToken: 'token', user }}
      branch={branch ? { ...branch, status: 'ACTIVE' } : null}
      onUnauthorized={vi.fn()}
    />,
  );
}

const box = (name: string) =>
  screen.getByRole('textbox', { name }) as HTMLInputElement;
const control = (label: string) =>
  screen.getByLabelText(label) as HTMLInputElement | HTMLSelectElement;
const save = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Save brand profile' }));
const useOrganization = (label: string) =>
  fireEvent.click(
    screen.getByRole('button', { name: 'Use organization value for ' + label }),
  );
const INHERITED = 'Inherited from the organization';
const overridden = (branch = 'North') => 'Overridden for ' + branch;
const PENDING = ' · not saved yet';

async function openNorth() {
  await waitFor(() => expect(box('Display name').value).toBe('North shop'));
}

describe('Brand inheritance (Phase 3.2)', () => {
  it('labels every branch field as inherited or overridden and shows the value in effect', async () => {
    stubApi();
    renderBrand();
    await openNorth();
    expect(box('Display name')).toHaveAccessibleDescription(overridden());
    expect(box('Website')).toHaveAccessibleDescription(overridden());
    expect(control('Logo image')).toHaveAccessibleDescription(overridden());
    for (const label of ['Font family'])
      expect(box(label)).toHaveAccessibleDescription(INHERITED);
    for (const label of ['Primary color', 'Secondary color', 'Accent color'])
      expect(control(label)).toHaveAccessibleDescription(INHERITED);
    // Inherited fields show the organization's value.
    expect(box('Font family').value).toBe('Inter');
    expect(control('Primary color').value).toBe('#111111');
    // Only overrides offer "Use organization value".
    expect(
      screen.getAllByRole('button', { name: /^Use organization value for / }),
    ).toHaveLength(3);
  });

  it('sends nothing when nothing changed, so inherited fields stay inherited', async () => {
    const { writes } = stubApi();
    renderBrand();
    await openNorth();
    save();
    expect(
      await screen.findByText('There are no changes to save.'),
    ).toBeInTheDocument();
    expect(writes).toHaveLength(0);
  });

  it('overrides one field independently and keeps every other field as it was', async () => {
    const { writes, server } = stubApi();
    renderBrand();
    await openNorth();
    fireEvent.change(box('Font family'), { target: { value: 'Lato' } });
    expect(box('Font family')).toHaveAccessibleDescription(
      overridden() + PENDING,
    );
    save();
    await screen.findByText('North brand profile saved.');
    expect(writes).toEqual([
      {
        method: 'PATCH',
        path: '/branches/b-1/brand',
        body: { fontFamily: 'Lato' },
      },
    ]);
    expect(server.overrides['b-1']).toEqual({
      displayName: 'North shop',
      websiteUrl: 'https://north.example',
      logoAssetId: 'north-logo',
      fontFamily: 'Lato',
    });
    // Reloaded from the effective profile: saved and labelled.
    await waitFor(() =>
      expect(box('Font family')).toHaveAccessibleDescription(overridden()),
    );
    expect(box('Font family').value).toBe('Lato');
    expect(box('Display name').value).toBe('North shop');
    expect(control('Primary color')).toHaveAccessibleDescription(INHERITED);
  });

  it('restores the organization value with "Use organization value", and saving clears the override', async () => {
    const { writes, server } = stubApi();
    renderBrand();
    await openNorth();
    useOrganization('Display name');
    expect(box('Display name').value).toBe('Acme');
    expect(box('Display name')).toHaveAccessibleDescription(
      INHERITED + PENDING,
    );
    expect(box('Display name')).toHaveFocus();
    expect(
      screen.queryByRole('button', {
        name: 'Use organization value for Display name',
      }),
    ).toBeNull();
    save();
    await screen.findByText('North brand profile saved.');
    expect(writes[0]?.body).toEqual({ displayName: null });
    expect(server.overrides['b-1']?.displayName).toBeNull();
    await waitFor(() =>
      expect(box('Display name')).toHaveAccessibleDescription(INHERITED),
    );
    expect(box('Display name').value).toBe('Acme');
  });

  it('saves a mix of cleared, new and changed overrides in one request, leaving untouched fields out', async () => {
    const { writes } = stubApi();
    renderBrand();
    await openNorth();
    useOrganization('Display name');
    useOrganization('Logo image');
    fireEvent.change(box('Font family'), { target: { value: 'Lato' } });
    fireEvent.change(box('Website'), {
      target: { value: 'https://north-new.example' },
    });
    fireEvent.change(control('Accent color'), { target: { value: '#ff0000' } });
    save();
    await screen.findByText('North brand profile saved.');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toEqual({
      displayName: null,
      logoAssetId: null,
      fontFamily: 'Lato',
      websiteUrl: 'https://north-new.example',
      accentColor: '#ff0000',
    });
  });

  it("treats typing the organization's own value, or emptying an override, as inheriting", async () => {
    const { writes } = stubApi();
    renderBrand();
    await openNorth();
    fireEvent.change(box('Font family'), { target: { value: 'Lat' } });
    fireEvent.change(box('Font family'), { target: { value: 'Inter' } });
    expect(box('Font family')).toHaveAccessibleDescription(INHERITED);
    fireEvent.change(box('Display name'), { target: { value: '' } });
    expect(box('Display name')).toHaveAccessibleDescription(
      INHERITED + PENDING,
    );
    expect(box('Display name')).toHaveAttribute('placeholder', 'Acme');
    save();
    await screen.findByText('North brand profile saved.');
    expect(writes[0]?.body).toEqual({ displayName: null });
  });

  it('follows organization changes in inherited fields but not in overridden ones', async () => {
    const { server } = stubApi();
    renderBrand();
    await openNorth();
    server.organization.fontFamily = 'Roboto';
    server.organization.displayName = 'Acme Group';
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(box('Font family').value).toBe('Roboto'));
    expect(box('Display name').value).toBe('North shop');
    useOrganization('Display name');
    expect(box('Display name').value).toBe('Acme Group');
  });

  it('keeps every edit and the pending labels when a save fails, and the retry sends the same change', async () => {
    let fail = true;
    const { writes } = stubApi((method) =>
      method === 'PATCH' && fail
        ? reply(400, { message: 'Invalid brand profile' })
        : undefined,
    );
    renderBrand();
    await openNorth();
    useOrganization('Display name');
    fireEvent.change(box('Font family'), { target: { value: 'Lato' } });
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Invalid brand profile',
    );
    expect(box('Display name').value).toBe('Acme');
    expect(box('Display name')).toHaveAccessibleDescription(
      INHERITED + PENDING,
    );
    expect(box('Font family').value).toBe('Lato');
    expect(box('Font family')).toHaveAccessibleDescription(
      overridden() + PENDING,
    );
    fail = false;
    save();
    await screen.findByText('North brand profile saved.');
    expect(writes.map((write) => write.body)).toEqual([
      { displayName: null, fontFamily: 'Lato' },
      { displayName: null, fontFamily: 'Lato' },
    ]);
  });

  it('says so, and keeps the edits, when the save worked but the new values could not be loaded', async () => {
    let saved = false;
    stubApi((method, path) => {
      if (method === 'PATCH') saved = true;
      return saved && path === '/branches/b-1/brand/effective'
        ? reply(500, { message: 'down' })
        : undefined;
    });
    renderBrand();
    await openNorth();
    fireEvent.change(box('Font family'), { target: { value: 'Lato' } });
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "North brand profile saved. However, the latest brand values couldn't be loaded",
    );
    expect(box('Font family').value).toBe('Lato');
  });

  it("keeps each branch's own inheritance when switching scope, and drops unsaved edits of the scope left", async () => {
    const { writes } = stubApi();
    renderBrand();
    await openNorth();
    fireEvent.change(box('Font family'), { target: { value: 'Lato' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Brand scope' }), {
      target: { value: 'b-2' },
    });
    await waitFor(() => expect(box('Display name').value).toBe('Acme'));
    expect(box('Display name')).toHaveAccessibleDescription(INHERITED);
    expect(box('Font family').value).toBe('Inter');
    expect(box('Font family')).toHaveAccessibleDescription(INHERITED);
    expect(control('Primary color')).toHaveAccessibleDescription(
      overridden('South'),
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Brand scope' }), {
      target: { value: 'b-1' },
    });
    await openNorth();
    expect(box('Font family').value).toBe('Inter');
    expect(box('Font family')).toHaveAccessibleDescription(INHERITED);
    expect(writes).toHaveLength(0);
  });

  // Before Phase 3.2 the uncontrolled logo select could not show a logo
  // missing from the asset list (here: no assets:read), so saving the
  // organization profile sent logoAssetId null and erased the logo.
  it('keeps the organization profile as before (no inheritance labels, whole profile saved) without erasing a logo missing from the asset list', async () => {
    const { writes } = stubApi();
    renderBrand(
      userWith(['brand:read', 'brand:manage', 'organizations:update']),
      '',
    );
    await waitFor(() => expect(box('Display name').value).toBe('Acme'));
    expect(screen.queryByText(INHERITED)).toBeNull();
    const logo = control('Logo image') as HTMLSelectElement;
    expect(logo.value).toBe('org-logo');
    expect(logo.selectedOptions[0]?.textContent).toBe('Current logo');
    expect(
      screen.queryByRole('button', { name: /^Use organization value/ }),
    ).toBeNull();
    fireEvent.change(box('Font family'), { target: { value: 'Lato' } });
    save();
    await screen.findByText('Organization brand profile saved.');
    expect(writes).toEqual([
      {
        method: 'PATCH',
        path: '/organization/brand',
        body: {
          displayName: 'Acme',
          primaryColor: '#111111',
          secondaryColor: '#eeeeee',
          accentColor: '#2f6fed',
          fontFamily: 'Lato',
          websiteUrl: 'https://acme.example',
          logoAssetId: 'org-logo',
        },
      },
    ]);
  });

  it('lists overridden fields by name for read-only users without loading the organization profile', async () => {
    stubApi();
    const fetchMock = vi.mocked(fetch);
    // Start on the organization (which loads its profile), then open North.
    renderBrand(userWith(['brand:read']), '');
    expect(await screen.findByText('Acme')).toBeInTheDocument();
    fetchMock.mockClear();
    fireEvent.change(screen.getByRole('combobox', { name: 'Brand scope' }), {
      target: { value: 'b-1' },
    });
    expect(await screen.findByText('North shop')).toBeInTheDocument();
    expect(
      screen.getByText('Display name, Website, Logo image'),
    ).toBeInTheDocument();
    await act(async () => undefined);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).endsWith('/organization/brand'),
      ),
    ).toBe(false);
  });
});

// Hardening fix 2: an organization save keeps unset colours unset; it never
// sends the colour the picker shows for them.
describe('Organization brand colours', () => {
  const orgAdmin = userWith([
    'brand:read',
    'brand:manage',
    'organizations:update',
  ]);
  async function openOrganization(
    server: ReturnType<typeof stubApi>['server'],
  ) {
    server.organization.secondaryColor = null;
    server.organization.accentColor = null;
    renderBrand(orgAdmin, '');
    await waitFor(() => expect(box('Display name').value).toBe('Acme'));
  }

  it('sends untouched unset colours as unset, and keeps an existing colour', async () => {
    const api = stubApi();
    await openOrganization(api.server);
    // The pickers show a colour even though none is set.
    expect(control('Secondary color').value).toBe('#ffffff');
    fireEvent.change(box('Font family'), { target: { value: 'Lato' } });
    save();
    await screen.findByText('Organization brand profile saved.');
    expect(api.writes[0]?.body).toMatchObject({
      primaryColor: '#111111',
      secondaryColor: null,
      accentColor: null,
      fontFamily: 'Lato',
    });
    expect(api.server.organization.secondaryColor).toBeNull();
  });

  it('sends a colour the user chose', async () => {
    const api = stubApi();
    await openOrganization(api.server);
    fireEvent.change(control('Accent color'), { target: { value: '#ff0000' } });
    fireEvent.change(control('Primary color'), {
      target: { value: '#123456' },
    });
    save();
    await screen.findByText('Organization brand profile saved.');
    expect(api.writes[0]?.body).toMatchObject({
      primaryColor: '#123456',
      secondaryColor: null,
      accentColor: '#ff0000',
    });
  });

  it('leaves branches inheriting the unset colours, with nothing to save', async () => {
    const api = stubApi();
    await openOrganization(api.server);
    save();
    await screen.findByText('Organization brand profile saved.');
    fireEvent.change(screen.getByRole('combobox', { name: 'Brand scope' }), {
      target: { value: 'b-1' },
    });
    await openNorth();
    expect(control('Secondary color')).toHaveAccessibleDescription(INHERITED);
    save();
    expect(
      await screen.findByText('There are no changes to save.'),
    ).toBeInTheDocument();
    expect(api.writes).toHaveLength(1);
  });
});
