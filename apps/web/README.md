# AdFlow Web

React + TypeScript + Vite web application. The app shows API health, provides login, and presents an authenticated branch shell. Configure the API base URL with `VITE_API_BASE_URL`.

## Session persistence

After login the app saves only `{ accessToken, expiresAt }` under the `adflow.session` `localStorage` key (`src/authStorage.ts`). Identity, permissions, and branch access are never stored. On startup, and when another tab signs in, a saved token is first checked locally: malformed or expired entries are removed without calling the API. A usable token is then sent to `GET /auth/me`, and the session is built only from that server response, which rechecks session revocation, expiry, user status, and active branch grants. A 401 removes the saved token and shows the sign-in screen. Network or server errors keep the token and offer **Try again** (or **Sign out**), so a temporary outage does not log the user out. Logout, the branch request's 401, every workspace `onUnauthorized` callback, and invalid restored sessions all go through one `clearSession` helper. Logout clears local state before calling `POST /auth/logout`, so it signs out even if revocation fails. Other tabs follow sign-out and sign-in through the browser `storage` event.

Session lifetime is unchanged: the server session expires 15 minutes after login (`JWT_ACCESS_TTL_SECONDS`), and no refresh token exists, so a restored session ends at the same time as the original.

Trade-off: any script running on the app's origin (for example through an XSS bug) can read a token in `localStorage` and use it until it expires or is revoked. This is mitigated by the short lifetime, server-side revocation on logout, and React's default output escaping (the app does not render raw HTML). An HttpOnly cookie session with CSRF protection and a Content-Security-Policy would harden this further and remain future work. On shared computers, users should sign out rather than close the tab.

Run from the repository root with `pnpm --filter @adflow/web dev` or use the root `pnpm dev` command to start both applications. Vite loads the repository-root `.env` (`envDir` is configured in `vite.config.ts`). The server binds to loopback by default. For intentional LAN access, start it with `pnpm --filter @adflow/web dev -- --host 0.0.0.0`.
Sprint 2 adds permission-aware organization and branch administration to the authenticated shell. Administrators can update the organization profile, manage branch details and status, and grant/revoke organization users' branch access. Branch users do not receive these administrative controls. The API remains the security boundary.

Sprint 6 adds a permission-aware workflow workspace for organization definition management and branch creative stage/history views. The JSON editor submits declarative stages and transitions that the API validates. Client controls are for usability; the API enforces permissions and branch access.

Sprint 8 adds a notification entry point with unread count, list, read state, and read-all behavior. Users with `audit:read` also see the audit history workspace and filters. Authorization remains server-enforced by the API.
