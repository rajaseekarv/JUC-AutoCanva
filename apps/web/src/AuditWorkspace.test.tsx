// Phase 3.3 regression tests for the audit screen: loading, errors with
// retry, empty states, stale replies, paging and readable entries.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { AuthenticatedUserResponse } from '@adflow/shared-types';
import { AuditWorkspace } from './ActivityWorkspaces';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const session = {
  accessToken: 'token',
  user: {
    id: 'u',
    organizationId: 'o',
    name: 'Auditor',
    email: 'auditor@example.local',
    permissions: ['audit:read'],
    branches: [],
  } as AuthenticatedUserResponse,
};
const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  action: 'creative.created',
  entityType: 'creative',
  entityId: 'creative-' + id,
  actorUserId: 'user-1',
  branchId: 'branch-1',
  createdAt: '2026-01-01T00:00:00Z',
  metadata: { name: 'Spring post' },
  ...extra,
});
function reply(status: number, body?: unknown): Response {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    ok: status < 300,
    status,
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
  } as Response;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
// `answer` receives the request's query parameters.
function stubApi(
  answer: (query: URLSearchParams) => Promise<Response> | Response,
) {
  const queries: URLSearchParams[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const query = new URL(input).searchParams;
      queries.push(query);
      return answer(query);
    }),
  );
  return queries;
}
const renderAudit = (onUnauthorized = vi.fn()) => {
  render(<AuditWorkspace session={session} onUnauthorized={onUnauthorized} />);
  return onUnauthorized;
};
const page = (items: unknown[], total = items.length) =>
  reply(200, { items, page: 1, limit: 25, total });

describe('Audit history (Phase 3.3)', () => {
  it('shows a loading state, not the empty state, before the first reply', async () => {
    const first = deferred<Response>();
    stubApi(() => first.promise);
    renderAudit();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading audit history…',
    );
    expect(screen.queryByText(/No activity|No audit entries/)).toBeNull();
    await act(async () => first.resolve(page([])));
    expect(
      screen.getByText('No activity has been recorded yet.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says when filters match nothing, and Clear filters loads everything again', async () => {
    const queries = stubApi((query) =>
      query.get('action') ? page([]) : page([entry('1')]),
    );
    renderAudit();
    await screen.findByText('creative.created');
    fireEvent.change(screen.getByLabelText('Action'), {
      target: { value: 'brand.updated' },
    });
    expect(
      await screen.findByText('No audit entries match these filters.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('creative.created')).toBeInTheDocument();
    expect(screen.getByLabelText('Action')).toHaveValue('');
    expect(queries.at(-1)?.get('action')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });

  it('explains a failed load and loads again with Try again', async () => {
    let fail = true;
    stubApi(() => (fail ? reply(500, {}) : page([entry('1')])));
    renderAudit();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Audit history couldn't be loaded. Please try again.",
    );
    expect(screen.queryByText(/No activity|No audit entries/)).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('creative.created')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    [400, "Some filters aren't valid"],
    [403, 'You do not have permission to view audit history.'],
    [404, 'No audit history is available for that branch ID.'],
  ])('explains a %s in words', async (status, text) => {
    stubApi(() => reply(status, { message: 'raw' }));
    renderAudit();
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
  });

  it('signs out on an expired session', async () => {
    stubApi(() => reply(401, {}));
    const onUnauthorized = renderAudit();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your session expired. Please sign in again.',
    );
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('ignores a late reply for filters that have since changed', async () => {
    const slow = deferred<Response>();
    stubApi((query) =>
      query.get('action') === 'creative'
        ? slow.promise
        : query.get('action') === 'creative.created'
          ? page([entry('new', { action: 'creative.created' })])
          : page([]),
    );
    renderAudit();
    await screen.findByText('No activity has been recorded yet.');
    fireEvent.change(screen.getByLabelText('Action'), {
      target: { value: 'creative' },
    });
    fireEvent.change(screen.getByLabelText('Action'), {
      target: { value: 'creative.created' },
    });
    expect(await screen.findByText('creative.created')).toBeInTheDocument();
    await act(async () =>
      slow.resolve(page([entry('old', { action: 'creative.stale' })])),
    );
    expect(screen.queryByText('creative.stale')).toBeNull();
    expect(screen.getByText('creative.created')).toBeInTheDocument();
  });

  it('keeps the previous entries, marked as updating, while new ones load', async () => {
    const next = deferred<Response>();
    stubApi((query) =>
      query.get('page') === '2'
        ? next.promise
        : page(
            Array.from({ length: 25 }, (_, index) => entry('p1-' + index)),
            30,
          ),
    );
    renderAudit();
    await waitFor(() =>
      expect(screen.getAllByText('creative.created')).toHaveLength(25),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('status')).toHaveTextContent(
      'Updating audit history…',
    );
    expect(screen.getByRole('list')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await act(async () =>
      next.resolve(
        reply(200, {
          items: Array.from({ length: 5 }, (_, index) => entry('p2-' + index)),
          page: 2,
          limit: 25,
          total: 30,
        }),
      ),
    );
    expect(
      screen.getByText(/Page 2 of 2 · entries 26–30 of 30/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled();
  });

  it('uses the total to page: no Next after exactly one full page', async () => {
    stubApi(() =>
      page(
        Array.from({ length: 25 }, (_, index) => entry(String(index))),
        25,
      ),
    );
    renderAudit();
    expect(
      await screen.findByText(/Page 1 of 1 · entries 1–25 of 25/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('labels each entry and keeps its details collapsed', async () => {
    stubApi(() =>
      page([
        entry('1'),
        entry('2', { actorUserId: null, branchId: null, metadata: {} }),
      ]),
    );
    renderAudit();
    await waitFor(() =>
      expect(screen.getAllByText('creative.created')).toHaveLength(2),
    );
    const [first, second] = screen.getAllByRole('listitem');
    expect(first).toHaveTextContent('Recordcreative · creative-1');
    expect(first).toHaveTextContent('ByUser user-1');
    expect(first).toHaveTextContent('Branchbranch-1');
    expect(first?.querySelector('details')).not.toHaveAttribute('open');
    expect(first).toHaveTextContent('Details');
    expect(second).toHaveTextContent('BySystem');
    expect(second).not.toHaveTextContent('Branch');
    expect(second?.querySelector('details')).toBeNull();
  });
});
