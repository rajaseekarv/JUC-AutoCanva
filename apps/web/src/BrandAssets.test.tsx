import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import BrandAssets from './BrandAssets';
import { imageReply, statusReply, stubObjectUrls } from './assetTestUtils';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Session = Parameters<typeof BrandAssets>[0]['session'];

function sessionWith(permissions: string[]): Session {
  return {
    accessToken: 'test-token',
    user: { permissions, branches: [] },
  } as unknown as Session;
}

const admin = sessionWith([
  'brand:read',
  'brand:manage',
  'assets:read',
  'assets:manage',
  'organizations:update',
]);

const asset = (id: string, originalName: string, branchId: string | null) => ({
  id,
  branchId,
  originalName,
  mimeType: 'image/png',
  sizeBytes: 2048,
  width: 1,
  height: 1,
});

const reply = (status: number, body: unknown) =>
  Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

// Serves the brand profile and the current asset list; DELETE requests are
// answered by `onDelete`, which may change the list the next reload sees.
function serve(
  initialAssets: ReturnType<typeof asset>[],
  onDelete: (assetId: string) => Promise<unknown> | unknown,
) {
  let assets = initialAssets;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'DELETE') {
      const assetId = decodeURIComponent(url.split('/assets/')[1] ?? '');
      return Promise.resolve(onDelete(assetId)).then((outcome) => {
        if (outcome === 'deleted') {
          assets = assets.filter((item) => item.id !== assetId);
          return reply(200, { id: assetId, status: 'DELETED' });
        }
        return outcome;
      });
    }
    if (url.endsWith('/organization/brand'))
      return reply(200, {
        displayName: 'AdFlow',
        primaryColor: null,
        secondaryColor: null,
        accentColor: null,
        fontFamily: null,
        websiteUrl: null,
        logoAssetId: null,
      });
    if (url.endsWith('/assets')) return reply(200, assets);
    return reply(200, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const assetListCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(
    ([input, init]) =>
      String(input).endsWith('/assets') && init?.method === undefined,
  ).length;

// Asset names also appear as logo options, so look inside the asset list.
const inAssetList = () => within(screen.getByRole('list'));

async function requestDeletion(name: string) {
  fireEvent.click(
    await screen.findByRole('button', { name: 'Delete ' + name }),
  );
  const group = screen.getByRole('group', { name: 'Confirm deleting ' + name });
  fireEvent.click(
    within(group).getByRole('button', { name: 'Confirm delete' }),
  );
}

describe('BrandAssets deletion', () => {
  it('deletes an unreferenced asset after confirmation and refreshes the list', async () => {
    const fetchMock = serve(
      [
        asset('asset-1', 'banner.png', null),
        asset('asset-2', 'logo.png', null),
      ],
      () => 'deleted',
    );
    render(
      <BrandAssets session={admin} branch={null} onUnauthorized={vi.fn()} />,
    );
    await requestDeletion('banner.png');

    expect(await screen.findByRole('status')).toHaveTextContent(
      '“banner.png” deleted.',
    );
    await waitFor(() =>
      expect(inAssetList().queryByText('banner.png')).not.toBeInTheDocument(),
    );
    expect(inAssetList().getByText('logo.png')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/assets\/asset-1$/),
      expect.objectContaining({
        method: 'DELETE',
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
    expect(assetListCalls(fetchMock)).toBe(2);
  });

  it('explains a 409 for an asset used by a creative, keeps it listed, and refreshes', async () => {
    const fetchMock = serve([asset('asset-1', 'logo.png', null)], () =>
      reply(409, {
        statusCode: 409,
        error: 'Conflict',
        message: 'Asset is used by a creative revision and cannot be deleted',
        reason: 'CREATIVE_REVISION',
      }),
    );
    render(
      <BrandAssets session={admin} branch={null} onUnauthorized={vi.fn()} />,
    );
    await requestDeletion('logo.png');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '“logo.png” is being used by a creative, so it cannot be deleted. The asset has been kept.',
    );
    expect(inAssetList().getByText('logo.png')).toBeInTheDocument();
    expect(
      screen.getByText('In use by a creative · cannot be deleted'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    // The list was fetched again after the refusal, and the controls are
    // usable again.
    expect(assetListCalls(fetchMock)).toBe(2);
    expect(
      screen.getByRole('button', { name: 'Delete logo.png' }),
    ).toBeEnabled();
  });

  it.each([
    [
      'ORGANIZATION_BRAND_LOGO',
      '“logo.png” is the organization brand logo, so it cannot be deleted. Choose a different logo first.',
      'Organization brand logo · cannot be deleted',
    ],
    [
      'BRANCH_BRAND_LOGO',
      '“logo.png” is a branch brand logo, so it cannot be deleted. Choose a different logo for that branch first.',
      'Branch brand logo · cannot be deleted',
    ],
    [
      undefined,
      '“logo.png” is in use, so it cannot be deleted.',
      'In use · cannot be deleted',
    ],
  ])('explains a 409 with reason %s', async (reason, alertText, label) => {
    serve([asset('asset-1', 'logo.png', null)], () =>
      reply(409, { statusCode: 409, message: 'In use', reason }),
    );
    render(
      <BrandAssets session={admin} branch={null} onUnauthorized={vi.fn()} />,
    );
    await requestDeletion('logo.png');
    expect(await screen.findByRole('alert')).toHaveTextContent(alertText);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(inAssetList().getByText('logo.png')).toBeInTheDocument();
  });

  it('sends nothing when the confirmation is cancelled', async () => {
    const onDelete = vi.fn();
    serve([asset('asset-1', 'logo.png', null)], onDelete);
    render(
      <BrandAssets session={admin} branch={null} onUnauthorized={vi.fn()} />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete logo.png' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Delete logo.png' }),
    ).toBeInTheDocument();
  });

  it('disables the controls while a deletion is in flight', async () => {
    let finish: (value: unknown) => void = () => undefined;
    serve(
      [
        asset('asset-1', 'banner.png', null),
        asset('asset-2', 'logo.png', null),
      ],
      () => new Promise((resolve) => (finish = resolve)),
    );
    render(
      <BrandAssets session={admin} branch={null} onUnauthorized={vi.fn()} />,
    );
    await requestDeletion('banner.png');
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Delete logo.png' }),
      ).toBeDisabled(),
    );
    expect(screen.getByRole('button', { name: 'Upload asset' })).toBeDisabled();
    finish('deleted');
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Delete logo.png' }),
      ).toBeEnabled(),
    );
  });

  it('keeps the asset and shows a generic error for an unexpected failure', async () => {
    serve([asset('asset-1', 'logo.png', null)], () =>
      reply(500, { statusCode: 500, message: 'Internal server error' }),
    );
    render(
      <BrandAssets session={admin} branch={null} onUnauthorized={vi.fn()} />,
    );
    await requestDeletion('logo.png');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to delete asset.',
    );
    expect(inAssetList().getByText('logo.png')).toBeInTheDocument();
    expect(screen.queryByText(/cannot be deleted/)).not.toBeInTheDocument();
  });

  it('keeps the existing permission message for a 403', async () => {
    serve([asset('asset-1', 'logo.png', null)], () =>
      reply(403, { statusCode: 403, message: 'Forbidden' }),
    );
    render(
      <BrandAssets session={admin} branch={null} onUnauthorized={vi.fn()} />,
    );
    await requestDeletion('logo.png');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You do not have permission to complete this action.',
    );
  });

  it('signs out on a 401 without reloading', async () => {
    const onUnauthorized = vi.fn();
    const fetchMock = serve([asset('asset-1', 'logo.png', null)], () =>
      reply(401, { statusCode: 401 }),
    );
    render(
      <BrandAssets
        session={admin}
        branch={null}
        onUnauthorized={onUnauthorized}
      />,
    );
    await requestDeletion('logo.png');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your session expired. Please sign in again.',
    );
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(assetListCalls(fetchMock)).toBe(1);
  });

  it('reports an asset that was already deleted elsewhere and refreshes', async () => {
    const fetchMock = serve([asset('asset-1', 'logo.png', null)], () =>
      reply(404, { statusCode: 404, message: 'Asset not found' }),
    );
    render(
      <BrandAssets session={admin} branch={null} onUnauthorized={vi.fn()} />,
    );
    await requestDeletion('logo.png');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '“logo.png” was already deleted or is no longer available.',
    );
    expect(assetListCalls(fetchMock)).toBe(2);
  });

  it('offers deletion only where the server would allow it', async () => {
    serve(
      [
        asset('asset-1', 'org.png', null),
        asset('asset-2', 'branch.png', 'branch-1'),
      ],
      () => 'deleted',
    );
    const branchManager = sessionWith([
      'brand:read',
      'assets:read',
      'assets:manage',
    ]);
    render(
      <BrandAssets
        session={branchManager}
        branch={null}
        onUnauthorized={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole('button', { name: 'Delete branch.png' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Delete org.png' }),
    ).not.toBeInTheDocument();
  });

  it('shows no delete controls to read-only users', async () => {
    serve([asset('asset-1', 'logo.png', null)], () => 'deleted');
    render(
      <BrandAssets
        session={sessionWith(['brand:read', 'assets:read'])}
        branch={null}
        onUnauthorized={vi.fn()}
      />,
    );
    expect(
      await within(await screen.findByRole('list')).findByText('logo.png'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Delete / }),
    ).not.toBeInTheDocument();
  });
});

