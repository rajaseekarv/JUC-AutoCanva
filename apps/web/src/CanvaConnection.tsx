import { useCallback, useEffect, useState } from 'react';
import type {
  AuthenticatedUserResponse,
  CanvaAuthorizationStart,
  CanvaCandidateWarning,
  CanvaExhaustedRevocation,
  CanvaIntegrationStatus,
  CanvaOAuthOutcome,
  CanvaPendingCandidate,
} from '@adflow/shared-types';

const apiBase =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000/api/v1';
type Session = { accessToken: string; user: AuthenticatedUserResponse };
type Notice = { tone: 'error' | 'info'; text: string };

export const CANVA_LAUNCH_PATH = '/api/v1/integrations/canva/oauth/launch';

// The callback reports one of these fixed values in ?canva=. Anything else
// in the URL is ignored, so no URL text is ever shown to the user.
const canvaOutcomeMessages: Record<CanvaOAuthOutcome, Notice> = {
  pending_confirmation: {
    tone: 'info',
    text: 'Review the Canva account below and confirm it to finish connecting.',
  },
  connected: { tone: 'info', text: 'Canva account connected.' },
  denied: { tone: 'error', text: 'Canva access was not granted.' },
  invalid_request: {
    tone: 'error',
    text: 'The response from Canva was not valid. Start again.',
  },
  expired_or_used: {
    tone: 'error',
    text: 'This Canva authorization expired or was already used. Start again.',
  },
  not_authorized: {
    tone: 'error',
    text: 'You no longer have permission to connect Canva.',
  },
  conflict: {
    tone: 'error',
    text: 'Another Canva authorization is already waiting for confirmation in this organization.',
  },
  account_unavailable: {
    tone: 'error',
    text: 'This Canva account cannot be connected to this organization.',
  },
  account_ineligible: {
    tone: 'error',
    text: 'This Canva account does not have the Autofill and brand template features AdFlow needs.',
  },
  insufficient_scope: {
    tone: 'error',
    text: 'Canva did not grant every permission AdFlow needs. Start again and allow all requested permissions.',
  },
  retry_connect: {
    tone: 'error',
    text: 'The Canva connection could not be completed. Try again in a few minutes.',
  },
  unavailable: {
    tone: 'error',
    text: 'Canva connection is temporarily unavailable. Try again later.',
  },
  disabled: { tone: 'error', text: 'Real Canva connection is disabled.' },
  failed: {
    tone: 'error',
    text: 'The Canva connection could not be completed.',
  },
};

const warningLabels: Record<CanvaCandidateWarning, string> = {
  differentAccount:
    'This is a different Canva account from the one currently connected. Connecting it replaces the current connection.',
  missingDisplayName:
    'Canva did not report a display name. I have checked the account IDs above.',
  scopesNotReported:
    'Canva did not report which permissions were granted. I accept connecting without that confirmation.',
};

const reauthorizationReasons: Record<string, string> = {
  invalid_grant: 'Canva no longer accepts the stored authorization.',
  undecryptable: 'The stored authorization can no longer be decrypted.',
  rotation_lost: 'A token refresh could not be saved.',
  identity_mismatch: 'The Canva account behind the authorization changed.',
};

const revocationReasons: Record<string, string> = {
  disconnect: 'Disconnected account',
  replaced_other_user: 'Replaced account',
  candidate_rejected: 'Rejected account',
  candidate_expired: 'Unconfirmed account',
  candidate_superseded: 'Superseded account',
  connect_conflict: 'Conflicting authorization',
  connect_failed: 'Failed authorization',
  connect_ineligible: 'Ineligible account',
  orphaned_rotation: 'Replaced token',
};

function isOutcome(value: string | null): value is CanvaOAuthOutcome {
  return value !== null && Object.hasOwn(canvaOutcomeMessages, value);
}

function callbackOutcome(): CanvaOAuthOutcome | null {
  const value = new URL(window.location.href).searchParams.get('canva');
  return isOutcome(value) ? value : null;
}

// Removes ?canva= (keeping the hash), so a reload does not repeat the notice.
function clearCallbackOutcome(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('canva')) return;
  url.searchParams.delete('canva');
  window.history.replaceState(window.history.state, '', url.toString());
}

