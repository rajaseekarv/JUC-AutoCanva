import { useCallback, useEffect, useRef, useState } from 'react';
import type { DataChange } from './dataChanges';

export type Notice = {
  id: string;
  title: string;
  message: string;
  type: string;
  createdAt: string;
  readAt: string | null;
  entityType: string;
  entityId: string;
  // The records the notification is about, as the API stores them. Each may
  // be null (for example a notification without a branch).
  branchId?: string | null;
  creativeId?: string | null;
  workflowInstanceId?: string | null;
};

export type Notifications = {
  items: Notice[];
  count: number;
  // Why the shown data may be out of date: both requests failed, or only the
  // unread count, or only the list. Empty while both are current.
  error: string;
  // Whether the last unread-count request failed (the count may be out of
  // date). Navigation hides its unread badge while this is true.
  countError: boolean;
  // Whether the last list request failed (the list may be out of date).
  listError: boolean;
  // Why marking read failed; empty once a later attempt succeeds.
  actionError: string;
  // Tells the hook whether the Notifications screen is open: opening it
  // loads the full list, and only an open screen keeps its list current.
  setScreenOpen: (open: boolean) => void;
  // Marks one notification, or all of them, read and refreshes.
  markRead: (id?: string) => Promise<void>;
};

const apiBase =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000/api/v1';
export const NOTIFICATION_POLL_MS = 60_000;
// After failed polls the interval doubles, up to 16 times the normal one.
const MAX_BACKOFF_STEPS = 4;
export const NOTIFICATION_MESSAGES = {
  unavailable: 'Notifications are unavailable.',
  countOnly:
    "The unread count couldn't be updated, so it may be out of date. The notifications below are current.",
  listOnly:
    "Your notifications couldn't be loaded, so the list below may be out of date. The unread count is current.",
  markOne: "We couldn't mark this notification as read. Please try again.",
  markAll: "We couldn't mark your notifications as read. Please try again.",
};

class Unauthorized extends Error {}

type Lane = {
  inFlight: boolean;
  // Another request was asked for while one was in flight; it runs once
  // the current one finishes, however many times it was asked for.
  again: boolean;
};

