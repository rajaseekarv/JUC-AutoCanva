import { useEffect, useId, useState } from 'react';
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
  const { items, count, error, listError, actionError, markRead } =
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
      {!listError && !items.length && (
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

export function AuditWorkspace({ session }: { session: Session }) {
  const [items, setItems] = useState<Audit[]>([]);
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [entityId, setEntityId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [actorUserId, setActorUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ page: String(page), limit: '25' });
    for (const [key, value] of Object.entries({
      action,
      entityType,
      entityId,
      branchId,
      actorUserId,
    })) {
      if (value.trim()) params.set(key, value.trim());
    }
    if (from) params.set('from', new Date(from).toISOString());
    if (to) params.set('to', new Date(to).toISOString());
    void fetch(`${base}/audit-logs?${params}`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Audit history is unavailable.');
        return response.json() as Promise<{ items: Audit[] }>;
      })
      .then((result) => {
        if (active) {
          setItems(result.items);
          setError('');
        }
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Audit history is unavailable.',
          );
      });
    return () => {
      active = false;
    };
  }, [
    session.accessToken,
    page,
    action,
    entityType,
    entityId,
    branchId,
    actorUserId,
    from,
    to,
  ]);
  return (
    <section className="service-card" id="audit" aria-labelledby="audit-title">
      <p className="card-label">ACTIVITY RECORD</p>
      <h2 id="audit-title">Audit history</h2>
      <p className="service-copy">
        A permanent record of who changed what, and when. Use the filters to
        narrow it down.
      </p>
      <div className="filter-grid">
        <div>
          <label htmlFor="audit-action">Action</label>
          <input
            id="audit-action"
            value={action}
            onChange={(event) => {
              setAction(event.target.value);
              setPage(1);
            }}
            placeholder="Filter by action"
          />
        </div>
        <div>
          <label htmlFor="audit-entity-type">Entity type</label>
          <input
            id="audit-entity-type"
            value={entityType}
            onChange={(event) => {
              setEntityType(event.target.value);
              setPage(1);
            }}
          />
        </div>
        <div>
          <label htmlFor="audit-entity-id">Entity ID</label>
          <input
            id="audit-entity-id"
            value={entityId}
            onChange={(event) => {
              setEntityId(event.target.value);
              setPage(1);
            }}
          />
        </div>
        <div>
          <label htmlFor="audit-branch-id">Branch ID</label>
          <input
            id="audit-branch-id"
            value={branchId}
            onChange={(event) => {
              setBranchId(event.target.value);
              setPage(1);
            }}
          />
        </div>
        <div>
          <label htmlFor="audit-actor-id">Actor user ID</label>
          <input
            id="audit-actor-id"
            value={actorUserId}
            onChange={(event) => {
              setActorUserId(event.target.value);
              setPage(1);
            }}
          />
        </div>
        <div>
          <label htmlFor="audit-from">From</label>
          <input
            id="audit-from"
            type="datetime-local"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
              setPage(1);
            }}
          />
        </div>
        <div>
          <label htmlFor="audit-to">To</label>
          <input
            id="audit-to"
            type="datetime-local"
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
              setPage(1);
            }}
          />
        </div>
      </div>
      <FeedbackMessage tone="error" message={error} />
      {!error && !items.length && (
        <p className="empty-state">No audit entries match.</p>
      )}
      <ul className="activity-list">
        {items.map((item) => (
          <li key={item.id}>
            <time dateTime={item.createdAt}>
              {new Date(item.createdAt).toLocaleString()}
            </time>
            <strong>{item.action}</strong>
            <span>
              {item.entityType} · {item.entityId}
            </span>
            {item.actorUserId && <span>Actor {item.actorUserId}</span>}
            {item.branchId && <span>Branch {item.branchId}</span>}
            <pre>{JSON.stringify(item.metadata, null, 2)}</pre>
          </li>
        ))}
      </ul>
      <div className="pagination">
        <button
          className="secondary-button"
          disabled={page <= 1}
          onClick={() => setPage((value) => value - 1)}
        >
          Previous
        </button>{' '}
        <span>Page {page}</span>{' '}
        <button
          className="secondary-button"
          disabled={items.length < 25}
          onClick={() => setPage((value) => value + 1)}
        >
          Next
        </button>
      </div>
    </section>
  );
}
