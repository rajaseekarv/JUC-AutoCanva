import { useEffect, useState } from 'react';
import type { AssetResponse } from '@adflow/shared-types';
import {
  assetPath,
  failureStatus,
  fetchAsset,
  formatDimensions,
  formatFileSize,
  formatLabel,
  type AssetSource,
} from './assetFiles';

type ImageState =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | {
      status:
        | 'unauthorized'
        | 'forbidden'
        | 'missing'
        | 'invalid'
        | 'error'
        | 'unavailable';
    };

const fallbackText: Record<Exclude<ImageState['status'], 'ready'>, string> = {
  loading: 'Loading image…',
  unauthorized: 'Sign in again to view this image',
  forbidden: 'You do not have permission to view this image',
  missing: 'Image unavailable',
  invalid: 'Image could not be displayed',
  error: 'Unable to load image',
  unavailable: 'Image preview is not supported in this browser',
};

// Fetches an asset's bytes for display. The request is cancelled and the
// object URL released when the asset changes or the image unmounts.
function useAssetImage(assetId: string, source: AssetSource): ImageState {
  const [state, setState] = useState<ImageState>({ status: 'loading' });
  const { apiBase, accessToken } = source;
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = '';
    setState({ status: 'loading' });
    if (typeof URL.createObjectURL !== 'function') {
      setState({ status: 'unavailable' });
      return () => controller.abort();
    }
    void (async () => {
      let next: ImageState;
      try {
        const response = await fetchAsset(
          source,
          assetPath(assetId, '/content'),
          controller.signal,
        );
        if (!response.ok) {
          next = { status: failureStatus(response.status) };
        } else {
          const image = await response.blob();
          if (!image.type.startsWith('image/')) {
            next = { status: 'invalid' };
          } else {
            objectUrl = URL.createObjectURL(image);
            next = { status: 'ready', url: objectUrl };
          }
        }
      } catch {
        next = { status: 'error' };
      }
      if (controller.signal.aborted) {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        return;
      }
      setState(next);
    })();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // The callback may change identity on every render; the image depends
    // only on which asset is shown and for which session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId, apiBase, accessToken]);
  return state;
}

export function AssetImage({
  assetId,
  alt,
  source,
  variant = 'thumbnail',
}: {
  assetId: string;
  alt: string;
  source: AssetSource;
  variant?: 'thumbnail' | 'preview' | 'logo';
}) {
  const loaded = useAssetImage(assetId, source);
  // A response that is not a decodable image (for example a corrupt file)
  // fails in the browser rather than in the request.
  const [brokenUrl, setBrokenUrl] = useState('');
  const state: ImageState =
    loaded.status === 'ready' && loaded.url === brokenUrl
      ? { status: 'invalid' }
      : loaded;
  const className = 'asset-image asset-image-' + variant;
  if (state.status === 'ready')
    return (
      <img
        className={className}
        src={state.url}
        alt={alt}
        onError={() => setBrokenUrl(state.url)}
      />
    );
  return (
    <span
      className={className + ' asset-image-fallback'}
      role="img"
      aria-label={alt + ': ' + fallbackText[state.status]}
      aria-busy={state.status === 'loading'}
      data-image-state={state.status}
    >
      {fallbackText[state.status]}
    </span>
  );
}

type MetadataState =
  | { status: 'loading' }
  | { status: 'loaded'; asset: AssetResponse }
  | { status: 'unauthorized' | 'forbidden' | 'missing' | 'error' };

const metadataText: Record<
  Exclude<MetadataState['status'], 'loaded'>,
  string
> = {
  loading: 'Loading image…',
  unauthorized: 'Sign in again to view this image',
  forbidden: 'You do not have permission to view this image',
  missing: 'Image unavailable — the asset was removed or cannot be found',
  error: 'Unable to load image details',
};

// An image or logo value stored on a creative revision: the referenced
// asset's own picture and file name. A historical revision passes its own
// stored asset ID, so it always shows the image it was saved with.
export function AssetReference({
  assetId,
  label,
  source,
  canReadAssets,
}: {
  assetId: unknown;
  label: string;
  source: AssetSource;
  canReadAssets: boolean;
}) {
  const id = typeof assetId === 'string' && assetId ? assetId : '';
  const [metadata, setMetadata] = useState<MetadataState>({
    status: 'loading',
  });
  const { apiBase, accessToken } = source;
  useEffect(() => {
    if (!id || !canReadAssets) return;
    const controller = new AbortController();
    setMetadata({ status: 'loading' });
    void (async () => {
      let next: MetadataState;
      try {
        const response = await fetchAsset(
          source,
          assetPath(id),
          controller.signal,
        );
        next = response.ok
          ? {
              status: 'loaded',
              asset: (await response.json()) as AssetResponse,
            }
          : { status: failureStatus(response.status) };
      } catch {
        next = { status: 'error' };
      }
      if (!controller.signal.aborted) setMetadata(next);
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, canReadAssets, apiBase, accessToken]);

  if (!id) return <span className="asset-reference">No image selected</span>;
  if (!canReadAssets)
    return (
      <span className="asset-reference asset-reference-note">
        Image selected · you do not have permission to view assets
      </span>
    );
  if (metadata.status !== 'loaded')
    return (
      <span
        className="asset-reference asset-reference-note"
        aria-busy={metadata.status === 'loading'}
        data-image-state={metadata.status}
      >
        {metadataText[metadata.status]}
      </span>
    );
  const { asset } = metadata;
  return (
    <span className="asset-reference">
      <AssetImage
        assetId={asset.id}
        alt={label + ': ' + asset.originalName}
        source={source}
      />
      <span className="asset-reference-details">
        <strong>{asset.originalName}</strong>
        <span>
          {formatLabel(asset.mimeType)} ·{' '}
          {formatDimensions(asset.width, asset.height)} ·{' '}
          {formatFileSize(asset.sizeBytes)}
        </span>
      </span>
    </span>
  );
}
