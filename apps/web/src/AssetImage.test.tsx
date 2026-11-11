import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  downloadAsset,
  formatDimensions,
  formatFileSize,
  formatLabel,
  type AssetSource,
} from './assetFiles';
import { AssetImage, AssetReference } from './AssetImage';
import { imageReply, statusReply, stubObjectUrls } from './assetTestUtils';

let objectUrls: ReturnType<typeof stubObjectUrls>;
beforeEach(() => {
  objectUrls = stubObjectUrls();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  objectUrls.restore();
});

const source = (onUnauthorized = vi.fn()): AssetSource => ({
  apiBase: 'http://api.test/api/v1',
  accessToken: 'test-token',
  onUnauthorized,
});

const metadata = (id: string, originalName: string) => ({
  id,
  organizationId: 'org-1',
  branchId: null,
  originalName,
  mimeType: 'image/png',
  sizeBytes: 2048,
  width: 1200,
  height: 628,
  status: 'ACTIVE',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

describe('AssetImage', () => {
  it('loads the bytes from the authenticated content endpoint into an object URL', async () => {
    const fetchMock = vi.fn(async () => imageReply('asset-1'));
    vi.stubGlobal('fetch', fetchMock);
    render(<AssetImage assetId="asset-1" alt="Logo" source={source()} />);
    const image = await screen.findByRole('img', { name: 'Logo' });
    expect(image.tagName).toBe('IMG');
    expect(image).toHaveAttribute('src', 'blob:test/asset-1/1');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/api/v1/assets/asset-1/content',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
  });

  it('encodes the asset ID so it cannot change the request path', async () => {
    const fetchMock = vi.fn(async () => imageReply('odd'));
    vi.stubGlobal('fetch', fetchMock);
    render(<AssetImage assetId="../x?y" alt="Odd" source={source()} />);
    await screen.findByRole('img', { name: 'Odd' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/api/v1/assets/..%2Fx%3Fy/content',
      expect.anything(),
    );
  });

  it('releases the object URL when the image unmounts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => imageReply('asset-1')),
    );
    const { unmount } = render(
      <AssetImage assetId="asset-1" alt="Logo" source={source()} />,
    );
    await screen.findByRole('img', { name: 'Logo' });
    unmount();
    expect(objectUrls.revoked).toEqual(['blob:test/asset-1/1']);
  });

  it.each([
    [401, 'Sign in again to view this image'],
    [403, 'You do not have permission to view this image'],
    [404, 'Image unavailable'],
    [500, 'Unable to load image'],
  ])('shows a fallback for HTTP %i', async (status, text) => {
    const onUnauthorized = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => statusReply(status)),
    );
    render(
      <AssetImage
        assetId="asset-1"
        alt="Logo"
        source={source(onUnauthorized)}
      />,
    );
    expect(
      await screen.findByRole('img', { name: 'Logo: ' + text }),
    ).toHaveTextContent(text);
    expect(onUnauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(objectUrls.created).toEqual([]);
  });

  it('treats a response that is not an image as invalid', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => imageReply('asset-1', 'text/html')),
    );
    render(<AssetImage assetId="asset-1" alt="Logo" source={source()} />);
    expect(
      await screen.findByRole('img', {
        name: 'Logo: Image could not be displayed',
      }),
    ).toBeInTheDocument();
    expect(objectUrls.created).toEqual([]);
  });

  it('shows a fallback when the browser cannot decode the image', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => imageReply('asset-1')),
    );
    render(<AssetImage assetId="asset-1" alt="Logo" source={source()} />);
    fireEvent.error(await screen.findByRole('img', { name: 'Logo' }));
    expect(
      await screen.findByRole('img', {
        name: 'Logo: Image could not be displayed',
      }),
    ).toBeInTheDocument();
  });

  it('shows a fallback when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    render(<AssetImage assetId="asset-1" alt="Logo" source={source()} />);
    expect(
      await screen.findByRole('img', { name: 'Logo: Unable to load image' }),
    ).toBeInTheDocument();
  });
});

