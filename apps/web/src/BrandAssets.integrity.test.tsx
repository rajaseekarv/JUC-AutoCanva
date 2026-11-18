// Phase 3.1 regression tests (C2): the brand form always holds the values
// of the scope (organization or branch) it saves to.
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

const user: AuthenticatedUserResponse = {
  id: 'user-1',
  organizationId: 'org-1',
  name: 'Admin',
  email: 'admin@example.local',
  permissions: ['brand:read', 'brand:manage', 'organizations:update'],
  branches: [
    { id: 'b-1', name: 'North', code: 'N' },
    { id: 'b-2', name: 'South', code: 'S' },
  ],
} as AuthenticatedUserResponse;

const ORG = {
  displayName: 'Org name',
  primaryColor: '#111111',
  secondaryColor: '#ffffff',
  accentColor: '#2f6fed',
  fontFamily: 'Inter',
  websiteUrl: 'https://org.example',
  logoAssetId: null,
};
const effective = (displayName: string, websiteUrl: string) => ({
  ...ORG,
  displayName,
  websiteUrl,
  overriddenFields: ['displayName', 'websiteUrl'],
});
const NORTH = effective('North shop', 'https://north.example');
const SOUTH = effective('South shop', 'https://south.example');

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
      if (path === '/organization/brand') return reply(200, ORG);
      if (path === '/branches/b-1/brand/effective') return reply(200, NORTH);
      if (path === '/branches/b-2/brand/effective') return reply(200, SOUTH);
      if (method === 'PATCH' && path === '/branches/b-1/brand')
        return reply(200, NORTH);
      if (method === 'PATCH' && path === '/branches/b-2/brand')
        return reply(200, SOUTH);
      return reply(404, { message: 'Not found' });
    }),
  );
  return writes;
}

function renderBrand() {
  render(
    <BrandAssets
      session={{ accessToken: 'token', user }}
      branch={null}
      onUnauthorized={vi.fn()}
    />,
  );
}

const scope = () => screen.getByRole('combobox', { name: 'Brand scope' });
const displayName = () =>
  screen.getByRole('textbox', { name: 'Display name' }) as HTMLInputElement;
const website = () =>
  screen.getByRole('textbox', { name: 'Website' }) as HTMLInputElement;
const save = () => screen.getByRole('button', { name: 'Save brand profile' });

async function chooseScope(value: string, expectedName?: string) {
  fireEvent.change(scope(), { target: { value } });
  if (expectedName)
    await waitFor(() => expect(displayName().value).toBe(expectedName));
}

describe('BrandAssets scope switching (C2)', () => {
  it("shows each scope its own values after a clean switch, and saves the second branch's values to it (probe C)", async () => {
    const writes = stubApi();
    renderBrand();
    await waitFor(() => expect(displayName().value).toBe('Org name'));
    await chooseScope('b-1', 'North shop');
    await chooseScope('b-2', 'South shop');
    expect(website().value).toBe('https://south.example');
    fireEvent.click(save());
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.path).toBe('/branches/b-2/brand');
    expect(writes[0]?.body).toMatchObject({
      displayName: 'South shop',
      websiteUrl: 'https://south.example',
    });
  });

  it("never saves the organization's unsaved values into a branch", async () => {
    const writes = stubApi();
    renderBrand();
    await waitFor(() => expect(displayName().value).toBe('Org name'));
    fireEvent.change(displayName(), { target: { value: 'Org typed' } });
    await chooseScope('b-1', 'North shop');
    fireEvent.click(save());
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.path).toBe('/branches/b-1/brand');
    expect(writes[0]?.body.displayName).toBe('North shop');
  });

  it('offers no form, and so no save, while the chosen scope is still loading', async () => {
    const north = deferred<Response>();
    const writes = stubApi((_method, path) =>
      path === '/branches/b-1/brand/effective' ? north.promise : undefined,
    );
    renderBrand();
    await waitFor(() => expect(displayName().value).toBe('Org name'));
    await chooseScope('b-1');
    expect(
      screen.queryByRole('button', { name: 'Save brand profile' }),
    ).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Display name' })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading North brand…',
    );
    await act(async () => north.resolve(reply(200, NORTH)));
    expect(displayName().value).toBe('North shop');
    expect(writes).toHaveLength(0);
  });

  it('ignores a late response for a scope that is no longer chosen', async () => {
    const north = deferred<Response>();
    const writes = stubApi((_method, path) =>
      path === '/branches/b-1/brand/effective' ? north.promise : undefined,
    );
    renderBrand();
    await waitFor(() => expect(displayName().value).toBe('Org name'));
    await chooseScope('b-1');
    await chooseScope('b-2', 'South shop');
    await act(async () => north.resolve(reply(200, NORTH)));
    expect(
      screen.getByRole('heading', { name: 'South brand' }),
    ).toBeInTheDocument();
    expect(displayName().value).toBe('South shop');
    fireEvent.click(save());
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.path).toBe('/branches/b-2/brand');
    expect(writes[0]?.body.displayName).toBe('South shop');
  });

  it("does not let an earlier scope's save result replace the newly chosen scope", async () => {
    const orgSave = deferred<Response>();
    const writes = stubApi((method, path) =>
      method === 'PATCH' && path === '/organization/brand'
        ? orgSave.promise
        : undefined,
    );
    renderBrand();
    await waitFor(() => expect(displayName().value).toBe('Org name'));
    fireEvent.change(displayName(), { target: { value: 'Org renamed' } });
    fireEvent.click(save());
    await waitFor(() => expect(writes).toHaveLength(1));
    await chooseScope('b-1', 'North shop');
    await act(async () =>
      orgSave.resolve(reply(200, { ...ORG, displayName: 'Org renamed' })),
    );
    expect(writes[0]).toMatchObject({
      path: '/organization/brand',
      body: { displayName: 'Org renamed' },
    });
    expect(
      screen.getByText(/Organization brand profile saved\./),
    ).toBeVisible();
    expect(displayName().value).toBe('North shop');
    expect(
      screen.getByRole('heading', { name: 'North brand' }),
    ).toBeInTheDocument();
  });
});
