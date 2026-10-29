import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type {
  AuthenticatedUserResponse,
  BranchResponse,
  CreativeResponse,
  CreativeRevisionResponse,
  TemplateFieldResponse,
  TemplateResponse,
} from '@adflow/shared-types';
import StatusBadge from './StatusBadge';

const apiBase =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000/api/v1';
type Session = { accessToken: string; user: AuthenticatedUserResponse };
type AssetOption = {
  id: string;
  originalName: string;
  branchId: string | null;
};

export default function CreativeWorkspace({
  session,
  branch,
  templateRefreshKey = 0,
  onUnauthorized,
}: {
  session: Session;
  branch: BranchResponse | null;
  templateRefreshKey?: number;
  onUnauthorized: () => void;
}) {
  const canRead = session.user.permissions.includes('creatives:read');
  const canCreate = session.user.permissions.includes('creatives:create');
  const canUpdate = session.user.permissions.includes('creatives:update');
  const [creatives, setCreatives] = useState<CreativeResponse[]>([]);
  const [templates, setTemplates] = useState<TemplateResponse[]>([]);
  const [templateDetail, setTemplateDetail] = useState<TemplateResponse | null>(
    null,
  );
  const [selectedId, setSelectedId] = useState('');
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [templateVersionId, setTemplateVersionId] = useState('');
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [history, setHistory] = useState<CreativeRevisionResponse[]>([]);
  const [inspectedRevision, setInspectedRevision] =
    useState<CreativeRevisionResponse | null>(null);
  const [assets, setAssets] = useState<AssetOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const loadSequence = useRef(0);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const selected =
    creatives.find((creative) => creative.id === selectedId) ?? null;
  const selectedVersion = useMemo(
    () =>
      templateDetail?.versions?.find(
        (version) => version.id === templateVersionId,
      ) ?? null,
    [templateDetail, templateVersionId],
  );
  // Mirrors the server's required-value rule; the server still validates.
  const missingRequiredValue =
    selectedVersion?.fields.some((field) => {
      if (!field.required) return false;
      const value = values[field.key];
      return (
        value === null ||
        value === undefined ||
        (typeof value === 'string' && value.trim().length === 0)
      );
    }) ?? false;
  const canSubmit =
    !!selectedVersion?.immutableAt &&
    name.trim().length > 0 &&
    !missingRequiredValue;

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(apiBase + path, {
      ...init,
      headers: {
        Authorization: 'Bearer ' + session.accessToken,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
    if (response.status === 401) {
      onUnauthorized();
      throw new Error('Your session expired. Please sign in again.');
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        message?: string;
      } | null;
      throw new Error(
        response.status === 403
          ? 'You do not have permission to complete this action.'
          : (payload?.message ?? 'Unable to complete the creative request.'),
      );
    }
    return response.json() as Promise<T>;
  }

  async function reload(): Promise<void> {
    // A slower response for a previous branch or session must not overwrite
    // the current branch's data; only the latest reload may apply results.
    const sequence = ++loadSequence.current;
    if (!canRead || !branch) {
      setCreatives([]);
      setTemplates([]);
      setAssets([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [creativeList, templateList, assetList] = await Promise.all([
        request<CreativeResponse[]>(
          '/creatives?branchId=' + encodeURIComponent(branch.id),
        ),
        session.user.permissions.includes('templates:read')
          ? request<TemplateResponse[]>('/templates')
          : Promise.resolve([]),
        session.user.permissions.includes('assets:read')
          ? request<AssetOption[]>(
              '/assets?branchId=' + encodeURIComponent(branch.id),
            )
          : Promise.resolve([]),
      ]);
      if (sequence !== loadSequence.current) return;
      setCreatives(creativeList);
      setTemplates(
        templateList.filter(
          (template) =>
            template.status === 'ACTIVE' &&
            template.activeVersionNumber !== null,
        ),
      );
      setAssets(assetList);
      setError('');
    } catch (cause) {
      if (sequence !== loadSequence.current) return;
      setError(
        cause instanceof Error ? cause.message : 'Unable to load creatives.',
      );
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }

  useEffect(() => {
    // Everything tied to the previous branch or session is cleared before the
    // reload, so no stale creative, asset, or revision can be selected or
    // submitted while the new data loads.
    setSelectedId('');
    setName('');
    setValues({});
    setSummary('');
    setMessage('');
    setSelectedTemplateId('');
    setTemplateVersionId('');
    setCreatives([]);
    setAssets([]);
    setHistory([]);
    setInspectedRevision(null);
    void reload();
    // State reload follows identity/branch changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.accessToken, branch?.id, templateRefreshKey]);
  useEffect(() => {
    if (!selectedTemplateId) {
      setTemplateDetail(null);
      return;
    }
    let cancelled = false;
    void request<TemplateResponse>(
      '/templates/' + encodeURIComponent(selectedTemplateId),
    )
      .then((detail) => {
        if (!cancelled) setTemplateDetail(detail);
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Unable to load template fields.',
          );
      });
    return () => {
      cancelled = true;
    };
    // The request is scoped to the selected template and token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTemplateId, session.accessToken]);
  useEffect(() => {
    if (!templateDetail) return;
    const selectedCreative = creatives.find((item) => item.id === selectedId);
    const revision = selectedCreative?.currentRevision;
    const active = templateDetail.versions?.find(
      (version) => version.versionNumber === templateDetail.activeVersionNumber,
    );
    const revisionVersion = templateDetail.versions?.find(
      (version) => version.id === revision?.templateVersionId,
    );
    const nextVersionId = revisionVersion?.id ?? active?.id ?? '';
    setTemplateVersionId(nextVersionId);
    if (revisionVersion && revision) {
      setValues(revision.values);
      setName(selectedCreative?.name ?? '');
    } else
      setValues(
        Object.fromEntries(
          ((revisionVersion ?? active)?.fields ?? [])
            .filter(
              (field) =>
                field.defaultValue !== null && field.defaultValue !== undefined,
            )
            .map((field) => [field.key, field.defaultValue]),
        ),
      );
  }, [templateDetail, selectedId, creatives]);
  useEffect(() => {
    if (!selected) {
      setHistory([]);
      setInspectedRevision(null);
      return;
    }
    void request<CreativeRevisionResponse[]>(
      '/creatives/' + encodeURIComponent(selected.id) + '/revisions',
    )
      .then(setHistory)
      .catch((cause: unknown) =>
        setError(
          cause instanceof Error
            ? cause.message
            : 'Unable to load revision history.',
        ),
      );
    // History reloads when the selected ID or access token changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, session.accessToken]);

  function chooseCreative(id: string): void {
    const creative = creatives.find((item) => item.id === id);
    setSelectedId(id);
    setInspectedRevision(null);
    setSummary('');
    if (!creative) {
      setName('');
      setValues({});
      setSelectedTemplateId('');
      setTemplateVersionId('');
      return;
    }
    setName(creative.name);
    const templateId =
      creative.currentRevision?.templateVersion.templateId ?? '';
    setSelectedTemplateId(templateId);
    setValues(creative.currentRevision?.values ?? {});
    setTemplateVersionId(creative.currentRevision?.templateVersionId ?? '');
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!branch || !selectedVersion) return;
    // Defense in depth: the server re-checks branch access, but the UI never
    // writes to a creative from a different branch than the one selected.
    if (selected && selected.branchId !== branch.id) {
      setError('Select a creative from the current branch.');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const saved = selected
        ? await request<CreativeResponse>(
            '/creatives/' + encodeURIComponent(selected.id),
            {
              method: 'PATCH',
              body: JSON.stringify({
                name,
                templateVersionId,
                values,
                summary: summary || null,
              }),
            },
          )
        : await request<CreativeResponse>('/creatives', {
            method: 'POST',
            body: JSON.stringify({
              name,
              branchId: branch.id,
              templateVersionId,
              values,
              summary: summary || null,
            }),
          });
      setCreatives((current) => [
        saved,
        ...current.filter((item) => item.id !== saved.id),
      ]);
      setSelectedId(saved.id);
      setMessage(
        selected ? 'A new immutable revision was saved.' : 'Creative created.',
      );
      setSummary('');
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Unable to save creative.',
      );
    } finally {
      setBusy(false);
    }
  }

  function updateValue(field: TemplateFieldResponse, value: unknown): void {
    setValues((current) => ({ ...current, [field.key]: value }));
  }
  function renderField(
    field: TemplateFieldResponse,
    source: Record<string, unknown>,
    readonly = false,
  ) {
    const value = source[field.key];
    if (field.type === 'IMAGE' || field.type === 'LOGO')
      return (
        <label key={field.id}>
          {field.label}
          {readonly ? (
            <p>{String(value ?? '—')}</p>
          ) : (
            <select
              aria-label={field.label}
              required={field.required}
              value={typeof value === 'string' ? value : ''}
              onChange={(event) =>
                updateValue(field, event.target.value || null)
              }
            >
              <option value="">Select image</option>
              {assets
                .filter(
                  (asset) =>
                    asset.branchId === null || asset.branchId === branch?.id,
                )
                .map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.originalName}
                  </option>
                ))}
            </select>
          )}
        </label>
      );
    if (readonly)
      return (
        <label key={field.id}>
          {field.label}
          <p>{value === undefined || value === null ? '—' : String(value)}</p>
        </label>
      );
    if (field.type === 'BOOLEAN')
      return (
        <label className="checkbox-label" key={field.id}>
          {field.label}
          <input
            aria-label={field.label}
            type="checkbox"
            checked={value === true}
            onChange={(event) => updateValue(field, event.target.checked)}
          />
        </label>
      );
    if (field.type === 'MULTILINE_TEXT')
      return (
        <label key={field.id}>
          {field.label}
          <textarea
            aria-label={field.label}
            required={field.required}
            maxLength={10000}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => updateValue(field, event.target.value)}
          />
        </label>
      );
    const inputType =
      field.type === 'NUMBER'
        ? 'number'
        : field.type === 'URL'
          ? 'url'
          : field.type === 'DATE'
            ? 'date'
            : field.type === 'COLOR'
              ? 'color'
              : 'text';
    return (
      <label key={field.id}>
        {field.label}
        <input
          aria-label={field.label}
          type={inputType}
          required={field.required}
          maxLength={field.type === 'NUMBER' ? undefined : 10000}
          value={value === null || value === undefined ? '' : String(value)}
          onChange={(event) =>
            updateValue(
              field,
              field.type === 'NUMBER'
                ? event.target.value
                  ? Number(event.target.value)
                  : null
                : event.target.value || null,
            )
          }
        />
        {field.helpText && <small>{field.helpText}</small>}
      </label>
    );
  }

  if (!canRead) return null;
  return (
    <section
      className="admin-panel creative-workspace"
      id="creatives"
      aria-labelledby="creative-workspace-title"
    >
      <div className="admin-heading">
        <div>
          <p className="eyebrow">CREATIVE OPERATIONS</p>
          <h2 id="creative-workspace-title">
            Creatives{branch ? ' · ' + branch.name : ''}
          </h2>
        </div>
        <button
          className="secondary-button"
          onClick={() => void reload()}
          disabled={loading}
        >
          {loading ? 'Loading…' : 'Refresh'}
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
      {!branch ? (
        <p className="admin-card">
          Select an authorized branch to manage its creatives.
        </p>
      ) : (
        <div className="creative-layout">
          <section className="admin-card">
            <h3>Branch creatives</h3>
            {loading ? (
              <p className="empty-state" role="status">
                Loading branch creatives…
              </p>
            ) : creatives.length ? (
              <ul className="admin-list">
                {creatives.map((creative) => (
                  <li key={creative.id}>
                    <div>
                      <strong>{creative.name}</strong>
                      <span>
                        <StatusBadge status={creative.status} /> Revision{' '}
                        {creative.currentRevision?.revisionNumber ?? 0}
                      </span>
                    </div>
                    <button
                      className="secondary-button"
                      onClick={() => chooseCreative(creative.id)}
                    >
                      Open
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty-state">
                No creatives for this branch yet. Start one from an active
                template.
              </p>
            )}
            {canCreate && (
              <button onClick={() => chooseCreative('')}>New creative</button>
            )}
          </section>
          {((selected && canUpdate) || (!selected && canCreate)) && (
            <form
              className="admin-card admin-form"
              onSubmit={(event) => void save(event)}
            >
              <h3>{selected ? 'Edit ' + selected.name : 'Create creative'}</h3>
              <label>
                Name
                <input
                  required
                  maxLength={120}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                Template
                <select
                  aria-label="Template"
                  required
                  value={selectedTemplateId}
                  disabled={loading || (!templates.length && !templateDetail)}
                  onChange={(event) => {
                    setSelectedTemplateId(event.target.value);
                    setTemplateVersionId('');
                    setValues({});
                  }}
                >
                  <option value="">
                    {loading
                      ? 'Loading templates…'
                      : templates.length
                        ? 'Choose template'
                        : 'No active templates'}
                  </option>
                  {templateDetail &&
                    !templates.some(
                      (item) => item.id === templateDetail.id,
                    ) && (
                      <option value={templateDetail.id}>
                        {templateDetail.name} · retained
                      </option>
                    )}
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
              </label>
              {!loading && !error && !templates.length && !templateDetail && (
                <p className="empty-state template-empty-state" role="status">
                  No active templates are available. Create a draft, add a
                  field, and activate it in{' '}
                  {session.user.permissions.includes('templates:read') ? (
                    <a href="#templates">Templates</a>
                  ) : (
                    'the Templates module (template read access is required)'
                  )}{' '}
                  before creating a creative.
                </p>
              )}
              {templateDetail?.versions && (
                <label>
                  Template version
                  <select
                    aria-label="Template version"
                    required
                    value={templateVersionId}
                    onChange={(event) => {
                      setTemplateVersionId(event.target.value);
                      const version = templateDetail.versions?.find(
                        (item) => item.id === event.target.value,
                      );
                      setValues(
                        Object.fromEntries(
                          (version?.fields ?? [])
                            .filter(
                              (field) =>
                                field.defaultValue !== null &&
                                field.defaultValue !== undefined,
                            )
                            .map((field) => [field.key, field.defaultValue]),
                        ),
                      );
                    }}
                  >
                    <option value="">Choose version</option>
                    {templateDetail.versions
                      .filter(
                        (version) =>
                          version.immutableAt &&
                          (version.id ===
                            selected?.currentRevision?.templateVersionId ||
                            (templateDetail.status === 'ACTIVE' &&
                              version.versionNumber ===
                                templateDetail.activeVersionNumber)),
                      )
                      .map((version) => (
                        <option key={version.id} value={version.id}>
                          Version {version.versionNumber}
                          {version.id ===
                            selected?.currentRevision?.templateVersionId &&
                          templateDetail.status === 'ARCHIVED'
                            ? ' · retained'
                            : ''}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              {selectedVersion?.fields.map((field) =>
                renderField(field, values),
              )}
              <label>
                Revision summary
                <textarea
                  maxLength={1000}
                  value={summary}
                  onChange={(event) => setSummary(event.target.value)}
                />
              </label>
              <button type="submit" disabled={busy || !canSubmit}>
                {busy
                  ? 'Saving…'
                  : selected
                    ? 'Save new revision'
                    : 'Create creative'}
              </button>
            </form>
          )}
          {selected && (
            <section className="admin-card">
              <h3>Revision history</h3>
              {history.length ? (
                <ul className="admin-list">
                  {history.map((revision) => (
                    <li key={revision.id}>
                      <div>
                        <strong>Revision {revision.revisionNumber}</strong>
                        <span>
                          {new Date(revision.createdAt).toLocaleString()} ·
                          Template version{' '}
                          {revision.templateVersion.versionNumber}
                        </span>
                      </div>
                      <button
                        className="secondary-button"
                        onClick={() => setInspectedRevision(revision)}
                      >
                        Inspect
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="empty-state">No revisions found.</p>
              )}
              {inspectedRevision && (
                <div className="creative-inspection">
                  <h4>
                    Revision {inspectedRevision.revisionNumber} · read only
                  </h4>
                  {inspectedRevision.summary && (
                    <p>{inspectedRevision.summary}</p>
                  )}
                  {inspectedRevision.templateVersion.fields.map((field) =>
                    renderField(field, inspectedRevision.values, true),
                  )}
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </section>
  );
}