describe('downloadAsset', () => {
  it('saves the file from the authenticated download endpoint under its name', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => imageReply('asset-1'));
    vi.stubGlobal('fetch', fetchMock);
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    await downloadAsset(source(), { id: 'asset-1', originalName: 'logo.png' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/api/v1/assets/asset-1/download',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.download).toBe('logo.png');
    expect(clicked[0]?.href).toBe('blob:test/asset-1/1');
    expect(clicked[0]?.isConnected).toBe(false);
    vi.runAllTimers();
    expect(objectUrls.revoked).toEqual(['blob:test/asset-1/1']);
  });

  it.each([
    [401, 'Your session expired. Please sign in again.'],
    [403, 'You do not have permission to download this asset.'],
    [404, '“logo.png” is no longer available.'],
    [500, 'Unable to download “logo.png”.'],
  ])('rejects HTTP %i with a message to show', async (status, message) => {
    const onUnauthorized = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => statusReply(status)),
    );
    await expect(
      downloadAsset(source(onUnauthorized), {
        id: 'asset-1',
        originalName: 'logo.png',
      }),
    ).rejects.toThrow(message);
    expect(onUnauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    expect(objectUrls.created).toEqual([]);
  });

  it('rejects a network failure with a message to show', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(
      downloadAsset(source(), { id: 'asset-1', originalName: 'logo.png' }),
    ).rejects.toThrow('Unable to download “logo.png”.');
  });
});

describe('AssetReference', () => {
  function serve(assets: Record<string, ReturnType<typeof metadata> | number>) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const [, path = ''] = String(input).split('/assets/');
      const [id = '', suffix] = path.split('/');
      const entry = assets[decodeURIComponent(id)];
      if (entry === undefined || typeof entry === 'number')
        return statusReply(entry ?? 404);
      return suffix === 'content'
        ? imageReply(entry.id)
        : statusReply(200, entry);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('shows the referenced image with its file name and details instead of the ID', async () => {
    serve({ 'asset-1': metadata('asset-1', 'hero.png') });
    render(
      <AssetReference
        assetId="asset-1"
        label="Hero"
        source={source()}
        canReadAssets
      />,
    );
    expect(
      await screen.findByRole('img', { name: 'Hero: hero.png' }),
    ).toHaveAttribute('src', 'blob:test/asset-1/1');
    expect(screen.getByText('hero.png')).toBeInTheDocument();
    expect(
      screen.getByText('PNG · 1200 × 628 px · 2.0 KB'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/asset-1/)).not.toBeInTheDocument();
  });

  it('follows a change of referenced asset to that asset own image', async () => {
    serve({
      'asset-1': metadata('asset-1', 'first.png'),
      'asset-2': metadata('asset-2', 'second.png'),
    });
    const { rerender } = render(
      <AssetReference
        assetId="asset-1"
        label="Hero"
        source={source()}
        canReadAssets
      />,
    );
    await screen.findByRole('img', { name: 'Hero: first.png' });
    rerender(
      <AssetReference
        assetId="asset-2"
        label="Hero"
        source={source()}
        canReadAssets
      />,
    );
    expect(
      await screen.findByRole('img', { name: 'Hero: second.png' }),
    ).toHaveAttribute('src', expect.stringMatching(/^blob:test\/asset-2\//));
    expect(screen.queryByText('first.png')).not.toBeInTheDocument();
  });

  it('explains a removed asset without requesting its content', async () => {
    const fetchMock = serve({});
    render(
      <AssetReference
        assetId="gone"
        label="Hero"
        source={source()}
        canReadAssets
      />,
    );
    expect(
      await screen.findByText(
        'Image unavailable — the asset was removed or cannot be found',
      ),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('explains an asset in a branch the viewer cannot access', async () => {
    serve({ other: 403 });
    render(
      <AssetReference
        assetId="other"
        label="Hero"
        source={source()}
        canReadAssets
      />,
    );
    expect(
      await screen.findByText('You do not have permission to view this image'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('requests nothing without the asset read permission', () => {
    const fetchMock = serve({});
    render(
      <AssetReference
        assetId="asset-1"
        label="Hero"
        source={source()}
        canReadAssets={false}
      />,
    );
    expect(
      screen.getByText(
        'Image selected · you do not have permission to view assets',
      ),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says when no image is selected', () => {
    const fetchMock = serve({});
    render(
      <AssetReference
        assetId={null}
        label="Hero"
        source={source()}
        canReadAssets
      />,
    );
    expect(screen.getByText('No image selected')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls the sign-out handler when the session has expired', async () => {
    const onUnauthorized = vi.fn();
    serve({ 'asset-1': 401 });
    render(
      <AssetReference
        assetId="asset-1"
        label="Hero"
        source={source(onUnauthorized)}
        canReadAssets
      />,
    );
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
  });
});

describe('asset formatting', () => {
  it('labels formats, dimensions, and sizes', () => {
    expect(formatLabel('image/png')).toBe('PNG');
    expect(formatLabel('image/jpeg')).toBe('JPEG');
    expect(formatLabel('image/webp')).toBe('WebP');
    expect(formatLabel('image/gif')).toBe('image/gif');
    expect(formatDimensions(1200, 628)).toBe('1200 × 628 px');
    expect(formatDimensions(null, 628)).toBe('Dimensions unknown');
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2.0 KB');
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
