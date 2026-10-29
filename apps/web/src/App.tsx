import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  SESSION_STORAGE_KEY,
  loadStoredSession,
  removeStoredSession,
  saveStoredSession,
} from './authStorage';
import OrganizationAdmin from './OrganizationAdmin';
import BrandAssets from './BrandAssets';
import TemplateManager from './TemplateManager';
import CreativeWorkspace from './CreativeWorkspace';
import WorkflowWorkspace from './WorkflowWorkspace';
import ApprovalsWorkspace from './ApprovalsWorkspace';
import { AuditWorkspace, NotificationsWorkspace } from './ActivityWorkspaces';
import CanvaIntegration from './CanvaIntegration';
import StatusBadge from './StatusBadge';
import WorkspaceShell, { type WorkspaceModule } from './WorkspaceShell';
import type {
  AuthenticatedUserResponse,
  BranchResponse,
  HealthResponse,
  LoginResponse,
} from '@adflow/shared-types';

type ApiStatus =
  | { state: 'checking' }
  | { state: 'online'; response: HealthResponse }
  | { state: 'offline'; message: string };

type AuthSession = { accessToken: string; user: AuthenticatedUserResponse };

const apiBaseUrl =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000/api/v1';

export default function App() {
  const [apiStatus, setApiStatus] = useState<ApiStatus>({ state: 'checking' });
  const [session, setSession] = useState<AuthSession | null>(null);
  // A saved token awaiting server validation through GET /auth/me.
  const [restoringToken, setRestoringToken] = useState<string | null>(
    () => loadStoredSession()?.accessToken ?? null,
  );
  const [restoreError, setRestoreError] = useState('');
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [loginError, setLoginError] = useState('');
  const [sessionExpired, setSessionExpired] = useState(false);
  const [selectedBranchId, setSelectedBranchId] = useState('');
  const [templateRefreshKey, setTemplateRefreshKey] = useState(0);
  const [branch, setBranch] = useState<BranchResponse | null>(null);
  const [branchError, setBranchError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Single exit path for logout, 401 responses, and invalid server sessions.
  // Passing the session's token avoids discarding a newer sign-in saved by another tab.
  const clearSession = useCallback(
    (expired: boolean, accessToken?: string): void => {
      removeStoredSession(accessToken);
      setSession(null);
      setRestoringToken(null);
      setRestoreError('');
      setSelectedBranchId('');
      setSessionExpired(expired);
    },
    [],
  );

  useEffect(() => {
    if (!restoringToken) return;
    const accessToken = restoringToken;
    const controller = new AbortController();
    async function restoreSession(): Promise<void> {
      setRestoreError('');
      try {
        const response = await fetch(`${apiBaseUrl}/auth/me`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          clearSession(true, accessToken);
          return;
        }
        // Temporary outages keep the saved token so the user can retry.
        if (!response.ok) {
          setRestoreError(
            `Unable to restore your session (HTTP ${response.status}).`,
          );
          return;
        }
        const user = (await response.json()) as AuthenticatedUserResponse;
        if (controller.signal.aborted) return;
        setSession({ accessToken, user });
        setSelectedBranchId(user.branches[0]?.id ?? '');
        setSessionExpired(false);
        setRestoringToken(null);
      } catch {
        if (controller.signal.aborted) return;
        setRestoreError('Unable to reach the API to restore your session.');
      }
    }
    void restoreSession();
    return () => controller.abort();
  }, [restoringToken, restoreAttempt, clearSession]);

  const activeAccessToken = session?.accessToken ?? null;
  useEffect(() => {
    function syncFromOtherTab(event: StorageEvent): void {
      if (event.key !== null && event.key !== SESSION_STORAGE_KEY) return;
      const stored = loadStoredSession();
      if (!stored) {
        // Another tab signed out, or the saved entry was cleared.
        clearSession(false);
        return;
      }
      if (
        stored.accessToken === activeAccessToken ||
        stored.accessToken === restoringToken
      )
        return;
      // Another tab signed in: validate its token through /auth/me before use.
      setSession(null);
      setRestoreError('');
      setSessionExpired(false);
      setRestoringToken(stored.accessToken);
    }
    window.addEventListener('storage', syncFromOtherTab);
    return () => window.removeEventListener('storage', syncFromOtherTab);
  }, [activeAccessToken, restoringToken, clearSession]);

  useEffect(() => {
    const controller = new AbortController();
    async function loadApiHealth(): Promise<void> {
      try {
        const response = await fetch(`${apiBaseUrl}/health`, {
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(`API returned HTTP ${response.status}`);
        const health = (await response.json()) as HealthResponse;
        setApiStatus({ state: 'online', response: health });
      } catch (error: unknown) {
        if (controller.signal.aborted) return;
        const message =
          error instanceof Error ? error.message : 'Unable to reach the API';
        setApiStatus({ state: 'offline', message });
      }
    }
    void loadApiHealth();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!session) {
      setBranch(null);
      return;
    }
    const activeSession = session;
    const controller = new AbortController();
    async function loadBranch(): Promise<void> {
      if (!selectedBranchId) return;
      try {
        const response = await fetch(
          `${apiBaseUrl}/branches/${encodeURIComponent(selectedBranchId)}`,
          {
            headers: { Authorization: `Bearer ${activeSession.accessToken}` },
            signal: controller.signal,
          },
        );
        if (response.status === 401) {
          clearSession(true, activeSession.accessToken);
          return;
        }
        if (!response.ok) throw new Error('Branch access is unavailable.');
        setBranch((await response.json()) as BranchResponse);
        setBranchError('');
      } catch (error: unknown) {
        if (controller.signal.aborted) return;
        setBranchError(
          error instanceof Error ? error.message : 'Unable to load branch',
        );
      }
    }
    void loadBranch();
    return () => controller.abort();
  }, [selectedBranchId, session, clearSession]);

  async function login(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLoginError('');
    setIsSubmitting(true);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch(`${apiBaseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: form.get('email'),
          password: form.get('password'),
        }),
      });
      if (!response.ok) throw new Error('Invalid email or password');
      const result = (await response.json()) as LoginResponse;
      saveStoredSession(result.accessToken, result.expiresIn);
      setRestoringToken(null);
      setSession({ accessToken: result.accessToken, user: result.user });
      setSelectedBranchId(result.user.branches[0]?.id ?? '');
      setSessionExpired(false);
    } catch (error: unknown) {
      setLoginError(
        error instanceof Error ? error.message : 'Unable to sign in',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function logout(accessToken: string): Promise<void> {
    // Clear locally first so a failed or slow revocation never leaves the user signed in.
    clearSession(false, accessToken);
    try {
      await fetch(`${apiBaseUrl}/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch {
      // The server session still expires on its own if revocation cannot reach the API.
    }
  }

  const statusLabel =
    apiStatus.state === 'checking'
      ? 'Checking API'
      : apiStatus.state === 'online'
        ? 'API online'
        : 'API unavailable';

  const statusChip = (
    <span className={`status-chip status-${apiStatus.state}`} role="status">
      <span className="status-dot" aria-hidden="true" />
      {statusLabel}
    </span>
  );
  const footer = (
    <footer className="footer">
      <span>AdFlow infrastructure</span>
      <span>Multi-branch operations</span>
    </footer>
  );

  if (session) {
    const permissions = session.user.permissions;
    const onUnauthorized = () => clearSession(true, session.accessToken);
    // Same modules, props, and permission rules as the former single page;
    // the shell only decides which one is shown.
    const modules: WorkspaceModule[] = [
      {
        id: 'branch-context',
        label: 'Branch',
        icon: 'branch',
        available: true,
        content: (
          <section
            className="service-card branch-card"
            id="branch-context"
            aria-labelledby="branch-title"
          >
            <p className="card-label">PERMITTED BRANCH CONTEXT</p>
            <label htmlFor="branch-select">Select branch</label>
            <select
              id="branch-select"
              value={selectedBranchId}
              onChange={(event) => setSelectedBranchId(event.target.value)}
            >
              {session.user.branches.map((permittedBranch) => (
                <option key={permittedBranch.id} value={permittedBranch.id}>
                  {permittedBranch.name} · {permittedBranch.code}
                </option>
              ))}
            </select>
            {branch && (
              <div className="branch-summary">
                <h2 id="branch-title">{branch.name}</h2>
                <p>
                  {branch.code} <StatusBadge status={branch.status} />
                </p>
              </div>
            )}
            {!session.user.branches.length && (
              <p className="empty-state">
                No branches are assigned to this account.
              </p>
            )}
            {branchError && (
              <p role="alert" className="form-message">
                {branchError}
              </p>
            )}
          </section>
        ),
      },
      {
        id: 'brand-assets',
        label: 'Brand & assets',
        icon: 'brand',
        available: permissions.includes('brand:read'),
        content: (
          <BrandAssets
            session={session}
            branch={branch}
            onUnauthorized={onUnauthorized}
          />
        ),
      },
      {
        id: 'templates',
        label: 'Templates',
        icon: 'templates',
        available: permissions.includes('templates:read'),
        content: (
          <TemplateManager
            session={session}
            onTemplatesChanged={() =>
              setTemplateRefreshKey((current) => current + 1)
            }
            onUnauthorized={onUnauthorized}
          />
        ),
      },
      {
        id: 'creatives',
        label: 'Creatives',
        icon: 'creatives',
        available: permissions.includes('creatives:read'),
        content: (
          <CreativeWorkspace
            session={session}
            branch={branch}
            templateRefreshKey={templateRefreshKey}
            onUnauthorized={onUnauthorized}
          />
        ),
      },
      {
        id: 'canva-integration',
        label: 'Canva mock',
        icon: 'canva',
        available: permissions.some((permission) =>
          permission.startsWith('canva:'),
        ),
        content: (
          <CanvaIntegration
            session={session}
            branch={branch}
            onUnauthorized={onUnauthorized}
          />
        ),
      },
      {
        id: 'workflows',
        label: 'Workflows',
        icon: 'workflows',
        available:
          permissions.includes('workflows:read') ||
          permissions.includes('workflows:start'),
        content: (
          <WorkflowWorkspace
            session={session}
            branch={branch}
            onUnauthorized={onUnauthorized}
          />
        ),
      },
      {
        id: 'approvals',
        label: 'Approvals',
        icon: 'approvals',
        available:
          permissions.includes('approvals:read') ||
          permissions.includes('comments:read'),
        content: (
          <ApprovalsWorkspace
            session={session}
            onUnauthorized={onUnauthorized}
          />
        ),
      },
      {
        id: 'notifications',
        label: 'Notifications',
        icon: 'notifications',
        available: true,
        content: <NotificationsWorkspace session={session} />,
      },
      {
        id: 'audit',
        label: 'Audit',
        icon: 'audit',
        available: permissions.includes('audit:read'),
        content: permissions.includes('audit:read') && (
          <AuditWorkspace session={session} />
        ),
      },
      {
        id: 'organization-admin',
        label: 'Administration',
        icon: 'admin',
        available:
          permissions.includes('organizations:update') ||
          permissions.includes('branches:manage') ||
          permissions.includes('users:branch-access:manage'),
        content: (
          <OrganizationAdmin
            session={session}
            onUnauthorized={onUnauthorized}
          />
        ),
      },
    ];
    return (
      <WorkspaceShell
        modules={modules}
        defaultModuleId="branch-context"
        statusChip={statusChip}
        heading={
          <div className="app-heading workspace-greeting">
            <div>
              <p className="eyebrow">YOUR WORKSPACE</p>
              <h1 id="page-title">Hello, {session.user.name}.</h1>
              <p className="intro">{session.user.email}</p>
            </div>
          </div>
        }
        contextLabel={branch?.name}
        userName={session.user.name}
        onSignOut={() => void logout(session.accessToken)}
        footer={footer}
      />
    );
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="AdFlow home">
          <span className="brand-mark" aria-hidden="true">
            A
          </span>
          <span>adflow</span>
        </a>
        {statusChip}
      </header>
      {restoringToken ? (
        <section className="auth-panel" aria-labelledby="page-title">
          <p className="eyebrow">ADVERTISING OPERATIONS</p>
          <h1 id="page-title">Welcome back.</h1>
          {restoreError ? (
            <>
              <p role="alert" className="form-message">
                {restoreError} Your saved sign-in was kept.
              </p>
              <div className="login-form">
                <button
                  type="button"
                  onClick={() => setRestoreAttempt((current) => current + 1)}
                >
                  Try again
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void logout(restoringToken)}
                >
                  Sign out
                </button>
              </div>
            </>
          ) : (
            <p className="intro" aria-live="polite" aria-busy="true">
              Restoring your session…
            </p>
          )}
        </section>
      ) : (
        <section className="auth-panel" aria-labelledby="page-title">
          <p className="eyebrow">ADVERTISING OPERATIONS</p>
          <h1 id="page-title">Welcome back.</h1>
          <p className="intro">
            Sign in to view the branches assigned to your account.
          </p>
          {sessionExpired && (
            <p role="status" className="info-message">
              Your session expired. Please sign in again.
            </p>
          )}
          <form className="login-form" onSubmit={(event) => void login(event)}>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
            />
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
            {loginError && (
              <p role="alert" className="form-message">
                {loginError}
              </p>
            )}
            <button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </section>
      )}
      {footer}
    </main>
  );
}
