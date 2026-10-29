import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type {
  AuthenticatedUserResponse,
  CanvaIntegrationStatus,
  CanvaPendingCandidate,
} from '@adflow/shared-types';
import CanvaIntegration from './CanvaIntegration';

// Real Canva mode in the web panel, with fetch mocked per route. The API
// makes every decision; these tests check what the panel shows and sends.

const admin: AuthenticatedUserResponse = {
  id: 'user-1',
  organizationId: 'org-1',
  name: 'Asha Admin',
  email: 'admin@example.local',
  permissions: [
    'canva:integration:read',
    'canva:integration:manage',
    'canva:jobs:create',
  ],
  branches: [],
};
const reader: AuthenticatedUserResponse = {
  ...admin,
  id: 'user-3',
  permissions: ['canva:integration:read'],
};

const launchUrl =
  'http://127.0.0.1:3000/api/v1/integrations/canva/oauth/launch';
const launchToken = 'L'.repeat(43);

function realStatus(
  overrides: Partial<CanvaIntegrationStatus> = {},
  canva: Partial<NonNullable<CanvaIntegrationStatus['canva']>> = {},
): CanvaIntegrationStatus {
  return {
    provider: 'CANVA',
    mode: 'CANVA',
    status: 'DISCONNECTED',
    connectedAt: null,
    accountLabel: null,
    isRealConnection: false,
    canva: {
      reauthorizationRequired: false,
      reauthorizationReason: null,
      configurationError: false,
      pendingRevocations: 0,
      exhaustedRevocations: 0,
      ...canva,
    },
    ...overrides,
  };
}

function pendingCandidate(
  overrides: Partial<CanvaPendingCandidate> = {},
): CanvaPendingCandidate {
  return {
    id: 'candidate-1',
    canvaDisplayName: 'Brand Studio',
    canvaUserId: '…lpha01',
    canvaTeamId: '…Beta02',
    scopes: {
      reported: true,
      granted: ['brandtemplate:meta:read', 'profile:read'],
      required: ['brandtemplate:meta:read', 'profile:read'],
      missing: [],
    },
    capabilities: { autofill: true, brandTemplate: true },
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
    warnings: [],
    ...overrides,
  };
}

type Reply = { status: number; body?: unknown };
type Route = (init: RequestInit) => Reply;

function reply({ status, body }: Reply) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    },
  };
}

let routes: Record<string, Route>;
const calls: Array<{ key: string; init: RequestInit }> = [];

function serve(overrides: Record<string, Route | Reply> = {}) {
  routes = {
    'GET /integrations/canva/status': () => ({
      status: 200,
      body: realStatus(),
    }),
    'GET /integrations/canva/jobs': () => ({ status: 200, body: [] }),
    'GET /integrations/canva/oauth/candidate': () => ({
      status: 404,
      body: {},
    }),
    'GET /integrations/canva/revocations': () => ({ status: 200, body: [] }),
  };
  for (const [key, route] of Object.entries(overrides))
    routes[key] = typeof route === 'function' ? route : () => route;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const path = new URL(input).pathname.replace(/^\/api\/v1/, '');
      const key = `${init.method ?? 'GET'} ${path}`;
      calls.push({ key, init });
      const route = routes[key];
      if (!route) throw new Error(`Unexpected request ${key}`);
      return reply(route(init));
    }),
  );
}

const callsTo = (key: string) => calls.filter((call) => call.key === key);
const bodyOf = (call: { init: RequestInit }) =>
  JSON.parse(String(call.init.body));

function renderPanel(
  user: AuthenticatedUserResponse = admin,
  onUnauthorized = vi.fn(),
) {
  render(
    <CanvaIntegration
      session={{ accessToken: 'session-access-token', user }}
      branch={null}
      onUnauthorized={onUnauthorized}
    />,
  );
  return { onUnauthorized };
}

