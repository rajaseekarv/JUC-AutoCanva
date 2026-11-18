import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { useEffect } from 'react';
import { NotificationsWorkspace } from './ActivityWorkspaces';
import type { DataChange } from './dataChanges';
import {
  NOTIFICATION_MESSAGES,
  NOTIFICATION_POLL_MS,
  useNotifications,
  type Notice,
} from './useNotifications';

const notice = (id: string, readAt: string | null = null): Notice => ({
  id,
  title: 'Notice ' + id,
  message: 'Message ' + id,
  type: 'REVIEW_TASK_ASSIGNED',
  createdAt: '2026-01-01T00:00:00Z',
  readAt,
  entityType: 'workflow_instance',
  entityId: 'instance-' + id,
});

type Reply = { status: number; body: unknown };
// A fake notifications API. Requests are answered at once unless `hold` is
// set for their path, in which case they wait for `release(path)`.
function fakeApi() {
  const api = {
    count: 0,
    list: [] as Notice[],
    status: { count: 200, list: 200, read: 200 },
    // Mark-as-read requests fail at the network level (no response).
    readRejects: false,
    hold: new Set<string>(),
    calls: [] as { path: string; token: string; method: string }[],
    waiting: new Map<string, ((reply: Reply) => void)[]>(),
    release(path: string, reply?: Reply) {
      const queue = api.waiting.get(path) ?? [];
      const next = queue.shift();
      next?.(
        reply ??
          (path.endsWith('unread-count')
            ? { status: api.status.count, body: { count: api.count } }
            : { status: api.status.list, body: api.list }),
      );
    },
  };
  const fetchMock = vi.fn(
    async (input: string, init?: RequestInit): Promise<Response> => {
      const path = input.replace(/^.*\/api\/v1/, '');
      const method = init?.method ?? 'GET';
      const token = String(
        (init?.headers as Record<string, string>).Authorization,
      ).replace('Bearer ', '');
      api.calls.push({ path, token, method });
      const respond = ({ status, body }: Reply) =>
        ({
          ok: status >= 200 && status < 300,
          status,
          json: async () => body,
        }) as Response;
      if (api.hold.has(path))
        return new Promise<Reply>((resolve) => {
          api.waiting.set(path, [...(api.waiting.get(path) ?? []), resolve]);
        }).then(respond);
      if (method === 'POST') {
        if (api.readRejects) throw new TypeError('Failed to fetch');
        return respond({ status: api.status.read, body: {} });
      }
      if (path === '/notifications/unread-count')
        return respond({
          status: api.status.count,
          body: { count: api.count },
        });
      return respond({ status: api.status.list, body: api.list });
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return api;
}

let visibility: DocumentVisibilityState = 'visible';
function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (document as { visibilityState?: unknown }).visibilityState;
});

