import { useCallback, useEffect, useState } from 'react';
import type { AuthenticatedUserResponse } from '@adflow/shared-types';

type Session = { accessToken: string; user: AuthenticatedUserResponse };
type Notice = {
  id: string;
  title: string;
  message: string;
  type: string;
  createdAt: string;
  readAt: string | null;
  entityType: string;
  entityId: string;
};
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

export function NotificationsWorkspace({ session }: { session: Session }) {
  const [items, setItems] = useState<Notice[]>([]);
  const [count, setCount] = useState(0);
  const [error, setError] = useState('');
  const headers = { Authorization: `Bearer ${session.accessToken}` };
  const refresh = useCallback(async () => {
    const authorization = { Authorization: `Bearer ${session.accessToken}` };
    try {
      const [listResponse, countResponse] = await Promise.all([
        fetch(`${base}/notifications`, { headers: authorization }),
        fetch(`${base}/notifications/unread-count`, { headers: authorization }),
      ]);
      if (!listResponse.ok || !countResponse.ok)
        throw new Error('Notifications are unavailable.');
      setItems((await listResponse.json()) as Notice[]);
      setCount(((await countResponse.json()) as { count: number }).count);
      setError('');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Notifications are unavailable.',
      );
    }
  }, [session.accessToken]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  async function markRead(id?: string) {
    const response = await fetch(
      `${base}/notifications${id ? `/${encodeURIComponent(id)}/read` : '/read-all'}`,
      { method: 'POST', headers },
    );
    if (response.ok) await refresh();
  }
  return (
    <section
      className="service-card"
      id="notifications"
      aria-labelledby="notifications-title"
    >
      <div className="app-heading">
        <div>
          <p className="card-label">IN-APP ACTIVITY</p>
          <h2 id="notifications-title">
            Notifications <span aria-label="unread count">{count}</span>
          </h2>
        </div>
        <button className="secondary-button" onClick={() => void markRead()}>
          Mark all read
        </button>
      </div>
      {error && (
        <p role="alert" className="form-message">
          {error}
        </p>
      )}
      {!error && !items.length && (
        <p className="empty-state">No notifications yet.</p>
      )}
      <ul className="activity-list">
        {items.map((item) => (
          <li
            key={item.id}
            aria-label={
              item.readAt ? 'Read notification' : 'Unread notification'
            }
          >
            <strong>{item.title}</strong>{' '}
            {item.readAt ? '' : <span className="unread-marker">• Unread</span>}
            <p>{item.message}</p>
            <time dateTime={item.createdAt}>
              {new Date(item.createdAt).toLocaleString()}
            </time>
            {!item.readAt && (
              <button
                className="secondary-button"
                onClick={() => void markRead(item.id)}
              >
                Mark read
              </button>
            )}
          </li>
        ))}
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
      <p className="card-label">ACCOUNTABILITY</p>
      <h2 id="audit-title">Audit history</h2>
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
      {error && (
        <p role="alert" className="form-message">
          {error}
        </p>
      )}
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