describe('BrandAssets existing behavior', () => {
  it('still reports a successful upload and reloads the list', async () => {
    const fetchMock = serve([], () => 'deleted');
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === 'POST'
          ? reply(201, asset('asset-9', 'new.png', null))
          : String(input).endsWith('/assets')
            ? reply(200, [])
            : reply(200, { displayName: null, logoAssetId: null }),
    );
    const view = render(
      <BrandAssets session={admin} branch={null} onUnauthorized={vi.fn()} />,
    );
    await screen.findByText('No assets uploaded.');
    const form = view.container.querySelector('form.admin-card');
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Asset uploaded.',
    );
  });

  it('shows the brand profile without requesting assets when the user lacks assets:read', async () => {
    const fetchMock = serve([asset('asset-1', 'logo.png', null)], () => {
      throw new Error('no deletion expected');
    });
    render(
      <BrandAssets
        session={sessionWith(['brand:read'])}
        branch={null}
        onUnauthorized={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole('heading', { name: 'Organization profile' }),
    ).toBeInTheDocument();
    expect(screen.getByText('AdFlow')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([input]) =>
        /\/assets(\?|$)/.test(String(input)),
      ),
    ).toBe(false);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Assets' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('No assets uploaded.')).not.toBeInTheDocument();
  });

  it('shows the effective branch profile without requesting assets when the user lacks assets:read', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      String(input).includes('/assets')
        ? reply(403, { statusCode: 403 })
        : reply(200, {
            displayName: 'North display name',
            overriddenFields: [],
          }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const north = { id: 'branch-north', name: 'North', code: 'NORTH' };
    const session = {
      accessToken: 'test-token',
      user: { permissions: ['brand:read'], branches: [north] },
    } as unknown as Session;
    render(
      <BrandAssets
        session={session}
        branch={{ ...north, status: 'ACTIVE' }}
        onUnauthorized={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole('heading', { name: 'Effective branch profile' }),
    ).toBeInTheDocument();
    expect(screen.getByText('North display name')).toBeInTheDocument();
    const requested = fetchMock.mock.calls.map(([input]) => String(input));
    expect(requested).toContainEqual(
      expect.stringContaining('/branches/branch-north/brand/effective'),
    );
    expect(requested).not.toContainEqual(expect.stringContaining('/assets'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('still shows the load error when the asset list cannot be fetched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => reply(500, { statusCode: 500 })),
    );
    render(
      <BrandAssets session={admin} branch={null} onUnauthorized={vi.fn()} />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to load brand settings.',
    );
  });
});

describe('BrandAssets usage', () => {
  const usageOf = (overrides: Record<string, unknown> = {}) => ({
    assetId: 'asset-1',
    inUse: false,
    creativeRevisions: [],
    organizationBrandProfile: null,
    branchBrandProfiles: [],
    hiddenReferenceCount: 0,
    ...overrides,
  });
  const inUse = usageOf({
    inUse: true,
    creativeRevisions: [
      {
        creativeId: 'creative-1',
        creativeName: 'Spring Sale',
        branchId: 'branch-1',
        branchName: 'North',
        revisionId: 'revision-2',
        revisionNumber: 2,
        isCurrentRevision: true,
        fields: [{ key: 'logo', label: 'Logo', type: 'LOGO' }],
      },
      {
        creativeId: 'creative-1',
        creativeName: 'Spring Sale',
        branchId: 'branch-1',
        branchName: 'North',
        revisionId: 'revision-1',
        revisionNumber: 1,
        isCurrentRevision: false,
        fields: [{ key: 'hero', label: null, type: null }],
      },
    ],
    organizationBrandProfile: { profileId: 'profile-1', displayName: 'AdFlow' },
    branchBrandProfiles: [
      { branchId: 'branch-1', branchName: 'North', branchCode: 'NORTH' },
    ],
  });

  // Serves the profile and asset list; usage requests are answered by
  // `onUsage`, deletions succeed.
  function serveUsage(
    assets: ReturnType<typeof asset>[],
    onUsage: (assetId: string) => Promise<unknown> | unknown,
  ) {
    const fetchMock = serve(assets, () => 'deleted');
    const base = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const match = /\/assets\/([^/]+)\/usage$/.exec(String(input));
        if (match)
          return Promise.resolve(onUsage(decodeURIComponent(match[1] ?? '')));
        return base!(input, init);
      },
    );
    return fetchMock;
  }
  const openUsage = async (name: string) =>
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Where is this asset used? (' + name + ')',
      }),
    );
  const panel = (name: string) =>
    screen.getByRole('region', { name: 'Where ' + name + ' is used' });

  it('opens a panel that loads, then groups where the asset is used', async () => {
    let answer: (value: unknown) => void = () => undefined;
    const fetchMock = serveUsage(
      [asset('asset-1', 'logo.png', null)],
      () => new Promise((resolve) => (answer = resolve)),
    );
    render(
      <BrandAssets session={admin} branch={null} onUnauthorized={vi.fn()} />,
    );
    await openUsage('logo.png');
    const region = panel('logo.png');
    expect(within(region).getByRole('status')).toHaveTextContent(
      'Loading asset usage…',
    );
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(
      screen.getByRole('button', {
        name: 'Where is this asset used? (logo.png)',
      }),
    ).toHaveAttribute('aria-expanded', 'true');
    // Nothing may claim the asset is unused while the request is pending.
    expect(region).not.toHaveTextContent(/not currently being used/);
    answer(reply(200, inUse));

    expect(
      await within(region).findByRole('heading', {
        name: 'Creative revisions',
      }),
    ).toBeInTheDocument();
    const [revisions, branches] = within(region).getAllByRole('list');
    const revisionItems = within(revisions!).getAllByRole('listitem');
    expect(revisionItems[0]).toHaveTextContent(
      'Spring Sale · Revision 2 (current) · Logo field · North branch',
    );
    expect(revisionItems[1]).toHaveTextContent(
      'Spring Sale · Revision 1 · hero field · North branch',
    );
    expect(
      within(region).getByRole('heading', {
        name: 'Organization brand profile',
      }),
    ).toBeInTheDocument();
    expect(region).toHaveTextContent('Used as the organization logo (AdFlow).');
    expect(
      within(region).getByRole('heading', { name: 'Branch brand profiles' }),
    ).toBeInTheDocument();
    expect(within(branches!).getByRole('listitem')).toHaveTextContent(
      'North (NORTH) branch logo',
    );
    expect(region).toHaveAttribute('aria-busy', 'false');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/assets\/asset-1\/usage$/),
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
  });

  it('says the asset is unused only after the usage request succeeds', async () => {
    serveUsage([asset('asset-1', 'logo.png', null)], () =>
      reply(200, usageOf()),
    );
    render(
      <BrandAssets session={admin} branch={null} onUnauthorized={vi.fn()} />,
    );
    await openUsage('logo.png');
    expect(
      await within(panel('logo.png')).findByText(
        'This asset is not currently being used.',
      ),
    ).toBeInTheDocument();
    expect(
      within(panel('logo.png')).queryByRole('heading'),
    ).not.toBeInTheDocument();
  });

  it('shows an error with retry when usage cannot be loaded', async () => {
    let calls = 0;
    serveUsage([asset('asset-1', 'logo.png', null)], () =>
      ++calls === 1 ? reply(500, { statusCode: 500 }) : reply(200, usageOf()),
    );
    render(
      <BrandAssets session={admin} branch={null} onUnauthorized={vi.fn()} />,
    );
    await openUsage('logo.png');
    const region = panel('logo.png');
    expect(await within(region).findByRole('alert')).toHaveTextContent(
      'Unable to load asset usage. Please try again.',
    );
    expect(region).not.toHaveTextContent(/not currently being used/);
    fireEvent.click(within(region).getByRole('button', { name: 'Try again' }));
    expect(
      await within(panel('logo.png')).findByText(
        'This asset is not currently being used.',
      ),
    ).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it('treats an incomplete response as an error, never as unused', async () => {
    serveUsage([asset('asset-1', 'logo.png', null)], () =>
      reply(200, { inUse: false }),
    );
    render(
      <BrandAssets session={admin} branch={null} onUnauthorized={vi.fn()} />,
    );
    await openUsage('logo.png');
    expect(
      await within(panel('logo.png')).findByRole('alert'),
    ).toHaveTextContent('Unable to load asset usage. Please try again.');
    expect(panel('logo.png')).not.toHaveTextContent(/not currently being used/);
  });

  it('never calls an asset unused when only hidden references exist', async () => {
    serveUsage([asset('asset-1', 'logo.png', null)], () =>
      reply(200, usageOf({ inUse: true, hiddenReferenceCount: 2 })),
    );
    render(
      <BrandAssets session={admin} branch={null} onUnauthorized={vi.fn()} />,
    );
    await openUsage('logo.png');
    const region = panel('logo.png');
    expect(
      await within(region).findByText(
        'Also used in 2 places in branches you do not have access to.',
      ),
    ).toBeInTheDocument();
    expect(region).toHaveTextContent('No creative revisions you can view.');
    expect(region).not.toHaveTextContent(/not currently being used/);
  });

  it('closes on a second click and ignores a late answer for a replaced panel', async () => {
    const answers: Record<string, (value: unknown) => void> = {};
    serveUsage(
      [
        asset('asset-1', 'logo.png', null),
        asset('asset-2', 'banner.png', null),
      ],
      (assetId) => new Promise((resolve) => (answers[assetId] = resolve)),
    );
    render(
      <BrandAssets session={admin} branch={null} onUnauthorized={vi.fn()} />,
    );
    await openUsage('logo.png');
    await openUsage('banner.png');
    expect(
      screen.queryByRole('region', { name: 'Where logo.png is used' }),
    ).not.toBeInTheDocument();
    answers['asset-1']?.(reply(200, inUse));
    answers['asset-2']?.(reply(200, usageOf({ assetId: 'asset-2' })));
    expect(
      await within(panel('banner.png')).findByText(
        'This asset is not currently being used.',
      ),
    ).toBeInTheDocument();
    expect(panel('banner.png')).not.toHaveTextContent('Spring Sale');
    await openUsage('banner.png');
    expect(
      screen.queryByRole('region', { name: 'Where banner.png is used' }),
    ).not.toBeInTheDocument();
  });

  it('signs out on a 401 and shows the load error', async () => {
    const onUnauthorized = vi.fn();
    serveUsage([asset('asset-1', 'logo.png', null)], () =>
      reply(401, { statusCode: 401 }),
    );
    render(
      <BrandAssets
        session={admin}
        branch={null}
        onUnauthorized={onUnauthorized}
      />,
    );
    await openUsage('logo.png');
    expect(
      await within(panel('logo.png')).findByRole('alert'),
    ).toHaveTextContent('Unable to load asset usage. Please try again.');
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('offers the read-only usage action without management controls', async () => {
    serveUsage([asset('asset-1', 'logo.png', null)], () =>
      reply(200, usageOf()),
    );
    render(
      <BrandAssets
        session={sessionWith(['brand:read', 'assets:read'])}
        branch={null}
        onUnauthorized={vi.fn()}
      />,
    );
    await openUsage('logo.png');
    expect(
      await within(panel('logo.png')).findByText(
        'This asset is not currently being used.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Delete / }),
    ).not.toBeInTheDocument();
  });

  it('keeps deletion working while a usage panel is open', async () => {
    serveUsage(
      [
        asset('asset-1', 'logo.png', null),
        asset('asset-2', 'banner.png', null),
      ],
      () => reply(200, usageOf()),
    );
    render(
      <BrandAssets session={admin} branch={null} onUnauthorized={vi.fn()} />,
    );
    await openUsage('logo.png');
    await within(panel('logo.png')).findByText(
      'This asset is not currently being used.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete logo.png' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      '“logo.png” deleted.',
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: 'Where logo.png is used' }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole('button', {
        name: 'Where is this asset used? (banner.png)',
      }),
    ).toBeInTheDocument();
  });
});

// Regression (Stage 8 E2E): a failed upload or save showed the generic
// "Unable to load brand settings." instead of the server's explanation.
describe('BrandAssets save and upload errors', () => {
  function serveFailing(status: number, body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === 'POST' || init?.method === 'PATCH'
          ? reply(status, body)
          : String(input).endsWith('/assets')
            ? reply(200, [])
            : reply(200, { displayName: 'AdFlow', logoAssetId: null }),
      ),
    );
  }
  const renderAdmin = () =>
    render(
      <BrandAssets session={admin} branch={null} onUnauthorized={vi.fn()} />,
    );
  const submitUpload = async (view: ReturnType<typeof render>) => {
    await screen.findByText('No assets uploaded.');
    fireEvent.submit(
      view.container.querySelector('form.admin-card') as HTMLFormElement,
    );
  };
  const submitSave = async () =>
    fireEvent.submit(
      (
        await screen.findByRole('button', { name: 'Save brand profile' })
      ).closest('form') as HTMLFormElement,
    );

  it('shows the server reason when an upload is rejected', async () => {
    serveFailing(400, {
      statusCode: 400,
      message: 'Only valid PNG, JPEG, or WebP images are allowed',
    });
    await submitUpload(renderAdmin());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only valid PNG, JPEG, or WebP images are allowed',
    );
  });

  it('falls back to an upload message for other upload failures', async () => {
    serveFailing(500, { statusCode: 500, message: 'Internal server error' });
    await submitUpload(renderAdmin());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to upload asset.',
    );
  });

  it('shows the server reason when a brand save is rejected', async () => {
    serveFailing(400, { statusCode: 400, message: 'Invalid brand profile' });
    renderAdmin();
    await submitSave();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Invalid brand profile',
    );
  });

  it('falls back to a save message, and keeps the permission message', async () => {
    serveFailing(503, { statusCode: 503 });
    const view = renderAdmin();
    await submitSave();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to save brand profile.',
    );
    view.unmount();
    serveFailing(403, { statusCode: 403, message: 'Forbidden' });
    renderAdmin();
    await submitSave();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You do not have permission to complete this action.',
    );
  });

  it('never reports a failed save or upload as a load failure', async () => {
    serveFailing(400, { statusCode: 400, message: ['not', 'a', 'string'] });
    await submitUpload(renderAdmin());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Unable to upload asset.');
    expect(alert).not.toHaveTextContent('Unable to load brand settings.');
  });
});

