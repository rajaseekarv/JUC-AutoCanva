import { useEffect, useState, type FormEvent } from 'react';
import type {
  AuthenticatedUserResponse,
  BranchResponse,
} from '@adflow/shared-types';

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
      throw new Error(
        response.status === 403
          ? 'You do not have permission to complete this action.'
          : 'Unable to load brand settings.',
      );
    return response.json() as Promise<T>;
  }

  async function reload(): Promise<void> {
    if (!session.user.permissions.includes('brand:read')) return;
    setError('');
    try {
      if (scopeBranch) {
        const [resolved, list] = await Promise.all([
          request<Brand>(
            '/branches/' +
              encodeURIComponent(scopeBranch.id) +
              '/brand/effective',
          ),
          request<Asset[]>(
            '/assets?branchId=' + encodeURIComponent(scopeBranch.id),
          ),
        ]);
        setBrand(resolved);
        setAssets(list);
      } else {
        const [profile, list] = await Promise.all([
          request<Brand>('/organization/brand'),
          request<Asset[]>('/assets'),
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
      setError(
        cause instanceof Error
          ? cause.message
          : 'Unable to save brand profile.',
      );
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
      setError(
        cause instanceof Error ? cause.message : 'Unable to upload asset.',
      );
    } finally {
      setBusy(false);
    }
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
      <section className="admin-card">
        <h3>Assets</h3>
        {assets.length ? (
          <ul className="admin-list">
            {assets.map((asset) => (
              <li key={asset.id}>
                <div>
                  <strong>{asset.originalName}</strong>
                  <span>
                    {asset.branchId ? 'Branch asset' : 'Organization asset'} ·{' '}
                    {asset.mimeType} · {Math.ceil(asset.sizeBytes / 1024)} KB
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">No assets uploaded.</p>
        )}
      </section>
    </section>
  );
}
