import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  AuthenticatedUserResponse,
  TemplateFieldResponse,
  TemplateResponse,
} from '@adflow/shared-types';
import StatusBadge from './StatusBadge';
import { statusLabel } from './statusDisplay';

const apiBase =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000/api/v1';
type Session = { accessToken: string; user: AuthenticatedUserResponse };
const can = (session: Session, permission: string) =>
  session.user.permissions.includes(permission);

export default function TemplateManager({
  session,
  onTemplatesChanged,
  onUnauthorized,
}: {
  session: Session;
  onTemplatesChanged?: () => void;
  onUnauthorized: () => void;
}) {
  const [templates, setTemplates] = useState<TemplateResponse[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [selected, setSelected] = useState<TemplateResponse | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editingFieldId, setEditingFieldId] = useState('');
  const [previewBranchId, setPreviewBranchId] = useState('');
  const [customPreviewValues, setCustomPreviewValues] = useState<
    Record<string, string>
  >({});
  const [previewFields, setPreviewFields] = useState<Array<{
    key: string;
    label: string;
    type: string;
    value: unknown;
    validationError: string | null;
  }> | null>(null);
  const accessToken = session.accessToken;
  const canReadTemplates = session.user.permissions.includes('templates:read');
  const unauthorizedHandler = useRef(onUnauthorized);
  unauthorizedHandler.current = onUnauthorized;

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        ...(init?.body instanceof FormData
          ? {}
          : { 'Content-Type': 'application/json' }),
        ...init?.headers,
      },
    });
    if (response.status === 401) {
      onUnauthorized();
      throw new Error('Your session expired.');
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        message?: string;
      } | null;
      throw new Error(body?.message ?? 'Template request failed.');
    }
    return response.status === 204
      ? (undefined as T)
      : ((await response.json()) as T);
  }

  async function refresh(id = selectedId) {
    if (!canReadTemplates) return;
    const list = await request<TemplateResponse[]>('/templates');
    setTemplates(list);
    if (id)
      setSelected(
        await request<TemplateResponse>(`/templates/${encodeURIComponent(id)}`),
      );
    else setSelected(null);
  }

  useEffect(() => {
    let active = true;
    if (!canReadTemplates) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void fetch(`${apiBase}/templates`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then(async (response) => {
        if (response.status === 401) {
          unauthorizedHandler.current();
          throw new Error('Your session expired.');
        }
        if (!response.ok) throw new Error('Unable to load templates.');
        return response.json() as Promise<TemplateResponse[]>;
      })
      .then((list) => {
        if (active) {
          setTemplates(list);
          setError('');
        }
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Unable to load templates.',
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [accessToken, canReadTemplates]);

  async function mutate(
    action: () => Promise<unknown>,
    success: string,
  ): Promise<boolean> {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
      await refresh();
      onTemplatesChanged?.();
      setMessage(success);
      return true;
    } catch (cause: unknown) {
      setError(
        cause instanceof Error ? cause.message : 'Template request failed.',
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const created = await request<TemplateResponse>('/templates', {
        method: 'POST',
        body: JSON.stringify({
          name: form.get('name'),
          code: form.get('code'),
          formatName: form.get('formatName'),
          width: Number(form.get('width')),
          height: Number(form.get('height')),
          unit: form.get('unit'),
        }),
      });
      setSelectedId(created.id);
      setCreating(false);
      await refresh(created.id);
      onTemplatesChanged?.();
      setMessage('Draft template created. Add a field before activating it.');
    } catch (cause: unknown) {
      setError(
        cause instanceof Error ? cause.message : 'Template request failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function addField(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const fieldType = form.get('type');
    const defaultText = form.get('defaultValue');
    const defaultValue =
      defaultText === null || defaultText === ''
        ? undefined
        : fieldType === 'NUMBER'
          ? Number(defaultText)
          : fieldType === 'BOOLEAN'
            ? defaultText === 'true'
            : defaultText;
    const validationRules = Object.fromEntries(
      ['minLength', 'maxLength', 'min', 'max'].flatMap((key) => {
        const value = form.get(key);
        return value === null || value === '' ? [] : [[key, Number(value)]];
      }),
    );
    const saved = await mutate(
      () =>
        request(`/templates/${selected.id}/fields`, {
          method: 'POST',
          body: JSON.stringify({
            key: form.get('key'),
            label: form.get('label'),
            type: form.get('type'),
            defaultValue,
            required: form.get('required') === 'on',
            dataSource: form.get('dataSource') || null,
            sourceKey: form.get('sourceKey') || null,
            validationRules: Object.keys(validationRules).length
              ? validationRules
              : null,
          }),
        }),
      'Field added.',
    );
    if (saved) formElement.reset();
  }

  async function moveField(
    field: TemplateFieldResponse,
    index: number,
    offset: -1 | 1,
    fields: TemplateFieldResponse[],
  ) {
    if (!selected) return;
    const other = fields[index + offset];
    if (!other) return;
    await mutate(async () => {
      const endpoint = `/templates/${selected.id}/fields/`;
      await request(`${endpoint}${field.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ displayOrder: fields.length + 1 }),
      });
      await request(`${endpoint}${other.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ displayOrder: index }),
      });
      await request(`${endpoint}${field.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ displayOrder: index + offset }),
      });
    }, 'Field order updated.');
  }

  async function previewTemplate() {
    if (!selected || !previewBranchId) return;
    const query = new URLSearchParams({ branchId: previewBranchId });
    for (const [key, value] of Object.entries(customPreviewValues)) {
      if (value) query.set(`value.${key}`, value);
    }
    try {
      const result = await request<{ fields: typeof previewFields }>(
        `/templates/${encodeURIComponent(selected.id)}/preview?${query.toString()}`,
      );
      setPreviewFields(result.fields);
      setError('');
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Preview failed.');
    }
  }

  if (!canReadTemplates) return null;
  // An unfrozen current version is the draft being edited; an ACTIVE template
  // keeps its frozen active version usable while such a draft exists.
  const currentVersion =
    selected?.versions?.find(
      (version) => version.versionNumber === selected.currentVersionNumber,
    ) ?? selected?.currentVersion;
  const hasDraft =
    selected?.status !== 'ARCHIVED' &&
    !!currentVersion &&
    !currentVersion.immutableAt;
  const editable = hasDraft && can(session, 'templates:edit');
  return (
    <section
      className="service-card template-manager"
      id="templates"
      aria-labelledby="templates-title"
    >
      <p className="card-label">REUSABLE CONTENT STRUCTURE</p>
      <div className="service-heading">
        <h2 id="templates-title">Templates</h2>
        {can(session, 'templates:create') && (
          <button type="button" onClick={() => setCreating((value) => !value)}>
            New template
          </button>
        )}
      </div>
      <p className="service-copy">
        Manage organization templates and their immutable active versions.
      </p>
      {error && (
        <p role="alert" className="form-message">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="form-message">
          {message}
        </p>
      )}
      {creating && (
        <form
          className="template-form"
          onSubmit={(event) => void create(event)}
        >
          <label>
            Name
            <input name="name" required maxLength={120} />
          </label>
          <label>
            Code
            <input name="code" required pattern="[A-Za-z0-9][A-Za-z0-9_-]*" />
          </label>
          <label>
            Format
            <input name="formatName" required placeholder="Social post" />
          </label>
          <label>
            Width
            <input name="width" type="number" min="1" max="50000" required />
          </label>
          <label>
            Height
            <input name="height" type="number" min="1" max="50000" required />
          </label>
          <label>
            Unit
            <select name="unit">
              <option>PX</option>
              <option>MM</option>
              <option>CM</option>
              <option>IN</option>
            </select>
          </label>
          <button disabled={busy}>Create draft</button>
        </form>
      )}
      {loading ? (
        <p className="empty-state" role="status">
          Loading organization templates…
        </p>
      ) : templates.length === 0 ? (
        <p className="empty-state" role="status">
          No templates yet. Create a draft, add at least one field, and activate
          a version before using it in Creative Workspace.
        </p>
      ) : (
        <label>
          Choose template
          <select
            aria-label="Choose template"
            value={selectedId}
            onChange={(event) => {
              setSelectedId(event.target.value);
              void refresh(event.target.value).catch((cause: unknown) =>
                setError(
                  cause instanceof Error
                    ? cause.message
                    : 'Unable to load template.',
                ),
              );
            }}
          >
            <option value="">Select…</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name} · {statusLabel(template.status)}
              </option>
            ))}
          </select>
        </label>
      )}
      {selected && (
        <div className="template-detail">
          <div className="service-heading">
            <div>
              <p className="card-label">
                {selected.code} · {selected.formatName} · {selected.width} ×{' '}
                {selected.height} {selected.unit}
              </p>
              <h3>{selected.name}</h3>
            </div>
            <span>
              <StatusBadge status={selected.status} /> v
              {selected.currentVersionNumber}
              {selected.activeVersionNumber
                ? ` (active v${selected.activeVersionNumber})`
                : ''}
              {hasDraft && selected.activeVersionNumber
                ? ` · draft v${selected.currentVersionNumber} in progress`
                : ''}
            </span>
          </div>
          {editable && (
            <form
              className="template-form"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                void mutate(
                  () =>
                    request(`/templates/${selected.id}`, {
                      method: 'PATCH',
                      body: JSON.stringify({
                        name: form.get('name'),
                        description: form.get('description') || null,
                        category: form.get('category') || null,
                      }),
                    }),
                  'Template details saved.',
                );
              }}
            >
              <label>
                Name
                <input name="name" defaultValue={selected.name} required />
              </label>
              <label>
                Description
                <input
                  name="description"
                  defaultValue={selected.description ?? ''}
                />
              </label>
              <label>
                Category
                <input name="category" defaultValue={selected.category ?? ''} />
              </label>
              <button disabled={busy}>Save details</button>
            </form>
          )}
          <h3>
            Fields · v{selected.currentVersionNumber}
            {hasDraft ? ' (draft)' : ''}
          </h3>
          {(
            selected.versions?.find(
              (version) =>
                version.versionNumber === selected.currentVersionNumber,
            )?.fields ?? []
          ).map((field, index, fields) => (
            <div className="template-field" key={field.id}>
              <div>
                <strong>{field.label}</strong>
                <span>
                  {field.key} · {field.type}
                  {field.required ? ' · required' : ' · optional'}
                  {field.dataSource
                    ? ` · ${field.dataSource}${field.sourceKey ? `.${field.sourceKey}` : ''}`
                    : ''}
                </span>
              </div>
              {editable && (
                <div className="template-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    aria-label={`Move ${field.label} up`}
                    disabled={index === 0 || busy}
                    onClick={() => void moveField(field, index, -1, fields)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    aria-label={`Move ${field.label} down`}
                    disabled={index === fields.length - 1 || busy}
                    onClick={() => void moveField(field, index, 1, fields)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() =>
                      setEditingFieldId(
                        editingFieldId === field.id ? '' : field.id,
                      )
                    }
                  >
                    Edit field
                  </button>
                  <button
                    type="button"
                    className="danger-button"
                    onClick={() =>
                      void mutate(
                        () =>
                          request(
                            `/templates/${selected.id}/fields/${field.id}`,
                            { method: 'DELETE' },
                          ),
                        'Field removed.',
                      )
                    }
                  >
                    Remove
                  </button>
                </div>
              )}
              {editable && editingFieldId === field.id && (
                <form
                  className="template-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    const nextType = form.get('type');
                    const nextDefaultText = form.get('defaultValue');
                    const nextDefaultValue =
                      nextDefaultText === null || nextDefaultText === ''
                        ? null
                        : nextType === 'NUMBER'
                          ? Number(nextDefaultText)
                          : nextType === 'BOOLEAN'
                            ? nextDefaultText === 'true'
                            : nextDefaultText;
                    const rules = Object.fromEntries(
                      ['minLength', 'maxLength', 'min', 'max'].flatMap(
                        (key) => {
                          const value = form.get(key);
                          return value === null || value === ''
                            ? []
                            : [[key, Number(value)]];
                        },
                      ),
                    );
                    const source = form.get('dataSource') || null;
                    void mutate(
                      () =>
                        request(
                          `/templates/${selected.id}/fields/${field.id}`,
                          {
                            method: 'PATCH',
                            body: JSON.stringify({
                              key: form.get('key'),
                              label: form.get('label'),
                              type: form.get('type'),
                              defaultValue: nextDefaultValue,
                              required: form.get('required') === 'on',
                              helpText: form.get('helpText') || null,
                              dataSource: source,
                              sourceKey:
                                source && source !== 'CUSTOM'
                                  ? form.get('sourceKey') || null
                                  : null,
                              validationRules: Object.keys(rules).length
                                ? rules
                                : null,
                            }),
                          },
                        ),
                      'Field updated.',
                    );
                    setEditingFieldId('');
                  }}
                >
                  <label>
                    Key
                    <input
                      name="key"
                      defaultValue={field.key}
                      required
                      pattern="[a-z][a-z0-9_]*"
                    />
                  </label>
                  <label>
                    Label
                    <input name="label" defaultValue={field.label} required />
                  </label>
                  <label>
                    Type
                    <select name="type" defaultValue={field.type}>
                      {[
                        'TEXT',
                        'MULTILINE_TEXT',
                        'IMAGE',
                        'LOGO',
                        'PHONE',
                        'URL',
                        'DATE',
                        'NUMBER',
                        'BOOLEAN',
                        'COLOR',
                      ].map((type) => (
                        <option key={type}>{type}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Source
                    <select
                      name="dataSource"
                      defaultValue={field.dataSource ?? ''}
                    >
                      <option value="">None</option>
                      <option value="ORGANIZATION_BRAND">
                        Organization brand
                      </option>
                      <option value="EFFECTIVE_BRAND">Effective brand</option>
                      <option value="BRANCH">Branch data</option>
                      <option value="CUSTOM">Custom preview value</option>
                    </select>
                  </label>
                  <label>
                    Default value
                    <input
                      name="defaultValue"
                      defaultValue={
                        field.defaultValue === null ||
                        field.defaultValue === undefined
                          ? ''
                          : String(field.defaultValue)
                      }
                    />
                  </label>
                  <label>
                    Source key
                    <input
                      name="sourceKey"
                      defaultValue={field.sourceKey ?? ''}
                    />
                  </label>
                  <label>
                    Help text
                    <input
                      name="helpText"
                      defaultValue={field.helpText ?? ''}
                    />
                  </label>
                  <label>
                    Minimum length
                    <input
                      type="number"
                      min="0"
                      name="minLength"
                      defaultValue={field.validationRules?.minLength}
                    />
                  </label>
                  <label>
                    Maximum length
                    <input
                      type="number"
                      min="1"
                      name="maxLength"
                      defaultValue={field.validationRules?.maxLength}
                    />
                  </label>
                  <label>
                    Minimum value
                    <input
                      type="number"
                      name="min"
                      defaultValue={field.validationRules?.min}
                    />
                  </label>
                  <label>
                    Maximum value
                    <input
                      type="number"
                      name="max"
                      defaultValue={field.validationRules?.max}
                    />
                  </label>
                  <label className="checkbox-label">
                    <input
                      name="required"
                      type="checkbox"
                      defaultChecked={field.required}
                    />{' '}
                    Required
                  </label>
                  <button disabled={busy}>Save field</button>
                </form>
              )}
            </div>
          ))}
          {editable && (
            <form
              className="template-form"
              onSubmit={(event) => void addField(event)}
            >
              <h4>Add field</h4>
              <label>
                Key
                <input name="key" required pattern="[a-z][a-z0-9_]*" />
              </label>
              <label>
                Label
                <input name="label" required />
              </label>
              <label>
                Type
                <select name="type">
                  {[
                    'TEXT',
                    'MULTILINE_TEXT',
                    'IMAGE',
                    'LOGO',
                    'PHONE',
                    'URL',
                    'DATE',
                    'NUMBER',
                    'BOOLEAN',
                    'COLOR',
                  ].map((type) => (
                    <option key={type}>{type}</option>
                  ))}
                </select>
              </label>
              <label>
                Default value
                <input name="defaultValue" />
              </label>
              <label>
                Data source
                <select name="dataSource">
                  <option value="">None</option>
                  <option value="ORGANIZATION_BRAND">Organization brand</option>
                  <option value="EFFECTIVE_BRAND">Effective brand</option>
                  <option value="BRANCH">Branch data</option>
                  <option value="CUSTOM">Custom preview value</option>
                </select>
              </label>
              <label>
                Source key
                <input name="sourceKey" placeholder="displayName, phone, …" />
              </label>
              <label>
                Minimum length
                <input type="number" min="0" name="minLength" />
              </label>
              <label>
                Maximum length
                <input type="number" min="1" name="maxLength" />
              </label>
              <label>
                Minimum value
                <input type="number" name="min" />
              </label>
              <label>
                Maximum value
                <input type="number" name="max" />
              </label>
              <label className="checkbox-label">
                <input name="required" type="checkbox" /> Required
              </label>
              <button disabled={busy}>Add field</button>
            </form>
          )}
          {session.user.branches.length > 0 && (
            <section
              className="template-preview"
              aria-label="Template preview values"
            >
              <h3>Branch data preview</h3>
              <label>
                Permitted branch
                <select
                  value={previewBranchId}
                  onChange={(event) => setPreviewBranchId(event.target.value)}
                >
                  <option value="">Choose branch…</option>
                  {session.user.branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name} · {branch.code}
                    </option>
                  ))}
                </select>
              </label>
              {(selected.currentVersion?.fields ?? [])
                .filter((field) => field.dataSource === 'CUSTOM')
                .map((field) => (
                  <label key={field.id}>
                    {field.label}
                    <input
                      value={customPreviewValues[field.key] ?? ''}
                      onChange={(event) =>
                        setCustomPreviewValues((values) => ({
                          ...values,
                          [field.key]: event.target.value,
                        }))
                      }
                    />
                  </label>
                ))}
              <button
                type="button"
                disabled={!previewBranchId || busy}
                onClick={() => void previewTemplate()}
              >
                Resolve preview
              </button>
              {previewFields && (
                <dl className="preview-results">
                  {previewFields.map((field) => (
                    <div key={field.key}>
                      <dt>{field.label}</dt>
                      <dd>
                        {typeof field.value === 'object' && field.value !== null
                          ? JSON.stringify(field.value)
                          : String(field.value ?? '—')}
                        {field.validationError && (
                          <span className="form-message">
                            {field.validationError}
                          </span>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </section>
          )}
          {/* Lifecycle buttons keep fixed positions and labels; inapplicable
              actions are disabled rather than swapped, so a repeated click
              can never trigger a different action. */}
          <div className="template-actions lifecycle-actions">
            {selected.status !== 'ARCHIVED' &&
              can(session, 'templates:activate') && (
                <button
                  type="button"
                  disabled={busy || !hasDraft}
                  title={
                    hasDraft
                      ? `Freeze draft v${selected.currentVersionNumber} and make it the active version`
                      : 'There is no draft version to activate'
                  }
                  onClick={() =>
                    void mutate(
                      () =>
                        request(`/templates/${selected.id}/activate`, {
                          method: 'POST',
                        }),
                      'Template version activated.',
                    )
                  }
                >
                  Activate draft version
                </button>
              )}
            {selected.status !== 'ARCHIVED' &&
              can(session, 'templates:edit') && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || hasDraft}
                  title={
                    hasDraft
                      ? 'A draft version is already in progress'
                      : `Copy active v${selected.currentVersionNumber} into a new draft; the active version stays in use`
                  }
                  onClick={() =>
                    void mutate(
                      () =>
                        request(`/templates/${selected.id}/versions`, {
                          method: 'POST',
                        }),
                      'New draft version created. The active version remains in use until the draft is activated.',
                    )
                  }
                >
                  Create new draft version
                </button>
              )}
            {selected.status !== 'ARCHIVED' &&
              can(session, 'templates:archive') && (
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() =>
                    void mutate(
                      () =>
                        request(`/templates/${selected.id}/archive`, {
                          method: 'POST',
                        }),
                      'Template archived.',
                    )
                  }
                >
                  Archive
                </button>
              )}
          </div>
        </div>
      )}
    </section>
  );
}
