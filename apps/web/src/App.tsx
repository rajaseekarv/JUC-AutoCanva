import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
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
import { useDataChanges } from './dataChanges';
import { returnFocusToConfirmTrigger } from './confirmFocus';
import { useNotifications } from './useNotifications';
import { useRecordLinks, type CreativeFormState } from './useRecordLinks';
import type {
  AuthenticatedUserResponse,
  BranchResponse,
  BranchSummary,
  HealthResponse,
  LoginResponse,
} from '@adflow/shared-types';

// Stable empty lists while signed out.
const NO_ITEMS: readonly string[] = [];
const NO_BRANCHES: readonly BranchSummary[] = [];

type ApiStatus =
  | { state: 'checking' }
  | { state: 'online'; response: HealthResponse }
  | { state: 'offline'; message: string };

type AuthSession = { accessToken: string; user: AuthenticatedUserResponse };

const apiBaseUrl =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000/api/v1';

// What a failed sign-in tells the user. Only a rejected email or password
// says so; anything else is a problem on our side or with the connection,
// and the browser's own network error text is never shown.
function loginFailureMessage(status: number | null): string {
  if (status === 401) return 'The email or password is incorrect.';
  if (status === 400) return 'Enter a valid email address and password.';
  if (status === 429)
    return 'Too many sign-in attempts. Wait a few minutes, then try again.';
  if (status === null)
    return "We couldn't reach JUC-AutoCanva. Check your internet connection and try again.";
  return "We couldn't sign you in right now. Please try again in a moment.";
}

