import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  BranchDetails,
  OrganizationResponse,
  OrganizationUserSummary,
  UserBranchAccessResponse,
} from '@adflow/shared-types';
import StatusBadge from './StatusBadge';
import FeedbackMessage from './FeedbackMessage';
import { returnFocusToConfirmTrigger } from './confirmFocus';

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000/api/v1';
const PERMISSIONS = {
  organizationUpdate: 'organizations:update',
  branchManage: 'branches:manage',
  branchAccessManage: 'users:branch-access:manage',
} as const;

type AdminSession = { accessToken: string; user: { permissions: string[] } };
type BranchForm = Pick<
  BranchDetails,
  | 'name'
  | 'code'
  | 'address'
  | 'city'
  | 'state'
  | 'pincode'
  | 'phone'
  | 'whatsapp'
  | 'email'
  | 'googleMapsUrl'
  | 'timezone'
>;
// Branch form labels; name, code and time zone are required by the API.
const branchFieldLabels: Record<keyof BranchForm, string> = {
  name: 'Name',
  code: 'Code',
  address: 'Address',
  city: 'City',
  state: 'State',
  pincode: 'PIN code',
  phone: 'Phone',
  whatsapp: 'WhatsApp',
  email: 'Email',
  googleMapsUrl: 'Google Maps link',
  timezone: 'Time zone',
};
const requiredBranchFields = new Set<keyof BranchForm>([
  'name',
  'code',
  'timezone',
]);
const emptyBranch: BranchForm = {
  name: '',
  code: '',
  address: null,
  city: null,
  state: null,
  pincode: null,
  phone: null,
  whatsapp: null,
  email: null,
  googleMapsUrl: null,
  timezone: 'Asia/Kolkata',
};

// A refused or failed request. For a refused change (400, 404 or 409) the
// API's own reason is kept, since it says what to fix (for example "Branch
// code is already in use").
const GENERIC_FAILURE = 'Unable to complete the request. Please try again.';
async function failureFrom(response: Response): Promise<string> {
  if (response.status === 403)
    return 'You do not have permission to complete this action.';
  if ([400, 404, 409].includes(response.status)) {
    const body = (await response.json().catch(() => null)) as {
      message?: unknown;
    } | null;
    if (typeof body?.message === 'string' && body.message.trim())
      return /[.!?]$/.test(body.message.trim())
        ? body.message.trim()
        : body.message.trim() + '.';
  }
  return GENERIC_FAILURE;
}
const messageOf = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

// One user's branch access as the screen last loaded it. Only the entry for
// the user selected now is shown, so a reply for a previously selected user
// can never show (or act on) their access under another name.
type AccessState = {
  userId: string;
  status: 'loading' | 'loaded' | 'failed';
  items: UserBranchAccessResponse[];
  error: string;
};

interface Props {
  session: AdminSession;
  onUnauthorized: () => void;
}