// The launch URL comes from the authenticated API response, which derives
// it from the server-validated CANVA_REDIRECT_URI (allowlisted origins).
// Its host may differ from VITE_API_BASE_URL (for example 127.0.0.1 versus
// localhost), so the host is NOT checked here; the server's allowlist is
// the control. This check is defense in depth only: it follows nothing but
// https (or http on 127.0.0.1 or [::1], the only http hosts the server
// accepts) with exactly the launch path and no query, fragment, or
// credentials, so a malformed or script URL is never submitted.
function launchTarget(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const secure =
      url.protocol === 'https:' ||
      (url.protocol === 'http:' &&
        ['127.0.0.1', '[::1]'].includes(url.hostname));
    return secure &&
      url.pathname === CANVA_LAUNCH_PATH &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

// A top-level form POST, so the browser navigates to the API host and the
// binding cookie is set there. The one-time launch token goes in the body,
// never in a URL or in web storage.
function submitCanvaLaunch(launchUrl: string, launchToken: string) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = launchUrl;
  form.style.display = 'none';
  const field = document.createElement('input');
  field.type = 'hidden';
  field.name = 'launch_token';
  field.value = launchToken;
  form.append(field);
  document.body.append(form);
  form.submit();
}

async function serverMessage(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string' && body.message) return body.message;
  } catch {
    // Not JSON: use the fallback.
  }
  return fallback;
}

function remaining(expiresAt: string, now: number): number {
  return Math.max(0, Date.parse(expiresAt) - now);
}

