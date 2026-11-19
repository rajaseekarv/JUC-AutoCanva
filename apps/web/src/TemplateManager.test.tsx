import { afterEach, describe, expect, it, vi } from 'vitest';
import {
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

// Phase 2A: confirmations, readable labels and visible lifecycle help.
describe('TemplateManager Phase 2A', () => {
  const headline = {
    id: 'field-1',
    key: 'headline',
    label: 'Headline',
    type: 'TEXT',
    required: true,
    displayOrder: 0,
    defaultValue: null,
    helpText: null,
    dataSource: 'EFFECTIVE_BRAND',
    sourceKey: 'displayName',
    validationRules: null,
  } as unknown as NonNullable<
    TemplateResponse['currentVersion']
  >['fields'][number];
  const draftVersion = { ...template.currentVersion!, fields: [headline] };
  const draft: TemplateResponse = {
    ...template,
    currentVersion: draftVersion,
    versions: [draftVersion],
  };
  const frozen = {
    ...template.currentVersion!,
    immutableAt: '2026-01-02T00:00:00Z',
  };
  const active: TemplateResponse = {
    ...template,
    status: 'ACTIVE',
    activeVersionNumber: 1,
    currentVersion: frozen,
    versions: [frozen],
  };

  function serve(initial: TemplateResponse) {
    let current = initial;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/archive') && init?.method === 'POST') {
        current = { ...current, status: 'ARCHIVED' };
        return { ok: true, status: 200, json: async () => current };
      }
      if (url.endsWith('/fields/field-1') && init?.method === 'DELETE') {
        const emptied = { ...draftVersion, fields: [] };
        current = { ...current, currentVersion: emptied, versions: [emptied] };
        return { ok: true, status: 204, json: async () => undefined };
      }
      return {
        ok: true,
        status: 200,
        json: async () =>
          url.endsWith('/templates/template-1') ? current : [current],
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  const calls = (fetchMock: ReturnType<typeof serve>, suffix: string) =>
    fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix));

  async function open() {
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
    await screen.findByRole('heading', { name: 'Spring post' });
  }

  it('archives a template only after confirming that it cannot be undone', async () => {
    const fetchMock = serve(active);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    const group = screen.getByRole('group', {
      name: 'Confirm archiving Spring post',
    });
    expect(group).toHaveTextContent(
      'Archive “Spring post”? This cannot be undone. The template can no longer be edited, activated or chosen for new creatives. Creatives already made from it keep their saved revisions.',
    );
    fireEvent.click(
      within(group).getByRole('button', { name: 'Keep template' }),
    );
    expect(
      screen.queryByRole('group', { name: /Confirm archiving/ }),
    ).not.toBeInTheDocument();
    expect(calls(fetchMock, '/archive')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Archive' })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    fireEvent.click(
      within(
        screen.getByRole('group', { name: /Confirm archiving/ }),
      ).getByRole('button', { name: 'Archive template' }),
    );
    // Q1: success uses the success style, not the error style.
    expect(await screen.findByText('Template archived.')).toHaveClass(
      'success-message',
    );
    expect(calls(fetchMock, '/archive')).toHaveLength(1);
    expect(
      screen.queryByRole('group', { name: /Confirm archiving/ }),
    ).not.toBeInTheDocument();
  });

  it('removes a draft field only after confirmation', async () => {
    const fetchMock = serve(draft);
    await open();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Remove Headline' }),
    );
    const group = screen.getByRole('group', {
      name: 'Confirm removing Headline',
    });
    expect(group).toHaveTextContent(
      'Remove the “Headline” field from draft version 1? Creatives made from earlier, activated versions are not affected.',
    );
    fireEvent.click(within(group).getByRole('button', { name: 'Keep field' }));
    expect(calls(fetchMock, '/fields/field-1')).toHaveLength(0);
    expect(
      screen.getByRole('button', { name: 'Remove Headline' }),
    ).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Headline' }));
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Confirm removing Headline' }),
      ).getByRole('button', { name: 'Remove field' }),
    );
    expect(await screen.findByText('Field removed.')).toHaveClass(
      'success-message',
    );
    expect(calls(fetchMock, '/fields/field-1')).toHaveLength(1);
  });

  it('shows readable field types and units while sending the API codes', async () => {
    serve(draft);
    await open();
    // The field summary uses words; the key stays visible for admins.
    expect(
      screen.getByText(
        /Short text · required · filled from Effective brand \(displayName\)/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('headline')).toBeInTheDocument();
    expect(
      screen.getByText(/spring-post · Square · 1080 × 1080 px/),
    ).toBeInTheDocument();
    const addField = screen
      .getByRole('heading', { name: 'Add field' })
      .closest('form')!;
    const typeSelect = within(addField).getByLabelText('Type');
    expect(
      within(typeSelect).getByRole('option', { name: 'Paragraph' }),
    ).toHaveValue('MULTILINE_TEXT');
    expect(
      within(typeSelect).getByRole('option', { name: 'Yes / no' }),
    ).toHaveValue('BOOLEAN');
    expect(
      within(typeSelect).queryByRole('option', { name: 'MULTILINE_TEXT' }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New template' }));
    const unit = screen.getByLabelText('Unit');
    expect(
      within(unit).getByRole('option', { name: 'Pixels (px)' }),
    ).toHaveValue('PX');
    expect(
      within(unit).getByRole('option', { name: 'Inches (in)' }),
    ).toHaveValue('IN');
  });

  it('explains Activate and New draft in visible text linked to the buttons', async () => {
    serve(draft);
    await open();
    const activate = screen.getByRole('button', {
      name: 'Activate draft version',
    });
    const newDraft = screen.getByRole('button', {
      name: 'Create new draft version',
    });
    expect(activate).not.toHaveAttribute('title');
    expect(newDraft).not.toHaveAttribute('title');
    expect(
      screen.getByText(/locks draft version 1 so it can no longer be edited/),
    ).toBeVisible();
    expect(activate).toHaveAccessibleDescription(
      /Activate draft version: locks draft version 1/,
    );
    expect(newDraft).toHaveAccessibleDescription(
      /Create new draft version: a draft version is already in progress; activate it first\./,
    );
  });
});

// Phase 2A polish: activating a draft version is confirmed first.
describe('TemplateManager activation confirmation', () => {
  it('explains activation and activates only after confirmation', async () => {
    const frozenV1 = {
      ...template.currentVersion!,
      immutableAt: '2026-01-02T00:00:00Z',
    };
    const draftV2 = {
      ...frozenV1,
      id: 'version-2',
      versionNumber: 2,
      immutableAt: null,
    };
    let current: TemplateResponse = {
      ...template,
      status: 'ACTIVE',
      activeVersionNumber: 1,
      currentVersionNumber: 2,
      currentVersion: draftV2,
      versions: [draftV2, frozenV1],
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/activate') && init?.method === 'POST') {
        const frozenV2 = { ...draftV2, immutableAt: '2026-01-03T00:00:00Z' };
        current = {
          ...current,
          activeVersionNumber: 2,
          currentVersion: frozenV2,
          versions: [frozenV2, frozenV1],
        };
        return { ok: true, status: 200, json: async () => current };
      }
      return {
        ok: true,
        status: 200,
        json: async () =>
          url.endsWith('/templates/template-1') ? current : [current],
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    const activateCalls = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/activate'));
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
    const activate = await screen.findByRole('button', {
      name: 'Activate draft version',
    });
    fireEvent.click(activate);
    expect(activate).toHaveAttribute('aria-expanded', 'true');
    const group = screen.getByRole('group', {
      name: 'Confirm activating version 2',
    });
    expect(group).toHaveTextContent(
      'Activate draft version 2 of “Spring post”? The version is locked for good and can no longer be edited (to make later changes, create a new draft version), and new creatives will use it. Version 1 will no longer be offered for new creatives. Creatives already made keep their saved revisions.',
    );
    expect(activateCalls()).toHaveLength(0);

    fireEvent.click(
      within(group).getByRole('button', { name: 'Keep current version' }),
    );
    // Keep returns focus to the button that opened the confirmation.
    expect(activate).toHaveFocus();
    expect(
      screen.queryByRole('group', { name: /Confirm activating/ }),
    ).not.toBeInTheDocument();
    expect(activateCalls()).toHaveLength(0);

    fireEvent.click(activate);
    const confirmActivate = within(
      screen.getByRole('group', { name: 'Confirm activating version 2' }),
    ).getByRole('button', { name: 'Activate version 2' });
    // A real click focuses the button; it disappears with the confirmation.
    confirmActivate.focus();
    fireEvent.click(confirmActivate);
    expect(await screen.findByText('Template version activated.')).toHaveClass(
      'success-message',
    );
    expect(activateCalls()).toHaveLength(1);
    // The confirm button is gone, so the result takes focus.
    await waitFor(() =>
      expect(screen.getByText('Template version activated.')).toHaveFocus(),
    );
    expect(
      screen.queryByRole('group', { name: /Confirm activating/ }),
    ).not.toBeInTheDocument();
    expect(activate).toBeDisabled();
  });
});

describe('TemplateManager activation when a request fails', () => {
  const frozenV1 = {
    ...template.currentVersion!,
    immutableAt: '2026-01-02T00:00:00Z',
  };
  const draftV2 = {
    ...frozenV1,
    id: 'version-2',
    versionNumber: 2,
    immutableAt: null,
  };
  const withDraft: TemplateResponse = {
    ...template,
    status: 'ACTIVE',
    activeVersionNumber: 1,
    currentVersionNumber: 2,
    currentVersion: draftV2,
    versions: [draftV2, frozenV1],
  };
  function serve(failure: 'activate' | 'reload') {
    let activated = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/activate') && init?.method === 'POST') {
        if (failure === 'activate')
          return {
            ok: false,
            status: 409,
            json: async () => ({ message: 'There is no draft to activate' }),
          };
        activated = true;
        return { ok: true, status: 200, json: async () => withDraft };
      }
      // Once the activation went through, reloading the templates fails.
      if (activated && failure === 'reload')
        return { ok: false, status: 503, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () =>
          url.endsWith('/templates/template-1') ? withDraft : [withDraft],
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  async function confirmActivation(onTemplatesChanged = vi.fn()) {
    render(
      <TemplateManager
        session={{ accessToken: 'token', user }}
        onTemplatesChanged={onTemplatesChanged}
        onUnauthorized={vi.fn()}
      />,
    );
    await screen.findByRole('option', { name: /Spring post/ });
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Choose template' }),
      { target: { value: 'template-1' } },
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Activate draft version' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Activate version 2' }));
  }
  const activateCalls = (fetchMock: ReturnType<typeof serve>) =>
    fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/activate'));

  it('closes the confirmation and says the screen may be out of date when only the reload fails', async () => {
    const fetchMock = serve('reload');
    const onTemplatesChanged = vi.fn();
    await confirmActivation(onTemplatesChanged);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      "Template version activated. However, the latest template details couldn't be loaded, so this screen may be out of date. Reload the page before making more changes.",
    );
    // The activation is not offered again from the open confirmation, and
    // it is not retried.
    expect(
      screen.queryByRole('group', { name: /Confirm activating/ }),
    ).not.toBeInTheDocument();
    expect(activateCalls(fetchMock)).toHaveLength(1);
    // Other screens still learn that templates changed.
    expect(onTemplatesChanged).toHaveBeenCalled();
  });

  it('keeps the confirmation open with the reason when activation fails', async () => {
    const fetchMock = serve('activate');
    const onTemplatesChanged = vi.fn();
    await confirmActivation(onTemplatesChanged);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'There is no draft to activate',
    );
    expect(
      screen.getByRole('group', { name: 'Confirm activating version 2' }),
    ).toBeInTheDocument();
    expect(activateCalls(fetchMock)).toHaveLength(1);
    expect(onTemplatesChanged).not.toHaveBeenCalled();
    expect(
      screen.queryByText('Template version activated.'),
    ).not.toBeInTheDocument();
  });
});