export default function OrganizationAdmin({ session, onUnauthorized }: Props) {
  const permissions = session.user.permissions;
  const canUpdateOrganization = permissions.includes(
    PERMISSIONS.organizationUpdate,
  );
  const canManageBranches = permissions.includes(PERMISSIONS.branchManage);
  const canManageUserAccess = permissions.includes(
    PERMISSIONS.branchAccessManage,
  );
  const [organization, setOrganization] = useState<OrganizationResponse | null>(
    null,
  );
  const [branches, setBranches] = useState<BranchDetails[]>([]);
  const [users, setUsers] = useState<OrganizationUserSummary[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [access, setAccess] = useState<AccessState>({
    userId: '',
    status: 'loading',
    items: [],
    error: '',
  });
  // Only the latest access request may apply its reply.
  const accessRequest = useRef(0);
  // The user selected now, for replies to changes sent earlier.
  const selectedUserIdNow = useRef(selectedUserId);
  selectedUserIdNow.current = selectedUserId;
  // The administration data: whether it has loaded at least once, whether a
  // load is running, and why the latest load failed. Only the latest load
  // may apply its reply.
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const loadSequence = useRef(0);
  // The organization as last loaded, to tell whether its form was edited.
  const organizationNow = useRef<OrganizationResponse | null>(null);
  const [organizationForm, setOrganizationForm] = useState({
    name: '',
    code: '',
  });
  const [branchForm, setBranchForm] = useState<BranchForm>(emptyBranch);
  const [editingBranchId, setEditingBranchId] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // The branch awaiting confirmation before it is deactivated, and the branch
  // whose access the selected user is about to lose.
  const [confirmingDeactivateId, setConfirmingDeactivateId] = useState('');
  const [confirmingRevokeBranchId, setConfirmingRevokeBranchId] = useState('');

  async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    if (response.status === 401) {
      onUnauthorized();
      throw new Error('Your session expired. Please sign in again.');
    }
    if (!response.ok) throw new Error(await failureFrom(response));
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  // Loads the organization, its branches and (for access managers) its
  // users. Typed organization details are kept: the form follows a reload
  // only while it still matches what was loaded before.
  async function loadAdministration(): Promise<boolean> {
    if (!canUpdateOrganization && !canManageBranches && !canManageUserAccess)
      return false;
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const [organizationResult, branchResult, organizationUsers] =
        await Promise.all([
          api<OrganizationResponse>('/organization'),
          api<BranchDetails[]>('/branches'),
          canManageUserAccess
            ? api<OrganizationUserSummary[]>('/users')
            : Promise.resolve(null),
        ]);
      if (sequence !== loadSequence.current) return false;
      const previous = organizationNow.current;
      organizationNow.current = organizationResult;
      setOrganization(organizationResult);
      setOrganizationForm((form) =>
        !previous ||
        (form.name === previous.name && form.code === previous.code)
          ? { name: organizationResult.name, code: organizationResult.code }
          : form,
      );
      setBranches(branchResult);
      if (organizationUsers) {
        setUsers(organizationUsers);
        // Keep the selected user while they are still listed.
        setSelectedUserId((current) =>
          organizationUsers.some((user) => user.id === current)
            ? current
            : (organizationUsers[0]?.id ?? ''),
        );
      }
      setLoaded(true);
      setLoadError('');
      return true;
    } catch (cause: unknown) {
      if (sequence !== loadSequence.current) return false;
      setLoadError(
        messageOf(cause, GENERIC_FAILURE) === GENERIC_FAILURE
          ? "Organization settings couldn't be loaded."
          : messageOf(cause, GENERIC_FAILURE),
      );
      return false;
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }

  useEffect(() => {
    void loadAdministration();
    // The request must reload when the active token changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.accessToken]);

  // Loads one user's branch access. Until it arrives (or when it fails) no
  // access, and no Grant or Revoke action, is shown for that user.
  async function loadAccess(userId: string): Promise<void> {
    const sequence = ++accessRequest.current;
    setAccess({ userId, status: 'loading', items: [], error: '' });
    try {
      const items = await api<UserBranchAccessResponse[]>(
        `/users/${encodeURIComponent(userId)}/branches`,
      );
      if (sequence !== accessRequest.current) return;
      setAccess({ userId, status: 'loaded', items, error: '' });
    } catch (cause: unknown) {
      if (sequence !== accessRequest.current) return;
      setAccess({
        userId,
        status: 'failed',
        items: [],
        error: messageOf(cause, GENERIC_FAILURE),
      });
    }
  }

  useEffect(() => {
    if (!canManageUserAccess || !selectedUserId) {
      accessRequest.current += 1;
      setAccess({ userId: '', status: 'loading', items: [], error: '' });
      return;
    }
    void loadAccess(selectedUserId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUserId, session.accessToken, canManageUserAccess]);

  async function submitOrganization(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const saved = await api<OrganizationResponse>('/organization', {
        method: 'PATCH',
        body: JSON.stringify(organizationForm),
      });
      organizationNow.current = saved;
      setOrganization(saved);
      setOrganizationForm({ name: saved.name, code: saved.code });
      setMessage('Organization profile saved.');
    } catch (cause: unknown) {
      // The typed details stay in the form.
      setError(messageOf(cause, 'Unable to save organization.'));
    } finally {
      setBusy(false);
    }
  }

  async function submitBranch(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    const payload = Object.fromEntries(
      Object.entries(branchForm).map(([key, value]) => [
        key,
        value === '' ? null : value,
      ]),
    );
    try {
      await api<BranchDetails>(
        editingBranchId
          ? `/branches/${encodeURIComponent(editingBranchId)}`
          : '/branches',
        {
          method: editingBranchId ? 'PATCH' : 'POST',
          body: JSON.stringify(payload),
        },
      );
      setBranchForm(emptyBranch);
      setEditingBranchId('');
      setMessage(editingBranchId ? 'Branch updated.' : 'Branch created.');
      // A failed reload is reported with Try again; the change is saved.
      await loadAdministration();
    } catch (cause: unknown) {
      // The typed branch details stay in the form.
      setError(messageOf(cause, 'Unable to save branch.'));
    } finally {
      setBusy(false);
    }
  }

  async function changeBranchStatus(branch: BranchDetails): Promise<void> {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await api<BranchDetails>(
        `/branches/${encodeURIComponent(branch.id)}/${branch.status === 'ACTIVE' ? 'deactivate' : 'activate'}`,
        { method: 'POST' },
      );
      setMessage(
        branch.status === 'ACTIVE'
          ? 'Branch deactivated.'
          : 'Branch activated.',
      );
      setConfirmingDeactivateId('');
      await loadAdministration();
    } catch (cause: unknown) {
      setError(messageOf(cause, 'Unable to change branch status.'));
    } finally {
      setBusy(false);
    }
  }

  // Grants or revokes the selected user's access to one branch. Only offered
  // once that user's own access has loaded. The success message names the
  // user and branch, and comes only from the API's answer; the user's access
  // is then reloaded (and shown only if they are still selected).
  async function changeUserBranch(
    branch: BranchDetails,
    grant: boolean,
  ): Promise<void> {
    const userId = selectedUserId;
    if (!userId || access.userId !== userId || access.status !== 'loaded')
      return;
    const userName =
      users.find((user) => user.id === userId)?.name ?? 'This person';
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await api<{ revoked?: boolean } | undefined>(
        `/users/${encodeURIComponent(userId)}/branches/${encodeURIComponent(branch.id)}`,
        { method: grant ? 'POST' : 'DELETE' },
      );
      setMessage(
        grant
          ? `Branch access granted: ${userName} can now work in ${branch.name}.`
          : result?.revoked === false
            ? `${userName} had no assigned access to ${branch.name}, so nothing changed.`
            : `Branch access revoked: ${userName} no longer has assigned access to ${branch.name}.`,
      );
      setConfirmingRevokeBranchId('');
      if (selectedUserIdNow.current === userId) await loadAccess(userId);
    } catch (cause: unknown) {
      setError(messageOf(cause, 'Unable to update branch access.'));
    } finally {
      setBusy(false);
    }
  }

  if (!canUpdateOrganization && !canManageBranches && !canManageUserAccess)
    return null;

  return (
    <section
      className="admin-panel"
      id="organization-admin"
      aria-labelledby="admin-title"
    >
      <div className="admin-heading">
        <div>
          <p className="eyebrow">ADMINISTRATION</p>
          <h2 id="admin-title">Organization & branches</h2>
          <p className="service-copy">
            Update your organization&apos;s details, add or change branches, and
            choose which branches each person can work in.
          </p>
        </div>
        <button
          className="secondary-button"
          disabled={loading}
          onClick={() => void loadAdministration()}
        >
          {loading && loaded ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <FeedbackMessage tone="error" message={error} />
      <FeedbackMessage tone="success" message={message} />
      {!loaded && loading && (
        <p className="empty-state" role="status">
          Loading organization settings…
        </p>
      )}
      {loadError && !loading && (
        <div className="run-load-error">
          <FeedbackMessage
            tone="error"
            message={
              loadError +
              (loaded
                ? ' What is shown below may be out of date.'
                : ' Please try again.')
            }
          />
          <button
            type="button"
            className="secondary-button"
            onClick={() => void loadAdministration()}
          >
            Try again
          </button>
        </div>
      )}

      {organization && (
        <section className="admin-card" aria-labelledby="organization-title">
          <h3 id="organization-title">Organization profile</h3>
          {canUpdateOrganization ? (
            <form
              className="admin-form"
              onSubmit={(event) => void submitOrganization(event)}
            >
              <label htmlFor="organization-name">Name</label>
              <input
                id="organization-name"
                value={organizationForm.name}
                onChange={(event) =>
                  setOrganizationForm({
                    ...organizationForm,
                    name: event.target.value,
                  })
                }
                required
                maxLength={120}
              />
              <label htmlFor="organization-code">Code</label>
              <input
                id="organization-code"
                value={organizationForm.code}
                onChange={(event) =>
                  setOrganizationForm({
                    ...organizationForm,
                    code: event.target.value,
                  })
                }
                required
                maxLength={50}
              />
              <button type="submit" disabled={busy}>
                Save organization
              </button>
            </form>
          ) : (
            <dl className="profile-list">
              <dt>Name</dt>
              <dd>{organization.name}</dd>
              <dt>Code</dt>
              <dd>{organization.code}</dd>
              <dt>Status</dt>
              <dd>
                <StatusBadge status={organization.status} />
              </dd>
            </dl>
          )}
        </section>
      )}

      {loaded && (
        <section className="admin-card" aria-labelledby="branches-title">
          <h3 id="branches-title">Branches</h3>
          {!branches.length && (
            <p className="empty-state">
              No branches yet.
              {canManageBranches
                ? ' Create the first one with the form below.'
                : ''}
            </p>
          )}
          <ul className="admin-list">
            {branches.map((branch) => (
              <li key={branch.id}>
                <div>
                  <strong>{branch.name}</strong>
                  <span>
                    {branch.code} <StatusBadge status={branch.status} />
                    {branch.city ? ` · ${branch.city}` : ''}
                  </span>
                </div>
                {canManageBranches && (
                  <div className="inline-actions">
                    <button
                      className="secondary-button"
                      onClick={() => {
                        setEditingBranchId(branch.id);
                        setBranchForm({
                          name: branch.name,
                          code: branch.code,
                          address: branch.address,
                          city: branch.city,
                          state: branch.state,
                          pincode: branch.pincode,
                          phone: branch.phone,
                          whatsapp: branch.whatsapp,
                          email: branch.email,
                          googleMapsUrl: branch.googleMapsUrl,
                          timezone: branch.timezone,
                        });
                      }}
                    >
                      Edit
                    </button>
                    <button
                      className="secondary-button"
                      disabled={busy}
                      aria-expanded={
                        branch.status === 'ACTIVE'
                          ? confirmingDeactivateId === branch.id
                          : undefined
                      }
                      onClick={() =>
                        branch.status === 'ACTIVE'
                          ? setConfirmingDeactivateId(branch.id)
                          : void changeBranchStatus(branch)
                      }
                    >
                      {branch.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                    </button>
                  </div>
                )}
                {canManageBranches &&
                  branch.status === 'ACTIVE' &&
                  confirmingDeactivateId === branch.id && (
                    <div
                      className="confirm-panel"
                      role="group"
                      aria-label={'Confirm deactivating ' + branch.name}
                    >
                      <p>
                        Deactivate {branch.name}? Nobody can choose or work in
                        this branch until it is activated again. Its creatives,
                        brand settings and history are kept, and you can
                        activate it again at any time.
                      </p>
                      <div className="template-actions">
                        <button
                          type="button"
                          className="danger-button"
                          disabled={busy}
                          onClick={() => void changeBranchStatus(branch)}
                        >
                          Deactivate branch
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={busy}
                          onClick={(event) => {
                            returnFocusToConfirmTrigger(event.currentTarget);
                            setConfirmingDeactivateId('');
                          }}
                        >
                          Keep active
                        </button>
                      </div>
                    </div>
                  )}
              </li>
            ))}
          </ul>
          {canManageBranches && (
            <form
              className="admin-form branch-edit-form"
              onSubmit={(event) => void submitBranch(event)}
            >
              <h4>{editingBranchId ? 'Edit branch' : 'Create branch'}</h4>
              {(
                [
                  'name',
                  'code',
                  'address',
                  'city',
                  'state',
                  'pincode',
                  'phone',
                  'whatsapp',
                  'email',
                  'googleMapsUrl',
                  'timezone',
                ] as const
              ).map((field) => (
                <label key={field} htmlFor={`branch-${field}`}>
                  <span>
                    {branchFieldLabels[field]}
                    <span className="field-hint">
                      {requiredBranchFields.has(field)
                        ? ' (required)'
                        : ' (optional)'}
                    </span>
                  </span>
                  <input
                    id={`branch-${field}`}
                    type={
                      field === 'email'
                        ? 'email'
                        : field === 'googleMapsUrl'
                          ? 'url'
                          : 'text'
                    }
                    value={branchForm[field] ?? ''}
                    onChange={(event) =>
                      setBranchForm({
                        ...branchForm,
                        [field]: event.target.value,
                      })
                    }
                    required={requiredBranchFields.has(field)}
                    placeholder={
                      field === 'timezone'
                        ? 'For example Asia/Kolkata'
                        : undefined
                    }
                  />
                </label>
              ))}
              <div className="inline-actions">
                <button type="submit" disabled={busy}>
                  {editingBranchId ? 'Save branch' : 'Create branch'}
                </button>
                {editingBranchId && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setEditingBranchId('');
                      setBranchForm(emptyBranch);
                    }}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </form>
          )}
        </section>
      )}

      {canManageUserAccess && loaded && (
        <section className="admin-card" aria-labelledby="user-access-title">
          <h3 id="user-access-title">User branch access</h3>
          {!users.length ? (
            <p className="empty-state">
              There are no users in this organization to give branch access to.
            </p>
          ) : (
            <>
              <label htmlFor="access-user">Organization user</label>
              <select
                id="access-user"
                value={selectedUserId}
                onChange={(event) => {
                  setSelectedUserId(event.target.value);
                  setConfirmingRevokeBranchId('');
                }}
              >
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name} · {user.email}
                  </option>
                ))}
              </select>
            </>
          )}
          {selectedUserId &&
            (access.userId !== selectedUserId ||
              access.status === 'loading') && (
              <p className="empty-state" role="status">
                Loading{' '}
                {users.find((user) => user.id === selectedUserId)?.name ??
                  'this person'}
                &apos;s branch access…
              </p>
            )}
          {selectedUserId &&
            access.userId === selectedUserId &&
            access.status === 'failed' && (
              <div className="run-load-error">
                <FeedbackMessage
                  tone="error"
                  message={[
                    (users.find((user) => user.id === selectedUserId)?.name ??
                      'This person') +
                      "'s branch access couldn't be loaded, so it can't be changed right now.",
                    access.error === GENERIC_FAILURE ? '' : access.error,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                />
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void loadAccess(selectedUserId)}
                >
                  Try again
                </button>
              </div>
            )}
          {selectedUserId &&
            access.userId === selectedUserId &&
            access.status === 'loaded' &&
            !branches.length && (
              <p className="empty-state">
                There are no branches to give access to yet.
              </p>
            )}
          {selectedUserId &&
            access.userId === selectedUserId &&
            access.status === 'loaded' && (
              <ul className="admin-list">
                {branches.map((branch) => {
                  const granted = access.items.some(
                    (item) => item.branch.id === branch.id,
                  );
                  return (
                    <li key={branch.id}>
                      <div>
                        <strong>{branch.name}</strong>
                        <span>
                          {branch.code} <StatusBadge status={branch.status} />
                          {granted ? ' · Access granted' : ' · No access'}
                        </span>
                      </div>
                      <button
                        className="secondary-button"
                        disabled={
                          busy || (branch.status !== 'ACTIVE' && !granted)
                        }
                        aria-expanded={
                          granted
                            ? confirmingRevokeBranchId === branch.id
                            : undefined
                        }
                        onClick={() =>
                          granted
                            ? setConfirmingRevokeBranchId(branch.id)
                            : void changeUserBranch(branch, true)
                        }
                      >
                        {granted ? 'Revoke access' : 'Grant access'}
                      </button>
                      {granted && confirmingRevokeBranchId === branch.id && (
                        <div
                          className="confirm-panel"
                          role="group"
                          aria-label={
                            'Confirm revoking access to ' + branch.name
                          }
                        >
                          <p>
                            Revoke{' '}
                            {users.find((user) => user.id === selectedUserId)
                              ?.name ?? 'this person'}
                            &apos;s access to {branch.name}? The branch is
                            removed from the branches assigned to them, so they
                            can no longer see or work on its creatives, brand or
                            workflows through this access. If their role lets
                            them manage every branch (as administrators&apos;
                            roles usually do), they keep access to all branches
                            through that role. You can grant access again at any
                            time.
                          </p>
                          <div className="template-actions">
                            <button
                              type="button"
                              className="danger-button"
                              disabled={busy}
                              aria-label={'Revoke access to ' + branch.name}
                              onClick={() =>
                                void changeUserBranch(branch, false)
                              }
                            >
                              Revoke access
                            </button>
                            <button
                              type="button"
                              className="secondary-button"
                              disabled={busy}
                              onClick={(event) => {
                                returnFocusToConfirmTrigger(
                                  event.currentTarget,
                                );
                                setConfirmingRevokeBranchId('');
                              }}
                            >
                              Keep access
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
        </section>
      )}
    </section>
  );
}
