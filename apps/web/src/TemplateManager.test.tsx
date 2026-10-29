import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  permissions: [
    'templates:read',
    'templates:create',
    'templates:edit',
    'templates:activate',
    'templates:archive',
  ],
  branches: [],
};
const template: TemplateResponse = {
  id: 'template-1',
  name: 'Spring post',
  code: 'spring-post',
  description: null,
  category: null,
  status: 'DRAFT',
  formatName: 'Square',
  width: 1080,
  height: 1080,
  unit: 'PX',
  currentVersionNumber: 1,
  activeVersionNumber: null,
  updatedAt: '2026-01-01T00:00:00Z',
  currentVersion: {
    id: 'version-1',
    versionNumber: 1,
    name: 'Spring post',
    description: null,
    category: null,
    formatName: 'Square',
    width: 1080,
    height: 1080,
    unit: 'PX',
    immutableAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    fields: [],
  },
};

describe('TemplateManager', () => {
  it('loads the new draft after creation so its fields can be added immediately', async () => {
    const createdDraft = { ...template, versions: [template.currentVersion!] };
    const fetchMock = vi
      .fn()
      .mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/templates') && init?.method === 'POST')
          return { ok: true, status: 201, json: async () => template };
        if (url.endsWith('/templates/template-1'))
          return { ok: true, status: 200, json: async () => createdDraft };
        return { ok: true, status: 200, json: async () => [template] };
      });
    vi.stubGlobal('fetch', fetchMock);
    const onTemplatesChanged = vi.fn();
    render(
      <TemplateManager
        session={{ accessToken: 'token', user }}
        onTemplatesChanged={onTemplatesChanged}
        onUnauthorized={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'New template' }),
    );
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Spring post' },
    });
    fireEvent.change(screen.getByLabelText('Code'), {
      target: { value: 'spring-post' },
    });
    fireEvent.change(screen.getByLabelText('Format'), {
      target: { value: 'Square' },
    });
    fireEvent.change(screen.getByLabelText('Width'), {
      target: { value: '1080' },
    });
    fireEvent.change(screen.getByLabelText('Height'), {
      target: { value: '1080' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));

    expect(
      await screen.findByRole('heading', { name: 'Spring post' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Add field' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Activate draft version' }),
    ).toBeInTheDocument();
    expect(onTemplatesChanged).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/templates/template-1'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token' }),
      }),
    );
  });

  it('loads organization templates and exposes draft lifecycle actions', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url.endsWith('/template-1') ? template : [template]),
    }));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <TemplateManager
        session={{ accessToken: 'token', user }}
        onUnauthorized={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole('option', { name: /Spring post/ }),
    ).toBeInTheDocument();
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Choose template' }),
      {
        target: { value: 'template-1' },
      },
    );
    expect(
      await screen.findByRole('heading', { name: 'Spring post' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'New template' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Activate draft version' }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/templates'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token' }),
      }),
    );
  });

  it('does not render template controls without the read permission', () => {
    render(
      <TemplateManager
        session={{ accessToken: 'token', user: { ...user, permissions: [] } }}
        onUnauthorized={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole('heading', { name: 'Templates' }),
    ).not.toBeInTheDocument();
  });

  it('opens the validated create-template form for users with create permission', () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, json: async () => [] }),
    );
    render(
      <TemplateManager
        session={{ accessToken: 'token', user }}
        onUnauthorized={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'New template' }));
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Width')).toHaveAttribute('type', 'number');
  });

  it('keeps lifecycle buttons in place so a repeated click cannot trigger a different action', async () => {
    const frozenV1 = {
      ...template.currentVersion!,
      immutableAt: '2026-01-02T00:00:00Z',
    };
    const activeTemplate: TemplateResponse = {
      ...template,
      status: 'ACTIVE',
      activeVersionNumber: 1,
      currentVersion: frozenV1,
      versions: [frozenV1],
    };
    const draftV2 = {
      ...frozenV1,
      id: 'version-2',
      versionNumber: 2,
      immutableAt: null,
    };
    const withDraft: TemplateResponse = {
      ...activeTemplate,
      currentVersionNumber: 2,
      currentVersion: draftV2,
      versions: [draftV2, frozenV1],
    };
    let current = activeTemplate;
    const fetchMock = vi
      .fn()
      .mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/versions') && init?.method === 'POST') {
          current = withDraft;
          return { ok: true, status: 201, json: async () => draftV2 };
        }
        return {
          ok: true,
          status: 200,
          json: async () =>
            url.endsWith('/templates/template-1') ? current : [current],
        };
      });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <TemplateManager
        session={{ accessToken: 'token', user }}
        onUnauthorized={vi.fn()}
      />,
    );
    await screen.findByRole('option', { name: /Spring post/ });
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Choose template' }),
      { target: { value: 'template-1' } },
    );
    const lifecycleNames = () =>
      screen
        .getAllByRole('button')
        .map((button) => button.textContent)
        .filter((name) => /draft version|Archive/.test(name ?? ''));
    const createVersion = await screen.findByRole('button', {
      name: 'Create new draft version',
    });
    const activate = screen.getByRole('button', {
      name: 'Activate draft version',
    });
    expect(activate).toBeDisabled();
    expect(createVersion).toBeEnabled();
    expect(
      screen.queryByRole('heading', { name: 'Add field' }),
    ).not.toBeInTheDocument();
    const initialOrder = lifecycleNames();

    fireEvent.click(createVersion);
    expect(await screen.findByText(/draft v2 in progress/)).toBeInTheDocument();
    // Same elements, same order: only their enabled state changed.
    expect(lifecycleNames()).toEqual(initialOrder);
    expect(createVersion).toBeDisabled();
    expect(activate).toBeEnabled();
    expect(
      screen.getByRole('heading', { name: 'Add field' }),
    ).toBeInTheDocument();
    fireEvent.click(createVersion);
    const versionPosts = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith('/versions') &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(versionPosts).toHaveLength(1);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith('/activate')),
    ).toBe(false);
  });

  it('hides lifecycle actions the user is not permitted to perform', async () => {
    const activeTemplate: TemplateResponse = {
      ...template,
      status: 'ACTIVE',
      activeVersionNumber: 1,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () =>
          url.endsWith('/template-1') ? activeTemplate : [activeTemplate],
      })),
    );
    render(
      <TemplateManager
        session={{
          accessToken: 'token',
          user: { ...user, permissions: ['templates:read'] },
        }}
        onUnauthorized={vi.fn()}
      />,
    );
    await screen.findByRole('option', { name: /Spring post/ });
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Choose template' }),
      { target: { value: 'template-1' } },
    );
    await screen.findByRole('heading', { name: 'Spring post' });
    expect(
      screen.queryByRole('button', { name: /draft version/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Add field' }),
    ).not.toBeInTheDocument();
  });
});