// Lets pending fetch replies and React updates settle.
async function settle() {
  for (let round = 0; round < 5; round += 1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

function Harness({
  token,
  open,
  dataChange,
  onUnauthorized,
}: {
  token: string | null;
  open: boolean;
  dataChange?: DataChange;
  onUnauthorized: (token: string) => void;
}) {
  const notifications = useNotifications({
    accessToken: token,
    dataChange,
    onUnauthorized,
  });
  const { setScreenOpen } = notifications;
  useEffect(() => setScreenOpen(open), [open, setScreenOpen]);
  return <NotificationsWorkspace notifications={notifications} />;
}
function renderHarness(props: Partial<Parameters<typeof Harness>[0]> = {}) {
  const onUnauthorized = props.onUnauthorized ?? vi.fn();
  const base = { token: 'token-a', open: false, onUnauthorized, ...props };
  const view = render(<Harness {...base} />);
  return {
    onUnauthorized,
    rerender: (next: Partial<Parameters<typeof Harness>[0]>) =>
      view.rerender(<Harness {...base} {...next} />),
    unmount: view.unmount,
  };
}
const countCalls = (api: ReturnType<typeof fakeApi>) =>
  api.calls.filter((call) => call.path === '/notifications/unread-count')
    .length;
const listCalls = (api: ReturnType<typeof fakeApi>) =>
  api.calls.filter(
    (call) => call.path === '/notifications' && call.method === 'GET',
  ).length;

describe('useNotifications', () => {
  it('loads the unread count once on sign-in, without the full list', async () => {
    const api = fakeApi();
    api.count = 2;
    api.list = [notice('n1')];
    renderHarness();
    await settle();
    expect(countCalls(api)).toBe(1);
    expect(listCalls(api)).toBe(0);
    expect(screen.getByText('2 unread')).toBeInTheDocument();
  });

  it('loads the count and the list once when Notifications opens', async () => {
    const api = fakeApi();
    api.count = 1;
    api.list = [notice('n1')];
    const view = renderHarness();
    await settle();
    view.rerender({ open: true });
    await settle();
    expect(countCalls(api)).toBe(2);
    expect(listCalls(api)).toBe(1);
    expect(screen.getByText('Notice n1')).toBeInTheDocument();
  });

  it('makes one count and one list request when the app starts on Notifications', async () => {
    const api = fakeApi();
    api.count = 1;
    api.list = [notice('n1')];
    renderHarness({ open: true });
    await settle();
    expect(countCalls(api)).toBe(1);
    expect(listCalls(api)).toBe(1);
    expect(screen.getByText('Notice n1')).toBeInTheDocument();
  });

  it('polls the unread count every 60 seconds', async () => {
    const api = fakeApi();
    renderHarness();
    await settle();
    expect(countCalls(api)).toBe(1);
    await advance(NOTIFICATION_POLL_MS - 1);
    expect(countCalls(api)).toBe(1);
    await advance(1);
    expect(countCalls(api)).toBe(2);
    await advance(NOTIFICATION_POLL_MS);
    expect(countCalls(api)).toBe(3);
  });

  it('does not fetch the list when a poll finds the count unchanged', async () => {
    const api = fakeApi();
    api.count = 1;
    api.list = [notice('n1')];
    renderHarness({ open: true });
    await settle();
    await advance(NOTIFICATION_POLL_MS * 3);
    expect(countCalls(api)).toBe(4);
    expect(listCalls(api)).toBe(1);
  });

  it('refreshes an open list when the count changes, but not a closed one', async () => {
    const api = fakeApi();
    api.count = 1;
    api.list = [notice('n1')];
    const view = renderHarness({ open: true });
    await settle();
    api.count = 2;
    api.list = [notice('n2'), notice('n1')];
    await advance(NOTIFICATION_POLL_MS);
    expect(listCalls(api)).toBe(2);
    expect(screen.getByText('Notice n2')).toBeInTheDocument();
    expect(screen.getByText('2 unread')).toBeInTheDocument();

    view.rerender({ open: false });
    api.count = 3;
    await advance(NOTIFICATION_POLL_MS);
    expect(screen.getByText('3 unread')).toBeInTheDocument();
    expect(listCalls(api)).toBe(2);
  });

  it('stops polling while the tab is hidden and refreshes when it is visible again', async () => {
    const api = fakeApi();
    renderHarness();
    await settle();
    setVisibility('hidden');
    await advance(NOTIFICATION_POLL_MS * 5);
    expect(countCalls(api)).toBe(1);
    setVisibility('visible');
    await settle();
    expect(countCalls(api)).toBe(2);
    await advance(NOTIFICATION_POLL_MS);
    expect(countCalls(api)).toBe(3);
  });

  it('does not schedule a poll when a request finishes while the tab is hidden', async () => {
    const api = fakeApi();
    api.hold.add('/notifications/unread-count');
    renderHarness();
    await settle();
    setVisibility('hidden');
    api.release('/notifications/unread-count');
    await settle();
    api.hold.clear();
    await advance(NOTIFICATION_POLL_MS * 3);
    expect(countCalls(api)).toBe(1);
  });

  it('stops on sign-out and on unmount, and removes its listener', async () => {
    const api = fakeApi();
    const view = renderHarness();
    await settle();
    view.rerender({ token: null });
    await advance(NOTIFICATION_POLL_MS * 3);
    setVisibility('hidden');
    setVisibility('visible');
    await settle();
    expect(countCalls(api)).toBe(1);

    view.rerender({ token: 'token-b' });
    await settle();
    expect(countCalls(api)).toBe(2);
    view.unmount();
    await advance(NOTIFICATION_POLL_MS * 3);
    setVisibility('hidden');
    setVisibility('visible');
    await settle();
    expect(countCalls(api)).toBe(2);
  });

  it('signs out through the existing handler on a 401', async () => {
    const api = fakeApi();
    api.status.count = 401;
    const view = renderHarness();
    await settle();
    expect(view.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(view.onUnauthorized).toHaveBeenCalledWith('token-a');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('signs out on a 401 when marking read', async () => {
    const api = fakeApi();
    api.count = 1;
    api.list = [notice('n1')];
    const view = renderHarness({ open: true });
    await settle();
    api.status.read = 401;
    fireEvent.click(screen.getByRole('button', { name: 'Mark read' }));
    await settle();
    expect(view.onUnauthorized).toHaveBeenCalledWith('token-a');
  });

  it('refreshes the count on dataChanges events, not on mount', async () => {
    const api = fakeApi();
    const view = renderHarness({
      dataChange: { key: 0, source: '' },
    });
    await settle();
    expect(countCalls(api)).toBe(1);
    view.rerender({ dataChange: { key: 1, source: 'approvals' } });
    await settle();
    expect(countCalls(api)).toBe(2);
    view.rerender({ dataChange: { key: 2, source: 'creatives' } });
    await settle();
    expect(countCalls(api)).toBe(3);
    expect(listCalls(api)).toBe(0);
  });

  it('marks read and refreshes the count and list once each', async () => {
    const api = fakeApi();
    api.count = 1;
    api.list = [notice('n1')];
    renderHarness({ open: true });
    await settle();
    api.count = 0;
    api.list = [notice('n1', '2026-01-02T00:00:00Z')];
    fireEvent.click(screen.getByRole('button', { name: 'Mark read' }));
    await settle();
    expect(api.calls.filter((call) => call.method === 'POST')).toEqual([
      expect.objectContaining({ path: '/notifications/n1/read' }),
    ]);
    expect(countCalls(api)).toBe(2);
    expect(listCalls(api)).toBe(2);
    expect(screen.getByText('No unread notifications')).toBeInTheDocument();
  });

  it('merges requests asked for while one is in flight into one follow-up', async () => {
    const api = fakeApi();
    api.hold.add('/notifications/unread-count');
    const view = renderHarness({ dataChange: { key: 0, source: '' } });
    await settle();
    expect(countCalls(api)).toBe(1);
    // Three changes and a visibility return while the first is in flight.
    view.rerender({ dataChange: { key: 1, source: 'approvals' } });
    view.rerender({ dataChange: { key: 2, source: 'workflows' } });
    view.rerender({ dataChange: { key: 3, source: 'creatives' } });
    setVisibility('visible');
    await settle();
    expect(countCalls(api)).toBe(1);
    api.release('/notifications/unread-count');
    await settle();
    expect(countCalls(api)).toBe(2);
    api.release('/notifications/unread-count');
    await settle();
    expect(countCalls(api)).toBe(2);
  });

  it('ignores a late reply that belongs to an earlier session', async () => {
    const api = fakeApi();
    api.hold.add('/notifications/unread-count');
    const view = renderHarness({ token: 'token-a' });
    await settle();
    view.rerender({ token: 'token-b' });
    await settle();
    const [replyToA, replyToB] =
      api.waiting.get('/notifications/unread-count') ?? [];
    expect(api.calls.map((call) => call.token)).toEqual(['token-a', 'token-b']);
    // Session B answers first; the slower reply for session A arrives later
    // and must not replace it.
    replyToB({ status: 200, body: { count: 2 } });
    await settle();
    expect(screen.getByText('2 unread')).toBeInTheDocument();
    replyToA({ status: 200, body: { count: 9 } });
    await settle();
    expect(screen.getByText('2 unread')).toBeInTheDocument();
    expect(screen.queryByText('9 unread')).toBeNull();
  });

  it('ignores an earlier session reply that arrives before the new session has a count', async () => {
    const api = fakeApi();
    api.hold.add('/notifications/unread-count');
    const view = renderHarness({ token: 'token-a' });
    await settle();
    view.rerender({ token: 'token-b' });
    await settle();
    const [replyToA, replyToB] =
      api.waiting.get('/notifications/unread-count') ?? [];
    // Session A's reply comes back first: it must not show A's count to B.
    replyToA({ status: 200, body: { count: 9 } });
    await settle();
    expect(screen.queryByText('9 unread')).toBeNull();
    expect(screen.getByText('No unread notifications')).toBeInTheDocument();
    replyToB({ status: 200, body: { count: 2 } });
    await settle();
    expect(screen.getByText('2 unread')).toBeInTheDocument();
  });

  it('after a change during an in-flight poll, shows the newer follow-up count', async () => {
    const api = fakeApi();
    api.hold.add('/notifications/unread-count');
    const view = renderHarness({ dataChange: { key: 0, source: '' } });
    await settle();
    // Review data changes while the first count is still on its way.
    view.rerender({ dataChange: { key: 1, source: 'approvals' } });
    await settle();
    api.release('/notifications/unread-count', {
      status: 200,
      body: { count: 5 },
    });
    await settle();
    expect(screen.getByText('5 unread')).toBeInTheDocument();
    expect(countCalls(api)).toBe(2);
    api.release('/notifications/unread-count', {
      status: 200,
      body: { count: 7 },
    });
    await settle();
    expect(screen.getByText('7 unread')).toBeInTheDocument();
    expect(countCalls(api)).toBe(2);
  });

  it('backs off after failures and returns to 60 seconds after a success', async () => {
    const api = fakeApi();
    api.status.count = 500;
    renderHarness();
    await settle();
    expect(countCalls(api)).toBe(1);
    // Only the count was asked for (the screen is closed), so only the count
    // is reported as out of date.
    expect(screen.getByRole('alert')).toHaveTextContent(
      NOTIFICATION_MESSAGES.countOnly,
    );
    // First failure: the next poll waits 2 minutes.
    await advance(NOTIFICATION_POLL_MS);
    expect(countCalls(api)).toBe(1);
    await advance(NOTIFICATION_POLL_MS);
    expect(countCalls(api)).toBe(2);
    // Second failure: 4 minutes.
    await advance(NOTIFICATION_POLL_MS * 3);
    expect(countCalls(api)).toBe(2);
    await advance(NOTIFICATION_POLL_MS);
    expect(countCalls(api)).toBe(3);
    // A success resets the interval.
    api.status.count = 200;
    api.count = 1;
    await advance(NOTIFICATION_POLL_MS * 8);
    expect(countCalls(api)).toBe(4);
    await advance(NOTIFICATION_POLL_MS);
    expect(countCalls(api)).toBe(5);
  });

  it('caps the back-off at 16 minutes', async () => {
    const api = fakeApi();
    api.status.count = 500;
    renderHarness();
    await settle();
    // Failures 1 to 4 wait 2, 4, 8 and 16 minutes; the fifth still 16.
    await advance(NOTIFICATION_POLL_MS * (2 + 4 + 8 + 16));
    expect(countCalls(api)).toBe(5);
    await advance(NOTIFICATION_POLL_MS * 16 - 1);
    expect(countCalls(api)).toBe(5);
    await advance(1);
    expect(countCalls(api)).toBe(6);
  });
});

// Each request kind keeps its own error, and each recovers on its own.
describe('useNotifications errors', () => {
  const alerts = () =>
    screen.queryAllByRole('alert').map((node) => node.textContent);

  it('keeps a count error when the list loads, and clears it when the count recovers', async () => {
    const api = fakeApi();
    api.status.count = 500;
    api.list = [notice('n1')];
    renderHarness({ open: true });
    await settle();
    expect(listCalls(api)).toBe(1);
    expect(screen.getByText('Notice n1')).toBeInTheDocument();
    expect(alerts()).toEqual([NOTIFICATION_MESSAGES.countOnly]);
    // The count recovers at the next (backed-off) poll.
    api.status.count = 200;
    api.count = 1;
    await advance(NOTIFICATION_POLL_MS * 2);
    expect(alerts()).toEqual([]);
    expect(screen.getByText('1 unread')).toBeInTheDocument();
  });

  it('keeps a list error when the count loads, and clears it when the list recovers', async () => {
    const api = fakeApi();
    api.count = 1;
    api.status.list = 500;
    renderHarness({ open: true });
    await settle();
    expect(alerts()).toEqual([NOTIFICATION_MESSAGES.listOnly]);
    // An unavailable list is not shown as an empty one.
    expect(screen.queryByText('No notifications yet.')).toBeNull();
    // A successful poll with the same count leaves the list error alone.
    await advance(NOTIFICATION_POLL_MS);
    expect(countCalls(api)).toBe(2);
    expect(alerts()).toEqual([NOTIFICATION_MESSAGES.listOnly]);
    // A changed count reloads the list, which now succeeds.
    api.status.list = 200;
    api.count = 2;
    api.list = [notice('n2'), notice('n1')];
    await advance(NOTIFICATION_POLL_MS);
    expect(alerts()).toEqual([]);
    expect(screen.getByText('Notice n2')).toBeInTheDocument();
  });

  it('reports both failures together, then each recovery separately', async () => {
    const api = fakeApi();
    api.status.count = 500;
    api.status.list = 500;
    renderHarness({ open: true });
    await settle();
    expect(alerts()).toEqual([NOTIFICATION_MESSAGES.unavailable]);
    api.status.count = 200;
    api.count = 1;
    await advance(NOTIFICATION_POLL_MS * 2);
    // The count is back; the list request after the changed count still
    // fails, so only the list is out of date.
    expect(alerts()).toEqual([NOTIFICATION_MESSAGES.listOnly]);
    api.status.list = 200;
    api.count = 2;
    api.list = [notice('n1')];
    await advance(NOTIFICATION_POLL_MS);
    expect(alerts()).toEqual([]);
    expect(screen.getByText('Notice n1')).toBeInTheDocument();
  });

  it('keeps a notification unread and says so when marking it read fails', async () => {
    const api = fakeApi();
    api.count = 1;
    api.list = [notice('n1')];
    const view = renderHarness({ open: true });
    await settle();
    const before = { count: countCalls(api), list: listCalls(api) };
    api.status.read = 500;
    fireEvent.click(screen.getByRole('button', { name: 'Mark read' }));
    await settle();
    expect(alerts()).toEqual([NOTIFICATION_MESSAGES.markOne]);
    expect(
      screen.getByRole('listitem', { name: 'Unread notification' }),
    ).toHaveTextContent('• Unread');
    expect(
      screen.getByRole('button', { name: 'Mark read' }),
    ).toBeInTheDocument();
    expect(screen.getByText('1 unread')).toBeInTheDocument();
    // Nothing was reloaded, and the session was kept.
    expect({ count: countCalls(api), list: listCalls(api) }).toEqual(before);
    expect(view.onUnauthorized).not.toHaveBeenCalled();

    // Trying again succeeds: the error goes and the state comes from the
    // server.
    api.status.read = 200;
    api.count = 0;
    api.list = [notice('n1', '2026-01-02T00:00:00Z')];
    fireEvent.click(screen.getByRole('button', { name: 'Mark read' }));
    await settle();
    expect(alerts()).toEqual([]);
    expect(
      screen.getByRole('listitem', { name: 'Read notification' }),
    ).toBeInTheDocument();
    expect(screen.getByText('No unread notifications')).toBeInTheDocument();
  });

  it('says so when marking all read fails, or the request cannot be sent', async () => {
    const api = fakeApi();
    api.count = 2;
    api.list = [notice('n1'), notice('n2')];
    renderHarness({ open: true });
    await settle();
    api.status.read = 503;
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    await settle();
    expect(alerts()).toEqual([NOTIFICATION_MESSAGES.markAll]);
    expect(
      screen.getAllByRole('listitem', { name: 'Unread notification' }),
    ).toHaveLength(2);
    expect(screen.getByText('2 unread')).toBeInTheDocument();

    api.readRejects = true;
    fireEvent.click(screen.getAllByRole('button', { name: 'Mark read' })[0]);
    await settle();
    expect(alerts()).toEqual([NOTIFICATION_MESSAGES.markOne]);
    expect(
      screen.getAllByRole('listitem', { name: 'Unread notification' }),
    ).toHaveLength(2);
  });

  it('shows no mark-read error on a 401, which signs out instead', async () => {
    const api = fakeApi();
    api.count = 1;
    api.list = [notice('n1')];
    const view = renderHarness({ open: true });
    await settle();
    api.status.read = 401;
    fireEvent.click(screen.getByRole('button', { name: 'Mark read' }));
    await settle();
    expect(view.onUnauthorized).toHaveBeenCalledWith('token-a');
    expect(alerts()).toEqual([]);
  });
});

// Phase 2B step 3: navigation hides its badge while the count is unavailable.
describe('useNotifications countError', () => {
  function CountProbe({ token }: { token: string | null }) {
    const { count, countError } = useNotifications({
      accessToken: token,
      onUnauthorized: vi.fn(),
    });
    return (
      <p data-testid="count-state">
        {countError ? 'unavailable' : `count ${count}`}
      </p>
    );
  }
  const state = () => screen.getByTestId('count-state').textContent;

  it('is set only while the last count request failed', async () => {
    const api = fakeApi();
    api.count = 3;
    render(<CountProbe token="token-a" />);
    await settle();
    expect(state()).toBe('count 3');
    api.status.count = 500;
    await advance(NOTIFICATION_POLL_MS);
    expect(state()).toBe('unavailable');
    // A failed list request does not affect it.
    api.status.count = 200;
    api.status.list = 500;
    await advance(NOTIFICATION_POLL_MS * 2);
    expect(state()).toBe('count 3');
    expect(countCalls(api)).toBe(3);
  });

  it('is cleared for a new session', async () => {
    const api = fakeApi();
    api.status.count = 500;
    const view = render(<CountProbe token="token-a" />);
    await settle();
    expect(state()).toBe('unavailable');
    api.status.count = 200;
    api.count = 0;
    view.rerender(<CountProbe token="token-b" />);
    await settle();
    expect(state()).toBe('count 0');
  });
});

// Phase 3.3: before the list has loaded, the screen says it is loading
// rather than that there are no notifications.
describe('Notifications list loading (Phase 3.3)', () => {
  it('says "Loading notifications…" until the list arrives, then the empty state', async () => {
    const api = fakeApi();
    api.hold.add('/notifications');
    renderHarness({ open: true });
    await settle();
    expect(screen.getByText('Loading notifications…')).toBeInTheDocument();
    expect(screen.queryByText('No notifications yet.')).toBeNull();
    api.release('/notifications');
    await settle();
    expect(screen.getByText('No notifications yet.')).toBeInTheDocument();
    expect(screen.queryByText('Loading notifications…')).toBeNull();
  });

  it('starts loading again for a new session instead of showing the previous empty state', async () => {
    const api = fakeApi();
    const view = renderHarness({ open: true });
    await settle();
    expect(screen.getByText('No notifications yet.')).toBeInTheDocument();
    api.hold.add('/notifications');
    view.rerender({ token: 'token-b' });
    await settle();
    expect(screen.getByText('Loading notifications…')).toBeInTheDocument();
    expect(screen.queryByText('No notifications yet.')).toBeNull();
  });
});
