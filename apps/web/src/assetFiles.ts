// Every image byte comes from the authenticated asset API with the bearer
// token, never from a public or filesystem URL. The bytes become an object
// URL that lives only as long as the component showing it.
export type AssetSource = {
  apiBase: string;
  accessToken: string;
  onUnauthorized: () => void;
};

export function assetPath(assetId: string, suffix = ''): string {
  return '/assets/' + encodeURIComponent(assetId) + suffix;
}

export function failureStatus(
  status: number,
): 'unauthorized' | 'forbidden' | 'missing' | 'error' {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'missing';
  return 'error';
}

export async function fetchAsset(
  source: AssetSource,
  path: string,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetch(source.apiBase + path, {
    headers: { Authorization: 'Bearer ' + source.accessToken },
    signal,
  });
  if (response.status === 401) source.onUnauthorized();
  return response;
}

const formatLabels: Record<string, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
};

export function formatLabel(mimeType: string): string {
  return formatLabels[mimeType] ?? mimeType;
}

export function formatDimensions(
  width: number | null,
  height: number | null,
): string {
  return width && height
    ? width + ' × ' + height + ' px'
    : 'Dimensions unknown';
}

export function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return sizeBytes + ' B';
  if (sizeBytes < 1024 * 1024) return (sizeBytes / 1024).toFixed(1) + ' KB';
  return (sizeBytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Saves an asset through the authenticated download endpoint. Resolves when
// the browser has been handed the file; rejects with a message to show.
export async function downloadAsset(
  source: AssetSource,
  asset: { id: string; originalName: string },
): Promise<void> {
  let response: Response;
  try {
    response = await fetchAsset(source, assetPath(asset.id, '/download'));
  } catch {
    throw new Error('Unable to download “' + asset.originalName + '”.');
  }
  if (!response.ok) {
    const status = failureStatus(response.status);
    throw new Error(
      status === 'unauthorized'
        ? 'Your session expired. Please sign in again.'
        : status === 'forbidden'
          ? 'You do not have permission to download this asset.'
          : status === 'missing'
            ? '“' + asset.originalName + '” is no longer available.'
            : 'Unable to download “' + asset.originalName + '”.',
    );
  }
  const file = await response.blob();
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = asset.originalName;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked after the click has been handled so the save can start.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
