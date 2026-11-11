import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  AssetInUseConflictResponse,
  AssetInUseReason,
  AssetUsageResponse,
  AuthenticatedUserResponse,
  BranchResponse,
} from '@adflow/shared-types';
import { AssetImage } from './AssetImage';
import {
  downloadAsset,
  formatDimensions,
  formatFileSize,
  formatLabel,
  type AssetSource,
} from './assetFiles';

const apiBase =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000/api/v1';
type Session = { accessToken: string; user: AuthenticatedUserResponse };
type Brand = {
  displayName: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  accentColor: string | null;
  fontFamily: string | null;
  websiteUrl: string | null;
  logoAssetId: string | null;
  overriddenFields?: string[];
};
type Asset = {
  id: string;
  branchId: string | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
};

class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

const inUseLabels: Record<AssetInUseReason, string> = {
  CREATIVE_REVISION: 'In use by a creative',
  ORGANIZATION_BRAND_LOGO: 'Organization brand logo',
  BRANCH_BRAND_LOGO: 'Branch brand logo',
};

// The message for a failed save or upload. The server's own 400 message
// explains what to fix (for example an unsupported image type); a 403 keeps
// the permission message and a 401 the sign-in message from request();
// anything else uses the action's fallback rather than the generic load error.
function failureMessage(cause: unknown, fallback: string): string {
  if (!(cause instanceof RequestError))
    return cause instanceof Error ? cause.message : fallback;
  if (cause.status === 403) return cause.message;
  const serverMessage = (cause.body as { message?: unknown } | null)?.message;
  if (cause.status === 400 && typeof serverMessage === 'string')
    return serverMessage;
  return fallback;
}

type UsageState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'loaded'; usage: AssetUsageResponse };

// Only a complete response may be shown, and only it can say "not used".
function isUsageResponse(body: unknown): body is AssetUsageResponse {
  const usage = body as Partial<AssetUsageResponse> | null;
  return (
    typeof usage?.inUse === 'boolean' &&
    Array.isArray(usage.creativeRevisions) &&
    Array.isArray(usage.branchBrandProfiles) &&
    usage.organizationBrandProfile !== undefined &&
    typeof usage.hiddenReferenceCount === 'number'
  );
}

function fieldNames(revision: AssetUsageResponse['creativeRevisions'][number]) {
  return revision.fields.length
    ? revision.fields
        .map((field) => (field.label ?? field.key) + ' field')
        .join(', ')
    : 'Field not identified';
}

function inUseLabel(reason: AssetInUseReason | null): string {
  return reason ? inUseLabels[reason] : 'In use';
}

function inUseReason(body: unknown): AssetInUseReason | null {
  const reason = (body as Partial<AssetInUseConflictResponse> | null)?.reason;
  return reason && reason in inUseLabels ? reason : null;
}

// Explains a refused deletion (HTTP 409); the asset itself is unchanged.
function inUseMessage(name: string, reason: AssetInUseReason | null): string {
  const quoted = '“' + name + '”';
  switch (reason) {
    case 'CREATIVE_REVISION':
      return (
        quoted +
        ' is being used by a creative, so it cannot be deleted. The asset has been kept.'
      );
    case 'ORGANIZATION_BRAND_LOGO':
      return (
        quoted +
        ' is the organization brand logo, so it cannot be deleted. Choose a different logo first.'
      );
    case 'BRANCH_BRAND_LOGO':
      return (
        quoted +
        ' is a branch brand logo, so it cannot be deleted. Choose a different logo for that branch first.'
      );
    default:
      return quoted + ' is in use, so it cannot be deleted.';
  }
}

