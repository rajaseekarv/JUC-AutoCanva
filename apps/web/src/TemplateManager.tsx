import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type {
  AuthenticatedUserResponse,
  TemplateFieldResponse,
  TemplateResponse,
} from '@adflow/shared-types';
import StatusBadge from './StatusBadge';
import { statusLabel } from './statusDisplay';
import FeedbackMessage from './FeedbackMessage';
import { useReportUnsaved } from './useReportUnsaved';
import { returnFocusToConfirmTrigger } from './confirmFocus';

const apiBase =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000/api/v1';
type Session = { accessToken: string; user: AuthenticatedUserResponse };
const can = (session: Session, permission: string) =>
  session.user.permissions.includes(permission);

// Display-only labels: the option values and stored values stay the API's
// codes (TEXT, PX, …).
const FIELD_TYPES = [
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
] as const;
const fieldTypeLabels: Record<string, string> = {
  TEXT: 'Short text',
  MULTILINE_TEXT: 'Paragraph',
  IMAGE: 'Image',
  LOGO: 'Logo',
  PHONE: 'Phone number',
  URL: 'Web address',
  DATE: 'Date',
  NUMBER: 'Number',
  BOOLEAN: 'Yes / no',
  COLOR: 'Colour',
};
const fieldTypeLabel = (type: string) => fieldTypeLabels[type] ?? type;
const UNITS = [
  { value: 'PX', label: 'Pixels (px)', short: 'px' },
  { value: 'MM', label: 'Millimetres (mm)', short: 'mm' },
  { value: 'CM', label: 'Centimetres (cm)', short: 'cm' },
  { value: 'IN', label: 'Inches (in)', short: 'in' },
] as const;
const unitShort = (unit: string) =>
  UNITS.find((item) => item.value === unit)?.short ?? unit;
// Whether a form holds anything other than what it started with. A select
// whose default is its first option has no defaultSelected option, so it is
// compared with that first option.
function formIsDirty(form: HTMLFormElement): boolean {
  for (const element of Array.from(form.elements)) {
    if (element instanceof HTMLInputElement) {
      if (element.type === 'checkbox' || element.type === 'radio') {
        if (element.checked !== element.defaultChecked) return true;
      } else if (element.type === 'file') {
        if (element.files?.length) return true;
      } else if (element.value !== element.defaultValue) return true;
    } else if (element instanceof HTMLTextAreaElement) {
      if (element.value !== element.defaultValue) return true;
    } else if (element instanceof HTMLSelectElement && !element.multiple) {
      const options = Array.from(element.options);
      const defaultIndex = Math.max(
        0,
        options.findIndex((option) => option.defaultSelected),
      );
      if (options.length && element.selectedIndex !== defaultIndex) return true;
    }
  }
  return false;
}
// An API message as a sentence, so text can follow it.
const asSentence = (message: string) =>
  /[.!?]$/.test(message.trim()) ? message.trim() : message.trim() + '.';
const dataSourceLabels: Record<string, string> = {
  ORGANIZATION_BRAND: 'Organization brand',
  EFFECTIVE_BRAND: 'Effective brand',
  BRANCH: 'Branch data',
  CUSTOM: 'Custom preview value',
};

