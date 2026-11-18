import { useEffect, useId, useRef, useState } from 'react';
import type { AuthenticatedUserResponse } from '@adflow/shared-types';
import FeedbackMessage from './FeedbackMessage';
import { returnFocusToConfirmTrigger } from './confirmFocus';
import type { Notifications } from './useNotifications';
import type { RecordNavigation } from './useRecordLinks';

type Session = { accessToken: string; user: AuthenticatedUserResponse };
type Audit = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actorUserId: string | null;
  branchId: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
};
const base =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000/api/v1';

// Shows the shared notification state the app shell owns (see
// useNotifications); this screen makes no requests of its own.
export function NotificationsWorkspace({
  notifications,
  navigation,
}: {
  notifications: Notifications;
  // Opens the record a notification is about (see useRecordLinks).
  navigation?: RecordNavigation;
}) {
  const { items, count, error, listError, listLoaded, actionError, markRead } =
    notifications;
  const idPrefix = useId();
  return (
    <section
      className="service-card"
      id="notifications"
      aria-labelledby="notifications-title"
    >
      <div className="app-heading">
        <div>
          <p className="card-label">UPDATES FOR YOU</p>
          <h2 id="notifications-title">Notifications</h2>
          <p className="notification-count">
            {count > 0 ? (
              <span className="badge badge-info">
                {count === 1 ? '1 unread' : count + ' unread'}
              </span>
            ) : (
              'No unread notifications'
            )}
          </p>
        </div>
        {count > 0 && (
          <button className="secondary-button" onClick={() => void markRead()}>
            Mark all read
          </button>
        )}
      </div>
      <FeedbackMessage tone="error" message={error} />
      <FeedbackMessage tone="error" message={actionError} />
      {/* "No notifications" only once the list has actually loaded. */}
      {!listError && !items.length && !listLoaded && (
        <p className="empty-state" role="status">
          Loading notifications…
        </p>
      )}
      {!listError && !items.length && listLoaded && (
        <p className="empty-state">No notifications yet.</p>
      )}
      <ul className="activity-list">
        {items.map((item, index) => {
          const destination = navigation?.destination(item) ?? null;
          const linkState =
            navigation?.state?.noticeId === item.id ? navigation.state : null;
          const titleId = `${idPrefix}-${index}`;
          return (
            <li
              key={item.id}
              aria-label={
                item.readAt ? 'Read notification' : 'Unread notification'
              }
            >
              <strong id={titleId}>{item.title}</strong>{' '}
              {item.readAt ? (
                ''
              ) : (
                <span className="unread-marker">• Unread</span>
              )}
              <p>{item.message}</p>
              <time dateTime={item.createdAt}>
                {new Date(item.createdAt).toLocaleString()}
              </time>
              {(destination || !item.readAt) && (
                <div className="notification-actions">
                  {navigation && destination && (
                    <button
                      type="button"
                      className="secondary-button"
                      aria-describedby={titleId}
                      aria-expanded={
                        linkState?.status === 'confirm' ? true : undefined
                      }
                      disabled={linkState?.status === 'opening'}
                      onClick={() => navigation.open(item)}
                    >
                      {linkState?.status === 'opening'
                        ? 'Opening…'
                        : destination.label}
                    </button>
                  )}
                  {!item.readAt && (
                    <button
                      type="button"
                      className="secondary-button"
                      aria-describedby={titleId}
                      onClick={() => void markRead(item.id)}
                    >
                      Mark read
                    </button>
                  )}
                </div>
              )}
              {navigation && linkState?.status === 'confirm' && (
                <div
                  className="confirm-panel"
                  role="group"
                  aria-label="Unsaved changes in Creatives"
                >
                  <p role="alert">{linkState.message}</p>
                  <div className="template-actions">
                    <button
                      type="button"
                      className="danger-button"
                      onClick={navigation.confirm}
                    >
                      Discard changes and open
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={(event) => {
                        returnFocusToConfirmTrigger(event.currentTarget);
                        navigation.cancel();
                      }}
                    >
                      Keep my changes
                    </button>
                  </div>
                </div>
              )}
              {navigation && linkState?.status === 'failed' && (
                <div className="notification-link-error">
                  <FeedbackMessage tone="error" message={linkState.message} />
                  {linkState.creativeInstead && (
                    <button
                      type="button"
                      className="secondary-button"
                      aria-describedby={titleId}
                      onClick={() =>
                        navigation.open(item, { creativeInstead: true })
                      }
                    >
                      Open creative instead
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const AUDIT_PAGE_SIZE = 25;
// Why audit history could not be shown, in words the user can act on.
function auditFailure(status: number): string {
  if (status === 400)
    return "Some filters aren't valid, so no audit history was loaded. Check the dates and IDs, then try again.";
  if (status === 403)
    return 'You do not have permission to view audit history.';
  if (status === 404)
    return 'No audit history is available for that branch ID. Check the ID, or use a branch you can access.';
  return "Audit history couldn't be loaded. Please try again.";
}
const hasMetadata = (metadata: Record<string, unknown> | null | undefined) =>
  !!metadata && Object.keys(metadata).length > 0;

export function AuditWorkspace({
  session,
  onUnauthorized,
}: {
  session: Session;
  onUnauthorized?: () => void;
}) {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [entityId, setEntityId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [actorUserId, setActorUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // The latest reply: the query it answers, its entries and total (when the
  // API sent one), or why it failed. Entries for an earlier query stay on
  // screen, marked as updating, until the reply for the current one arrives.
  const [result, setResult] = useState<{
    query: string;
    items: Audit[];
    total: number | null;
    error: string;
  } | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;
  const filters = { action, entityType, entityId, branchId, actorUserId };
  const filtered =
    Object.values(filters).some((value) => value.trim()) || !!from || !!to;
  const params = new URLSearchParams({
    page: String(page),
    limit: String(AUDIT_PAGE_SIZE),
  });
  for (const [key, value] of Object.entries(filters))
    if (value.trim()) params.set(key, value.trim());
  if (from) params.set('from', new Date(from).toISOString());
  if (to) params.set('to', new Date(to).toISOString());
  const query = params.toString();
  const current = result?.query === query ? result : null;
  const loading = !current;

  useEffect(() => {
    // Each change of filters or page sends one request; a reply for a query
    // that is no longer current is ignored.
    let active = true;
    void fetch(`${base}/audit-logs?${query}`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    })
      .then(async (response) => {
        if (response.status === 401) {
          unauthorized.current?.();
          throw new Error('Your session expired. Please sign in again.');
        }
        if (!response.ok) throw new Error(auditFailure(response.status));
        return response.json() as Promise<{ items: Audit[]; total?: number }>;
      })
      .then((reply) => {
        if (active)
          setResult({
            query,
            items: reply.items,
            total: typeof reply.total === 'number' ? reply.total : null,
            error: '',
          });
      })
      .catch((cause: unknown) => {
        if (active)
          setResult({
            query,
            items: [],
            total: null,
            error: cause instanceof Error ? cause.message : auditFailure(0),
          });
      });
    return () => {
      active = false;
    };
  }, [session.accessToken, query, retryKey]);

  function clearFilters(): void {
    setAction('');
    setEntityType('');
    setEntityId('');
    setBranchId('');
    setActorUserId('');
    setFrom('');
    setTo('');
    setPage(1);
  }
  // A filter change starts again from the first page.
  const filterInput = (
    id: string,
    label: string,
    value: string,
    set: (value: string) => void,
    extra: { type?: string; placeholder?: string } = {},
  ) => (
    <div>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={extra.type}
        value={value}
        placeholder={extra.placeholder}
        onChange={(event) => {
          set(event.target.value);
          setPage(1);
        }}
      />
    </div>
  );
  // What is on screen: the current reply, or the previous one while the
  // current one loads.
  const shown = current ?? (result && !result.error ? result : null);
  const items = shown?.items ?? [];
  const total = current?.total ?? null;
  const firstShown = (page - 1) * AUDIT_PAGE_SIZE + 1;
  const lastPage =
    total !== null ? Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE)) : null;
  const hasNext =
    !!current &&
    !current.error &&
    (total !== null
      ? page * AUDIT_PAGE_SIZE < total
      : current.items.length === AUDIT_PAGE_SIZE);
  return (
    <section className="service-card" id="audit" aria-labelledby="audit-title">
      <p className="card-label">ACTIVITY RECORD</p>
      <h2 id="audit-title">Audit history</h2>
      <p className="service-copy">
        A permanent record of who changed what, and when. Use the filters to
        narrow it down; each filter must match exactly.
      </p>
      <div className="filter-grid">
        {filterInput('audit-action', 'Action', action, setAction, {
          placeholder: 'For example creative.created',
        })}
        {filterInput(
          'audit-entity-type',
          'Entity type',
          entityType,
          setEntityType,
          {
            placeholder: 'For example creative',
          },
        )}
        {filterInput('audit-entity-id', 'Entity ID', entityId, setEntityId)}
        {filterInput('audit-branch-id', 'Branch ID', branchId, setBranchId)}
        {filterInput(
          'audit-actor-id',
          'Actor user ID',
          actorUserId,
          setActorUserId,
        )}
        {filterInput('audit-from', 'From', from, setFrom, {
          type: 'datetime-local',
        })}
        {filterInput('audit-to', 'To', to, setTo, { type: 'datetime-local' })}
      </div>
      {filtered && (
        <button
          type="button"
          className="secondary-button"
          onClick={clearFilters}
        >
          Clear filters
        </button>
      )}
      {loading && (
        <p className="empty-state" role="status">
          {shown ? 'Updating audit history…' : 'Loading audit history…'}
        </p>
      )}
      {current?.error && (
        <div className="run-load-error">
          <FeedbackMessage tone="error" message={current.error} />
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setResult(null);
              setRetryKey((key) => key + 1);
            }}
          >
            Try again
          </button>
        </div>
      )}
      {current && !current.error && !items.length && (
        <p className="empty-state">
          {filtered
            ? 'No audit entries match these filters.'
            : 'No activity has been recorded yet.'}
        </p>
      )}
      {!current?.error && items.length > 0 && (
        <ul className="activity-list audit-list" aria-busy={loading}>
          {items.map((item) => (
            <li key={item.id}>
              <time dateTime={item.createdAt}>
                {new Date(item.createdAt).toLocaleString()}
              </time>
              <strong>{item.action}</strong>
              <dl className="audit-facts">
                <dt>Record</dt>
                <dd>
                  {item.entityType} · <code>{item.entityId}</code>
                </dd>
                <dt>By</dt>
                <dd>
                  {item.actorUserId ? (
                    <>
                      User <code>{item.actorUserId}</code>
                    </>
                  ) : (
                    'System'
                  )}
                </dd>
                {item.branchId && (
                  <>
                    <dt>Branch</dt>
                    <dd>
                      <code>{item.branchId}</code>
                    </dd>
                  </>
                )}
              </dl>
              {hasMetadata(item.metadata) && (
                <details>
                  <summary>Details</summary>
                  <pre>{JSON.stringify(item.metadata, null, 2)}</pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
      {!current?.error && (
        <div className="pagination">
          <button
            className="secondary-button"
            disabled={page <= 1 || loading}
            onClick={() => setPage((value) => value - 1)}
          >
            Previous
          </button>{' '}
          <span>
            Page {page}
            {lastPage !== null ? ` of ${lastPage}` : ''}
            {current && total !== null && items.length > 0
              ? ` · entries ${firstShown}–${firstShown + items.length - 1} of ${total}`
              : ''}
          </span>{' '}
          <button
            className="secondary-button"
            disabled={!hasNext || loading}
            onClick={() => setPage((value) => value + 1)}
          >
            Next
          </button>
        </div>
      )}
    </section>
  );
}