describe('BrandAssets images', () => {
  let objectUrls: ReturnType<typeof stubObjectUrls>;
  beforeEach(() => {
    objectUrls = stubObjectUrls();
  });
  afterEach(() => {
    // Unmount first: images release their object URLs as they unmount.
    cleanup();
    vi.restoreAllMocks();
    objectUrls.restore();
  });

  const brandProfile = (
    logoAssetId: string | null,
    overriddenFields?: string[],
  ) => ({
    displayName: 'AdFlow',
    primaryColor: null,
    secondaryColor: null,
    accentColor: null,
    fontFamily: null,
    websiteUrl: null,
    logoAssetId,
    ...(overriddenFields ? { overriddenFields } : {}),
  });

  // Serves the brand profile, the asset list, and each asset's bytes;
  // `content` overrides the reply for an asset's content or download.
  type ListedAsset = Omit<ReturnType<typeof asset>, 'width' | 'height'> & {
    width: number | null;
    height: number | null;
  };
  function serveImages(options: {
    assets: ListedAsset[];
    logoAssetId?: string | null;
    overriddenFields?: string[];
    content?: Record<string, number>;
  }) {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const match = /\/assets\/([^/?]+)\/(content|download)$/.exec(url);
      if (match) {
        const assetId = decodeURIComponent(match[1] ?? '');
        const status = options.content?.[assetId];
        return Promise.resolve(
          status ? statusReply(status) : imageReply(assetId),
        );
      }
      if (url.endsWith('/organization/brand') || url.endsWith('/effective'))
        return reply(
          200,
          brandProfile(options.logoAssetId ?? null, options.overriddenFields),
        );
      if (/\/assets(\?|$)/.test(url)) return reply(200, options.assets);
      return reply(200, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  const contentCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => /\/(content|download)$/.test(url));

  it('shows an authenticated thumbnail with format, dimensions, and size for each asset', async () => {
    const fetchMock = serveImages({
      assets: [
        { ...asset('asset-1', 'banner.png', null), width: 1200, height: 628 },
        {
          ...asset('asset-2', 'photo.jpg', null),
          mimeType: 'image/jpeg',
          width: null,
          height: null,
          sizeBytes: 3 * 1024 * 1024,
        },
      ],
    });
    render(
      <BrandAssets session={admin} branch={null} onUnauthorized={vi.fn()} />,
    );
    expect(
      await screen.findByRole('img', { name: 'Thumbnail of banner.png' }),
    ).toHaveAttribute('src', expect.stringMatching(/^blob:test\/asset-1\//));
    expect(
      await screen.findByRole('img', { name: 'Thumbnail of photo.jpg' }),
    ).toHaveAttribute('src', expect.stringMatching(/^blob:test\/asset-2\//));
    expect(
      inAssetList().getByText(
        'Organization asset · PNG · 1200 × 628 px · 2.0 KB',
      ),
    ).toBeInTheDocument();
    expect(
      inAssetList().getByText(
        'Organization asset · JPEG · Dimensions unknown · 3.0 MB',
      ),
    ).toBeInTheDocument();
    for (const call of fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith('/content'),
    ))
      expect((call as unknown[])[1]).toEqual(
        expect.objectContaining({
          headers: { Authorization: 'Bearer test-token' },
        }),
      );
  });

  it('opens a larger preview with the asset details and closes it', async () => {
    serveImages({
      assets: [
        { ...asset('asset-1', 'banner.png', null), width: 1200, height: 628 },
      ],
    });
    render(
      <BrandAssets session={admin} branch={null} onUnauthorized={vi.fn()} />,
    );
    const toggle = await screen.findByRole('button', {
      name: 'Preview banner.png',
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const preview = screen.getByRole('region', {
      name: 'Preview of banner.png',
    });
    expect(
      await within(preview).findByRole('img', { name: 'banner.png' }),
    ).toHaveAttribute('src', expect.stringMatching(/^blob:test\/asset-1\//));
    expect(within(preview).getByText('Format: PNG')).toBeInTheDocument();
    expect(
      within(preview).getByText('Dimensions: 1200 × 628 px'),
    ).toBeInTheDocument();
    expect(within(preview).getByText('File size: 2.0 KB')).toBeInTheDocument();
    fireEvent.click(
      within(preview).getByRole('button', { name: 'Close preview' }),
    );
    expect(
      screen.queryByRole('region', { name: 'Preview of banner.png' }),
    ).not.toBeInTheDocument();
  });

  it('downloads through the authenticated endpoint', async () => {
    const fetchMock = serveImages({
      assets: [asset('asset-1', 'banner.png', null)],
    });
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    render(
      <BrandAssets session={admin} branch={null} onUnauthorized={vi.fn()} />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Download banner.png' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Downloading “banner.png”.',
    );
    expect(clicked.map((link) => link.download)).toEqual(['banner.png']);
    expect(contentCalls(fetchMock)).toContain(
      'http://localhost:3000/api/v1/assets/asset-1/download',
    );
  });

  it.each([
    [404, '“banner.png” is no longer available.'],
    [403, 'You do not have permission to download this asset.'],
    [500, 'Unable to download “banner.png”.'],
  ])('explains a failed download (HTTP %i)', async (status, text) => {
    serveImages({
      assets: [asset('asset-1', 'banner.png', null)],
      content: { 'asset-1': status },
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    render(
      <BrandAssets session={admin} branch={null} onUnauthorized={vi.fn()} />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Download banner.png' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(click).not.toHaveBeenCalled();
  });

  it('signs out when a download finds the session expired', async () => {
    serveImages({
      assets: [asset('asset-1', 'banner.png', null)],
      content: { 'asset-1': 401 },
    });
    const onUnauthorized = vi.fn();
    render(
      <BrandAssets
        session={admin}
        branch={null}
        onUnauthorized={onUnauthorized}
      />,
    );
    await screen.findByRole('img', {
      name: 'Thumbnail of banner.png: Sign in again to view this image',
    });
    onUnauthorized.mockClear();
    fireEvent.click(
      screen.getByRole('button', { name: 'Download banner.png' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your session expired. Please sign in again.',
    );
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('keeps listing an asset whose file is missing, with a placeholder', async () => {
    serveImages({
      assets: [asset('asset-1', 'banner.png', null)],
      content: { 'asset-1': 404 },
    });
    render(
      <BrandAssets session={admin} branch={null} onUnauthorized={vi.fn()} />,
    );
    expect(
      await screen.findByRole('img', {
        name: 'Thumbnail of banner.png: Image unavailable',
      }),
    ).toBeInTheDocument();
    expect(inAssetList().getByText('banner.png')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Delete banner.png' }),
    ).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the organization logo image', async () => {
    serveImages({
      assets: [asset('logo-1', 'logo.png', null)],
      logoAssetId: 'logo-1',
    });
    render(
      <BrandAssets session={admin} branch={null} onUnauthorized={vi.fn()} />,
    );
    expect(
      await screen.findByRole('img', { name: 'Organization logo' }),
    ).toHaveAttribute('src', expect.stringMatching(/^blob:test\/logo-1\//));
  });

  it('shows a placeholder when no logo is configured', async () => {
    const fetchMock = serveImages({ assets: [] });
    render(
      <BrandAssets session={admin} branch={null} onUnauthorized={vi.fn()} />,
    );
    expect(
      await screen.findByRole('img', {
        name: 'Organization logo: no logo configured',
      }),
    ).toHaveTextContent('No logo');
    expect(contentCalls(fetchMock)).toEqual([]);
  });

  it('labels a branch logo inherited from the organization and one the branch overrides', async () => {
    const branchSession = {
      ...sessionWith(['brand:read', 'assets:read']),
      user: {
        permissions: ['brand:read', 'assets:read'],
        branches: [{ id: 'branch-1', name: 'North', code: 'NORTH' }],
      },
    } as unknown as Session;
    const northBranch = {
      id: 'branch-1',
      name: 'North',
      code: 'NORTH',
      status: 'ACTIVE',
    } as const;
    serveImages({ assets: [], logoAssetId: 'org-logo' });
    render(
      <BrandAssets
        session={branchSession}
        branch={northBranch}
        onUnauthorized={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole('img', {
        name: 'Logo inherited from the organization',
      }),
    ).toHaveAttribute('src', expect.stringMatching(/^blob:test\/org-logo\//));
    cleanup();
    serveImages({
      assets: [],
      logoAssetId: 'north-logo',
      overriddenFields: ['logoAssetId'],
    });
    render(
      <BrandAssets
        session={branchSession}
        branch={northBranch}
        onUnauthorized={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole('img', { name: 'North logo' }),
    ).toHaveAttribute('src', expect.stringMatching(/^blob:test\/north-logo\//));
  });

  it('requests no image bytes and offers no preview or download without asset read permission', async () => {
    const fetchMock = serveImages({
      assets: [asset('asset-1', 'banner.png', null)],
      logoAssetId: 'logo-1',
    });
    render(
      <BrandAssets
        session={sessionWith(['brand:read'])}
        branch={null}
        onUnauthorized={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole('img', {
        name: 'Organization logo: you do not have permission to view assets',
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Preview banner.png' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Download banner.png' }),
    ).not.toBeInTheDocument();
    expect(contentCalls(fetchMock)).toEqual([]);
  });
});
