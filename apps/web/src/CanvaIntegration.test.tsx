import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type {
  AuthenticatedUserResponse,
  BranchResponse,
  CanvaJobResponse,
} from '@adflow/shared-types';
import CanvaIntegration, { canvaRequestTimeoutMs } from './CanvaIntegration';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const branch: BranchResponse = {
  id: 'branch-1',
  name: 'North',
  code: 'NORTH',
  status: 'ACTIVE',
};
const user: AuthenticatedUserResponse = {
  id: 'user-1',
  organizationId: 'org-1',
  name: 'North Operator',
  email: 'operator@example.local',
  permissions: [
    'canva:integration:read',
    'canva:integration:manage',
    'canva:jobs:create',
    'creatives:read',
  ],
  branches: [{ id: branch.id, name: branch.name, code: branch.code }],
};
const creatives = [
  { id: 'creative-1', name: 'North offer' },
  { id: 'creative-2', name: 'South offer' },
];

function canvaJob(overrides: Partial<CanvaJobResponse> = {}): CanvaJobResponse {
  return {
    id: 'job-1',
    organizationId: 'org-1',
    branchId: 'branch-1',
    creativeId: 'creative-1',
    creativeRevisionId: 'revision-1',
    status: 'SUCCEEDED',
    mode: 'MOCK',
    externalDesignId: null,
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-10-25T07:00:00.000Z',
    updatedAt: '2026-10-25T07:00:00.000Z',
    ...overrides,
  };
}

function reply(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

type PostOutcome = (init: RequestInit) => unknown;

// Each POST consumes the next scripted outcome; every Idempotency-Key sent is
// recorded so tests can compare retries with new actions.
const southBranch: BranchResponse = {
  id: 'branch-2',
  name: 'South',
  code: 'SOUTH',
  status: 'ACTIVE',
};
const southCreatives = [{ id: 'creative-9', name: 'South branch offer' }];

function renderWithApi(
  posts: PostOutcome[],
  options: {
    jobs?: CanvaJobResponse[];
    failJobRefreshes?: boolean;
    // Holds the second branch's creatives response until resolved.
    southGate?: Promise<void>;
  } = {},
) {
  const keys: string[] = [];
  const postBodies: string[] = [];
  let jobRequests = 0;
  const fetchMock = vi
    .fn()
    .mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/integrations/canva/status'))
        return reply(200, {
          provider: 'CANVA',
          mode: 'MOCK',
          status: 'CONNECTED',
          connectedAt: null,
          accountLabel: 'Mock Canva account',
          isRealConnection: false,
        });
      if (
        input.endsWith('/integrations/canva/jobs') &&
        init?.method === 'POST'
      ) {
        const headers = init.headers as Record<string, string>;
        keys.push(headers['Idempotency-Key']);
        postBodies.push(String(init.body));
        const outcome = posts.shift();
        if (!outcome) throw new Error('Unexpected POST');
        return outcome(init);
      }
      if (input.endsWith('/integrations/canva/jobs')) {
        jobRequests += 1;
        if (options.failJobRefreshes && jobRequests > 1) return reply(500, {});
        return reply(200, options.jobs ?? []);
      }
      if (input.includes('/creatives?branchId=branch-1'))
        return reply(200, creatives);
      if (input.includes('/creatives?branchId=branch-2')) {
        await options.southGate;
        return reply(200, southCreatives);
      }
      return reply(404, {});
    });
  vi.stubGlobal('fetch', fetchMock);
  const onUnauthorized = vi.fn();
  const ui = (activeBranch: BranchResponse) => (
    <CanvaIntegration
      session={{ accessToken: 'token', user }}
      branch={activeBranch}
      onUnauthorized={onUnauthorized}
    />
  );
  let view = render(ui(branch));
  return {
    fetchMock,
    keys,
    postBodies,
    jobRequests: () => jobRequests,
    switchBranch: (next: BranchResponse) => view.rerender(ui(next)),
    // A fresh mount, as after a page reload.
    reload: () => {
      view.unmount();
      view = render(ui(branch));
    },
  };
}

async function ready() {
  expect(await screen.findByText('Mock provider connected')).toBeVisible();
  await screen.findByRole('option', { name: 'North offer' });
}

function prepareButton() {
  return screen.getByRole('button', { name: 'Prepare mock design' });
}

function retryButton() {
  return screen.queryByRole('button', { name: 'Retry and resume job' });
}

const unavailable = () =>
  reply(503, {
    statusCode: 503,
    message:
      'The Canva job outcome could not be saved; retry with the same Idempotency-Key',
  });
const succeeded = () => reply(201, canvaJob({ status: 'SUCCEEDED' }));