export default function BrandAssets({
  session,
  branch,
  onUnauthorized,
}: {
  session: Session;
  branch: BranchResponse | null;
  onUnauthorized: () => void;
}) {
  const canManageBrand = session.user.permissions.includes('brand:manage');
  const canManageOrganization = session.user.permissions.includes(
    'organizations:update',
  );
  const canManageAssets = session.user.permissions.includes('assets:manage');
  const [scopeBranchId, setScopeBranchId] = useState('');
  const scopeBranch = session.user.branches.find(
    (item) => item.id === scopeBranchId,
  );
  const incomingBranchId = branch?.id;
  useEffect(() => {
    if (incomingBranchId) setScopeBranchId(incomingBranchId);
  }, [incomingBranchId]);
  const [brand, setBrand] = useState<Brand | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmingAssetId, setConfirmingAssetId] = useState('');
  // One usage panel at a time; the counter discards responses for a panel
  // that was closed or replaced before they arrived.
  const [usageAssetId, setUsageAssetId] = useState('');
  const [usage, setUsage] = useState<UsageState>({ status: 'loading' });
  const usageRequest = useRef(0);
  const canReadAssets = session.user.permissions.includes('assets:read');
  // Assets whose deletion the server refused because they are referenced.
  const [inUse, setInUse] = useState<Record<string, AssetInUseReason | null>>(
    {},
  );
  const [previewAssetId, setPreviewAssetId] = useState('');
  const [downloadingAssetId, setDownloadingAssetId] = useState('');
  const assetSource: AssetSource = {
    apiBase,
    accessToken: session.accessToken,
    onUnauthorized,
  };

  async function download(asset: Asset): Promise<void> {
    setDownloadingAssetId(asset.id);
    setError('');
    setMessage('');
    try {
      await downloadAsset(assetSource, asset);
      setMessage('Downloading “' + asset.originalName + '”.');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Unable to download “' + asset.originalName + '”.',
      );
    } finally {
      setDownloadingAssetId('');
    }
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(apiBase + path, {
      ...init,
      headers: {
        Authorization: 'Bearer ' + session.accessToken,
        ...(init?.body instanceof FormData
          ? {}
          : init?.body
            ? { 'Content-Type': 'application/json' }
            : {}),
        ...init?.headers,
      },
    });
    if (response.status === 401) {
      onUnauthorized();
      throw new Error('Your session expired. Please sign in again.');
    }
    if (!response.ok)
      throw new RequestError(
        response.status === 403
          ? 'You do not have permission to complete this action.'
          : 'Unable to load brand settings.',
        response.status,
        await response.json().catch(() => null),
      );
    return response.json() as Promise<T>;
  }

  async function reload(): Promise<void> {
    if (!session.user.permissions.includes('brand:read')) return;
    setError('');
    // Brand settings need only brand:read; without assets:read the asset
    // list is never requested, so its 403 cannot hide the brand profile.
    const listAssets = (path: string): Promise<Asset[]> =>
      canReadAssets ? request<Asset[]>(path) : Promise.resolve([]);
    try {
      if (scopeBranch) {
        const [resolved, list] = await Promise.all([
          request<Brand>(
            '/branches/' +
              encodeURIComponent(scopeBranch.id) +
              '/brand/effective',
          ),
          listAssets('/assets?branchId=' + encodeURIComponent(scopeBranch.id)),
        ]);
        setBrand(resolved);
        setAssets(list);
      } else {
        const [profile, list] = await Promise.all([
          request<Brand>('/organization/brand'),
          listAssets('/assets'),
        ]);
        setBrand(profile);
        setAssets(list);
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Unable to load brand settings.',
      );
    }
  }
  useEffect(() => {
    void reload();
    // Reload when the active identity or branch context changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.accessToken, scopeBranchId]);

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!brand) return;
    setBusy(true);
    setError('');
    setMessage('');
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(
      [
        'displayName',
        'primaryColor',
        'secondaryColor',
        'accentColor',
        'fontFamily',
        'websiteUrl',
        'logoAssetId',
      ].map((key) => {
        const value = String(form.get(key) ?? '').trim();
        return [key, value || null];
      }),
    );
    try {
      const path = scopeBranch
        ? '/branches/' + encodeURIComponent(scopeBranch.id) + '/brand'
        : '/organization/brand';
      const result = await request<Brand>(path, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      setBrand(result);
      setMessage('Brand profile saved.');
    } catch (cause) {
      setError(failureMessage(cause, 'Unable to save brand profile.'));
    } finally {
      setBusy(false);
    }
  }

  async function upload(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const query = scopeBranch
      ? '?branchId=' + encodeURIComponent(scopeBranch.id)
      : '';
    try {
      await request<Asset>('/assets' + query, { method: 'POST', body: form });
      setMessage('Asset uploaded.');
      formElement.reset();
      await reload();
    } catch (cause) {
      setError(failureMessage(cause, 'Unable to upload asset.'));
    } finally {
      setBusy(false);
    }
  }

  // Organization-wide assets also need organization management, as the
  // server enforces; branch assets are checked against branch access there.
  const canDelete = (asset: Asset) =>
    canManageAssets && (asset.branchId !== null || canManageOrganization);

  function closeUsage(): void {
    usageRequest.current += 1;
    setUsageAssetId('');
  }

  // Read-only: fetches where the asset is used each time the panel opens, so
  // it never shows usage from before a later change.
  async function loadUsage(asset: Asset): Promise<void> {
    const requestId = ++usageRequest.current;
    setUsageAssetId(asset.id);
    setUsage({ status: 'loading' });
    let next: UsageState;
    try {
      const body = await request<unknown>(
        '/assets/' + encodeURIComponent(asset.id) + '/usage',
      );
      next = isUsageResponse(body)
        ? { status: 'loaded', usage: body }
        : { status: 'error' };
    } catch {
      next = { status: 'error' };
    }
    if (usageRequest.current === requestId) setUsage(next);
  }

  // A different scope lists different assets; close any open panel.
  useEffect(() => {
    usageRequest.current += 1;
    setUsageAssetId('');
    setPreviewAssetId('');
  }, [scopeBranchId]);

  async function remove(asset: Asset): Promise<void> {
    setBusy(true);
    setError('');
    setMessage('');
    setConfirmingAssetId('');
    let outcome: { error?: string; message?: string; refresh: boolean };
    try {
      await request<{ id: string; status: 'DELETED' }>(
        '/assets/' + encodeURIComponent(asset.id),
        { method: 'DELETE' },
      );
      outcome = {
        message: '“' + asset.originalName + '” deleted.',
        refresh: true,
      };
    } catch (cause) {
      if (cause instanceof RequestError && cause.status === 409) {
        // Nothing changed on the server: keep the asset listed and say why.
        const reason = inUseReason(cause.body);
        setInUse((current) => ({ ...current, [asset.id]: reason }));
        outcome = {
          error: inUseMessage(asset.originalName, reason),
          refresh: true,
        };
      } else if (cause instanceof RequestError && cause.status === 404) {
        outcome = {
          error:
            '“' +
            asset.originalName +
            '” was already deleted or is no longer available.',
          refresh: true,
        };
      } else {
        outcome = {
          error:
            cause instanceof RequestError && cause.status !== 403
              ? 'Unable to delete asset.'
              : cause instanceof Error
                ? cause.message
                : 'Unable to delete asset.',
          // A 401 has already signed the user out; do not reload.
          refresh: cause instanceof RequestError,
        };
      }
    }
    // Reload first: it clears the banner before fetching the current list.
    if (outcome.refresh) await reload();
    if (outcome.error) setError(outcome.error);
    if (outcome.message) setMessage(outcome.message);
    setBusy(false);
  }

  if (!session.user.permissions.includes('brand:read')) return null;
  return (
    <section
      className="admin-panel"
      id="brand-assets"
      aria-labelledby="brand-assets-title"
    >
      <div className="admin-heading">
        <div>
          <p className="eyebrow">BRAND MANAGEMENT</p>
          <h2 id="brand-assets-title">
            {scopeBranch ? scopeBranch.name + ' brand' : 'Organization brand'}
          </h2>
        </div>
        <label>
          Brand scope
          <select
            aria-label="Brand scope"
            value={scopeBranchId}
            onChange={(event) => setScopeBranchId(event.target.value)}
          >
            <option value="">Organization</option>
            {session.user.branches.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>{' '}
        <button className="secondary-button" onClick={() => void reload()}>
          Refresh
        </button>
      </div>
      {error && (
        <p role="alert" className="form-message">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="success-message">
          {message}
        </p>
      )}
      {brand && (
        <section className="admin-card">
          <h3>
            {scopeBranch ? 'Effective branch profile' : 'Organization profile'}
          </h3>
          <BrandLogo
            logoAssetId={brand.logoAssetId}
            label={
              !scopeBranch
                ? 'Organization logo'
                : brand.overriddenFields?.includes('logoAssetId')
                  ? scopeBranch.name + ' logo'
                  : 'Logo inherited from the organization'
            }
            canReadAssets={canReadAssets}
            source={assetSource}
          />
          {canManageBrand && (scopeBranch || canManageOrganization) ? (
            <form className="admin-form" onSubmit={(event) => void save(event)}>
              <label>
                Display name
                <input
                  name="displayName"
                  defaultValue={brand.displayName ?? ''}
                  maxLength={120}
                />
              </label>
              <label>
                Primary color
                <input
                  name="primaryColor"
                  type="color"
                  defaultValue={brand.primaryColor ?? '#202020'}
                />
              </label>
              <label>
                Secondary color
                <input
                  name="secondaryColor"
                  type="color"
                  defaultValue={brand.secondaryColor ?? '#ffffff'}
                />
              </label>
              <label>
                Accent color
                <input
                  name="accentColor"
                  type="color"
                  defaultValue={brand.accentColor ?? '#2f6fed'}
                />
              </label>
              <label>
                Font family
                <input
                  name="fontFamily"
                  defaultValue={brand.fontFamily ?? ''}
                  maxLength={120}
                />
              </label>
              <label>
                Website
                <input
                  name="websiteUrl"
                  type="url"
                  defaultValue={brand.websiteUrl ?? ''}
                />
              </label>
              <label>
                Logo image
                <select
                  name="logoAssetId"
                  defaultValue={brand.logoAssetId ?? ''}
                >
                  <option value="">No logo selected</option>
                  {assets
                    .filter((asset) =>
                      scopeBranch
                        ? asset.branchId === null ||
                          asset.branchId === scopeBranch.id
                        : asset.branchId === null,
                    )
                    .map((asset) => (
                      <option key={asset.id} value={asset.id}>
                        {asset.originalName}
                      </option>
                    ))}
                </select>
              </label>{' '}
              <button type="submit" disabled={busy}>
                Save brand profile
              </button>
            </form>
          ) : (
            <dl className="profile-list">
              <dt>Display name</dt>
              <dd>{brand.displayName ?? '—'}</dd>
              <dt>Primary color</dt>
              <dd>{brand.primaryColor ?? '—'}</dd>
              <dt>Website</dt>
              <dd>{brand.websiteUrl ?? '—'}</dd>
              <dt>Branch overrides</dt>
              <dd>{brand.overriddenFields?.join(', ') || 'None'}</dd>
            </dl>
          )}
        </section>
      )}
      {canManageAssets && (scopeBranch || canManageOrganization) && (
        <form
          className="admin-card admin-form"
          onSubmit={(event) => void upload(event)}
        >
          <h3>Upload image asset</h3>
          <p>
            PNG, JPEG, or WebP; maximum 5 MB. Files are stored locally and
            branch uploads are restricted to the selected branch.
          </p>
          <label>
            Image
            <input
              name="file"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              required
            />
          </label>
          <button type="submit" disabled={busy}>
            Upload asset
          </button>
        </form>
      )}
      {canReadAssets && (
        <section className="admin-card">
          <h3>Assets</h3>
          {assets.length ? (
            <ul className="admin-list">
              {assets.map((asset) => (
                <li key={asset.id} className="asset-row">
                  {canReadAssets && (
                    <AssetImage
                      assetId={asset.id}
                      alt={'Thumbnail of ' + asset.originalName}
                      source={assetSource}
                    />
                  )}
                  <div className="asset-row-details">
                    <strong>{asset.originalName}</strong>
                    <span>
                      {asset.branchId ? 'Branch asset' : 'Organization asset'} ·{' '}
                      {formatLabel(asset.mimeType)} ·{' '}
                      {formatDimensions(asset.width, asset.height)} ·{' '}
                      {formatFileSize(asset.sizeBytes)}
                    </span>
                    {asset.id in inUse && (
                      <span className="asset-in-use">
                        {inUseLabel(inUse[asset.id] ?? null) +
                          ' · cannot be deleted'}
                      </span>
                    )}
                  </div>
                  <div className="template-actions">
                    {canReadAssets && (
                      <>
                        <button
                          type="button"
                          className="secondary-button"
                          aria-expanded={previewAssetId === asset.id}
                          aria-controls={'asset-preview-' + asset.id}
                          aria-label={'Preview ' + asset.originalName}
                          onClick={() =>
                            setPreviewAssetId(
                              previewAssetId === asset.id ? '' : asset.id,
                            )
                          }
                        >
                          Preview
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={downloadingAssetId === asset.id}
                          aria-label={'Download ' + asset.originalName}
                          onClick={() => void download(asset)}
                        >
                          {downloadingAssetId === asset.id
                            ? 'Downloading…'
                            : 'Download'}
                        </button>
                      </>
                    )}
                    {canReadAssets && (
                      <button
                        type="button"
                        className="secondary-button"
                        aria-expanded={usageAssetId === asset.id}
                        aria-controls={'asset-usage-' + asset.id}
                        aria-label={
                          'Where is this asset used? (' +
                          asset.originalName +
                          ')'
                        }
                        onClick={() =>
                          usageAssetId === asset.id
                            ? closeUsage()
                            : void loadUsage(asset)
                        }
                      >
                        Where is this asset used?
                      </button>
                    )}
                    {canDelete(asset) &&
                      (confirmingAssetId === asset.id ? (
                        <div
                          className="template-actions"
                          role="group"
                          aria-label={'Confirm deleting ' + asset.originalName}
                        >
                          <span>Delete permanently?</span>
                          <button
                            type="button"
                            className="danger-button"
                            disabled={busy}
                            onClick={() => void remove(asset)}
                          >
                            Confirm delete
                          </button>
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={busy}
                            onClick={() => setConfirmingAssetId('')}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="danger-button"
                          disabled={busy}
                          aria-label={'Delete ' + asset.originalName}
                          onClick={() => setConfirmingAssetId(asset.id)}
                        >
                          Delete
                        </button>
                      ))}
                  </div>
                  {previewAssetId === asset.id && (
                    <section
                      id={'asset-preview-' + asset.id}
                      className="asset-preview"
                      aria-label={'Preview of ' + asset.originalName}
                    >
                      <AssetImage
                        assetId={asset.id}
                        alt={asset.originalName}
                        source={assetSource}
                        variant="preview"
                      />
                      <div className="asset-preview-details">
                        <strong>{asset.originalName}</strong>
                        <span>Format: {formatLabel(asset.mimeType)}</span>
                        <span>
                          Dimensions:{' '}
                          {formatDimensions(asset.width, asset.height)}
                        </span>
                        <span>
                          File size: {formatFileSize(asset.sizeBytes)}
                        </span>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => setPreviewAssetId('')}
                        >
                          Close preview
                        </button>
                      </div>
                    </section>
                  )}
                  {usageAssetId === asset.id && (
                    <AssetUsagePanel
                      id={'asset-usage-' + asset.id}
                      name={asset.originalName}
                      state={usage}
                      onRetry={() => void loadUsage(asset)}
                    />
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-state">No assets uploaded.</p>
          )}
        </section>
      )}
    </section>
  );
}

// The logo in effect for the selected scope, or a placeholder when none is
// configured. The image is read through the authenticated asset API.
function BrandLogo({
  logoAssetId,
  label,
  canReadAssets,
  source,
}: {
  logoAssetId: string | null;
  label: string;
  canReadAssets: boolean;
  source: AssetSource;
}) {
  return (
    <figure className="brand-logo">
      {!logoAssetId ? (
        <span
          className="asset-image asset-image-logo asset-image-fallback"
          role="img"
          aria-label={label + ': no logo configured'}
        >
          No logo
        </span>
      ) : canReadAssets ? (
        <AssetImage
          assetId={logoAssetId}
          alt={label}
          source={source}
          variant="logo"
        />
      ) : (
        <span
          className="asset-image asset-image-logo asset-image-fallback"
          role="img"
          aria-label={label + ': you do not have permission to view assets'}
        >
          Logo hidden
        </span>
      )}
      <figcaption>
        {logoAssetId ? label : label + ' · No logo configured'}
      </figcaption>
    </figure>
  );
}

// Where an asset is used, grouped by kind. Nothing here says the asset is
// unused unless the usage request succeeded and reported no use at all.
function AssetUsagePanel({
  id,
  name,
  state,
  onRetry,
}: {
  id: string;
  name: string;
  state: UsageState;
  onRetry: () => void;
}) {
  return (
    <section
      id={id}
      className="asset-usage"
      aria-label={'Where ' + name + ' is used'}
      aria-busy={state.status === 'loading'}
    >
      {state.status === 'loading' && <p role="status">Loading asset usage…</p>}
      {state.status === 'error' && (
        <div className="inline-actions">
          <p role="alert" className="form-message">
            Unable to load asset usage. Please try again.
          </p>
          <button type="button" className="secondary-button" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
      {state.status === 'loaded' && <AssetUsageDetails usage={state.usage} />}
    </section>
  );
}

function AssetUsageDetails({ usage }: { usage: AssetUsageResponse }) {
  if (!usage.inUse)
    return (
      <p className="empty-state">This asset is not currently being used.</p>
    );
  const hidden = usage.hiddenReferenceCount;
  return (
    <>
      <h4>Creative revisions</h4>
      {usage.creativeRevisions.length ? (
        <ul>
          {usage.creativeRevisions.map((revision) => (
            <li key={revision.revisionId}>
              <strong>{revision.creativeName}</strong> · Revision{' '}
              {revision.revisionNumber}
              {revision.isCurrentRevision ? ' (current)' : ''} ·{' '}
              {fieldNames(revision)} · {revision.branchName} branch
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-state">No creative revisions you can view.</p>
      )}
      <h4>Organization brand profile</h4>
      {usage.organizationBrandProfile ? (
        <p>
          Used as the organization logo
          {usage.organizationBrandProfile.displayName
            ? ' (' + usage.organizationBrandProfile.displayName + ')'
            : ''}
          .
        </p>
      ) : (
        <p className="empty-state">Not used as the organization logo.</p>
      )}
      <h4>Branch brand profiles</h4>
      {usage.branchBrandProfiles.length ? (
        <ul>
          {usage.branchBrandProfiles.map((profile) => (
            <li key={profile.branchId}>
              {profile.branchName} ({profile.branchCode}) branch logo
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-state">No branch brand profiles you can view.</p>
      )}
      {hidden > 0 && (
        <p className="asset-in-use">
          Also used in {hidden} {hidden === 1 ? 'place' : 'places'} in branches
          you do not have access to.
        </p>
      )}
    </>
  );
}
