import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
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
import FeedbackMessage from './FeedbackMessage';

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

// The brand fields, in form order. A branch inherits each one from the
// organization unless the branch overrides it (a non-null value in its
// override); the API's PATCH changes only the fields it is sent, and null
// removes an override.
const BRAND_FIELDS = [
  'displayName',
  'primaryColor',
  'secondaryColor',
  'accentColor',
  'fontFamily',
  'websiteUrl',
  'logoAssetId',
] as const;
type BrandField = (typeof BRAND_FIELDS)[number];
const brandFieldLabels: Record<BrandField, string> = {
  displayName: 'Display name',
  primaryColor: 'Primary color',
  secondaryColor: 'Secondary color',
  accentColor: 'Accent color',
  fontFamily: 'Font family',
  websiteUrl: 'Website',
  logoAssetId: 'Logo image',
};
// What a colour picker shows for an unset colour (it cannot show none).
const colorDefaults: Partial<Record<BrandField, string>> = {
  primaryColor: '#202020',
  secondaryColor: '#ffffff',
  accentColor: '#2f6fed',
};
// A field in the form: its value, and whether it is set to use the
// organization's value (branch scope only).
type FieldState = { value: string; inherited: boolean };
type BrandPatch = Partial<Record<BrandField, string | null>>;

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
  // The loaded profile and the scope ('' for the organization) it belongs
  // to. It is shown, and its form offered, only while that scope is still
  // the selected one, so values loaded or typed for one scope can never be
  // saved to another.
  // For a branch the profile is the effective one; `organization` is the
  // organization's own profile, loaded alongside it when the branch can be
  // edited, so "Use organization value" knows what it restores.
  const [loaded, setLoaded] = useState<{
    scopeId: string;
    brand: Brand;
    organization: Brand | null;
  } | null>(null);
  const brand = loaded?.scopeId === scopeBranchId ? loaded.brand : null;
  const organizationBrand =
    loaded?.scopeId === scopeBranchId ? loaded.organization : null;
  // Only the latest load may apply its reply: a slower reply for a scope
  // chosen earlier is ignored.
  const loadRequest = useRef(0);
  // The scope selected now, for replies to saves sent earlier.
  const scopeNow = useRef(scopeBranchId);
  scopeNow.current = scopeBranchId;
  // The fields the user has changed in the brand form, for one scope. Fields
  // not listed show the loaded profile, so a reload (Refresh, an upload)
  // updates them without discarding what was typed elsewhere in the form.
  const [edits, setEdits] = useState<{
    scopeId: string;
    fields: Partial<Record<BrandField, FieldState>>;
  }>({ scopeId: '', fields: {} });
  const scopeEdits = edits.scopeId === scopeBranchId ? edits.fields : {};
  const fieldId = useId();
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

  // True once this load's reply was applied.
  async function reload(): Promise<boolean> {
    if (!session.user.permissions.includes('brand:read')) return false;
    const sequence = ++loadRequest.current;
    const scopeId = scopeBranch?.id ?? '';
    setError('');
    // Brand settings need only brand:read; without assets:read the asset
    // list is never requested, so its 403 cannot hide the brand profile.
    const listAssets = (path: string): Promise<Asset[]> =>
      canReadAssets ? request<Asset[]>(path) : Promise.resolve([]);
    try {
      const [profile, organization, list] = await Promise.all([
        request<Brand>(
          scopeBranch
            ? '/branches/' +
                encodeURIComponent(scopeBranch.id) +
                '/brand/effective'
            : '/organization/brand',
        ),
        scopeBranch && canManageBrand
          ? request<Brand>('/organization/brand')
          : Promise.resolve(null),
        listAssets(
          scopeBranch
            ? '/assets?branchId=' + encodeURIComponent(scopeBranch.id)
            : '/assets',
        ),
      ]);
      if (sequence !== loadRequest.current) return false;
      setLoaded({ scopeId, brand: profile, organization });
      setAssets(list);
      return true;
    } catch (cause) {
      if (sequence !== loadRequest.current) return false;
      setError(
        cause instanceof Error
          ? cause.message
          : 'Unable to load brand settings.',
      );
      return false;
    }
  }

  // ---- Brand form state (organization or one branch) ----
  const isOverridden = (field: BrandField) =>
    !!scopeBranch && !!brand?.overriddenFields?.includes(field);
  const organizationValue = (field: BrandField) =>
    organizationBrand?.[field] ?? '';
  function fieldState(field: BrandField): FieldState {
    return (
      scopeEdits[field] ?? {
        value: brand?.[field] ?? '',
        inherited: !!scopeBranch && !isOverridden(field),
      }
    );
  }
  // Whether a branch field will use the organization's value once saved:
  // it was set to, it is empty (null means "inherit" to the API), or it is
  // an inherited field whose value was not actually changed.
  function usesOrganization(field: BrandField): boolean {
    const state = fieldState(field);
    const value = state.value.trim();
    return (
      state.inherited ||
      value === '' ||
      (!isOverridden(field) && value === organizationValue(field))
    );
  }
  // A branch save sends only what changes: a new or changed override, or
  // null to remove one. Inherited fields the user did not change are left
  // out, so they keep following the organization.
  function branchPatch(): BrandPatch {
    const patch: BrandPatch = {};
    for (const field of BRAND_FIELDS) {
      if (usesOrganization(field)) {
        if (isOverridden(field)) patch[field] = null;
        continue;
      }
      const value = fieldState(field).value.trim();
      if (!isOverridden(field) || value !== (brand?.[field] ?? ''))
        patch[field] = value;
    }
    return patch;
  }
  // The organization profile is saved whole, as before; an unset colour is
  // sent as the colour the picker shows.
  function organizationPayload(): BrandPatch {
    return Object.fromEntries(
      BRAND_FIELDS.map((field) => [
        field,
        fieldState(field).value.trim() || colorDefaults[field] || null,
      ]),
    );
  }
  const pendingPatch: BrandPatch = scopeBranch && brand ? branchPatch() : {};
  function setField(field: BrandField, state: FieldState): void {
    const scopeId = scopeBranchId;
    setEdits((current) => ({
      scopeId,
      fields: {
        ...(current.scopeId === scopeId ? current.fields : {}),
        [field]: state,
      },
    }));
  }
  function restoreOrganizationValue(field: BrandField): void {
    setField(field, { value: organizationValue(field), inherited: true });
    // The button disappears; keep focus on the field it changed.
    document.getElementById(fieldId + '-' + field)?.focus();
  }
  // One form field. For a branch, a line under it says whether it is
  // inherited from the organization or overridden (and whether that is not
  // saved yet), with "Use organization value" for an override.
  function renderBrandField(
    field: BrandField,
    kind: 'text' | 'url' | 'color' | 'logo',
  ) {
    const state = fieldState(field);
    const id = fieldId + '-' + field;
    const sourceId = id + '-source';
    const inherited = !!scopeBranch && usesOrganization(field);
    const pending = field in pendingPatch;
    const common = {
      id,
      name: field,
      'aria-describedby': scopeBranch ? sourceId : undefined,
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
        setField(field, { value: event.target.value, inherited: false }),
    };
    const logoOptions = assets.filter((asset) =>
      scopeBranch
        ? asset.branchId === null || asset.branchId === scopeBranch.id
        : asset.branchId === null,
    );
    const control =
      kind === 'logo' ? (
        <select {...common} value={state.value}>
          <option value="">
            {scopeBranch ? 'Same as the organization' : 'No logo selected'}
          </option>
          {/* A logo set elsewhere that the asset list does not include (for
              example without assets:read) stays selected, so saving keeps
              it instead of clearing it. */}
          {state.value &&
            !logoOptions.some((asset) => asset.id === state.value) && (
              <option value={state.value}>Current logo</option>
            )}
          {logoOptions.map((asset) => (
            <option key={asset.id} value={asset.id}>
              {asset.originalName}
            </option>
          ))}
        </select>
      ) : kind === 'color' ? (
        <input
          {...common}
          type="color"
          value={state.value || colorDefaults[field]}
        />
      ) : (
        <input
          {...common}
          type={kind === 'url' ? 'url' : 'text'}
          maxLength={kind === 'text' ? 120 : undefined}
          value={state.value}
          // An emptied branch field uses the organization's value.
          placeholder={
            scopeBranch ? organizationValue(field) || undefined : undefined
          }
        />
      );
    return (
      <div className="brand-field" key={field}>
        <label>
          {brandFieldLabels[field]}
          {control}
        </label>
        {scopeBranch && (
          <div className="brand-field-source">
            <span
              id={sourceId}
              className={
                'brand-source ' +
                (inherited ? 'brand-source-inherited' : 'brand-source-override')
              }
            >
              {inherited
                ? 'Inherited from the organization'
                : 'Overridden for ' + scopeBranch.name}
              {pending ? ' · not saved yet' : ''}
            </span>
            {!inherited && (
              <button
                type="button"
                className="secondary-button"
                aria-label={
                  'Use organization value for ' + brandFieldLabels[field]
                }
                disabled={busy}
                onClick={() => restoreOrganizationValue(field)}
              >
                Use organization value
              </button>
            )}
          </div>
        )}
      </div>
    );
  }
  useEffect(() => {
    void reload();
    // Reload when the active identity or branch context changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.accessToken, scopeBranchId]);

  // Saves the form to the scope it was rendered for (the form is keyed by
  // scope), whatever is selected by the time the reply arrives.
  async function save(
    event: FormEvent<HTMLFormElement>,
    formScope: { id: string; name: string } | null,
  ): Promise<void> {
    event.preventDefault();
    if (!brand) return;
    const scopeId = formScope?.id ?? '';
    const submitted = scopeEdits;
    const payload = formScope ? branchPatch() : organizationPayload();
    setError('');
    setMessage('');
    if (formScope && Object.keys(payload).length === 0) {
      // The API refuses an empty change; nothing differs from what is saved.
      setMessage('There are no changes to save.');
      return;
    }
    setBusy(true);
    const saved =
      (formScope ? formScope.name : 'Organization') + ' brand profile saved.';
    try {
      const path = formScope
        ? '/branches/' + encodeURIComponent(formScope.id) + '/brand'
        : '/organization/brand';
      const result = await request<Brand>(path, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      // The organization save returns the profile; a branch save returns
      // only the branch's overrides, so the effective profile is reloaded
      // (when the branch is still selected) before the form shows it.
      let current = true;
      if (!formScope)
        setLoaded((loadedNow) =>
          loadedNow?.scopeId === scopeId
            ? { ...loadedNow, brand: result }
            : loadedNow,
        );
      else if (scopeNow.current === scopeId) current = await reload();
      if (current) {
        // Saved edits are now the loaded values; anything typed while the
        // save was in flight stays.
        setEdits((now) => {
          if (now.scopeId !== scopeId) return now;
          const fields = { ...now.fields };
          for (const field of BRAND_FIELDS)
            if (fields[field] && fields[field] === submitted[field])
              delete fields[field];
          return { scopeId, fields };
        });
        setMessage(saved);
      } else
        setError(
          saved +
            " However, the latest brand values couldn't be loaded, so this form may be out of date. Use Refresh before making more changes.",
        );
    } catch (cause) {
      // Nothing was saved: the form keeps every value.
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
    // Unsaved brand edits belong to the scope they were made in: another
    // scope starts from its own saved values, and so does a return to this
    // one.
    setEdits({ scopeId: scopeBranchId, fields: {} });
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
          <p className="eyebrow">BRAND & IMAGES</p>
          <h2 id="brand-assets-title">
            {scopeBranch ? scopeBranch.name + ' brand' : 'Organization brand'}
          </h2>
          <p className="service-copy">
            Set the logo, colours and website used in creatives, and upload
            images. Branches use the organization&apos;s settings unless they
            are changed for that branch.
          </p>
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
      <FeedbackMessage tone="error" message={error} />
      <FeedbackMessage tone="success" message={message} />
      {!brand && !error && (
        <p className="empty-state" role="status">
          Loading {scopeBranch ? scopeBranch.name : 'organization'} brand…
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
            // Keyed by scope: the inputs start from this scope's values.
            <form
              key={scopeBranchId || 'organization'}
              className="admin-form"
              aria-label={
                (scopeBranch ? scopeBranch.name : 'Organization') +
                ' brand profile'
              }
              onSubmit={(event) =>
                void save(
                  event,
                  scopeBranch
                    ? { id: scopeBranch.id, name: scopeBranch.name }
                    : null,
                )
              }
            >
              {scopeBranch && (
                <p className="field-hint">
                  Each field shows whether it is inherited from the organization
                  (and follows it when it changes) or overridden for{' '}
                  {scopeBranch.name}. Changing a field overrides it; Use
                  organization value removes the override when you save.
                </p>
              )}
              {renderBrandField('displayName', 'text')}
              {renderBrandField('primaryColor', 'color')}
              {renderBrandField('secondaryColor', 'color')}
              {renderBrandField('accentColor', 'color')}
              {renderBrandField('fontFamily', 'text')}
              {renderBrandField('websiteUrl', 'url')}
              {renderBrandField('logoAssetId', 'logo')}{' '}
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
              <dd>
                {(brand.overriddenFields ?? [])
                  .map(
                    (field) => brandFieldLabels[field as BrandField] ?? field,
                  )
                  .join(', ') || 'None'}
              </dd>
            </dl>
          )}
        </section>
      )}
      {canManageAssets && (scopeBranch || canManageOrganization) && (
        // Keyed by scope: a file chosen for one scope is not uploaded to
        // another.
        <form
          key={scopeBranchId || 'organization'}
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