describe('CanvaIntegration', () => {
  it('labels the provider as mock and prepares a job from the selected branch creative', async () => {
    const { fetchMock } = renderWithApi([succeeded]);
    expect(
      await screen.findByRole('heading', { name: 'Canva integration' }),
    ).toBeInTheDocument();
    expect(screen.getByText('MOCK MODE')).toBeInTheDocument();
    expect(
      screen.getByText(/does not connect to a real Canva account/),
    ).toBeInTheDocument();
    await ready();
    fireEvent.click(prepareButton());
    expect(
      await screen.findByText('Mock design prepared.'),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/integrations/canva/jobs',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ creativeId: 'creative-1' }),
        headers: expect.objectContaining({
          'Idempotency-Key': expect.stringMatching(/^[\w.:/-]{8,128}$/),
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('retries with the exact same key after a 503 and resumes the job', async () => {
    const { keys } = renderWithApi([unavailable, succeeded]);
    await ready();
    fireEvent.click(prepareButton());
    expect(
      await screen.findByText(/Retry to resume the same job/),
    ).toBeInTheDocument();
    expect(prepareButton()).toBeDisabled();
    await waitFor(() => expect(retryButton()).toBeEnabled());
    fireEvent.click(retryButton()!);
    expect(
      await screen.findByText('Mock design prepared.'),
    ).toBeInTheDocument();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(retryButton()).toBeNull();
  });

  it('keeps the key after another 5xx response without a JSON body', async () => {
    const { keys } = renderWithApi([
      () => ({
        ok: false,
        status: 500,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      }),
      succeeded,
    ]);
    await ready();
    fireEvent.click(prepareButton());
    expect(
      await screen.findByText(
        'The mock design request did not finish. Retry to resume the same job.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(retryButton()).toBeEnabled());
    fireEvent.click(retryButton()!);
    await screen.findByText('Mock design prepared.');
    expect(keys[1]).toBe(keys[0]);
  });

  it('keeps the key after a network failure', async () => {
    const { keys } = renderWithApi([
      () => {
        throw new TypeError('Failed to fetch');
      },
      succeeded,
    ]);
    await ready();
    fireEvent.click(prepareButton());
    expect(await screen.findByText(/outcome is unknown/)).toBeInTheDocument();
    await waitFor(() => expect(retryButton()).toBeEnabled());
    fireEvent.click(retryButton()!);
    await screen.findByText('Mock design prepared.');
    expect(keys[1]).toBe(keys[0]);
  });

  it('treats a timeout as unknown, clears the busy state, and keeps the key', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hang: PostOutcome = (init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      });
    const { keys } = renderWithApi([hang, succeeded]);
    await ready();
    fireEvent.click(prepareButton());
    await act(async () => {
      vi.advanceTimersByTime(canvaRequestTimeoutMs);
    });
    expect(await screen.findByText(/outcome is unknown/)).toBeInTheDocument();
    await waitFor(() => expect(retryButton()).toBeEnabled());
    fireEvent.click(retryButton()!);
    await screen.findByText('Mock design prepared.');
    expect(keys[1]).toBe(keys[0]);
  });

  it('keeps the key and offers retry when the job is still QUEUED', async () => {
    const { keys } = renderWithApi([
      () => reply(200, canvaJob({ status: 'QUEUED' })),
      succeeded,
    ]);
    await ready();
    fireEvent.click(prepareButton());
    expect(
      await screen.findByText(/queued but not finished/),
    ).toBeInTheDocument();
    await waitFor(() => expect(retryButton()).toBeEnabled());
    fireEvent.click(retryButton()!);
    await screen.findByText('Mock design prepared.');
    expect(keys[1]).toBe(keys[0]);
  });

  it('treats SUCCEEDED as final and uses a new key for the next action', async () => {
    const { keys } = renderWithApi([succeeded, succeeded]);
    await ready();
    fireEvent.click(prepareButton());
    await screen.findByText('Mock design prepared.');
    expect(retryButton()).toBeNull();
    await waitFor(() => expect(prepareButton()).toBeEnabled());
    fireEvent.click(prepareButton());
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('treats FAILED as final, shows the safe error, and uses a new key next time', async () => {
    const { keys } = renderWithApi([
      () =>
        reply(
          201,
          canvaJob({
            status: 'FAILED',
            errorCode: 'PROVIDER_UNAVAILABLE',
            errorMessage: 'The provider could not prepare a design.',
          }),
        ),
      succeeded,
    ]);
    await ready();
    fireEvent.click(prepareButton());
    expect(
      await screen.findByText('The provider could not prepare a design.'),
    ).toBeInTheDocument();
    expect(retryButton()).toBeNull();
    await waitFor(() => expect(prepareButton()).toBeEnabled());
    fireEvent.click(prepareButton());
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('drops the retry key when the selected creative changes', async () => {
    const { keys, postBodies } = renderWithApi([unavailable, succeeded]);
    await ready();
    fireEvent.click(prepareButton());
    await waitFor(() => expect(retryButton()).toBeEnabled());
    fireEvent.change(screen.getByLabelText(/Prepare design from branch/), {
      target: { value: 'creative-2' },
    });
    expect(retryButton()).toBeNull();
    expect(prepareButton()).toBeEnabled();
    fireEvent.click(prepareButton());
    await screen.findByText('Mock design prepared.');
    expect(keys[1]).not.toBe(keys[0]);
    expect(postBodies[1]).toBe(JSON.stringify({ creativeId: 'creative-2' }));
  });

  it('shows the server message for a 409 without offering retry', async () => {
    const { keys } = renderWithApi([
      () =>
        reply(409, {
          statusCode: 409,
          message: 'Connect the mock Canva provider first',
        }),
      succeeded,
    ]);
    await ready();
    fireEvent.click(prepareButton());
    expect(
      await screen.findByText('Connect the mock Canva provider first'),
    ).toBeInTheDocument();
    expect(retryButton()).toBeNull();
    await waitFor(() => expect(prepareButton()).toBeEnabled());
    fireEvent.click(prepareButton());
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('refreshes the job list after a failed attempt', async () => {
    const { jobRequests } = renderWithApi([unavailable]);
    await ready();
    const before = jobRequests();
    fireEvent.click(prepareButton());
    await screen.findByText(/Retry to resume the same job/);
    await waitFor(() => expect(jobRequests()).toBe(before + 1));
  });

  it('keeps the attempt result and clears busy when the follow-up refresh fails', async () => {
    renderWithApi([unavailable], { failJobRefreshes: true });
    await ready();
    fireEvent.click(prepareButton());
    expect(
      await screen.findByText('Canva integration status is unavailable.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Retry to resume the same job/)).toBeVisible();
    await waitFor(() => expect(retryButton()).toBeEnabled());
  });

  it('labels job rows with plain-language status and known creative names', async () => {
    renderWithApi([], {
      jobs: [
        canvaJob({ id: 'job-q', status: 'QUEUED' }),
        canvaJob({
          id: 'job-s',
          creativeId: 'creative-2',
          externalDesignId: 'mock-design-revision-2',
        }),
        canvaJob({
          id: 'job-f',
          creativeId: 'creative-elsewhere',
          status: 'FAILED',
          errorMessage: 'The provider could not prepare a design.',
        }),
      ],
    });
    await ready();
    const rows = within(screen.getByRole('list', { name: 'Canva mock jobs' }));
    const items = rows.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Queued · not finished');
    expect(items[0]).toHaveTextContent('North offer');
    expect(items[0]).toHaveTextContent(/did not finish/);
    expect(items[1]).toHaveTextContent('Prepared');
    expect(items[1]).toHaveTextContent('South offer');
    expect(items[1]).toHaveTextContent('mock-design-revision-2');
    expect(items[2]).toHaveTextContent('Failed');
    expect(items[2]).not.toHaveTextContent(/offer/);
    expect(items[0].querySelector('time')).toHaveAttribute(
      'dateTime',
      '2026-10-25T07:00:00.000Z',
    );
  });

  it('renders nothing for a user without Canva permissions', () => {
    render(
      <CanvaIntegration
        session={{ accessToken: 'token', user: { ...user, permissions: [] } }}
        branch={branch}
        onUnauthorized={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole('heading', { name: /Canva integration foundation/i }),
    ).toBeNull();
  });
});

describe('CanvaIntegration retry key lifetime', () => {
  const creativeSelect = () =>
    screen.getByLabelText(/Prepare design from branch/) as HTMLSelectElement;
  const failed = () =>
    reply(
      201,
      canvaJob({
        status: 'FAILED',
        errorCode: 'PROVIDER_UNAVAILABLE',
        errorMessage: 'The provider could not prepare a design.',
      }),
    );

  it('reuses the same key across repeated retries until the job is final', async () => {
    const { keys } = renderWithApi([unavailable, unavailable, succeeded]);
    await ready();
    fireEvent.click(prepareButton());
    await waitFor(() => expect(retryButton()).toBeEnabled());
    fireEvent.click(retryButton()!);
    await screen.findByText(/Retry to resume the same job/);
    await waitFor(() => expect(retryButton()).toBeEnabled());
    fireEvent.click(retryButton()!);
    await screen.findByText('Mock design prepared.');
    expect(keys).toEqual([keys[0], keys[0], keys[0]]);
    expect(retryButton()).toBeNull();
  });

  it('drops the key when a retry ends FAILED and uses a new key next', async () => {
    const { keys } = renderWithApi([unavailable, failed, succeeded]);
    await ready();
    fireEvent.click(prepareButton());
    await waitFor(() => expect(retryButton()).toBeEnabled());
    fireEvent.click(retryButton()!);
    await screen.findByText('The provider could not prepare a design.');
    expect(retryButton()).toBeNull();
    await waitFor(() => expect(prepareButton()).toBeEnabled());
    fireEvent.click(prepareButton());
    await waitFor(() => expect(keys).toHaveLength(3));
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('drops the key when the server rejects a retry with a 4xx', async () => {
    renderWithApi([
      unavailable,
      () => reply(409, { message: 'Idempotency key already used' }),
    ]);
    await ready();
    fireEvent.click(prepareButton());
    await waitFor(() => expect(retryButton()).toBeEnabled());
    fireEvent.click(retryButton()!);
    await screen.findByText('Idempotency key already used');
    expect(retryButton()).toBeNull();
  });

  it('keeps the key in memory only and never writes it to web storage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { keys } = renderWithApi([unavailable]);
    await ready();
    fireEvent.click(prepareButton());
    await waitFor(() => expect(retryButton()).toBeEnabled());
    expect(setItem).not.toHaveBeenCalled();
    for (const store of [window.sessionStorage, window.localStorage])
      for (let index = 0; index < store.length; index += 1)
        expect(store.getItem(store.key(index)!)).not.toContain(keys[0]);
  });

  it('does not restore a retry after the page reloads', async () => {
    const api = renderWithApi([unavailable, succeeded]);
    await ready();
    fireEvent.click(prepareButton());
    await waitFor(() => expect(retryButton()).toBeEnabled());
    api.reload();
    await ready();
    await waitFor(() => expect(prepareButton()).toBeEnabled());
    expect(retryButton()).toBeNull();
    fireEvent.click(prepareButton());
    await screen.findByText('Mock design prepared.');
    expect(api.keys[1]).not.toBe(api.keys[0]);
  });

  it('keeps the pending retry when switching back to its branch', async () => {
    const api = renderWithApi([unavailable, succeeded]);
    await ready();
    fireEvent.change(creativeSelect(), { target: { value: 'creative-2' } });
    fireEvent.click(prepareButton());
    await waitFor(() => expect(retryButton()).toBeEnabled());
    api.switchBranch(southBranch);
    await screen.findByRole('option', { name: 'South branch offer' });
    expect(retryButton()).toBeNull();
    api.switchBranch(branch);
    await waitFor(() => expect(creativeSelect().value).toBe('creative-2'));
    await waitFor(() => expect(retryButton()).toBeEnabled());
    fireEvent.click(retryButton()!);
    await screen.findByText('Mock design prepared.');
    expect(api.keys[1]).toBe(api.keys[0]);
    expect(api.postBodies[1]).toBe(
      JSON.stringify({ creativeId: 'creative-2' }),
    );
  });

  it.each([
    [
      'a network failure',
      () => {
        throw new TypeError('Failed to fetch');
      },
    ],
    ['a QUEUED job', () => reply(200, canvaJob({ status: 'QUEUED' }))],
    ['a 409', () => reply(409, { message: 'Rejected' })],
  ])('refreshes the job list after %s', async (_case, outcome) => {
    const { jobRequests } = renderWithApi([outcome]);
    await ready();
    const before = jobRequests();
    fireEvent.click(prepareButton());
    await waitFor(() => expect(jobRequests()).toBe(before + 1));
  });
});

describe('CanvaIntegration branch changes', () => {
  it('clears the previous branch creative and never submits it after switching', async () => {
    let openSouth!: () => void;
    const southGate = new Promise<void>((resolve) => {
      openSouth = resolve;
    });
    const api = renderWithApi([succeeded], { southGate });
    await ready();
    api.switchBranch(southBranch);
    // While the new branch loads, the old creative is gone and nothing can be
    // prepared.
    await waitFor(() =>
      expect(screen.queryByRole('option', { name: 'North offer' })).toBeNull(),
    );
    expect(prepareButton()).toBeDisabled();
    openSouth();
    await screen.findByRole('option', { name: 'South branch offer' });
    await waitFor(() => expect(prepareButton()).toBeEnabled());
    fireEvent.click(prepareButton());
    await screen.findByText('Mock design prepared.');
    expect(api.postBodies).toEqual([
      JSON.stringify({ creativeId: 'creative-9' }),
    ]);
  });
});
