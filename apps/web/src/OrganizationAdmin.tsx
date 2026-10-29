import { useEffect, useState, type FormEvent } from 'react';
import type {
  BranchDetails,
  OrganizationResponse,
  OrganizationUserSummary,
  UserBranchAccessResponse,
} from '@adflow/shared-types';
import StatusBadge from './StatusBadge';

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
  const [userAccess, setUserAccess] = useState<UserBranchAccessResponse[]>([]);
  const [organizationForm, setOrganizationForm] = useState({
    name: '',
    code: '',
  });
  const [branchForm, setBranchForm] = useState<BranchForm>(emptyBranch);
  const [editingBranchId, setEditingBranchId] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
    if (!response.ok)
      throw new Error(
        response.status === 403
          ? 'You do not have permission to complete this action.'
          : 'Unable to complete the request.',
      );
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  async function loadAdministration(): Promise<void> {
    if (!canUpdateOrganization && !canManageBranches && !canManageUserAccess)
      return;
    setError('');
    try {
      const [organizationResult, branchResult] = await Promise.all([
        api<OrganizationResponse>('/organization'),
        api<BranchDetails[]>('/branches'),
      ]);
      setOrganization(organizationResult);
      setOrganizationForm({
        name: organizationResult.name,
        code: organizationResult.code,
      });
      setBranches(branchResult);
      if (canManageUserAccess) {
        const organizationUsers =
          await api<OrganizationUserSummary[]>('/users');
        setUsers(organizationUsers);
        setSelectedUserId(
          (current) => current || organizationUsers[0]?.id || '',
        );
      }
    } catch (cause: unknown) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Unable to load organization settings.',
      );
    }
  }

  useEffect(() => {
    void loadAdministration();
    // The request must reload when the active token changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.accessToken]);

  useEffect(() => {
    if (!canManageUserAccess || !selectedUserId) {
      setUserAccess([]);
      return;
    }
    void api<UserBranchAccessResponse[]>(
      `/users/${encodeURIComponent(selectedUserId)}/branches`,
    )
      .then(setUserAccess)
      .catch((cause: unknown) =>
        setError(
          cause instanceof Error
            ? cause.message
            : 'Unable to load branch access.',
        ),
      );
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
      setOrganization(saved);
      setOrganizationForm({ name: saved.name, code: saved.code });
      setMessage('Organization profile saved.');
    } catch (cause: unknown) {
      setError(
        cause instanceof Error ? cause.message : 'Unable to save organization.',
      );
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
      await loadAdministration();
    } catch (cause: unknown) {
      setError(
        cause instanceof Error ? cause.message : 'Unable to save branch.',
      );
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
      await loadAdministration();
    } catch (cause: unknown) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Unable to change branch status.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function changeUserBranch(
    branchId: string,
    grant: boolean,
  ): Promise<void> {
    if (!selectedUserId) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await api(
        `/users/${encodeURIComponent(selectedUserId)}/branches/${encodeURIComponent(branchId)}`,
        { method: grant ? 'POST' : 'DELETE' },
      );
      const access = await api<UserBranchAccessResponse[]>(
        `/users/${encodeURIComponent(selectedUserId)}/branches`,
      );
      setUserAccess(access);
      setMessage(grant ? 'Branch access granted.' : 'Branch access revoked.');
    } catch (cause: unknown) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Unable to update branch access.',
      );
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
          <p className="eyebrow">ORGANIZATION ADMINISTRATION</p>
          <h2 id="admin-title">Organization & branches</h2>
        </div>
        <button
          className="secondary-button"
          onClick={() => void loadAdministration()}
        >
          Refresh
        </button>
      </div>
      {error && (
        <p className="form-message" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="success-message" role="status">
          {message}
        </p>
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

      <section className="admin-card" aria-labelledby="branches-title">
        <h3 id="branches-title">Branches</h3>
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
                    onClick={() => void changeBranchStatus(branch)}
                  >
                    {branch.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                  </button>
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
                {field === 'googleMapsUrl'
                  ? 'Google Maps URL'
                  : field[0].toUpperCase() + field.slice(1)}
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
                  required={
                    field === 'name' || field === 'code' || field === 'timezone'
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

      {canManageUserAccess && (
        <section className="admin-card" aria-labelledby="user-access-title">
          <h3 id="user-access-title">User branch access</h3>
          <label htmlFor="access-user">Organization user</label>
          <select
            id="access-user"
            value={selectedUserId}
            onChange={(event) => setSelectedUserId(event.target.value)}
          >
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name} · {user.email}
              </option>
            ))}
          </select>
          {selectedUserId && (
            <ul className="admin-list">
              {branches.map((branch) => {
                const granted = userAccess.some(
                  (access) => access.branch.id === branch.id,
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
                      onClick={() => void changeUserBranch(branch.id, !granted)}
                    >
                      {granted ? 'Revoke access' : 'Grant access'}
                    </button>
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