class LoginFailure extends Error {}

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
  // Creatives, Workflows and Approvals report review-data changes here so
  // the other two refresh their lists.
  const [dataChange, onDataChanged] = useDataChanges();
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
  // Notifications are owned here and shared, so only one copy is polled. A
  // 401 signs out through the same path as every other screen.
  const notifications = useNotifications({
    accessToken: session?.accessToken ?? null,
    dataChange,
    onUnauthorized: (accessToken) => clearSession(true, accessToken),
  });
  const { setScreenOpen: setNotificationsOpen } = notifications;
  // What the Creatives form holds, so a notification link or the Branch
  // selector can ask before discarding unsaved edits.
  const creativeForm = useRef<CreativeFormState>({
    creativeId: '',
    dirty: false,
  });
  // Sign out pressed while the Creatives form has unsaved changes: signing
  // out waits for the user to confirm discarding them.
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  // Set once signing out has started, so a repeated click sends nothing.
  const signingOut = useRef(false);
  const reportCreativeForm = useCallback((state: CreativeFormState) => {
    creativeForm.current = state;
    // Nothing left to protect (saved or reverted): stop asking.
    if (!state.dirty) setConfirmingSignOut(false);
  }, []);
  // A branch chosen in the Branch selector while the Creatives form has
  // unsaved changes; switching waits for the user to confirm discarding them.
  const [pendingBranchId, setPendingBranchId] = useState('');
  const branchSelectRef = useRef<HTMLSelectElement>(null);
  const sessionToken = session?.accessToken ?? null;
  useEffect(() => {
    setPendingBranchId('');
    setConfirmingSignOut(false);
    signingOut.current = false;
    // The previous session's form is gone. Creatives reports its new form
    // when it mounts; without Creatives there is nothing to protect.
    if (!sessionToken) creativeForm.current = { creativeId: '', dirty: false };
  }, [sessionToken]);
  const selectBranchForLink = useCallback((branchId: string) => {
    // A notification link asked (or had nothing to ask) on its own.
    setPendingBranchId('');
    setBranchError('');
    setSelectedBranchId(branchId);
  }, []);
  function chooseBranch(branchId: string): void {
    if (branchId === selectedBranchId) {
      setPendingBranchId('');
      return;
    }
    // Switching branch resets the Creatives form, so unsaved edits are only
    // discarded after an explicit confirmation.
    if (creativeForm.current.dirty) {
      setPendingBranchId(branchId);
      return;
    }
    setPendingBranchId('');
    setSelectedBranchId(branchId);
  }
  // Following a notification to its record (one pending request at a time).
  const recordLinks = useRecordLinks({
    accessToken: session?.accessToken ?? null,
    permissions: session?.user.permissions ?? NO_ITEMS,
    branches: session?.user.branches ?? NO_BRANCHES,
    selectedBranchId,
    selectBranch: selectBranchForLink,
    branchError,
    creativeForm,
    markRead: notifications.markRead,
  });
  const { openRequest, reportOpen } = recordLinks;

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
            "JUC-AutoCanva isn't responding right now, so we couldn't confirm your sign-in.",
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
        setRestoreError(
          "We couldn't reach JUC-AutoCanva to confirm your sign-in. Check your internet connection.",
        );
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
      let response: Response;
      try {
        response = await fetch(`${apiBaseUrl}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: form.get('email'),
            password: form.get('password'),
          }),
        });
      } catch {
        // The request never reached the server (offline, DNS, CORS).
        throw new LoginFailure(loginFailureMessage(null));
      }
      if (!response.ok)
        throw new LoginFailure(loginFailureMessage(response.status));
      const result = (await response.json()) as LoginResponse;
      saveStoredSession(result.accessToken, result.expiresIn);
      setRestoringToken(null);
      setSession({ accessToken: result.accessToken, user: result.user });
      setSelectedBranchId(result.user.branches[0]?.id ?? '');
      setSessionExpired(false);
    } catch (error: unknown) {
      // Only our own messages are shown; an unexpected error (for example an
      // unreadable response) gets the generic one.
      setLoginError(
        error instanceof LoginFailure
          ? error.message
          : loginFailureMessage(500),
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  // Sign out from the workspace. Signing out discards the Creatives form, so
  // unsaved edits are only discarded after an explicit confirmation.
  function requestSignOut(accessToken: string): void {
    if (signingOut.current) return;
    if (creativeForm.current.dirty) {
      setConfirmingSignOut(true);
      return;
    }
    signOut(accessToken);
  }
  function signOut(accessToken: string): void {
    if (signingOut.current) return;
    signingOut.current = true;
    setConfirmingSignOut(false);
    void logout(accessToken);
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

  // Nothing is shown while the service is reachable (or still being
  // checked); only an outage gets a notice, in the top bar and as a short
  // explanation above the page content.
  const serviceUnavailable = apiStatus.state === 'offline';
  const statusChip = serviceUnavailable ? (
    <span className="status-chip status-offline">
      <span className="status-dot" aria-hidden="true" />
      Service unavailable
    </span>
  ) : null;
  const serviceNotice = serviceUnavailable ? (
    <p role="alert" className="form-message">
      We can&apos;t reach JUC-AutoCanva right now, so some information may not
      load or save. Check your internet connection, then refresh the page.
    </p>
  ) : null;
  const footer = (
    <footer className="footer">
      <span>JUC-AutoCanva</span>
      <span>Advertising operations for every branch</span>
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
            <p className="card-label">YOUR BRANCH</p>
            <p className="service-copy">
              Choose the branch you are working for. Creatives, brand settings
              and workflows on other screens follow this choice.
            </p>
            <label htmlFor="branch-select">Select branch</label>
            <select
              id="branch-select"
              ref={branchSelectRef}
              value={selectedBranchId}
              onChange={(event) => chooseBranch(event.target.value)}
            >
              {session.user.branches.map((permittedBranch) => (
                <option key={permittedBranch.id} value={permittedBranch.id}>
                  {permittedBranch.name} · {permittedBranch.code}
                </option>
              ))}
            </select>
            {pendingBranchId && (
              // The selector keeps showing the current branch until the
              // switch is confirmed.
              <div
                className="confirm-panel"
                role="group"
                aria-label="Unsaved changes in Creatives"
              >
                <p role="alert">
                  You have unsaved changes in Creatives. Switching to the{' '}
                  {session.user.branches.find(
                    (item) => item.id === pendingBranchId,
                  )?.name ?? 'selected'}{' '}
                  branch discards them.
                </p>
                <div className="template-actions">
                  <button
                    type="button"
                    className="danger-button"
                    onClick={() => {
                      const next = pendingBranchId;
                      setPendingBranchId('');
                      setSelectedBranchId(next);
                    }}
                  >
                    Discard changes and continue
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setPendingBranchId('');
                      branchSelectRef.current?.focus();
                    }}
                  >
                    Keep my changes
                  </button>
                </div>
              </div>
            )}
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
            dataChange={dataChange}
            onDataChanged={onDataChanged}
            onUnauthorized={onUnauthorized}
            openRequest={
              openRequest?.module === 'creatives' ? openRequest : null
            }
            onOpenResult={reportOpen}
            onFormStateChange={reportCreativeForm}
          />
        ),
      },
      {
        id: 'canva-integration',
        label: 'Canva (demo)',
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
            dataChange={dataChange}
            onDataChanged={onDataChanged}
            onUnauthorized={onUnauthorized}
            openRequest={
              openRequest?.module === 'workflows' ? openRequest : null
            }
            onOpenResult={reportOpen}
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
            dataChange={dataChange}
            onDataChanged={onDataChanged}
            onUnauthorized={onUnauthorized}
            openRequest={
              openRequest?.module === 'approvals' ? openRequest : null
            }
            onOpenResult={reportOpen}
          />
        ),
      },
      {
        id: 'notifications',
        label: 'Notifications',
        icon: 'notifications',
        available: true,
        // The shared unread count; no badge while the count is unavailable
        // (its last request failed). Before the first reply the count is 0,
        // which the shell does not show.
        badge: notifications.countError
          ? undefined
          : {
              count: notifications.count,
              description: `${notifications.count} unread`,
            },
        content: (
          <NotificationsWorkspace
            notifications={notifications}
            navigation={recordLinks.navigation}
          />
        ),
      },
      {
        id: 'audit',
        label: 'Audit',
        icon: 'audit',
        available: permissions.includes('audit:read'),
        content: permissions.includes('audit:read') && (
          <AuditWorkspace session={session} onUnauthorized={onUnauthorized} />
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
          <>
            <div className="app-heading workspace-greeting">
              <div>
                <p className="eyebrow">YOUR WORKSPACE</p>
                <h1 id="page-title">Hello, {session.user.name}.</h1>
                <p className="intro">{session.user.email}</p>
              </div>
            </div>
            {serviceNotice}
          </>
        }
        contextLabel={branch?.name}
        userName={session.user.name}
        onSignOut={() => requestSignOut(session.accessToken)}
        signOutConfirmation={
          confirmingSignOut ? (
            <div
              className="confirm-panel"
              role="group"
              aria-label="Unsaved changes in Creatives"
            >
              <p role="alert">
                You have unsaved changes in Creatives. Signing out discards
                them.
              </p>
              <div className="template-actions">
                <button
                  type="button"
                  className="danger-button"
                  onClick={() => signOut(session.accessToken)}
                >
                  Discard changes and continue
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={(event) => {
                    returnFocusToConfirmTrigger(event.currentTarget);
                    setConfirmingSignOut(false);
                  }}
                >
                  Keep my changes
                </button>
              </div>
            </div>
          ) : null
        }
        footer={footer}
        onActiveModuleChange={(moduleId) =>
          setNotificationsOpen(moduleId === 'notifications')
        }
      />
    );
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="JUC-AutoCanva home">
          <span className="brand-mark" aria-hidden="true">
            J
          </span>
          <span>JUC-AutoCanva</span>
        </a>
        {statusChip}
      </header>
      {serviceNotice}
      {restoringToken ? (
        <section className="auth-panel" aria-labelledby="page-title">
          <p className="eyebrow">ADVERTISING OPERATIONS</p>
          <h1 id="page-title">Welcome back.</h1>
          {restoreError ? (
            <>
              <p role="alert" className="form-message">
                {restoreError} Your saved sign-in has been kept, so you can try
                again in a moment, or sign out to use a different account.
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