function formatCountdown(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

// Real Canva mode only. Every decision is made by the API: this component
// shows what it returns and sends the administrator's explicit choices.
export default function CanvaConnection({
  session,
  status,
  canManage,
  onUnauthorized,
  onChanged,
}: {
  session: Session;
  status: CanvaIntegrationStatus;
  canManage: boolean;
  onUnauthorized: () => void;
  onChanged: () => Promise<void>;
}) {
  const [notice, setNotice] = useState<Notice | null>(() => {
    const outcome = callbackOutcome();
    return outcome ? canvaOutcomeMessages[outcome] : null;
  });
  const [candidate, setCandidate] = useState<CanvaPendingCandidate | null>(
    null,
  );
  const [acknowledged, setAcknowledged] = useState<
    Partial<Record<CanvaCandidateWarning, boolean>>
  >({});
  const [revocations, setRevocations] = useState<CanvaExhaustedRevocation[]>(
    [],
  );
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const authorization = { Authorization: `Bearer ${session.accessToken}` };
  const details = status.canva;
  const exhaustedCount = details?.exhaustedRevocations ?? 0;

  const loadCandidate = useCallback(async () => {
    if (!canManage) return;
    try {
      const response = await fetch(
        `${apiBase}/integrations/canva/oauth/candidate`,
        {
          headers: { Authorization: `Bearer ${session.accessToken}` },
        },
      );
      if (response.status === 401) return onUnauthorized();
      if (response.status === 404) {
        setCandidate(null);
        return;
      }
      if (!response.ok) {
        setCandidate(null);
        // 503 while durable storage is off: real connection not available.
        setNotice({
          tone: 'error',
          text: await serverMessage(
            response,
            'The pending Canva account could not be loaded.',
          ),
        });
        return;
      }
      setCandidate((await response.json()) as CanvaPendingCandidate);
      setAcknowledged({});
    } catch {
      setNotice({
        tone: 'error',
        text: 'The pending Canva account could not be loaded.',
      });
    }
  }, [canManage, session.accessToken, onUnauthorized]);

  const loadRevocations = useCallback(async () => {
    if (!canManage || !exhaustedCount) {
      setRevocations([]);
      return;
    }
    try {
      const response = await fetch(
        `${apiBase}/integrations/canva/revocations`,
        {
          headers: { Authorization: `Bearer ${session.accessToken}` },
        },
      );
      if (response.status === 401) return onUnauthorized();
      if (response.ok)
        setRevocations((await response.json()) as CanvaExhaustedRevocation[]);
    } catch {
      // The count in the status still shows that something needs attention.
    }
  }, [canManage, exhaustedCount, session.accessToken, onUnauthorized]);

  useEffect(() => {
    clearCallbackOutcome();
  }, []);

  useEffect(() => {
    void loadCandidate();
  }, [loadCandidate]);

  useEffect(() => {
    void loadRevocations();
  }, [loadRevocations]);

  // The countdown runs only while a candidate is shown.
  useEffect(() => {
    if (!candidate) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [candidate]);

  // Runs one administrator action; the response handler returns the notice.
  async function runAction(
    path: string,
    body: unknown,
    handle: (response: Response) => Promise<Notice | null>,
  ) {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`${apiBase}/integrations/canva/${path}`, {
        method: 'POST',
        headers: {
          ...authorization,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      setNotice(await handle(response));
    } catch {
      setNotice({
        tone: 'error',
        text: 'The request did not complete. Reload to check the current state before trying again.',
      });
    } finally {
      setBusy(false);
    }
  }

  function connect() {
    void runAction('oauth/authorize', undefined, async (response) => {
      if (!response.ok)
        return {
          tone: 'error',
          text: await serverMessage(
            response,
            'Canva authorization could not be started.',
          ),
        };
      const started =
        (await response.json()) as Partial<CanvaAuthorizationStart>;
      const target = launchTarget(started.launchUrl);
      if (!target || typeof started.launchToken !== 'string')
        return {
          tone: 'error',
          text: 'Canva authorization could not be started.',
        };
      submitCanvaLaunch(target, started.launchToken);
      return { tone: 'info', text: 'Opening Canva…' };
    });
  }

  function confirm(current: CanvaPendingCandidate) {
    const acknowledgements = Object.fromEntries(
      current.warnings.map((warning) => [warning, !!acknowledged[warning]]),
    );
    void runAction(
      'oauth/candidate/confirm',
      { candidateId: current.id, acknowledgements },
      async (response) => {
        if (response.ok) {
          setCandidate(null);
          await onChanged();
          return { tone: 'info', text: 'Canva account connected.' };
        }
        const text = await serverMessage(
          response,
          'The Canva account could not be connected.',
        );
        // 400 (an acknowledgement is missing) and 5xx keep the candidate;
        // 404 (expired or gone) and 409 (the connection changed) end it.
        if (response.status === 404) {
          setCandidate(null);
          return {
            tone: 'error',
            text: 'This Canva authorization expired or is no longer available. Start again.',
          };
        }
        if (response.status === 409) {
          setCandidate(null);
          await onChanged();
        }
        return { tone: 'error', text };
      },
    );
  }

  function reject(current: CanvaPendingCandidate) {
    void runAction(
      'oauth/candidate/reject',
      { candidateId: current.id },
      async (response) => {
        if (response.ok || response.status === 404) {
          setCandidate(null);
          await onChanged();
          return response.ok
            ? {
                tone: 'info',
                text: 'Canva account rejected. Its access is queued for revocation.',
              }
            : {
                tone: 'error',
                text: 'This Canva authorization is no longer available.',
              };
        }
        return {
          tone: 'error',
          text: await serverMessage(
            response,
            'The Canva account could not be rejected.',
          ),
        };
      },
    );
  }

  function disconnect() {
    setConfirmingDisconnect(false);
    void runAction('disconnect', undefined, async (response) => {
      await onChanged();
      if (!response.ok)
        return {
          tone: 'error',
          text: await serverMessage(
            response,
            'Canva could not be disconnected.',
          ),
        };
      const result = (await response.json()) as CanvaIntegrationStatus;
      setCandidate(null);
      return {
        tone: 'info',
        text:
          result.revocation === 'queued'
            ? 'Canva disconnected. Its access is queued for revocation and has not been revoked yet.'
            : 'Canva disconnected.',
      };
    });
  }

  function revocationAction(id: string, action: 'retry' | 'dismiss') {
    void runAction(
      `revocations/${encodeURIComponent(id)}/${action}`,
      undefined,
      async (response) => {
        await onChanged();
        await loadRevocations();
        if (response.ok)
          return {
            tone: 'info',
            text:
              action === 'retry'
                ? 'Revocation queued again.'
                : 'Revocation dismissed. The stored token was deleted without being revoked.',
          };
        return {
          tone: 'error',
          text: await serverMessage(
            response,
            'The revocation could not be updated.',
          ),
        };
      },
    );
  }

  const connected = status.status === 'CONNECTED';
  const expiresIn = candidate ? remaining(candidate.expiresAt, now) : 0;
  const expired = candidate !== null && expiresIn === 0;
  const eligible =
    candidate !== null &&
    candidate.capabilities.autofill &&
    candidate.capabilities.brandTemplate &&
    candidate.scopes.missing.length === 0;
  const allAcknowledged =
    candidate?.warnings.every((warning) => acknowledged[warning]) ?? false;

  return (
    <div className="canva-connection">
      {details?.reauthorizationRequired && (
        <p role="alert" className="form-message">
          Canva must be reconnected.{' '}
          {reauthorizationReasons[details.reauthorizationReason ?? ''] ?? ''}
        </p>
      )}
      {details?.configurationError && (
        <p role="alert" className="form-message">
          Canva rejected AdFlow&apos;s app configuration. An administrator must
          check the Canva integration settings.
        </p>
      )}
      {!!details?.pendingRevocations && (
        <p>
          {details.pendingRevocations} Canva authorization
          {details.pendingRevocations === 1 ? ' is' : 's are'} queued for
          revocation.
        </p>
      )}

      {canManage && !candidate && (
        <div className="canva-connection-actions">
          <button disabled={busy} onClick={connect}>
            {connected || details?.reauthorizationRequired
              ? 'Reconnect Canva account'
              : 'Connect Canva account'}
          </button>
          {connected && !confirmingDisconnect && (
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => setConfirmingDisconnect(true)}
            >
              Disconnect Canva
            </button>
          )}
        </div>
      )}
      {canManage && confirmingDisconnect && (
        <div
          className="canva-connection-actions"
          role="group"
          aria-label="Confirm disconnection"
        >
          <p>
            Disconnecting removes the stored Canva authorization. Its access is
            queued for revocation at Canva.
          </p>
          <button
            className="danger-button"
            disabled={busy}
            onClick={disconnect}
          >
            Confirm disconnect
          </button>
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() => setConfirmingDisconnect(false)}
          >
            Cancel
          </button>
        </div>
      )}

      {canManage && candidate && (
        <section
          className="canva-candidate"
          aria-labelledby="canva-candidate-title"
        >
          <h3 id="canva-candidate-title">Confirm the Canva account</h3>
          {/* Untrusted text from Canva: rendered as text only. */}
          <p className="canva-candidate-name">
            {candidate.canvaDisplayName ?? 'No display name reported by Canva'}
          </p>
          <dl>
            <dt>Canva user</dt>
            <dd>{candidate.canvaUserId}</dd>
            <dt>Canva team</dt>
            <dd>{candidate.canvaTeamId}</dd>
            <dt>Started by</dt>
            <dd>
              You ({session.user.name}),{' '}
              <time dateTime={candidate.startedAt}>
                {formatTime(candidate.startedAt)}
              </time>
            </dd>
            <dt>Autofill</dt>
            <dd>{candidate.capabilities.autofill ? 'Available' : 'Missing'}</dd>
            <dt>Brand templates</dt>
            <dd>
              {candidate.capabilities.brandTemplate ? 'Available' : 'Missing'}
            </dd>
            <dt>Permissions</dt>
            <dd>
              {candidate.scopes.reported ? (
                <ul aria-label="Requested Canva permissions">
                  {candidate.scopes.required.map((scope) => (
                    <li key={scope}>
                      {scope}:{' '}
                      {candidate.scopes.missing.includes(scope)
                        ? 'not granted'
                        : 'granted'}
                    </li>
                  ))}
                </ul>
              ) : (
                'Not reported by Canva'
              )}
            </dd>
          </dl>
          <p role="timer" aria-live="off">
            {expired
              ? 'This authorization has expired. Start again.'
              : `Expires in ${formatCountdown(expiresIn)}`}
          </p>
          {!eligible && (
            <p role="alert" className="form-message">
              This Canva account cannot be connected: a required feature or
              permission is missing.
            </p>
          )}
          {candidate.warnings.map((warning) => (
            <label className="checkbox-label" key={warning}>
              <input
                type="checkbox"
                checked={!!acknowledged[warning]}
                disabled={busy || expired}
                onChange={(event) =>
                  setAcknowledged((current) => ({
                    ...current,
                    [warning]: event.target.checked,
                  }))
                }
              />
              {warningLabels[warning]}
            </label>
          ))}
          <div className="canva-connection-actions">
            <button
              disabled={busy || expired || !eligible || !allAcknowledged}
              onClick={() => confirm(candidate)}
            >
              Connect this Canva account
            </button>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => reject(candidate)}
            >
              Reject
            </button>
          </div>
        </section>
      )}

      {canManage && revocations.length > 0 && (
        <section aria-labelledby="canva-revocations-title">
          <h3 id="canva-revocations-title">Revocations that need attention</h3>
          <p>
            Canva did not confirm these revocations after every retry. Retry
            sends them again; Dismiss deletes the stored token without revoking
            it, and the Canva user can still remove AdFlow in Canva.
          </p>
          <ul aria-label="Exhausted Canva revocations">
            {revocations.map((revocation) => (
              <li key={revocation.id}>
                <span>
                  {revocationReasons[revocation.reason] ??
                    'Canva authorization'}{' '}
                  · {revocation.attempts} attempts · since{' '}
                  <time dateTime={revocation.exhaustedAt}>
                    {formatTime(revocation.exhaustedAt)}
                  </time>
                </span>
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => revocationAction(revocation.id, 'retry')}
                >
                  Retry
                </button>
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => revocationAction(revocation.id, 'dismiss')}
                >
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {notice && (
        <p
          role={notice.tone === 'error' ? 'alert' : 'status'}
          className={notice.tone === 'error' ? 'form-message' : undefined}
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}