export default function TemplateManager({
  session,
  onTemplatesChanged,
  onUnauthorized,
  onUnsavedChange,
}: {
  session: Session;
  onTemplatesChanged?: () => void;
  onUnauthorized: () => void;
  // Told whether any template form holds unsaved edits.
  onUnsavedChange?: (dirty: boolean) => void;
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
  // Why the open field edit was not saved; shown inside that edit form.
  const [fieldError, setFieldError] = useState<{
    fieldId: string;
    message: string;
  } | null>(null);
  const [savingFieldId, setSavingFieldId] = useState('');
  // The template chosen now and the field being edited now, for replies to
  // requests sent earlier. Only the latest detail request may apply its
  // reply, so a slow reply for a previously chosen template can never put
  // that template (and its forms) back on screen.
  const selectedIdRef = useRef('');
  const editingFieldRef = useRef('');
  editingFieldRef.current = editingFieldId;
  const detailRequest = useRef(0);
  // The destructive action awaiting confirmation: 'archive', or the ID of the
  // field to remove.
  const [confirming, setConfirming] = useState<
    | { kind: 'activate' }
    | { kind: 'archive' }
    | { kind: 'remove-field'; fieldId: string }
    | null
  >(null);
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
  const lifecycleHelpId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const [formsDirty, setFormsDirty] = useState(false);
  // Forms also become clean without an input event: when the template is
  // reloaded (a save), a form closes or is replaced, or an action finishes
  // (Add field resets its form). Checked after each of those.
  useEffect(() => {
    const root = sectionRef.current;
    setFormsDirty(
      !!root && [...root.querySelectorAll('form')].some(formIsDirty),
    );
  }, [selected, selectedId, editingFieldId, creating, busy]);
  useReportUnsaved(formsDirty, onUnsavedChange);
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

  // Reloads the list and the template chosen now (not the one chosen when an
  // earlier action started).
  async function refresh(id = selectedIdRef.current) {
    if (!canReadTemplates) return;
    const sequence = ++detailRequest.current;
    const list = await request<TemplateResponse[]>('/templates');
    setTemplates(list);
    const detail = id
      ? await request<TemplateResponse>(`/templates/${encodeURIComponent(id)}`)
      : null;
    if (sequence === detailRequest.current && selectedIdRef.current === id)
      setSelected(detail);
  }

  // Everything typed for one template belongs to it alone: choosing another
  // template closes open edits and confirmations, and its forms only appear
  // once its own details have loaded (they are keyed by template, so they
  // start from that template's values).
  function selectTemplate(id: string) {
    selectedIdRef.current = id;
    setSelectedId(id);
    setSelected(null);
    setConfirming(null);
    setEditingFieldId('');
    setFieldError(null);
    setCustomPreviewValues({});
    setPreviewFields(null);
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

  // `reportError`, when given, receives the message of a change the API
  // refused instead of the screen's banner (for example inside the form the
  // change came from).
  async function mutate(
    action: () => Promise<unknown>,
    success: string,
    reportError?: (message: string) => void,
  ): Promise<boolean> {
    setBusy(true);
    setError('');
    setMessage('');
    // Set once the API has accepted the change. A failure after that point
    // only means the screen could not be refreshed: the change is reported as
    // done (so confirmations close and are not sent again) and the user is
    // told the screen may be out of date. Nothing is retried.
    let applied = false;
    try {
      await action();
      applied = true;
      await refresh();
      onTemplatesChanged?.();
      setMessage(success);
      return true;
    } catch (cause: unknown) {
      if (applied) {
        onTemplatesChanged?.();
        setError(
          success +
            " However, the latest template details couldn't be loaded, so this screen may be out of date. Reload the page before making more changes.",
        );
        return true;
      }
      (reportError ?? setError)(
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
      selectTemplate(created.id);
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

  // Unsaved edits in any of this screen's forms (new template, details,
  // field edit, Add field). The forms are uncontrolled, so each control is
  // compared with its own default: a form React resets or remounts with
  // saved values reads as clean again.
  function checkForms(): void {
    const root = sectionRef.current;
    setFormsDirty(
      !!root && [...root.querySelectorAll('form')].some(formIsDirty),
    );
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
      ref={sectionRef}
      className="service-card template-manager"
      id="templates"
      aria-labelledby="templates-title"
      onChange={checkForms}
    >
      <p className="card-label">DESIGN TEMPLATES</p>
      <div className="service-heading">
        <h2 id="templates-title">Templates</h2>
        {can(session, 'templates:create') && (
          <button type="button" onClick={() => setCreating((value) => !value)}>
            New template
          </button>
        )}
      </div>
      <p className="service-copy">
        A template lists the details every creative needs, such as a headline or
        a logo. Creatives can use a template once a version of it is activated;
        an activated version can no longer be changed.
      </p>
      <FeedbackMessage tone="error" message={error} />
      <FeedbackMessage tone="success" message={message} />
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
              {UNITS.map((unit) => (
                <option key={unit.value} value={unit.value}>
                  {unit.label}
                </option>
              ))}
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
              const id = event.target.value;
              selectTemplate(id);
              void refresh(id).catch((cause: unknown) => {
                // A failure for a template no longer chosen is not reported.
                if (selectedIdRef.current === id)
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : 'Unable to load template.',
                  );
              });
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
      {selectedId && !selected && !error && (
        <p className="empty-state" role="status">
          Loading template…
        </p>
      )}
      {selected && (
        // Keyed by template: every form below starts from this template's
        // own values, never from what was typed for another template.
        <div className="template-detail" key={selected.id}>
          <div className="service-heading">
            <div>
              <p className="card-label">
                {selected.code} · {selected.formatName} · {selected.width} ×{' '}
                {selected.height} {unitShort(selected.unit)}
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
              aria-label="Template details"
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
                  {fieldTypeLabel(field.type)}
                  {field.required ? ' · required' : ' · optional'}
                  {field.dataSource
                    ? ` · filled from ${dataSourceLabels[field.dataSource] ?? field.dataSource}${field.sourceKey ? ` (${field.sourceKey})` : ''}`
                    : ''}
                  {' · key '}
                  <code>{field.key}</code>
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
                    aria-expanded={editingFieldId === field.id}
                    onClick={() => {
                      setFieldError(null);
                      setEditingFieldId(
                        editingFieldId === field.id ? '' : field.id,
                      );
                    }}
                  >
                    Edit field
                  </button>
                  <button
                    type="button"
                    className="danger-button"
                    disabled={busy}
                    aria-label={`Remove ${field.label}`}
                    aria-expanded={
                      confirming?.kind === 'remove-field' &&
                      confirming.fieldId === field.id
                    }
                    onClick={() =>
                      setConfirming({ kind: 'remove-field', fieldId: field.id })
                    }
                  >
                    Remove
                  </button>
                </div>
              )}
              {editable &&
                confirming?.kind === 'remove-field' &&
                confirming.fieldId === field.id && (
                  <div
                    className="confirm-panel"
                    role="group"
                    aria-label={`Confirm removing ${field.label}`}
                  >
                    <p>
                      Remove the “{field.label}” field from draft version{' '}
                      {selected.currentVersionNumber}? Creatives made from
                      earlier, activated versions are not affected.
                    </p>
                    <div className="template-actions">
                      <button
                        type="button"
                        className="danger-button"
                        disabled={busy}
                        onClick={() =>
                          void mutate(
                            () =>
                              request(
                                `/templates/${selected.id}/fields/${field.id}`,
                                { method: 'DELETE' },
                              ),
                            'Field removed.',
                          ).then((done) => {
                            if (done) setConfirming(null);
                          })
                        }
                      >
                        Remove field
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy}
                        onClick={(event) => {
                          returnFocusToConfirmTrigger(event.currentTarget);
                          setConfirming(null);
                        }}
                      >
                        Keep field
                      </button>
                    </div>
                  </div>
                )}
              {editable && editingFieldId === field.id && (
                <form
                  className="template-form"
                  aria-label={`Edit ${field.label}`}
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
                    setFieldError(null);
                    setSavingFieldId(field.id);
                    // The form stays open, with everything typed, until the
                    // API accepts the change; a refusal is explained inside
                    // it. Only a successful save (or Cancel) closes it.
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
                      (message) => {
                        // The form was closed meanwhile (Cancel, or another
                        // template): report the refusal on the screen.
                        if (editingFieldRef.current === field.id)
                          setFieldError({ fieldId: field.id, message });
                        else setError(message);
                      },
                    ).then((saved) => {
                      setSavingFieldId('');
                      if (saved && editingFieldRef.current === field.id)
                        setEditingFieldId('');
                    });
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
                      {FIELD_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {fieldTypeLabel(type)}
                        </option>
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
                  {fieldError?.fieldId === field.id && (
                    <p role="alert" className="form-message">
                      The field was not saved: {asSentence(fieldError.message)}{' '}
                      Your changes are still in the form. Correct them and save
                      again, or cancel to discard them.
                    </p>
                  )}
                  <div className="template-actions">
                    <button disabled={busy}>
                      {savingFieldId === field.id ? 'Saving…' : 'Save field'}
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        setFieldError(null);
                        setEditingFieldId('');
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>
          ))}
          {editable && (
            <form
              className="template-form"
              aria-label="Add field"
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
                  {FIELD_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {fieldTypeLabel(type)}
                    </option>
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
                Show preview
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
          {selected.status !== 'ARCHIVED' &&
            (can(session, 'templates:activate') ||
              can(session, 'templates:edit')) && (
              <ul className="lifecycle-help" id={lifecycleHelpId}>
                {can(session, 'templates:activate') && (
                  <li>
                    <strong>Activate draft version:</strong>{' '}
                    {hasDraft
                      ? `locks draft version ${selected.currentVersionNumber} so it can no longer be edited, and makes it the version new creatives use.`
                      : 'there is no draft version to activate right now.'}
                  </li>
                )}
                {can(session, 'templates:edit') && (
                  <li>
                    <strong>Create new draft version:</strong>{' '}
                    {hasDraft
                      ? 'a draft version is already in progress; activate it first.'
                      : `copies version ${selected.currentVersionNumber} into a new draft you can edit. The active version stays in use until the draft is activated.`}
                  </li>
                )}
              </ul>
            )}
          <div className="template-actions lifecycle-actions">
            {selected.status !== 'ARCHIVED' &&
              can(session, 'templates:activate') && (
                <button
                  type="button"
                  disabled={busy || !hasDraft}
                  aria-describedby={lifecycleHelpId}
                  aria-expanded={confirming?.kind === 'activate'}
                  onClick={() => setConfirming({ kind: 'activate' })}
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
                  aria-describedby={lifecycleHelpId}
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
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  aria-expanded={confirming?.kind === 'archive'}
                  onClick={() => setConfirming({ kind: 'archive' })}
                >
                  Archive
                </button>
              )}
          </div>
          {selected.status !== 'ARCHIVED' &&
            can(session, 'templates:activate') &&
            hasDraft &&
            confirming?.kind === 'activate' && (
              <div
                className="confirm-panel"
                role="group"
                aria-label={`Confirm activating version ${selected.currentVersionNumber}`}
              >
                <p>
                  Activate draft version {selected.currentVersionNumber} of “
                  {selected.name}”? The version is locked for good and can no
                  longer be edited (to make later changes, create a new draft
                  version), and new creatives will use it.
                  {selected.activeVersionNumber
                    ? ` Version ${selected.activeVersionNumber} will no longer be offered for new creatives.`
                    : ''}{' '}
                  Creatives already made keep their saved revisions.
                </p>
                <div className="template-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void mutate(
                        () =>
                          request(`/templates/${selected.id}/activate`, {
                            method: 'POST',
                          }),
                        'Template version activated.',
                      ).then((done) => {
                        if (done) setConfirming(null);
                      })
                    }
                  >
                    Activate version {selected.currentVersionNumber}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={(event) => {
                      returnFocusToConfirmTrigger(event.currentTarget);
                      setConfirming(null);
                    }}
                  >
                    Keep current version
                  </button>
                </div>
              </div>
            )}
          {selected.status !== 'ARCHIVED' &&
            can(session, 'templates:archive') &&
            confirming?.kind === 'archive' && (
              <div
                className="confirm-panel"
                role="group"
                aria-label={`Confirm archiving ${selected.name}`}
              >
                <p>
                  Archive “{selected.name}”? This cannot be undone. The template
                  can no longer be edited, activated or chosen for new
                  creatives. Creatives already made from it keep their saved
                  revisions.
                </p>
                <div className="template-actions">
                  <button
                    type="button"
                    className="danger-button"
                    disabled={busy}
                    onClick={() =>
                      void mutate(
                        () =>
                          request(`/templates/${selected.id}/archive`, {
                            method: 'POST',
                          }),
                        'Template archived.',
                      ).then((done) => {
                        if (done) setConfirming(null);
                      })
                    }
                  >
                    Archive template
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={(event) => {
                      returnFocusToConfirmTrigger(event.currentTarget);
                      setConfirming(null);
                    }}
                  >
                    Keep template
                  </button>
                </div>
              </div>
            )}
        </div>
      )}
    </section>
  );
}
