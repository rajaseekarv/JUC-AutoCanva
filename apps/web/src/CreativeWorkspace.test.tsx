import { afterEach, describe, expect, it, vi } from 'vitest';
import {
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
  CreativeRevisionResponse,
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
const template: TemplateResponse = {
  id: 'template-1',
  name: 'Social post',
  code: 'social',
  description: null,
  category: null,
  status: 'ACTIVE',
  formatName: 'Square',
  width: 1080,
  height: 1080,
  unit: 'PX',
  currentVersionNumber: 1,
  activeVersionNumber: 1,
  updatedAt: '2026-01-01T00:00:00Z',
};
const version = {
  id: 'version-1',
  templateId: 'template-1',
  versionNumber: 1,
  name: 'Social post',
  description: null,
  category: null,
  formatName: 'Square',
  width: 1080,
  height: 1080,
  unit: 'PX' as const,
  immutableAt: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  fields: [
    {
      id: 'field-1',
      key: 'headline',
      label: 'Headline',
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
const detail: TemplateResponse = { ...template, versions: [version] };
const revision: CreativeRevisionResponse = {
  id: 'revision-1',
  revisionNumber: 1,
  templateVersionId: version.id,
  values: { headline: 'Original' },
  summary: null,
  createdById: 'user-1',
  createdAt: '2026-01-01T00:00:00Z',
  templateVersion: version,
};
const creative: CreativeResponse = {
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
};

describe('CreativeWorkspace', () => {
  it('explains why creation is unavailable until an active template exists', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url.includes('/creatives?') ? [] : []),
    }));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <CreativeWorkspace
        session={{ accessToken: 'token', user }}
        branch={branch}
        onUnauthorized={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'New creative' }),
    );
    expect(
      await screen.findByText(/No active templates are available/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Templates' })).toHaveAttribute(
      'href',
      '#templates',
    );
    expect(screen.getByRole('combobox', { name: 'Template' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Launch' },
    });
    fireEvent.change(screen.getByLabelText('Revision summary'), {
      target: { value: 'Initial revision' },
    });
    expect(
      screen.getByRole('button', { name: 'Create creative' }),
    ).toBeDisabled();
  });

  it('reloads eligible templates after the template manager changes them', async () => {
    let availableTemplates: TemplateResponse[] = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => {
        if (url.endsWith('/templates')) return availableTemplates;
        if (url.endsWith('/templates/template-1')) return detail;
        return [];
      },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const onUnauthorized = vi.fn();
    const renderWorkspace = (templateRefreshKey: number) => (
      <CreativeWorkspace
        session={{ accessToken: 'token', user }}
        branch={branch}
        templateRefreshKey={templateRefreshKey}
        onUnauthorized={onUnauthorized}
      />
    );
    const view = render(renderWorkspace(0));
    fireEvent.click(
      await screen.findByRole('button', { name: 'New creative' }),
    );
    expect(
      await screen.findByText(/No active templates are available/),
    ).toBeInTheDocument();

    availableTemplates = [template];
    view.rerender(renderWorkspace(1));

    expect(
      await screen.findByRole('option', { name: 'Social post' }),
    ).toBeInTheDocument();
  });

  it('creates a creative with fields from the selected active template version', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/creatives?'))
          return { ok: true, status: 200, json: async () => [] };
        if (url.endsWith('/templates'))
          return { ok: true, status: 200, json: async () => [template] };
        if (url.includes('/assets?'))
          return { ok: true, status: 200, json: async () => [] };
        if (url.endsWith('/templates/template-1'))
          return { ok: true, status: 200, json: async () => detail };
        if (url.endsWith('/creatives') && init?.method === 'POST')
          return { ok: true, status: 201, json: async () => creative };
        return { ok: true, status: 200, json: async () => [] };
      });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <CreativeWorkspace
        session={{ accessToken: 'token', user }}
        branch={branch}
        onUnauthorized={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'New creative' }),
    );
    fireEvent.change(
      await screen.findByRole('combobox', { name: 'Template' }),
      { target: { value: template.id } },
    );
    const headline = await screen.findByRole('textbox', { name: 'Headline' });
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Launch' },
    });
    fireEvent.change(headline, { target: { value: 'Fresh headline' } });
    const createButton = screen.getByRole('button', {
      name: 'Create creative',
    });
    expect(createButton).toBeEnabled();
    fireEvent.click(createButton);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Creative created.',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/creatives'),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('Fresh headline'),
      }),
    );
  });

  it('enables Create creative only with a trimmed name, a selected version, and required values', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/templates'))
        return { ok: true, status: 200, json: async () => [template] };
      if (url.endsWith('/templates/template-1'))
        return { ok: true, status: 200, json: async () => detail };
      return { ok: true, status: 200, json: async () => [] };
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <CreativeWorkspace
        session={{ accessToken: 'token', user }}
        branch={branch}
        onUnauthorized={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'New creative' }),
    );
    const createButton = screen.getByRole('button', {
      name: 'Create creative',
    });
    const nameInput = screen.getByLabelText('Name');

    // Missing version: a valid name alone is not enough.
    fireEvent.change(nameInput, { target: { value: 'Launch' } });
    expect(createButton).toBeDisabled();

    fireEvent.change(
      await screen.findByRole('combobox', { name: 'Template' }),
      { target: { value: template.id } },
    );
    const headline = await screen.findByRole('textbox', { name: 'Headline' });
    const versionSelect = screen.getByRole('combobox', {
      name: 'Template version',
    });
    expect(versionSelect).toHaveValue('version-1');
    fireEvent.change(headline, { target: { value: 'Fresh headline' } });

    // Valid name with a selected version and required values.
    expect(createButton).toBeEnabled();

    // Empty name.
    fireEvent.change(nameInput, { target: { value: '' } });
    expect(createButton).toBeDisabled();

    // Whitespace-only name.
    fireEvent.change(nameInput, { target: { value: '   ' } });
    expect(createButton).toBeDisabled();

    fireEvent.change(nameInput, { target: { value: '  Launch  ' } });
    expect(createButton).toBeEnabled();

    // Whitespace-only value for a required template field.
    fireEvent.change(headline, { target: { value: '  ' } });
    expect(createButton).toBeDisabled();
    fireEvent.change(headline, { target: { value: 'Fresh headline' } });
    expect(createButton).toBeEnabled();

    // Version deselected after being chosen.
    fireEvent.change(versionSelect, { target: { value: '' } });
    expect(createButton).toBeDisabled();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith('/creatives') &&
          (init as RequestInit | undefined)?.method === 'POST',
      ),
    ).toBe(false);
  });

  it('keeps offering the active version, not the draft, while a newer template draft exists', async () => {
    const draftVersion = {
      ...version,
      id: 'version-2',
      versionNumber: 2,
      immutableAt: null,
      fields: [{ ...version.fields[0]!, id: 'field-2', label: 'Draft only' }],
    };
    const withDraft: TemplateResponse = {
      ...template,
      currentVersionNumber: 2,
      activeVersionNumber: 1,
    };
    const fetchMock = vi
      .fn()
      .mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/templates'))
          return { ok: true, status: 200, json: async () => [withDraft] };
        if (url.endsWith('/templates/template-1'))
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ...withDraft,
              versions: [draftVersion, version],
            }),
          };
        if (url.endsWith('/creatives') && init?.method === 'POST')
          return { ok: true, status: 201, json: async () => creative };
        return { ok: true, status: 200, json: async () => [] };
      });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <CreativeWorkspace
        session={{ accessToken: 'token', user }}
        branch={branch}
        onUnauthorized={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'New creative' }),
    );
    fireEvent.change(
      await screen.findByRole('combobox', { name: 'Template' }),
      { target: { value: template.id } },
    );
    const headline = await screen.findByRole('textbox', { name: 'Headline' });
    const versionSelect = screen.getByRole('combobox', {
      name: 'Template version',
    });
    expect(
      Array.from((versionSelect as HTMLSelectElement).options).map(
        (option) => option.textContent,
      ),
    ).toEqual(['Choose version', 'Version 1']);
    expect(versionSelect).toHaveValue('version-1');
    expect(
      screen.queryByRole('textbox', { name: 'Draft only' }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Launch' },
    });
    fireEvent.change(headline, { target: { value: 'Live headline' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create creative' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Creative created.',
    );
    const post = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/creatives') &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toMatchObject({
      templateVersionId: 'version-1',
    });
  });

  it('saves edits as a new revision and exposes prior values read-only', async () => {
    const historyRevision = { ...revision, values: { headline: 'Original' } };
    const updated = {
      ...creative,
      currentRevisionId: 'revision-2',
      currentRevision: {
        ...revision,
        id: 'revision-2',
        revisionNumber: 2,
        values: { headline: 'Revised' },
      },
    };
    const fetchMock = vi
      .fn()
      .mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/creatives?'))
          return { ok: true, status: 200, json: async () => [creative] };
        if (url.endsWith('/templates'))
          return { ok: true, status: 200, json: async () => [template] };
        if (url.includes('/assets?'))
          return { ok: true, status: 200, json: async () => [] };
        if (url.endsWith('/templates/template-1'))
          return { ok: true, status: 200, json: async () => detail };
        if (url.endsWith('/creatives/creative-1/revisions'))
          return { ok: true, status: 200, json: async () => [historyRevision] };
        if (url.endsWith('/creatives/creative-1') && init?.method === 'PATCH')
          return { ok: true, status: 200, json: async () => updated };
        return { ok: true, status: 200, json: async () => [] };
      });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <CreativeWorkspace
        session={{ accessToken: 'token', user }}
        branch={branch}
        onUnauthorized={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    const headline = await screen.findByRole('textbox', { name: 'Headline' });
    fireEvent.change(headline, { target: { value: 'Revised' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'new immutable revision',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/creatives/creative-1'),
      expect.objectContaining({ method: 'PATCH' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect' }));
    await waitFor(() =>
      expect(screen.getByText('Revision 1 · read only')).toBeInTheDocument(),
    );
    expect(screen.getByText('Original')).toBeInTheDocument();
  });

  it('does not render creative data without read permission', () => {
    render(
      <CreativeWorkspace
        session={{ accessToken: 'token', user: { ...user, permissions: [] } }}
        branch={branch}
        onUnauthorized={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole('heading', { name: /Creatives/ }),
    ).not.toBeInTheDocument();
  });
});

describe('CreativeWorkspace branch changes', () => {
  const southBranch: BranchResponse = {
    id: 'branch-2',
    name: 'South',
    code: 'SOUTH',
    status: 'ACTIVE',
  };
  const southCreative: CreativeResponse = {
    ...creative,
    id: 'creative-9',
    branchId: 'branch-2',
    name: 'South launch',
  };

  // Branch-scoped creatives per branch; a gate can hold a branch's response.
  function renderAcrossBranches(gates: Record<string, Promise<void>> = {}) {
    const fetchMock = vi
      .fn()
      .mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/creatives?branchId=branch-1')) {
          await gates['branch-1'];
          return { ok: true, status: 200, json: async () => [creative] };
        }
        if (url.includes('/creatives?branchId=branch-2')) {
          await gates['branch-2'];
          return { ok: true, status: 200, json: async () => [southCreative] };
        }
        if (url.endsWith('/templates'))
          return { ok: true, status: 200, json: async () => [template] };
        if (url.endsWith('/templates/template-1'))
          return { ok: true, status: 200, json: async () => detail };
        if (url.includes('/revisions'))
          return { ok: true, status: 200, json: async () => [revision] };
        if (init?.method === 'PATCH')
          return { ok: true, status: 200, json: async () => southCreative };
        return { ok: true, status: 200, json: async () => [] };
      });
    vi.stubGlobal('fetch', fetchMock);
    const onUnauthorized = vi.fn();
    const ui = (activeBranch: BranchResponse) => (
      <CreativeWorkspace
        session={{ accessToken: 'token', user }}
        branch={activeBranch}
        onUnauthorized={onUnauthorized}
      />
    );
    const view = render(ui(branch));
    return {
      fetchMock,
      switchBranch: (next: BranchResponse) => view.rerender(ui(next)),
    };
  }

  const patches = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls
      .filter(
        ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
      )
      .map(([url]) => String(url));

  it('clears an open creative from the previous branch so it cannot be saved', async () => {
    const { fetchMock, switchBranch } = renderAcrossBranches();
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect(
      await screen.findByRole('textbox', { name: 'Headline' }),
    ).toHaveValue('Original');

    switchBranch(southBranch);

    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Headline' })).toBeNull(),
    );
    expect(
      screen.queryByRole('button', { name: 'Save new revision' }),
    ).toBeNull();
    expect(await screen.findByText('South launch')).toBeInTheDocument();
    expect(screen.queryByText('Launch')).toBeNull();
    expect(patches(fetchMock)).toEqual([]);
  });

  it('ignores a late response for the previous branch and saves only the current branch creative', async () => {
    let releaseNorth!: () => void;
    const northGate = new Promise<void>((resolve) => {
      releaseNorth = resolve;
    });
    const { fetchMock, switchBranch } = renderAcrossBranches({
      'branch-1': northGate,
    });
    // Switch before the first branch's creatives arrive, then let them land.
    switchBranch(southBranch);
    expect(await screen.findByText('South launch')).toBeInTheDocument();
    releaseNorth();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes('branchId=branch-1'),
        ),
      ).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('Launch')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Open' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const headline = await screen.findByRole('textbox', { name: 'Headline' });
    fireEvent.change(headline, { target: { value: 'South revision' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));
    await screen.findByText(/new immutable revision/);
    expect(patches(fetchMock)).toEqual([
      expect.stringContaining('/creatives/creative-9'),
    ]);
  });
});
