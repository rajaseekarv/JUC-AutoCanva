import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AuthenticatedUserResponse,
  BranchResponse,
  CanvaIntegrationStatus,
  CanvaJobResponse,
  CreativeResponse,
} from '@adflow/shared-types';
import CanvaConnection from './CanvaConnection';
import type { StatusTone } from './statusDisplay';

const apiBase =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000/api/v1';
type Session = { accessToken: string; user: AuthenticatedUserResponse };

export const canvaRequestTimeoutMs = 15_000;

// One prepare-design action. Its key is reused for every retry so the API
// resumes the same job. It lives in component memory only and is never
// written to web storage, so a page reload loses it.
type PrepareAttempt = { creativeId: string; key: string };
type AttemptNotice = { tone: 'error' | 'info'; text: string };

const jobStatusLabels: Record<CanvaJobResponse['status'], string> = {
  QUEUED: 'Queued · not finished',
  PROCESSING: 'Processing',
  SUCCEEDED: 'Prepared',
  FAILED: 'Failed',
};
const jobStatusTones: Record<CanvaJobResponse['status'], StatusTone> = {
  QUEUED: 'warning',
  PROCESSING: 'info',
  SUCCEEDED: 'success',
  FAILED: 'danger',
};

function newIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `web-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function fetchWithTimeout(input: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), canvaRequestTimeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function serverMessage(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string' && body.message) return body.message;
    if (Array.isArray(body.message) && body.message.length)
      return body.message.join(' ');
  } catch {
    // Fall through to the generic message when the body is not JSON.
  }
  return fallback;
}

function formatTimestamp(value: string): string | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toLocaleString();
}

export default function CanvaIntegration({
  session,
  branch,
  onUnauthorized,
}: {
  session: Session;
  branch: BranchResponse | null;
  onUnauthorized: () => void;
}) {
  const permissions = session.user.permissions;
  const canRead = permissions.includes('canva:integration:read');
  const canManage = permissions.includes('canva:integration:manage');
  const canCreateJob = permissions.includes('canva:jobs:create');
  const [status, setStatus] = useState<CanvaIntegrationStatus | null>(null);
  const [jobs, setJobs] = useState<CanvaJobResponse[]>([]);
  const [creatives, setCreatives] = useState<CreativeResponse[]>([]);
  const [creativeId, setCreativeId] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState<PrepareAttempt | null>(null);
  // Read by the creatives loader without making it reload on every attempt.
  const attemptRef = useRef<PrepareAttempt | null>(null);
  const [notice, setNotice] = useState<AttemptNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const branchId = branch?.id;

  const refresh = useCallback(async () => {
    if (!canRead) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [statusResponse, jobsResponse] = await Promise.all([
        fetchWithTimeout(`${apiBase}/integrations/canva/status`, {
          headers: { Authorization: `Bearer ${session.accessToken}` },
        }),
        fetchWithTimeout(`${apiBase}/integrations/canva/jobs`, {
          headers: { Authorization: `Bearer ${session.accessToken}` },
        }),
      ]);
      if (statusResponse.status === 401 || jobsResponse.status === 401) {
        onUnauthorized();
        return;
      }
      if (!statusResponse.ok || !jobsResponse.ok)
        throw new Error('Canva integration status is unavailable.');
      setStatus((await statusResponse.json()) as CanvaIntegrationStatus);
      setJobs((await jobsResponse.json()) as CanvaJobResponse[]);
      setError('');
    } catch (cause) {
      setError(
        cause instanceof Error && cause.name !== 'AbortError'
          ? cause.message
          : 'Canva integration status is unavailable.',
      );
    } finally {
      setLoading(false);
    }
  }, [canRead, session.accessToken, onUnauthorized]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    // A branch or session change invalidates the previous creatives; clear
    // them first so a stale creative can never be selected or submitted.
    setCreatives([]);
    setCreativeId('');
    if (!branchId || !canCreateJob) return;
    let active = true;
    void fetch(
      `${apiBase}/creatives?branchId=${encodeURIComponent(branchId)}`,
      { headers: { Authorization: `Bearer ${session.accessToken}` } },
    )
      .then(async (response) => {
        if (response.status === 401) {
          onUnauthorized();
        } else if (response.ok && active) {
          const result = (await response.json()) as CreativeResponse[];
          // Reselect the creative of a pending retry when it is in this
          // branch; otherwise default to the first creative.
          const pendingCreativeId = attemptRef.current?.creativeId;
          const preferred =
            result.find((creative) => creative.id === pendingCreativeId) ??
            result[0];
          setCreatives(result);
          setCreativeId(preferred?.id ?? '');
        }
      })
      .catch(() => {
        if (active) setError('Unable to load creatives for this branch.');
      });
    return () => {
      active = false;
    };
  }, [branchId, canCreateJob, session.accessToken, onUnauthorized]);

  async function changeConnection(action: 'connect' | 'disconnect') {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${apiBase}/integrations/canva/${action}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok) throw new Error('Unable to update mock connection.');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Canva action failed.');
    } finally {
      setBusy(false);
    }
  }

  // The key is kept for any outcome that may have left the job unfinished
  // (5xx, network failure, timeout, or a QUEUED job) and dropped once the job
  // is final or the API rejects the request with a 4xx.
  function rememberAttempt(next: PrepareAttempt | null) {
    attemptRef.current = next;
    setAttempt(next);
  }

  async function prepareDesign(current: PrepareAttempt) {
    setBusy(true);
    setNotice(null);
    rememberAttempt(current);
    try {
      const response = await fetchWithTimeout(
        `${apiBase}/integrations/canva/jobs`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.accessToken}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': current.key,
          },
          body: JSON.stringify({ creativeId: current.creativeId }),
        },
      );
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (response.status >= 500) {
        setNotice({
          tone: 'error',
          text: `${await serverMessage(
            response,
            'The mock design request did not finish.',
          )} Retry to resume the same job.`,
        });
      } else if (!response.ok) {
        rememberAttempt(null);
        setNotice({
          tone: 'error',
          text: await serverMessage(response, 'Unable to prepare mock design.'),
        });
      } else {
        const job = (await response.json()) as CanvaJobResponse;
        if (job.status === 'SUCCEEDED') {
          rememberAttempt(null);
          setNotice({ tone: 'info', text: 'Mock design prepared.' });
        } else if (job.status === 'FAILED') {
          rememberAttempt(null);
          setNotice({
            tone: 'error',
            text:
              job.errorMessage ??
              'The mock provider could not prepare a design.',
          });
        } else {
          setNotice({
            tone: 'info',
            text: 'The mock design job is queued but not finished. Retry to resume it.',
          });
        }
      }
    } catch {
      setNotice({
        tone: 'error',
        text: 'The request did not complete, so its outcome is unknown. Retry to resume the same job safely.',
      });
    } finally {
      setBusy(false);
    }
    await refresh();
  }

  function selectCreative(nextCreativeId: string) {
    setCreativeId(nextCreativeId);
    rememberAttempt(null);
    setNotice(null);
  }

  const retryable = attempt !== null && attempt.creativeId === creativeId;
  // Real Canva mode is reported by the API; mock mode is the default.
  const realMode = status?.mode === 'CANVA';
  const creativeNames = new Map(
    creatives.map((creative) => [creative.id, creative.name]),
  );

  if (!canRead && !canManage && !canCreateJob) return null;

  return (
    <section
      className="service-card canva-integration"
      id="canva-integration"
      aria-labelledby="canva-title"
    >
      <p className="card-label">EXTERNAL CREATIVE PROVIDER</p>
      <div className="service-heading canva-heading">
        <h2 id="canva-title">Canva integration</h2>
        <span className="mock-badge">
          {realMode ? 'REAL CANVA MODE' : 'MOCK MODE'}
        </span>
      </div>
      {realMode ? (
        <p>
          Connects one Canva account for this organization. An administrator
          reviews and confirms the account before it is used. Nothing is
          published.
        </p>
      ) : (
        <p>
          Mock provider only. This demo does not connect to a real Canva account
          or publish designs.
        </p>
      )}
      <p role="status">
        {loading
          ? realMode
            ? 'Checking Canva connection…'
            : 'Checking mock provider…'
          : !status
            ? 'Mock provider status unavailable'
            : status.status === 'CONNECTED'
              ? status.isRealConnection
                ? 'Canva provider connected'
                : 'Mock provider connected'
              : realMode
                ? 'Canva not connected'
                : 'Mock provider disconnected'}
      </p>
      {status && realMode && (
        <CanvaConnection
          session={session}
          status={status}
          canManage={canManage}
          onUnauthorized={onUnauthorized}
          onChanged={refresh}
        />
      )}
      {canManage && !realMode && (
        <button
          className="secondary-button"
          disabled={busy || loading || !status}
          onClick={() =>
            void changeConnection(
              status?.status === 'CONNECTED' ? 'disconnect' : 'connect',
            )
          }
        >
          {status?.status === 'CONNECTED'
            ? 'Disconnect mock provider'
            : 'Connect mock provider'}
        </button>
      )}
      {canCreateJob && realMode && (
        <p>Design preparation with real Canva is not available yet.</p>
      )}
      {canCreateJob && !realMode && (
        <div className="canva-job-controls">
          <label htmlFor="canva-creative">
            Prepare design from branch creative
          </label>
          <select
            id="canva-creative"
            value={creativeId}
            onChange={(event) => selectCreative(event.target.value)}
            disabled={!branch || creatives.length === 0}
          >
            {!creatives.length && <option value="">No branch creatives</option>}
            {creatives.map((creative) => (
              <option key={creative.id} value={creative.id}>
                {creative.name}
              </option>
            ))}
          </select>
          <button
            disabled={
              busy ||
              loading ||
              retryable ||
              !creativeId ||
              status?.status !== 'CONNECTED'
            }
            onClick={() =>
              void prepareDesign({ creativeId, key: newIdempotencyKey() })
            }
          >
            Prepare mock design
          </button>
          {retryable && (
            <>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => {
                  if (attempt) void prepareDesign(attempt);
                }}
              >
                Retry and resume job
              </button>
              <p>
                Retrying resumes the same job instead of creating a new one.
                Reloading this page loses the retry link.
              </p>
            </>
          )}
        </div>
      )}
      {notice && (
        <p
          role={notice.tone === 'error' ? 'alert' : 'status'}
          className={notice.tone === 'error' ? 'form-message' : undefined}
        >
          {notice.text}
        </p>
      )}
      {error && (
        <p role="alert" className="form-message">
          {error}
        </p>
      )}
      {canRead && (
        <ul aria-label="Canva mock jobs">
          {jobs.map((job) => {
            const creativeName = creativeNames.get(job.creativeId);
            const createdAt = job.createdAt
              ? formatTimestamp(job.createdAt)
              : null;
            return (
              <li key={job.id}>
                <strong
                  className={`badge badge-${jobStatusTones[job.status] ?? 'neutral'}`}
                >
                  {jobStatusLabels[job.status] ?? job.status}
                </strong>
                <span> · {job.mode}</span>
                {creativeName && <span> · {creativeName}</span>}
                {createdAt && (
                  <span>
                    {' · '}
                    <time dateTime={job.createdAt}>{createdAt}</time>
                  </span>
                )}
                {job.externalDesignId && <span> · {job.externalDesignId}</span>}
                {job.status === 'QUEUED' && (
                  <p>
                    This job did not finish. It can be resumed only with Retry,
                    before this page is reloaded.
                  </p>
                )}
                {job.errorMessage && (
                  <p role="alert" className="form-message">
                    {job.errorMessage}
                  </p>
                )}
              </li>
            );
          })}
          {!jobs.length && (
            <li className="empty-state">
              No mock design jobs have been prepared.
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
