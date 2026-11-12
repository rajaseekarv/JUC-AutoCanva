import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  BranchResponse,
  CreativeResponse,
  CreativeRevisionResponse,
  TemplateResponse,
} from '@adflow/shared-types';
import CreativeWorkspace from './CreativeWorkspace';
import { imageReply, statusReply, stubObjectUrls } from './assetTestUtils';

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

describe('CreativeWorkspace images', () => {
  let objectUrls: ReturnType<typeof stubObjectUrls>;
  beforeEach(() => {
    objectUrls = stubObjectUrls();
  });
  afterEach(() => {
    // Unmount first: images release their object URLs as they unmount.
    cleanup();
    objectUrls.restore();
  });

  const imageVersion = {
    ...version,
    fields: [
      ...version.fields,
      {
        ...version.fields[0]!,
        id: 'field-2',
        key: 'hero',
        label: 'Hero image',
        type: 'IMAGE' as const,
        required: false,
        displayOrder: 1,
      },
    ],
  };
  const imageDetail: TemplateResponse = {
    ...template,
    versions: [imageVersion],
  };
  const assetRecord = (id: string, originalName: string) => ({
    id,
    organizationId: 'org-1',
    branchId: 'branch-1',
    originalName,
    mimeType: 'image/png',
    sizeBytes: 4096,
    width: 1080,
    height: 1080,
    status: 'ACTIVE',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  });
  const assetsById: Record<string, ReturnType<typeof assetRecord>> = {
    'asset-old': assetRecord('asset-old', 'old-hero.png'),
    'asset-new': assetRecord('asset-new', 'new-hero.png'),
  };
  const firstRevision: CreativeRevisionResponse = {
    ...revision,
    templateVersion: imageVersion,
    values: { headline: 'Original', hero: 'asset-old' },
  };
  const secondRevision: CreativeRevisionResponse = {
    ...firstRevision,
    id: 'revision-2',
    revisionNumber: 2,
    values: { headline: 'Revised', hero: 'asset-new' },
  };
  const imageCreative: CreativeResponse = {
    ...creative,
    currentRevisionId: secondRevision.id,
    currentRevision: secondRevision,
  };

  function serveCreative(missing: string[] = []) {
    const fetchMock = vi.fn(async (url: string) => {
      const assetMatch = /\/assets\/([^/?]+)(\/content)?$/.exec(url);
      if (assetMatch) {
        const assetId = decodeURIComponent(assetMatch[1] ?? '');
        const record = assetsById[assetId];
        if (!record || missing.includes(assetId))
          return statusReply(404, { message: 'Asset not found' });
        return assetMatch[2] ? imageReply(assetId) : statusReply(200, record);
      }
      if (url.includes('/creatives?')) return statusReply(200, [imageCreative]);
      if (url.endsWith('/templates')) return statusReply(200, [template]);
      if (url.includes('/assets?'))
        return statusReply(200, Object.values(assetsById));
      if (url.endsWith('/templates/template-1'))
        return statusReply(200, imageDetail);
      if (url.endsWith('/creatives/creative-1/revisions'))
        return statusReply(200, [secondRevision, firstRevision]);
      return statusReply(200, []);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('shows each historical revision its own referenced image, not the latest one', async () => {
    const fetchMock = serveCreative();
    render(
      <CreativeWorkspace
        session={{ accessToken: 'token', user }}
        branch={branch}
        onUnauthorized={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    // The editor previews the current revision's selection.
    expect(
      await screen.findByRole('img', {
        name: 'Hero image preview: new-hero.png',
      }),
    ).toHaveAttribute('src', expect.stringMatching(/^blob:test\/asset-new\//));

    const inspectButtons = await screen.findAllByRole('button', {
      name: 'Inspect',
    });
    fireEvent.click(inspectButtons[1]!);
    await screen.findByText('Revision 1 · read only');
    const inspection = screen
      .getByText('Revision 1 · read only')
      .closest('.creative-inspection') as HTMLElement;
    expect(
      await within(inspection).findByRole('img', {
        name: 'Hero image: old-hero.png',
      }),
    ).toHaveAttribute('src', expect.stringMatching(/^blob:test\/asset-old\//));
    expect(within(inspection).getByText('old-hero.png')).toBeInTheDocument();
    expect(within(inspection).queryByText('new-hero.png')).toBeNull();
    expect(within(inspection).queryByText('asset-old')).toBeNull();

    fireEvent.click(inspectButtons[0]!);
    await screen.findByText('Revision 2 · read only');
    expect(
      await within(inspection).findByRole('img', {
        name: 'Hero image: new-hero.png',
      }),
    ).toHaveAttribute('src', expect.stringMatching(/^blob:test\/asset-new\//));
    expect(within(inspection).queryByText('old-hero.png')).toBeNull();

    for (const [url, init] of fetchMock.mock.calls as unknown as [
      string,
      RequestInit,
    ][])
      if (url.includes('/assets/asset-'))
        expect(init.headers).toEqual({ Authorization: 'Bearer token' });
  });

  it('explains a revision image whose asset is no longer available', async () => {
    serveCreative(['asset-old']);
    render(
      <CreativeWorkspace
        session={{ accessToken: 'token', user }}
        branch={branch}
        onUnauthorized={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    const inspectButtons = await screen.findAllByRole('button', {
      name: 'Inspect',
    });
    fireEvent.click(inspectButtons[1]!);
    expect(
      await screen.findByText(
        'Image unavailable — the asset was removed or cannot be found',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('asset-old')).toBeNull();
  });

  it('shows no image and requests none without asset read permission', async () => {
    const fetchMock = serveCreative();
    render(
      <CreativeWorkspace
        session={{
          accessToken: 'token',
          user: {
            ...user,
            permissions: user.permissions.filter(
              (permission) => permission !== 'assets:read',
            ),
          },
        }}
        branch={branch}
        onUnauthorized={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    const inspectButtons = await screen.findAllByRole('button', {
      name: 'Inspect',
    });
    fireEvent.click(inspectButtons[1]!);
    await screen.findByText('Revision 1 · read only');
    expect(
      screen.getAllByText(
        'Image selected · you do not have permission to view assets',
      ).length,
    ).toBeGreaterThan(0);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/assets/')),
    ).toBe(false);
  });
});

describe('CreativeWorkspace review feedback and resubmission', () => {
  const submitter: AuthenticatedUserResponse = {
    ...user,
    permissions: [
      'creatives:read',
      'creatives:update',
      'templates:read',
      'comments:read',
      'comments:create',
      'approvals:read',
      'change_requests:read',
      'workflows:read',
      'workflows:start',
    ],
  };
  const revisionTwo: CreativeRevisionResponse = {
    ...revision,
    id: 'revision-2',
    revisionNumber: 2,
    values: { headline: 'Revised' },
  };
  const atRevision = (current: CreativeRevisionResponse): CreativeResponse => ({
    ...creative,
    currentRevisionId: current.id,
    currentRevision: current,
  });
  type Request = {
    id: string;
    revisionNumber: number;
    requestedChanges: string;
    explanation: string | null;
    status: string;
  };

  // A creative whose latest run ended with changes requested on revision 1.
  // Starting a run for a newer revision resolves the request, as the API does.
  function serveReview(
    options: {
      current?: CreativeRevisionResponse;
      runStatus?: string;
      startStatus?: number;
      requests?: Request[];
      // The stage the started run is at, as the API returns it.
      startStage?: { key: string; name: string; requiresReview: boolean };
      // Extra fields of the creative as the list returns it.
      listed?: Partial<CreativeResponse>;
      // Stage 12: a refused revision save, and requests held until released.
      patchStatus?: number;
      holdPatch?: boolean;
      holdRun?: boolean;
    } = {},
  ) {
    let releasePatch: () => void = () => undefined;
    const patchHeld = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });
    let releaseRun: () => void = () => undefined;
    const runHeld = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let current = options.current ?? revisionTwo;
    let runStatus = options.runStatus ?? 'COMPLETED';
    let creativeStatus = 'changes';
    const requests = options.requests ?? [
      {
        id: 'request-1',
        revisionNumber: 1,
        requestedChanges: 'Logo is too small',
        explanation: 'Use the large variant',
        status: 'OPEN',
      },
    ];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (
        url.endsWith('/creatives/creative-1/workflows') &&
        method === 'POST'
      ) {
        if (options.startStatus)
          return statusReply(options.startStatus, {
            message: 'Enabled workflow not found',
          });
        runStatus = 'RUNNING';
        creativeStatus = options.startStage?.key ?? 'review';
        for (const request of requests)
          if (request.revisionNumber < current.revisionNumber)
            request.status = 'RESOLVED';
        return statusReply(201, {
          id: 'instance-2',
          ...(options.startStage ? { currentStage: options.startStage } : {}),
        });
      }
      if (url.endsWith('/creatives/creative-1') && method === 'PATCH') {
        if (options.holdPatch) await patchHeld;
        if (options.patchStatus)
          return statusReply(options.patchStatus, {
            message: 'Headline is required',
          });
        current = revisionTwo;
        return statusReply(200, atRevision(current));
      }
      if (url.includes('/creatives?'))
        return statusReply(200, [
          { ...atRevision(current), status: creativeStatus, ...options.listed },
        ]);
      if (url.endsWith('/templates')) return statusReply(200, [template]);
      if (url.endsWith('/templates/template-1'))
        return statusReply(200, detail);
      if (url.endsWith('/creatives/creative-1/revisions'))
        return statusReply(
          200,
          current.revisionNumber === 2 ? [revisionTwo, revision] : [revision],
        );
      if (url.endsWith('/creatives/creative-1/workflow')) {
        if (options.holdRun) await runHeld;
        return statusReply(200, {
          id: 'instance-1',
          status: runStatus,
          workflowId: 'workflow-1',
          creativeRevisionId: 'revision-1',
        });
      }
      if (url.endsWith('/revisions/1/comments'))
        return statusReply(200, [
          {
            id: 'comment-1',
            text: 'Please enlarge the logo',
            parentId: null,
            createdAt: '2026-11-05T10:00:00.000Z',
            author: { name: 'Rita Reviewer' },
          },
        ]);
      if (url.endsWith('/comments')) return statusReply(200, []);
      if (url.endsWith('/decisions'))
        return statusReply(200, [
          {
            id: 'decision-1',
            revisionNumber: 1,
            decision: 'CHANGES_REQUESTED',
            reason: 'Logo is too small',
            createdAt: '2026-11-05T10:00:00.000Z',
            reviewer: { name: 'Rita Reviewer' },
          },
        ]);
      if (url.endsWith('/change-requests'))
        return statusReply(
          200,
          requests.map((request) => ({ ...request })),
        );
      return statusReply(200, []);
    });
    vi.stubGlobal('fetch', fetchMock);
    return {
      fetchMock,
      requests,
      releasePatch: () => releasePatch(),
      releaseRun: () => releaseRun(),
    };
  }

  async function openCreative(session = submitter, onDataChanged = vi.fn()) {
    render(
      <CreativeWorkspace
        session={{ accessToken: 'token', user: session }}
        branch={branch}
        onDataChanged={onDataChanged}
        onUnauthorized={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
  }
  const banner = () =>
    screen.findByRole('region', { name: 'Open change requests' });

  // Regression (Stage 11 E2E): approval is revision-specific. After an
  // approved revision 1 a newer revision 2 was still badged "Approved".
  it('shows the current revision as Draft and names the older approved revision', async () => {
    serveReview({
      listed: {
        status: 'DRAFT',
        approvedRevision: {
          revisionId: 'revision-1',
          revisionNumber: 1,
          approvedAt: '2026-11-05T10:00:00.000Z',
          reviewer: { id: 'reviewer-1', name: 'Rita Reviewer' },
        },
        currentRevisionApproved: false,
      },
      requests: [],
    });
    await openCreative();
    const row = screen.getByRole('button', { name: 'Open' }).closest('li')!;
    expect(row).toHaveTextContent('Draft');
    expect(row).not.toHaveTextContent('Approved');
    expect(row).toHaveTextContent(
      'Revision 1 approved · current revision 2 not yet approved',
    );
    // The open creative's detail states the current revision's status too.
    await waitFor(() =>
      expect(document.querySelector('p.creative-review-state')).not.toBeNull(),
    );
    const detail = document.querySelector('p.creative-review-state')!;
    expect(detail).toHaveTextContent('Draft Current revision 2');
    expect(detail).toHaveTextContent(
      'Revision 1 approved · current revision 2 not yet approved',
    );
  });

  it('says the current revision is approved when it is', async () => {
    serveReview({
      listed: {
        status: 'approved',
        approvedRevision: {
          revisionId: 'revision-2',
          revisionNumber: 2,
          approvedAt: '2026-11-05T10:00:00.000Z',
          reviewer: { id: 'reviewer-1', name: 'Rita Reviewer' },
        },
        currentRevisionApproved: true,
      },
      requests: [],
    });
    await openCreative();
    const row = screen.getByRole('button', { name: 'Open' }).closest('li')!;
    expect(row).toHaveTextContent('Current revision 2 approved');
    expect(row).not.toHaveTextContent('not yet approved');
  });

  it('lets the submitter read reviewer comments and decisions after the review closed', async () => {
    serveReview();
    await openCreative();
    const feedback = await screen.findByRole('region', {
      name: 'Review feedback',
    });
    expect(
      await within(feedback).findByText(
        /Revision 1 · Changes requested by Rita Reviewer/,
      ),
    ).toBeInTheDocument();
    fireEvent.change(
      within(feedback).getByRole('combobox', { name: 'Feedback revision' }),
      { target: { value: '1' } },
    );
    expect(
      await within(feedback).findByText('Please enlarge the logo'),
    ).toBeInTheDocument();
    expect(
      within(feedback).getByRole('button', {
        name: "Reply to Rita Reviewer's comment",
      }),
    ).toBeInTheDocument();
  });

  it('resubmits a newer revision with the previous workflow and clears the banner', async () => {
    const { fetchMock, requests } = serveReview();
    await openCreative();
    const openBanner = await banner();
    expect(openBanner).toHaveTextContent(
      'Revision 1: Logo is too small (Use the large variant)',
    );
    expect(openBanner).toHaveTextContent('Revision 2 is saved.');
    fireEvent.click(
      within(openBanner).getByRole('button', { name: 'Resubmit for review' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Revision 2 was resubmitted for review.',
    );
    const start = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/creatives/creative-1/workflows') &&
        (init as RequestInit | undefined)?.method === 'POST',
    )!;
    expect(JSON.parse(String((start[1] as RequestInit).body))).toEqual({
      workflowId: 'workflow-1',
      creativeRevisionId: 'revision-2',
    });
    expect(requests[0]!.status).toBe('RESOLVED');
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: 'Open change requests' }),
      ).not.toBeInTheDocument(),
    );
  });

  // Regression (Stage 11 E2E): a run starts at the workflow's entry stage.
  // When that is not a review stage (Draft → Review), the screen claimed the
  // revision was "resubmitted for review" although no reviewer had a task,
  // and the list kept the old status badge.
  it('says where the run waits when resubmission lands on a non-review stage, and refreshes the list', async () => {
    const { fetchMock } = serveReview({
      startStage: { key: 'draft', name: 'Draft', requiresReview: false },
    });
    await openCreative();
    const listCalls = () =>
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/creatives?'),
      ).length;
    const before = listCalls();
    fireEvent.click(
      within(await banner()).getByRole('button', {
        name: 'Resubmit for review',
      }),
    );
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(
      'Revision 2 was resubmitted. Its workflow is at the Draft stage; move it on from Workflows to send it to a reviewer.',
    );
    expect(status).not.toHaveTextContent('resubmitted for review');
    await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
    // The list row (found from its Open button) shows the new status.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Open' }).closest('li'),
      ).toHaveTextContent(/Draft/),
    );
  });

  it('still says "resubmitted for review" when the run starts at a review stage', async () => {
    serveReview({
      startStage: { key: 'review', name: 'Review', requiresReview: true },
    });
    await openCreative();
    fireEvent.click(
      within(await banner()).getByRole('button', {
        name: 'Resubmit for review',
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Revision 2 was resubmitted for review.',
    );
  });

  it('keeps the request open and explains a failed resubmission', async () => {
    const { requests } = serveReview({ startStatus: 404 });
    await openCreative();
    fireEvent.click(
      within(await banner()).getByRole('button', {
        name: 'Resubmit for review',
      }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enabled workflow not found',
    );
    expect(requests[0]!.status).toBe('OPEN');
    expect(await banner()).toBeInTheDocument();
  });

  it('asks for a new revision before offering resubmission', async () => {
    serveReview({ current: revision });
    await openCreative();
    const openBanner = await banner();
    expect(openBanner).toHaveTextContent(
      'Save a new revision with the requested changes, then resubmit it for review.',
    );
    expect(
      within(openBanner).queryByRole('button', { name: 'Resubmit for review' }),
    ).toBeNull();
  });

  it('offers resubmission once a newer revision is saved', async () => {
    serveReview({ current: revision });
    await openCreative();
    await banner();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Headline' }), {
      target: { value: 'Revised' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));
    expect(
      await within(await banner()).findByRole('button', {
        name: 'Resubmit for review',
      }),
    ).toBeInTheDocument();
  });

  it('does not offer resubmission while a run is active', async () => {
    serveReview({ runStatus: 'RUNNING' });
    await openCreative();
    const openBanner = await banner();
    expect(
      await within(openBanner).findByText(
        'A review is already running for this creative.',
      ),
    ).toBeInTheDocument();
    expect(
      within(openBanner).queryByRole('button', { name: 'Resubmit for review' }),
    ).toBeNull();
  });

  it('does not offer resubmission without workflows:start', async () => {
    const { fetchMock } = serveReview();
    await openCreative({
      ...submitter,
      permissions: submitter.permissions.filter(
        (permission) => permission !== 'workflows:start',
      ),
    });
    const openBanner = await banner();
    expect(openBanner).toHaveTextContent(
      'Someone who can start workflows needs to resubmit it for review.',
    );
    expect(
      within(openBanner).queryByRole('button', { name: 'Resubmit for review' }),
    ).toBeNull();
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
      ),
    ).toBe(false);
  });

  it('shows no feedback panel or banner without review read permissions', async () => {
    const { fetchMock } = serveReview();
    await openCreative({
      ...submitter,
      permissions: ['creatives:read', 'creatives:update', 'templates:read'],
    });
    await screen.findByRole('textbox', { name: 'Headline' });
    expect(
      screen.queryByRole('region', { name: 'Review feedback' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Open change requests' }),
    ).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) =>
        /\/(comments|decisions|change-requests|workflow)$/.test(String(url)),
      ),
    ).toBe(false);
  });

  // Stage 12: one-click resubmission after changes were requested on the
  // current revision: the existing save, then the existing start.
  describe('Save and resubmit for review', () => {
    const oneClick = () =>
      screen.queryByRole('button', { name: 'Save and resubmit for review' });
    const writes = (fetchMock: ReturnType<typeof serveReview>['fetchMock']) =>
      fetchMock.mock.calls
        .filter(([, init]) =>
          ['PATCH', 'POST'].includes(
            (init as RequestInit | undefined)?.method ?? 'GET',
          ),
        )
        .map(([url, init]) => ({
          method: (init as RequestInit).method,
          url: String(url).replace(/^.*\/api\/v1/, ''),
          body: JSON.parse(String((init as RequestInit).body)) as unknown,
        }));
    // Changes were requested on revision 1, which is still current.
    async function openWithRequestOnCurrent(
      options: Parameters<typeof serveReview>[0] = {},
      session = submitter,
    ) {
      const served = serveReview({ current: revision, ...options });
      const onDataChanged = vi.fn();
      await openCreative(session, onDataChanged);
      await banner();
      fireEvent.change(
        await screen.findByRole('textbox', { name: 'Headline' }),
        { target: { value: 'Bigger logo' } },
      );
      return { ...served, onDataChanged };
    }

    it('saves the new revision, then resubmits that revision with the latest run workflow', async () => {
      const { fetchMock, requests, onDataChanged } =
        await openWithRequestOnCurrent();
      expect(await banner()).toHaveTextContent(
        'Save and resubmit for review in the form below does both in one step.',
      );
      fireEvent.click(oneClick()!);
      expect(await screen.findByRole('status')).toHaveTextContent(
        'Revision 2 was saved and resubmitted for review.',
      );
      expect(writes(fetchMock)).toEqual([
        {
          method: 'PATCH',
          url: '/creatives/creative-1',
          body: expect.objectContaining({
            values: { headline: 'Bigger logo' },
          }),
        },
        {
          method: 'POST',
          url: '/creatives/creative-1/workflows',
          body: { workflowId: 'workflow-1', creativeRevisionId: 'revision-2' },
        },
      ]);
      expect(requests[0]!.status).toBe('RESOLVED');
      expect(onDataChanged).toHaveBeenCalledWith('creatives');
      await waitFor(() =>
        expect(
          screen.queryByRole('region', { name: 'Open change requests' }),
        ).not.toBeInTheDocument(),
      );
    });

    it('says where the run waits when the workflow starts at a non-review stage', async () => {
      await openWithRequestOnCurrent({
        startStage: { key: 'draft', name: 'Draft', requiresReview: false },
      });
      fireEvent.click(oneClick()!);
      expect(await screen.findByRole('status')).toHaveTextContent(
        'Revision 2 was saved and resubmitted. Its workflow is at the Draft stage; move it on from Workflows to send it to a reviewer.',
      );
    });

    it('starts no workflow when the save fails, and keeps the edits', async () => {
      const { fetchMock, requests } = await openWithRequestOnCurrent({
        patchStatus: 400,
      });
      fireEvent.click(oneClick()!);
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Headline is required',
      );
      expect(writes(fetchMock).map((write) => write.method)).toEqual(['PATCH']);
      expect(requests[0]!.status).toBe('OPEN');
      expect(screen.getByRole('textbox', { name: 'Headline' })).toHaveValue(
        'Bigger logo',
      );
    });

    it('keeps the saved revision when the start fails, and offers Resubmit for review to retry', async () => {
      const { fetchMock, requests } = await openWithRequestOnCurrent({
        startStatus: 404,
      });
      fireEvent.click(oneClick()!);
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Revision 2 was saved, but it could not be resubmitted: Enabled workflow not found Use Resubmit for review to try again.',
      );
      expect(writes(fetchMock).map((write) => write.method)).toEqual([
        'PATCH',
        'POST',
      ]);
      expect(requests[0]!.status).toBe('OPEN');
      // Revision 2 now answers the request on revision 1: the existing
      // resubmission path takes over.
      expect(
        await within(await banner()).findByRole('button', {
          name: 'Resubmit for review',
        }),
      ).toBeInTheDocument();
      await waitFor(() => expect(oneClick()).not.toBeInTheDocument());
    });

    it.each(['creatives:update', 'workflows:start', 'workflows:read'])(
      'is not offered without %s',
      async (missing) => {
        await openWithRequestOnCurrent(
          {},
          {
            ...submitter,
            permissions: submitter.permissions.filter(
              (permission) => permission !== missing,
            ),
          },
        ).catch(() => undefined);
        await banner();
        expect(oneClick()).not.toBeInTheDocument();
      },
    );

    it('is not offered when no change request is unresolved', async () => {
      serveReview({ current: revision, requests: [] });
      await openCreative();
      await screen.findByRole('textbox', { name: 'Headline' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(oneClick()).not.toBeInTheDocument();
    });

    it('is not offered for a request on an older revision, where Resubmit for review applies', async () => {
      serveReview();
      await openCreative();
      expect(
        await within(await banner()).findByRole('button', {
          name: 'Resubmit for review',
        }),
      ).toBeInTheDocument();
      expect(oneClick()).not.toBeInTheDocument();
    });

    it('is not offered while a run is active (the edit lock applies)', async () => {
      serveReview({ current: revision, runStatus: 'RUNNING' });
      await openCreative();
      await screen.findByRole('region', { name: 'Editing locked' });
      expect(oneClick()).not.toBeInTheDocument();
    });

    it('is not offered until the run state has loaded', async () => {
      const { releaseRun } = serveReview({ current: revision, holdRun: true });
      await openCreative();
      await banner();
      expect(oneClick()).not.toBeInTheDocument();
      releaseRun();
      expect(
        await screen.findByRole('button', {
          name: 'Save and resubmit for review',
        }),
      ).toBeEnabled();
    });

    it('sends one save and one start when clicked twice', async () => {
      const { fetchMock, releasePatch } = await openWithRequestOnCurrent({
        holdPatch: true,
      });
      fireEvent.click(oneClick()!);
      fireEvent.click(oneClick()!);
      expect(oneClick()).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
      releasePatch();
      expect(await screen.findByRole('status')).toHaveTextContent(
        'Revision 2 was saved and resubmitted for review.',
      );
      expect(writes(fetchMock).map((write) => write.method)).toEqual([
        'PATCH',
        'POST',
      ]);
    });
  });
});

// Stage 10.2: the API refuses a new revision while a run is RUNNING (409).
// The screen locks saving in advance when it can read workflows.
describe('CreativeWorkspace edit lock during a running workflow', () => {
  const editor: AuthenticatedUserResponse = {
    ...user,
    permissions: [...user.permissions, 'workflows:read'],
  };
  const runningRun = {
    id: 'instance-1',
    status: 'RUNNING',
    workflowId: 'workflow-1',
    creativeRevisionId: 'revision-1',
    currentStage: { name: 'Legal review' },
    workflow: { name: 'Spring review' },
  };

  // `run` is read on every request, so a test can finish the run later.
  function serveLock(
    options: {
      run?: Record<string, unknown> | null;
      // Resolves the workflow request only when the test calls release().
      holdRun?: boolean;
      patchStatus?: number;
    } = {},
  ) {
    const state = { run: options.run === undefined ? runningRun : options.run };
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/creatives/creative-1/workflow')) {
        if (options.holdRun) await held;
        return statusReply(200, state.run);
      }
      if (url.endsWith('/creatives/creative-1') && method === 'PATCH')
        return options.patchStatus
          ? statusReply(options.patchStatus, {
              message:
                'Creative revisions cannot change while a workflow is running',
            })
          : statusReply(200, creative);
      if (url.endsWith('/creatives') && method === 'POST')
        return statusReply(201, { ...creative, id: 'creative-2' });
      if (url.includes('/creatives?')) return statusReply(200, [creative]);
      if (url.endsWith('/templates')) return statusReply(200, [template]);
      if (url.endsWith('/templates/template-1'))
        return statusReply(200, detail);
      if (url.endsWith('/creatives/creative-1/revisions'))
        return statusReply(200, [revision]);
      return statusReply(200, []);
    });
    vi.stubGlobal('fetch', fetchMock);
    const writes = () =>
      fetchMock.mock.calls.filter(([, init]) =>
        ['PATCH', 'POST'].includes(
          (init as RequestInit | undefined)?.method ?? 'GET',
        ),
      );
    return { fetchMock, state, release: () => release(), writes };
  }

  function renderWorkspace(
    session: AuthenticatedUserResponse = editor,
    dataChange?: { key: number; source: 'workflows' | '' },
  ) {
    const element = (change = dataChange) => (
      <CreativeWorkspace
        session={{ accessToken: 'token', user: session }}
        branch={branch}
        dataChange={change}
        onUnauthorized={vi.fn()}
      />
    );
    const view = render(element());
    return {
      ...view,
      rerenderWith: (change: { key: number; source: 'workflows' | '' }) =>
        view.rerender(element(change)),
    };
  }

  async function openAndEdit() {
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Headline' }), {
      target: { value: 'Edited while locked' },
    });
  }
  const saveButton = () =>
    screen.getByRole('button', { name: 'Save new revision' });
  const lockNotice = () =>
    screen.findByRole('region', { name: 'Editing locked' });

  it('disables saving and explains the revision, stage and workflow that hold the lock', async () => {
    serveLock();
    renderWorkspace();
    await openAndEdit();
    const notice = await lockNotice();
    expect(notice).toHaveTextContent(
      'Revision 1 is currently under review at stage Legal review in Spring review. Editing is locked until the workflow finishes or is cancelled.',
    );
    expect(
      within(notice).getByRole('link', { name: 'Open Workflows' }),
    ).toHaveAttribute('href', '#workflows');
    expect(saveButton()).toBeDisabled();
    expect(saveButton()).toHaveAttribute('aria-describedby', notice.id);
  });

  it('sends no revision when the form is submitted another way, such as Enter in a field', async () => {
    const { writes } = serveLock();
    renderWorkspace();
    await openAndEdit();
    await lockNotice();
    fireEvent.submit(saveButton().closest('form')!);
    fireEvent.click(saveButton());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(writes()).toEqual([]);
  });

  it('restores saving through the cross-screen refresh when the run completes, keeping the edits', async () => {
    const { state, writes } = serveLock();
    const view = renderWorkspace(editor, { key: 0, source: '' });
    await openAndEdit();
    await lockNotice();
    state.run = { ...runningRun, status: 'COMPLETED' };
    view.rerenderWith({ key: 1, source: 'workflows' });
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(
      screen.queryByRole('region', { name: 'Editing locked' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Headline' })).toHaveValue(
      'Edited while locked',
    );
    fireEvent.click(saveButton());
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(String((writes()[0]![1] as RequestInit).body)).toContain(
      'Edited while locked',
    );
  });

  it('also unlocks when the run was cancelled', async () => {
    const { state } = serveLock();
    const view = renderWorkspace(editor, { key: 0, source: '' });
    await openAndEdit();
    await lockNotice();
    state.run = { ...runningRun, status: 'CANCELLED' };
    view.rerenderWith({ key: 1, source: 'workflows' });
    await waitFor(() => expect(saveButton()).toBeEnabled());
  });

  it('keeps saving unavailable until the workflow state is known', async () => {
    const { release } = serveLock({
      run: { ...runningRun, status: 'COMPLETED' },
      holdRun: true,
    });
    renderWorkspace();
    await openAndEdit();
    expect(
      await screen.findByText(
        'Checking whether a workflow is running before saving…',
      ),
    ).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    release();
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(
      screen.queryByText(
        'Checking whether a workflow is running before saving…',
      ),
    ).not.toBeInTheDocument();
  });

  it('allows saving when the creative has never run a workflow', async () => {
    serveLock({ run: null });
    renderWorkspace();
    await openAndEdit();
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(
      screen.queryByRole('region', { name: 'Editing locked' }),
    ).not.toBeInTheDocument();
  });

  it('without workflows:read, requests no workflow state and shows the API 409 with the edits kept', async () => {
    const { fetchMock, writes } = serveLock({ patchStatus: 409 });
    renderWorkspace(user);
    await openAndEdit();
    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Creative revisions cannot change while a workflow is running Your edits are still in the form; save them once the workflow finishes or is cancelled.',
    );
    expect(writes()).toHaveLength(1);
    expect(screen.getByRole('textbox', { name: 'Headline' })).toHaveValue(
      'Edited while locked',
    );
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith('/workflow')),
    ).toBe(false);
  });

  it('shows the lock after a 409 when a run started elsewhere since the screen loaded', async () => {
    const { state } = serveLock({ run: null, patchStatus: 409 });
    renderWorkspace();
    await openAndEdit();
    await waitFor(() => expect(saveButton()).toBeEnabled());
    state.run = runningRun;
    fireEvent.click(saveButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Creative revisions cannot change while a workflow is running',
    );
    expect(await lockNotice()).toHaveTextContent('Legal review');
    expect(saveButton()).toBeDisabled();
  });

  // Regression (found while adding the lock): a refresh from another screen
  // reloaded the list and overwrote unsaved field values with the stored
  // revision, although Stage 12 promised to keep them.
  it('keeps unsaved edits when another screen refreshes the list, and loads a newer revision saved elsewhere', async () => {
    const { fetchMock } = serveLock({ run: null });
    const view = renderWorkspace(editor, { key: 0, source: '' });
    await openAndEdit();
    view.rerenderWith({ key: 1, source: 'workflows' });
    const listCalls = () =>
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/creatives?'),
      ).length;
    await waitFor(() => expect(listCalls()).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole('textbox', { name: 'Headline' })).toHaveValue(
      'Edited while locked',
    );
    // A newer revision saved elsewhere replaces the form, as before.
    const revisionTwo = {
      ...revision,
      id: 'revision-2',
      revisionNumber: 2,
      values: { headline: 'Saved elsewhere' },
    };
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/creatives?')
        ? statusReply(200, [
            {
              ...creative,
              currentRevisionId: 'revision-2',
              currentRevision: revisionTwo,
            },
          ])
        : url.endsWith('/templates/template-1')
          ? statusReply(200, detail)
          : statusReply(200, url.endsWith('/workflow') ? null : []),
    );
    view.rerenderWith({ key: 2, source: 'workflows' });
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Headline' })).toHaveValue(
        'Saved elsewhere',
      ),
    );
  });

  it('does not lock creating a new creative', async () => {
    const { writes } = serveLock();
    renderWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    await lockNotice();
    fireEvent.click(screen.getByRole('button', { name: 'New creative' }));
    expect(
      screen.queryByRole('region', { name: 'Editing locked' }),
    ).not.toBeInTheDocument();
    fireEvent.change(
      await screen.findByRole('combobox', { name: 'Template' }),
      { target: { value: template.id } },
    );
    fireEvent.change(await screen.findByRole('textbox', { name: 'Headline' }), {
      target: { value: 'Fresh' },
    });
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Second' },
    });
    const create = screen.getByRole('button', { name: 'Create creative' });
    expect(create).toBeEnabled();
    expect(create).not.toHaveAttribute('aria-describedby');
    fireEvent.click(create);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect((writes()[0]![1] as RequestInit).method).toBe('POST');
  });
});