// The signed-in user's notifications, owned by the app shell so every
// screen shares one copy and nothing polls on its own.
//
// - The unread count is fetched on sign-in, every 60 seconds while the tab is
//   visible, when the tab becomes visible again, on every dataChanges event,
//   and when the Notifications screen opens.
// - The full list is fetched only when the Notifications screen opens, after
//   marking read, and while the screen is open when a newer count differs.
//   A background poll whose count is unchanged fetches nothing else.
// - Each kind of request runs one at a time; requests asked for meanwhile
//   are merged into one follow-up. Replies for an earlier session, or older
//   than the data already shown, are ignored.
// - A 401 signs out through `onUnauthorized`. Other failures keep the last
//   data and are tracked per request kind: the Notifications screen says
//   whether the count, the list or both may be out of date, and failed
//   count polls slow the polling. A failed mark-as-read changes nothing and
//   says so.
export function useNotifications({
  accessToken,
  dataChange,
  onUnauthorized,
  pollMs = NOTIFICATION_POLL_MS,
}: {
  accessToken: string | null;
  dataChange?: DataChange;
  onUnauthorized: (accessToken: string) => void;
  pollMs?: number;
}): Notifications {
  const [items, setItems] = useState<Notice[]>([]);
  const [count, setCount] = useState(0);
  // Each request kind records its own failure, set only by its own request
  // and cleared only when that kind of request succeeds again.
  const [countError, setCountError] = useState(false);
  const [listError, setListError] = useState(false);
  const [actionError, setActionError] = useState('');

  // The token requests are made for. Kept current during render so a screen
  // opened by a child effect, before this hook's own effects, uses it.
  const tokenRef = useRef(accessToken);
  tokenRef.current = accessToken;
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;
  const controller = useRef<AbortController | null>(null);
  const screenOpen = useRef(false);
  const countLane = useRef<Lane>({ inFlight: false, again: false });
  const listLane = useRef<Lane>({ inFlight: false, again: false });
  // Every request gets the next stamp when it starts. The list is current
  // for every count whose request started before the list's request.
  const clock = useRef(0);
  const listStamp = useRef(0);
  const appliedCountStamp = useRef(0);
  const knownCount = useRef<number | null>(null);
  const failures = useRef(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  // One controller per session; signing out or switching session aborts it.
  const signal = useCallback(() => {
    if (!controller.current || controller.current.signal.aborted)
      controller.current = new AbortController();
    return controller.current.signal;
  }, []);

  const get = useCallback(
    async <T>(path: string, token: string): Promise<T> => {
      const response = await fetch(apiBase + path, {
        headers: { Authorization: `Bearer ${token}` },
        signal: signal(),
      });
      if (response.status === 401) throw new Unauthorized();
      if (!response.ok) throw new Error(NOTIFICATION_MESSAGES.unavailable);
      return (await response.json()) as T;
    },
    [signal],
  );

  // Whether a reply still belongs to the signed-in session.
  const current = useCallback(
    (token: string) =>
      tokenRef.current === token && !controller.current?.signal.aborted,
    [],
  );

  // A 401 signs out; any other failure is recorded for its request kind.
  const fail = useCallback(
    (cause: unknown, token: string, kind: 'count' | 'list') => {
      if (!current(token)) return;
      if (cause instanceof Unauthorized) {
        unauthorizedRef.current(token);
        return;
      }
      if (kind === 'count') setCountError(true);
      else setListError(true);
    },
    [current],
  );

  const schedulePoll = useRef<() => void>(() => undefined);

  const refreshList = useCallback(
    async ({ join }: { join: boolean }): Promise<void> => {
      const token = tokenRef.current;
      if (!token) return;
      const lane = listLane.current;
      if (lane.inFlight) {
        if (!join) lane.again = true;
        return;
      }
      lane.inFlight = true;
      try {
        do {
          lane.again = false;
          const stamp = ++clock.current;
          listStamp.current = stamp;
          try {
            const list = await get<Notice[]>('/notifications', token);
            if (!current(token)) return;
            setItems(list);
            setListError(false);
          } catch (cause) {
            fail(cause, token, 'list');
            return;
          }
        } while (lane.again && current(token));
      } finally {
        lane.inFlight = false;
      }
    },
    [get, fail, current],
  );

  const refreshCount = useCallback(
    async ({ join }: { join: boolean }): Promise<void> => {
      const token = tokenRef.current;
      if (!token) return;
      const lane = countLane.current;
      if (lane.inFlight) {
        if (!join) lane.again = true;
        return;
      }
      lane.inFlight = true;
      try {
        do {
          lane.again = false;
          const stamp = ++clock.current;
          try {
            const { count: latest } = await get<{ count: number }>(
              '/notifications/unread-count',
              token,
            );
            if (!current(token)) return;
            failures.current = 0;
            setCountError(false);
            if (stamp < appliedCountStamp.current) continue;
            appliedCountStamp.current = stamp;
            const changed = knownCount.current !== latest;
            knownCount.current = latest;
            setCount(latest);
            // An open screen's list is refreshed only when this count is
            // newer than the list and differs from the previous count.
            if (screenOpen.current && changed && stamp > listStamp.current)
              void refreshList({ join: false });
          } catch (cause) {
            if (!current(token)) return;
            if (!(cause instanceof Unauthorized))
              failures.current = Math.min(
                failures.current + 1,
                MAX_BACKOFF_STEPS,
              );
            fail(cause, token, 'count');
            return;
          }
        } while (lane.again && current(token));
      } finally {
        lane.inFlight = false;
        if (current(token)) schedulePoll.current();
      }
    },
    [get, fail, current, refreshList],
  );

  // Polling: one timer, restarted after every count request, and only while
  // signed in and the tab is visible.
  schedulePoll.current = () => {
    clearTimeout(pollTimer.current);
    pollTimer.current = undefined;
    if (!tokenRef.current || document.visibilityState !== 'visible') return;
    pollTimer.current = setTimeout(
      () => void refreshCount({ join: true }),
      pollMs * 2 ** failures.current,
    );
  };

  // Sign-in, sign-out and session changes.
  useEffect(() => {
    if (!accessToken) {
      clearTimeout(pollTimer.current);
      return;
    }
    // The previous session's data is dropped. Request stamps keep counting
    // up, so a request already started for this session (for example by a
    // screen opened before this effect ran) stays valid.
    setItems([]);
    setCount(0);
    setCountError(false);
    setListError(false);
    setActionError('');
    knownCount.current = null;
    failures.current = 0;
    void refreshCount({ join: true });
    if (screenOpen.current) void refreshList({ join: true });
    function onVisibilityChange(): void {
      if (document.visibilityState === 'visible')
        void refreshCount({ join: true });
      else {
        clearTimeout(pollTimer.current);
        pollTimer.current = undefined;
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      clearTimeout(pollTimer.current);
      pollTimer.current = undefined;
      // Outstanding requests of this session are cancelled and ignored.
      controller.current?.abort();
      controller.current = null;
      countLane.current = { inFlight: false, again: false };
      listLane.current = { inFlight: false, again: false };
    };
  }, [accessToken, refreshCount, refreshList]);

  // Review data changed on another screen: the count may have changed too.
  const seenChange = useRef(dataChange?.key ?? 0);
  useEffect(() => {
    const key = dataChange?.key ?? 0;
    if (key === seenChange.current) return;
    seenChange.current = key;
    void refreshCount({ join: false });
  }, [dataChange?.key, refreshCount]);

  const setScreenOpen = useCallback(
    (open: boolean) => {
      if (open === screenOpen.current) return;
      screenOpen.current = open;
      if (!open) return;
      // The count request starts first, so the list started after it is
      // already current for that count.
      void refreshCount({ join: true });
      void refreshList({ join: true });
    },
    [refreshCount, refreshList],
  );

  const markRead = useCallback(
    async (id?: string) => {
      const token = tokenRef.current;
      if (!token) return;
      // Cleared first, so a repeated failure is announced again.
      setActionError('');
      const failed = id
        ? NOTIFICATION_MESSAGES.markOne
        : NOTIFICATION_MESSAGES.markAll;
      try {
        const response = await fetch(
          `${apiBase}/notifications${id ? `/${encodeURIComponent(id)}/read` : '/read-all'}`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            signal: signal(),
          },
        );
        if (response.status === 401) throw new Unauthorized();
        if (!response.ok) throw new Error(failed);
      } catch (cause) {
        if (!current(token)) return;
        // Nothing is changed locally: the notification keeps its state until
        // the server confirms, and the list is not reloaded.
        if (cause instanceof Unauthorized) unauthorizedRef.current(token);
        else setActionError(failed);
        return;
      }
      if (!current(token)) return;
      void refreshCount({ join: false });
      void refreshList({ join: false });
    },
    [signal, current, refreshCount, refreshList],
  );

  const error =
    countError && listError
      ? NOTIFICATION_MESSAGES.unavailable
      : countError
        ? NOTIFICATION_MESSAGES.countOnly
        : listError
          ? NOTIFICATION_MESSAGES.listOnly
          : '';
  return {
    items,
    count,
    error,
    countError,
    listError,
    actionError,
    setScreenOpen,
    markRead,
  };
}