beforeEach(() => {
  calls.length = 0;
  window.history.replaceState(null, '', '/#canva-integration');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('CanvaIntegration in real Canva mode: connecting', () => {
  it('labels real mode and hides the mock controls', async () => {
    serve();
    renderPanel();
    expect(await screen.findByText('REAL CANVA MODE')).toBeInTheDocument();
    expect(await screen.findByText('Canva not connected')).toBeInTheDocument();
    expect(screen.queryByText('Connect mock provider')).toBeNull();
    expect(screen.queryByText('Prepare mock design')).toBeNull();
    expect(
      screen.getByText(
        'Design preparation with real Canva is not available yet.',
      ),
    ).toBeInTheDocument();
  });

  it('posts the one-time launch token in a top-level form, never storing or showing it', async () => {
    serve({
      'POST /integrations/canva/oauth/authorize': {
        status: 200,
        body: { launchUrl, launchToken, expiresAt: new Date().toISOString() },
      },
    });
    const submitted: HTMLFormElement[] = [];
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (
      this: HTMLFormElement,
    ) {
      submitted.push(this);
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    renderPanel();
    fireEvent.click(await screen.findByText('Connect Canva account'));
    await waitFor(() => expect(submitted).toHaveLength(1));
    const [form] = submitted;
    expect(form.method).toBe('post');
    expect(form.action).toBe(launchUrl);
    expect(
      (form.elements.namedItem('launch_token') as HTMLInputElement).value,
    ).toBe(launchToken);
    expect(
      callsTo('POST /integrations/canva/oauth/authorize')[0].init.body,
    ).toBeUndefined();
    expect(setItem).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(launchToken);
    expect(window.location.href).not.toContain(launchToken);
  });

  it('refuses a launch URL that is not the API launch endpoint', async () => {
    for (const url of [
      'javascript:alert(1)',
      'http://api.example.com/api/v1/integrations/canva/oauth/launch',
      'https://api.example.com/api/v1/integrations/canva/oauth/launch?next=x',
      'https://api.example.com/somewhere-else',
      'not a url',
      '/api/v1/integrations/canva/oauth/launch',
      'http://localhost:3000/api/v1/integrations/canva/oauth/launch',
      'https://user:pass@api.example.com/api/v1/integrations/canva/oauth/launch',
      'https://api.example.com/api/v1/integrations/canva/oauth/launch#x',
      'data:text/html,<form>',
    ]) {
      cleanup();
      serve({
        'POST /integrations/canva/oauth/authorize': {
          status: 200,
          body: { launchUrl: url, launchToken, expiresAt: '' },
        },
      });
      const submit = vi
        .spyOn(HTMLFormElement.prototype, 'submit')
        .mockImplementation(() => undefined);
      renderPanel();
      fireEvent.click(await screen.findByText('Connect Canva account'));
      expect(
        await screen.findByText('Canva authorization could not be started.'),
      ).toBeInTheDocument();
      expect(submit).not.toHaveBeenCalled();
    }
  });

  it('shows the server message when real connection is unavailable', async () => {
    serve({
      'GET /integrations/canva/oauth/candidate': {
        status: 503,
        body: { message: 'Real Canva connection is not available yet' },
      },
      'POST /integrations/canva/oauth/authorize': {
        status: 503,
        body: { message: 'Real Canva connection is not available yet' },
      },
    });
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit');
    renderPanel();
    expect(
      await screen.findByText('Real Canva connection is not available yet'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText('Connect Canva account'));
    await waitFor(() =>
      expect(callsTo('POST /integrations/canva/oauth/authorize')).toHaveLength(
        1,
      ),
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it('shows a fixed message for the callback outcome and removes it from the URL', async () => {
    window.history.replaceState(
      null,
      '',
      '/?canva=account_ineligible#canva-integration',
    );
    serve();
    renderPanel();
    expect(
      await screen.findByText(
        'This Canva account does not have the Autofill and brand template features AdFlow needs.',
      ),
    ).toBeInTheDocument();
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#canva-integration');
  });

  it('ignores an unknown callback value instead of reflecting it', async () => {
    window.history.replaceState(
      null,
      '',
      '/?canva=%3Cb%3Eyou%20won%3C%2Fb%3E#canva-integration',
    );
    serve();
    renderPanel();
    await screen.findByText('Canva not connected');
    expect(document.body.textContent).not.toContain('you won');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('signs out on a 401', async () => {
    serve({ 'GET /integrations/canva/oauth/candidate': { status: 401 } });
    const { onUnauthorized } = renderPanel();
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
  });
});

describe('CanvaIntegration in real Canva mode: confirming the account', () => {
  it('shows the pending identity, scopes, capabilities, and expiry, with the name as text only', async () => {
    serve({
      'GET /integrations/canva/oauth/candidate': {
        status: 200,
        body: pendingCandidate({
          canvaDisplayName: '<img src=x onerror="alert(1)">',
        }),
      },
    });
    renderPanel();
    const section = await screen.findByRole('region', {
      name: 'Confirm the Canva account',
    });
    expect(
      within(section).getByText('<img src=x onerror="alert(1)">'),
    ).toBeInTheDocument();
    expect(section.querySelector('img')).toBeNull();
    expect(within(section).getByText('…lpha01')).toBeInTheDocument();
    expect(within(section).getByText('…Beta02')).toBeInTheDocument();
    expect(
      within(section).getByText('profile:read: granted'),
    ).toBeInTheDocument();
    expect(within(section).getAllByText('Available')).toHaveLength(2);
    expect(within(section).getByRole('timer')).toHaveTextContent(
      /^Expires in \d+:\d\d$/,
    );
    // While a candidate is pending, a new authorization cannot be started.
    expect(screen.queryByText('Connect Canva account')).toBeNull();
  });

  it('requires every warning to be acknowledged and sends the acknowledgements', async () => {
    let connected = false;
    serve({
      'GET /integrations/canva/status': () => ({
        status: 200,
        body: connected
          ? realStatus({ status: 'CONNECTED', isRealConnection: true })
          : realStatus(),
      }),
      'GET /integrations/canva/oauth/candidate': {
        status: 200,
        body: pendingCandidate({
          canvaDisplayName: null,
          warnings: ['differentAccount', 'missingDisplayName'],
        }),
      },
      'POST /integrations/canva/oauth/candidate/confirm': () => {
        connected = true;
        return {
          status: 200,
          body: {
            status: 'CONNECTED',
            replacedPrevious: true,
            sameCanvaUser: false,
          },
        };
      },
    });
    renderPanel();
    const confirm = await screen.findByText('Connect this Canva account');
    expect(
      screen.getByText('No display name reported by Canva'),
    ).toBeInTheDocument();
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/different Canva account/));
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/did not report a display name/));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(
      await screen.findByText('Canva account connected.'),
    ).toBeInTheDocument();
    expect(
      bodyOf(callsTo('POST /integrations/canva/oauth/candidate/confirm')[0]),
    ).toEqual({
      candidateId: 'candidate-1',
      acknowledgements: { differentAccount: true, missingDisplayName: true },
    });
    expect(
      await screen.findByText('Canva provider connected'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Confirm the Canva account' }),
    ).toBeNull();
  });

  it('keeps the candidate after a 400 or 503 and shows the server message', async () => {
    let answer: Reply = {
      status: 400,
      body: {
        message: 'Confirm each warning before connecting this Canva account',
      },
    };
    serve({
      'GET /integrations/canva/oauth/candidate': {
        status: 200,
        body: pendingCandidate(),
      },
      'POST /integrations/canva/oauth/candidate/confirm': () => answer,
    });
    renderPanel();
    fireEvent.click(await screen.findByText('Connect this Canva account'));
    expect(
      await screen.findByText(
        'Confirm each warning before connecting this Canva account',
      ),
    ).toBeInTheDocument();
    answer = {
      status: 503,
      body: { message: 'The Canva change was not saved; try again' },
    };
    fireEvent.click(screen.getByText('Connect this Canva account'));
    expect(
      await screen.findByText('The Canva change was not saved; try again'),
    ).toBeInTheDocument();
    expect(screen.getByText('Connect this Canva account')).toBeEnabled();
  });

  it('ends the candidate on a 404 (expired) and on a 409 (connection changed)', async () => {
    serve({
      'GET /integrations/canva/oauth/candidate': {
        status: 200,
        body: pendingCandidate(),
      },
      'POST /integrations/canva/oauth/candidate/confirm': {
        status: 404,
        body: { message: 'No Canva account to confirm' },
      },
    });
    renderPanel();
    fireEvent.click(await screen.findByText('Connect this Canva account'));
    expect(
      await screen.findByText(
        'This Canva authorization expired or is no longer available. Start again.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Connect Canva account')).toBeInTheDocument();

    cleanup();
    serve({
      'GET /integrations/canva/oauth/candidate': {
        status: 200,
        body: pendingCandidate(),
      },
      'POST /integrations/canva/oauth/candidate/confirm': {
        status: 409,
        body: {
          message:
            'The Canva connection changed while this authorization was pending; start again',
        },
      },
    });
    renderPanel();
    fireEvent.click(await screen.findByText('Connect this Canva account'));
    expect(
      await screen.findByText(
        'The Canva connection changed while this authorization was pending; start again',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Confirm the Canva account' }),
    ).toBeNull();
  });

  it('disables confirmation once the candidate has expired', async () => {
    serve({
      'GET /integrations/canva/oauth/candidate': {
        status: 200,
        body: pendingCandidate({
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
        }),
      },
    });
    renderPanel();
    expect(
      await screen.findByText('This authorization has expired. Start again.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Connect this Canva account')).toBeDisabled();
    expect(screen.getByText('Reject')).toBeEnabled();
  });

  it('refuses to confirm an account with a missing capability or permission', async () => {
    serve({
      'GET /integrations/canva/oauth/candidate': {
        status: 200,
        body: pendingCandidate({
          capabilities: { autofill: false, brandTemplate: true },
          scopes: {
            reported: true,
            granted: ['profile:read'],
            required: ['brandtemplate:meta:read', 'profile:read'],
            missing: ['brandtemplate:meta:read'],
          },
        }),
      },
    });
    renderPanel();
    expect(
      await screen.findByText(/a required feature or permission is missing/),
    ).toBeInTheDocument();
    expect(screen.getByText('Missing')).toBeInTheDocument();
    expect(
      screen.getByText('brandtemplate:meta:read: not granted'),
    ).toBeInTheDocument();
    expect(screen.getByText('Connect this Canva account')).toBeDisabled();
  });

  it('rejects a candidate explicitly', async () => {
    serve({
      'GET /integrations/canva/oauth/candidate': {
        status: 200,
        body: pendingCandidate(),
      },
      'POST /integrations/canva/oauth/candidate/reject': {
        status: 200,
        body: { rejected: true },
      },
    });
    renderPanel();
    fireEvent.click(await screen.findByText('Reject'));
    expect(
      await screen.findByText(
        'Canva account rejected. Its access is queued for revocation.',
      ),
    ).toBeInTheDocument();
    expect(
      bodyOf(callsTo('POST /integrations/canva/oauth/candidate/reject')[0]),
    ).toEqual({ candidateId: 'candidate-1' });
  });

  it('never asks for the candidate without the management permission', async () => {
    serve();
    renderPanel(reader);
    await screen.findByText('Canva not connected');
    expect(callsTo('GET /integrations/canva/oauth/candidate')).toHaveLength(0);
    expect(screen.queryByText('Connect Canva account')).toBeNull();
  });
});

describe('CanvaIntegration in real Canva mode: connection health', () => {
  it('disconnects only after a second confirmation and reports the revocation as queued', async () => {
    let connected = true;
    serve({
      'GET /integrations/canva/status': () => ({
        status: 200,
        body: connected
          ? realStatus({ status: 'CONNECTED', isRealConnection: true })
          : realStatus(),
      }),
      'POST /integrations/canva/disconnect': () => {
        connected = false;
        return {
          status: 201,
          body: { ...realStatus(), revocation: 'queued' },
        };
      },
    });
    renderPanel();
    fireEvent.click(await screen.findByText('Disconnect Canva'));
    expect(callsTo('POST /integrations/canva/disconnect')).toHaveLength(0);
    fireEvent.click(screen.getByText('Confirm disconnect'));
    expect(
      await screen.findByText(
        'Canva disconnected. Its access is queued for revocation and has not been revoked yet.',
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText('Canva not connected')).toBeInTheDocument();
  });

  it('explains a required reconnection, a configuration error, and queued revocations', async () => {
    serve({
      'GET /integrations/canva/status': {
        status: 200,
        body: realStatus(
          {},
          {
            reauthorizationRequired: true,
            reauthorizationReason: 'rotation_lost',
            configurationError: true,
            pendingRevocations: 2,
          },
        ),
      },
    });
    renderPanel();
    expect(
      await screen.findByText(
        /Canva must be reconnected\. A token refresh could not be saved\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/rejected AdFlow's app configuration/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/2 Canva authorizations are queued for revocation/),
    ).toBeInTheDocument();
    expect(screen.getByText('Reconnect Canva account')).toBeInTheDocument();
  });

  it('lists exhausted revocations and retries or dismisses them', async () => {
    let exhausted = 1;
    serve({
      'GET /integrations/canva/status': () => ({
        status: 200,
        body: realStatus({}, { exhaustedRevocations: exhausted }),
      }),
      'GET /integrations/canva/revocations': () => ({
        status: 200,
        body: exhausted
          ? [
              {
                id: 'revocation-7',
                reason: 'disconnect',
                attempts: 8,
                lastErrorKind: 'transient',
                createdAt: '2026-10-20T10:00:00.000Z',
                exhaustedAt: '2026-10-21T10:00:00.000Z',
              },
            ]
          : [],
      }),
      'POST /integrations/canva/revocations/revocation-7/retry': () => {
        exhausted = 0;
        return { status: 200, body: { state: 'queued' } };
      },
    });
    renderPanel();
    const list = await screen.findByRole('list', {
      name: 'Exhausted Canva revocations',
    });
    expect(
      within(list).getByText(/Disconnected account · 8 attempts/),
    ).toBeInTheDocument();
    fireEvent.click(within(list).getByText('Retry'));
    expect(
      await screen.findByText('Revocation queued again.'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole('list', { name: 'Exhausted Canva revocations' }),
      ).toBeNull(),
    );
  });
});
