# Canva integration foundation

## Current behavior

The API uses a deterministic mock provider. Authorized organization admins can connect or disconnect the mock account. Users with `canva:jobs:create` can prepare a mock design reference from a creative's current immutable revision when they also have current access to that creative's branch. Results are explicitly marked `MOCK`; they do not represent Canva accounts, designs, or Autofill jobs. The mock needs no Canva credentials or configuration. No Canva tokens are stored.

API permissions are `canva:integration:read`, `canva:integration:manage`, and `canva:jobs:create`. Organization ownership comes from the authenticated principal. Branch access is checked against the database for every branch-scoped job operation. Job creation requires an `Idempotency-Key` scoped to the organization; reuse of a key for another creative is rejected with `409`. Connection changes and job outcomes are audited.

## Job states and recovery

A job is created as `QUEUED` and is intended to move to `SUCCEEDED` or `FAILED` once. The service finalizes with Prisma `updateMany` filtered on `status = QUEUED` and writes the `canva.design.prepared` or `canva.design.failed` audit event only when that update reports one changed row; when it reports zero, the persisted state is returned without an audit event. Unit tests establish this logic.

This was verified against an isolated PostgreSQL 18 test database at the default `READ COMMITTED` isolation level (`apps/api/src/pg/concurrency.pg.spec.ts`). With the job row held locked, two same-key retries were both observed in `pg_stat_activity` waiting inside the finalizing `UPDATE`; after release, exactly one `canva.design.prepared` audit event was written and both requests returned the same `SUCCEEDED` job. Prisma 6.19 emits a single statement that keeps the predicate: `UPDATE "public"."canva_jobs" SET … WHERE ("public"."canva_jobs"."id" = $4 AND "public"."canva_jobs"."status" = CAST($5::text AS "public"."CanvaJobStatus"))`. A Prisma upgrade or a different isolation level would need this test re-run.

- **Definite provider failure.** If the provider rejects the request, the job is stored as `FAILED` with the safe code `PROVIDER_UNAVAILABLE`. Provider error details are not exposed.
- **Uncertain persistence outcome.** If the outcome (success or provider failure) cannot be saved, the API returns `503` and the job stays `QUEUED`. It is never marked `FAILED` because of a database error.

Same-key retry behavior:

- `SUCCEEDED` or `FAILED`: final for that key; the stored job is returned and the provider is not called again. To try again after a failure, send a new key.
- `QUEUED`: the request resumes the job. The provider is called again for the creative revision stored on the job, not the creative's current revision, and the job is finalized as above.

No background worker resumes `QUEUED` jobs; only a same-key retry does.

## Web client retries

Each **Prepare mock design** action generates one random `Idempotency-Key` and keeps it, with the selected creative, in component memory only. The key is never written to `localStorage`, `sessionStorage`, or any other storage, and no endpoint or schema change supports it. Requests time out after 15 seconds (`AbortController`); a timeout is treated as an unknown outcome, not a failure.

| Outcome                                       | Key       | What the user sees                                       |
| --------------------------------------------- | --------- | -------------------------------------------------------- |
| `503` or other `5xx`                          | kept      | The server message and a **Retry and resume job** action |
| Network failure or timeout                    | kept      | "Outcome is unknown" and the retry action                |
| `2xx` with job `QUEUED`                       | kept      | "Queued but not finished" and the retry action           |
| `2xx` with job `SUCCEEDED`                    | cleared   | "Mock design prepared."                                  |
| `2xx` with job `FAILED`                       | cleared   | The job's safe error message                             |
| Other `4xx` (for example `400`, `404`, `409`) | cleared   | The server message, with no retry action                 |
| `401`                                         | discarded | Sign-out; the component unmounts with its in-memory key  |

Every `5xx` is treated as retryable. A `401` is not handled as a retry outcome: it starts the app's sign-out, which removes the Canva panel and the key it held, so signing in again starts with a new key. Retry resends the same key as many times as needed, so the API resumes the existing job instead of creating another. A `2xx` response whose job is still `QUEUED` is not a completed job: the key is kept and Retry stays available. Only `SUCCEEDED` and `FAILED` are final; after either, the next **Prepare mock design** action uses a new key. While a retry is pending, **Prepare mock design** is disabled; choosing a different creative discards the pending key. The job list is refreshed after every attempt, successful or not, and a refresh failure is shown separately without hiding the attempt's result or leaving the controls busy. Job rows show a plain-language status (queued and not finished, prepared, failed), the creative name when that creative is loaded for the current branch, and the creation time supplied by the API.

Reloading or closing the page loses the in-memory key, so recovery after a reload is not supported. The interrupted job stays `QUEUED`, labelled as not finished in the job list, and a new action creates a new job with a new key. Switching branch and back keeps a pending key and reselects its creative, because the component is not remounted. The server's idempotency checks remain authoritative: the client only resends the same key.

Switching branch clears the previously selected creative before the new branch's creatives load, so a creative from the previous branch cannot be prepared.

All of this applies to the mock provider only: no real Canva API is called and nothing is published.

## Verification status

| Behavior                                                                                                                   | Evidence                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Recovery logic: `503` on unsaved outcomes, `QUEUED` resume against the stored revision, `SUCCEEDED`/`FAILED` final per key | Unit tests with mocked Prisma; `503` pass-through also covered by mocked-Prisma HTTP tests                                   |
| Web client key reuse, timeout, retry handling, and memory-only key lifetime (no storage, no restore after reload)          | Component tests with mocked `fetch`                                                                                          |
| Only one finalization and audit event when same-key requests race                                                          | Real PostgreSQL 18 test (`*.pg.spec.ts`): blocked-request evidence from `pg_stat_activity`, audit count, and the emitted SQL |

## Real Canva OAuth (Stages 2 and 2.1)

Stage 2 implements the durable OAuth storage and revocation safeguards specified by [revision 5 of the persistence proposal](canva-oauth-persistence-proposal.md): the schema and migration files, PostgreSQL stores, administrator confirmation, the durable revocation queue, and its worker. Stage 2.1 adds the web confirmation flow, the key reseal job, the operator command, the `rotation_lost` mark, and the remaining PostgreSQL gate harness. **Real Canva is still not enabled, and the integration is not production-ready.**

- Mock is the default and the only design provider.
- Real mode stays fail-closed unless `CANVA_OAUTH_PERSISTENCE_ENABLED=true`. Until then the module wires "unavailable" stores, and start, launch, callback, confirmation, and disconnect refuse.
- The migrations have not been applied to any development, shared, or production database. The Stage 2.5 gates applied them only to disposable schemas on a dedicated test cluster.
- The PostgreSQL gates (§10 of the proposal) passed on PostgreSQL 18.6 in Stage 2.5 (2026-10-28; see the gate runbook §11). Mocked tests alone are not evidence of database behavior.
- No code path has called Canva. Every test stubs the network.

### Configuration

Server-only variables, validated at startup by `apps/api/src/config/environment.ts` (rules in `apps/api/src/canva/oauth/canva-oauth.config.ts`). Validation errors name the variable but never print its value.

| Variable                               | Rule                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CANVA_PROVIDER_MODE`                  | `mock` (default) or `canva`. In `mock`, every Canva value below is ignored                                                                                                                                                                                                                                                                 |
| `CANVA_CLIENT_ID`                      | Required in `canva` mode; the Canva app's client ID                                                                                                                                                                                                                                                                                        |
| `CANVA_CLIENT_SECRET`                  | Required in `canva` mode. It is held in a redacting wrapper (`SecretValue`), so it cannot reach logs, JSON, or error messages, and it is sent only in the token request's `Authorization: Basic` header                                                                                                                                    |
| `CANVA_REDIRECT_URI`                   | Required in `canva` mode. It must be in canonical form (exactly as URL parsing writes it: lower-case host, no default port, no `..` segments), end in `/api/v1/integrations/canva/oauth/callback` with no query, fragment, or credentials, and use `https`, or `http` only on `127.0.0.1` or `[::1]` for local development (Canva's local-development guidance uses `127.0.0.1`, not `localhost`). Its origin must be listed in `CANVA_REDIRECT_ALLOWED_ORIGINS`; with that list unset only the loopback `http` origins are accepted. Local value: `http://127.0.0.1:3000/api/v1/integrations/canva/oauth/callback` |
| `CANVA_REDIRECT_ALLOWED_ORIGINS`       | Comma-separated origins (scheme, host, optional port; no path, query, or credentials), each `https` or loopback `http`. The explicit allowlist for the redirect URI's origin. Required for any `https` deployment host; optional for local development on `127.0.0.1` |
| `CANVA_TOKEN_ENCRYPTION_KEY`           | Required in `canva` mode: 32 random bytes as base64, separate from the client secret                                                                                                                                                                                                                                                       |
| `CANVA_TOKEN_ENCRYPTION_KEY_VERSION`   | Version of that key (default `1`)                                                                                                                                                                                                                                                                                                          |
| `CANVA_TOKEN_ENCRYPTION_PREVIOUS_KEYS` | Optional `version:base64-key` pairs, decryption only, used during key rotation                                                                                                                                                                                                                                                             |
| `CANVA_OAUTH_PERSISTENCE_ENABLED`      | `true` or `false` (default `false`; anything else is rejected). Wires the PostgreSQL stores. Requires the Canva OAuth migrations. Keep `false` until the PostgreSQL gates pass                                                                                                                                                             |
| `CANVA_REVOCATION_WORKER_ENABLED`      | `true` or `false` (default `false`). Lets the revocation worker run when triggered, which calls Canva's revoke endpoint. Requires `CANVA_OAUTH_PERSISTENCE_ENABLED=true`                                                                                                                                                                   |

Secrets come from the deployment secret manager or a local, untracked `.env`. They are never committed, and they are never sent to the web client.

**Encryption keys.**

- Generate `CANVA_TOKEN_ENCRYPTION_KEY` as 32 random bytes from a CSPRNG, base64-encoded. Store it only in the secret manager, never alongside the database or its backups.
- It must differ from the client secret (validated).
- Every sealed value carries its key version. To rotate, move the current key into `CANVA_TOKEN_ENCRYPTION_PREVIOUS_KEYS` as `version:key`, set a new key with a higher `CANVA_TOKEN_ENCRYPTION_KEY_VERSION`, and keep the old key until nothing references its version.
- After switching keys, run the reseal (see [Key rotation](#key-rotation-reseal)) until the old version reports `safe to retire`, and only then remove it from `CANVA_TOKEN_ENCRYPTION_PREVIOUS_KEYS`.
- A lost key makes its rows undecryptable. Credentials are then marked `undecryptable` and must be reconnected, and their queued revocations finish as `undecryptable` without a call.

### Endpoints

All JSON endpoints require the JWT guard plus `canva:integration:manage` (status needs `canva:integration:read`). They answer `409` in mock mode, and `503` "Real Canva connection is not available yet" while durable storage is off.

| Endpoint                                             | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST …/canva/oauth/authorize`                       | Records an attempt and returns `{ launchUrl, launchToken, expiresAt }`. **Contract change from Stage 1**, which returned `{ authorizationUrl, expiresAt }`; no web code used it. The launch token is single-use and valid for 60 seconds; only its SHA-256 hash is stored. More than 20 open attempts per organization answers `429`                                                                                                       |
| `POST …/canva/oauth/launch`                          | Unauthenticated form POST (`launch_token`), so the browser navigates top-level on the callback's host. It consumes the launch token, creates the state, the PKCE verifier, and the browser-binding value, sets the `adflow_canva_oauth_binding` cookie (`HttpOnly`, `SameSite=Lax`, path `/api/v1/integrations/canva/oauth`, 10 minutes, `Secure` for `https`), and answers `303` to Canva. An unusable token answers `303` to the web app |
| `GET …/canva/oauth/callback`                         | Unauthenticated by design. It always answers `303` to the fixed `WEB_ORIGIN` at `/?canva=<outcome>#canva-integration`, with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, and clears the binding cookie. Nothing from the request is reflected into the redirect                                                                                                                                                           |
| `GET …/canva/oauth/candidate`                        | The pending Canva account, only for the administrator **and session** that started the flow: display name (sanitized, render as text only), shortened user and team IDs, granted versus required scopes, capabilities, start and expiry times, and the `warnings` that need acknowledging                                                                                                                                                  |
| `POST …/canva/oauth/candidate/confirm`               | Body `{ candidateId, acknowledgements: { differentAccount?, missingDisplayName?, scopesNotReported? } }`, strict. A missing acknowledgement answers `400` and keeps the candidate; a changed connection answers `409` and queues the candidate's tokens. On success the credential is activated                                                                                                                                            |
| `POST …/canva/oauth/candidate/reject`                | Body `{ candidateId }`. Queues the candidate's tokens for revocation and releases the account                                                                                                                                                                                                                                                                                                                                              |
| `GET …/canva/revocations`                            | The organization's exhausted revocations (`id`, `reason`, `attempts`, `lastErrorKind`, `createdAt`, `exhaustedAt`), so an administrator can act on them. No ciphertext or Canva IDs |
| `POST …/canva/revocations/:id/retry` and `…/dismiss` | Administrator actions on an exhausted revocation, scoped to the caller's organization and audited                                                                                                                                                                                                                                                                                                                                          |
| `POST …/canva/disconnect`                            | Real mode with storage on: deletes the credential, supersedes a pending candidate, and queues both token sets in one transaction. The response's `revocation` is `queued` or `none`, never "revoked"                                                                                                                                                                                                                                       |
| `GET …/canva/status`                                 | Real mode with storage on adds `canva: { reauthorizationRequired, reauthorizationReason, configurationError, pendingRevocations, exhaustedRevocations }`. Canva IDs are never included                                                                                                                                                                                                                                                     |

Callback outcomes:

- `pending_confirmation`: a candidate is waiting for confirmation.
- `denied`, `invalid_request`, `expired_or_used`, `not_authorized`, `unavailable`, `disabled`, `failed`.
- `conflict`: another candidate is pending in this organization.
- `account_unavailable`: the Canva user is connected to another organization.
- `account_ineligible`: a capability is missing.
- `insufficient_scope`.
- `retry_connect`: a revocation for this Canva user may still take effect; try again in a few minutes.

In real mode, the mock `connect` and job-creation actions answer `409`, so a mock result can never pass as a real one. Status ignores a leftover mock connection. Mock mode behaves exactly as before.

The response shapes are shared with the web app in `packages/shared-types` (`CanvaAuthorizationStart`, `CanvaPendingCandidate`, `CanvaCandidateConfirmation`, `CanvaCandidateConfirmed`, `CanvaExhaustedRevocation`, `CanvaOAuthOutcome`), and the API's service methods are typed against them, so a contract change fails the typecheck.

### Web flow (real mode only)

The Canva panel switches to this flow when `GET …/status` reports `mode: "CANVA"`; in mock mode it is unchanged. Every decision is the API's: the panel shows what the API returns and sends the administrator's explicit choices.

- **Connect** calls `POST …/oauth/authorize`, then submits a hidden top-level form to `launchUrl` with `launch_token`. The token stays in that request body: it is never put in a URL, shown, or written to web storage. The panel follows only an `https` (or loopback `http`) URL whose path is exactly the launch path. It cannot check the host, which comes from the server's `CANVA_REDIRECT_URI`.
- **Callback result**: Canva's redirect returns to `/?canva=<outcome>#canva-integration`. The panel shows a fixed message for each known outcome, ignores any other value (nothing from the URL is reflected), and removes the parameter from the address bar. `pending_confirmation` does not connect anything.
- **Confirm** (administrators with `canva:integration:manage`, same session): the display name as plain text, the shortened Canva user and team IDs, who started the flow and when, the Autofill and brand-template capabilities, each required scope as granted or not (or "Not reported by Canva"), and a countdown to expiry. Each warning has its own checkbox, and **Connect this Canva account** stays disabled until every warning is acknowledged, both capabilities are present, no scope is missing, and the candidate has not expired. **Reject** is always available. A new authorization cannot be started while a candidate is pending.
- **Errors**: `400` (an acknowledgement is missing) and `5xx` keep the candidate and show the server message; `404` (expired or gone) and `409` (the connection changed) end it and ask the administrator to start again; `401` signs out.
- **Disconnect** asks for a second confirmation and reports that access is _queued_ for revocation, never that it was revoked.
- **Health**: a required reconnection with its reason (`invalid_grant`, `undecryptable`, `rotation_lost`, `identity_mismatch`), a configuration error, the number of queued revocations, and the exhausted revocations with **Retry** and **Dismiss**.

Component tests (`apps/web/src/CanvaConnection.test.tsx`) and the mocked end-to-end HTTP workflow (`apps/api/src/http/canva-oauth-workflow.http.spec.ts`: the real application over HTTP in real mode with storage on, in-memory stores, and a fake Canva) cover these paths. Neither is evidence of browser cookie behavior (gate G) or of PostgreSQL behavior.

### Security design

**Where each value comes from** (Stage 2.2 audit):

| Value | Source | Trusted for |
| --- | --- | --- |
| Redirect URI, and the launch URL and binding-cookie host derived from it | Server configuration (`CANVA_REDIRECT_URI`, allowlisted origin) | The only callback and launch destination; never request headers |
| Post-callback destination | Server configuration (`WEB_ORIGIN`) plus one fixed outcome value | The only place the callback redirects; nothing from the request is reflected |
| Launch token | Browser form body | Nothing beyond matching one unexpired, unused attempt hash |
| Binding cookie | Browser cookie (host-only, `HttpOnly`, `SameSite=Lax`) | Matching the attempt's binding hash; never parsed further |
| `state`, `code`, `error` | Canva's redirect (browser query string) | `state` only as a hash lookup; `code` only for the PKCE-bound exchange; `error` only to pick `denied` or `failed`. Every other parameter (`redirect_uri`, `return_to`, `next`) is ignored |
| Tokens, identity, capabilities, display name | Canva's API, server to server | Stored sealed; the display name is sanitized and rendered as text only |

The web panel's own launch-URL check (https, or http on `127.0.0.1`/`[::1]`; exactly the launch path; no query, fragment, or credentials) is defense in depth against a malformed or script URL. It does **not** check the host, because the host comes from the server's allowlisted configuration and may legitimately differ from `VITE_API_BASE_URL`; the server-side allowlist is the control. Tests: `canva-oauth.config.spec.ts` (disallowed hosts and ports, subdomains, unexpected and non-canonical paths, malformed lists, the local configuration), the workflow spec (spoofed `Host`/`X-Forwarded-Host` and `redirect_uri`/`return_to`/`next` parameters), and `CanvaConnection.test.tsx`.

- **State and browser binding**: the state is created at launch, not at authorize. It is 32 random bytes (base64url), and only its SHA-256 hash is stored, with the owning organization, user, and session, for 10 minutes from launch. The callback consumes it in one conditional update that also requires the binding cookie's hash, so a leaked state without the cookie cannot burn the attempt. Forged, expired, and replayed states stop before any token exchange, and even an error response burns its state.
- **PKCE**: a 64-byte random `code_verifier` stays on the server, sealed at rest, and only its S256 challenge goes to Canva. An authorization code injected from another flow fails the exchange because the verifier does not match.
- **Callback authentication**: the JWT guard is replaced by the state record, and the starting user's session and `canva:integration:manage` permission are re-checked (read-only) before the exchange.
- **Token storage**: AES-256-GCM with a random IV per value, an authentication tag, and a key version. Associated data binds each value to its organization and purpose (`canva:access-token:<org>`, and so on). Plaintext tokens are never stored.
- **Confirmation, not auto-activation**: the callback reads the identity (`/users/me`), the capabilities, and the profile, checks the granted scopes, and stores a _candidate_. Only the same administrator, in the same session, can activate it, after acknowledging every warning (a different Canva account than the current one, no display name, scopes not reported). Unconfirmed candidates expire after 10 minutes and their tokens are queued for revocation.
- **One Canva user, one organization**: `canva_accounts` holds each Canva user for at most one organization, and credentials and candidates reference it through composite foreign keys. The database therefore rejects a credential or candidate for a user held elsewhere, and `ON UPDATE RESTRICT` stops a hold from moving or being released while referenced.
- **Refresh**: a fresh token is read without locking. Within 5 minutes of expiry, a refresh takes a 60-second lease in the credential row (database time) and waits up to 15 seconds for another holder. The rotation is written only if the version and chain are unchanged. A claimant that took over an expired lease and then gets `invalid_grant` waits up to 15 seconds for the previous holder's write before marking. A refresh overtaken by a reconnect or disconnect writes nothing, queues its rotated grant as `orphaned_rotation`, and re-reads.
- **Failure handling**: only an OAuth `invalid_grant`, a credential that can no longer be decrypted, or a rotation that could not be saved (`rotation_lost`) requires reconnection. Each mark is version-conditioned, so it never disables a newer reconnect.
  - `rotation_lost`: Canva rotated the refresh token (so the stored one is spent), but the write did not land. That is either a definite failure (rolled back after the store's own deadlock retries), or an ambiguous one whose re-read shows the same chain at exactly the version that was read. In both cases the credential is marked `rotation_lost`, version-conditioned: it is deleted, the status shows reconnection required, and an audit event records the reason. A late commit that lands first changes the version, so the mark matches nothing and the newer credential is used. The rotated grant is discarded, not queued, as for any lost token (§5.8), and stays valid at Canva until it expires.
    - A reconnect or disconnect that wins the race with the mark leaves the rotated grant orphaned; it is queued as `orphaned_rotation` under the guard.
    - If the re-read or the mark fails, nothing is given up and the error is retryable; the next refresh gets `invalid_grant` and marks the connection then.
    - A same-chain write with a newer version (another holder) is never marked.
    - Nothing on this path revokes; only the worker does, under the guard.
    - **Recovery** is an administrator reconnect (the panel shows **Reconnect Canva account** and the reason). No automatic recovery is claimed: AdFlow cannot re-save the rotated tokens once the write is lost.
  - **Identity re-check** (`CanvaAccessTokenService.verifyStoredIdentity`, §2.8) marks `identity_mismatch` when `/users/me` no longer matches the stored Canva user. Its intended caller is the real Autofill provider adapter, once per job before its first Canva design call. That adapter is not built (design calls are mock-only), so nothing calls it yet; refresh never changes the Canva user, so no other path needs it.
  - HTTP 408/425/429/5xx, network failures, timeouts, and unreadable responses are retryable and leave the stored credential untouched.
  - Other 4xx responses are configuration errors: they keep the credential and set the status's `configurationError`.
  - No response body, token, or credential is logged or included in errors.
- **Revocation (the same-user guard)**: Canva revokes the user's consent along with a refresh token. AdFlow therefore never revokes from a request path.
  - Every token AdFlow gives up is queued in `canva_pending_revocations` in the same transaction that gave it up.
  - `CanvaRevocationWorker` is the only caller of `CanvaTokenClient.revoke`; a test enforces this. Its T1 transaction locks the Canva user's account row and finishes the row without a call (`skipped_shared_consent`) if any credential or candidate for that user exists in any organization. Otherwise it commits `in_flight` before the call.
  - A new candidate for that user is refused with `retry_connect`, and its tokens are discarded, while a revocation is in flight or its possible-effect window reaches past the attempt's launch.
  - An unknown identity, an unverifiable save, or a user held elsewhere means the tokens are discarded, never queued.
  - **A database transaction cannot be atomic with Canva's HTTP endpoint.** The window narrows the race to the assumptions and residual risks in §11 of the proposal; it does not eliminate it.
- **Disconnect**: one transaction deletes the credential, supersedes a pending candidate, queues both token sets, releases the account, and marks the connection `DISCONNECTED`. The audit records `revocation: queued`; the worker records the outcome later.
- **Write verification**: every credential and candidate write carries a `writeId`, and every grant a `chainId`. After an ambiguous commit (the transaction body finished but the commit was not confirmed), the API re-reads by `writeId`. Tokens that may be stored are never queued.

The logic is covered by unit tests with in-memory doubles, by scripted-Prisma store tests that check statement order and branches, and by mocked-Prisma HTTP tests (`apps/api/src/canva/oauth/*.spec.ts`, `apps/api/src/http/api.http.spec.ts`). Every one of them stubs `fetch` to fail, and none touches a database. **None of these is evidence of PostgreSQL locking, isolation, or commit behavior.** That evidence can come only from the PostgreSQL gates.

### Revocation worker: operation and monitoring

- **Nothing schedules it.** With `CANVA_REVOCATION_WORKER_ENABLED=true`, it is triggered after a transaction that queued work, on status reads that show pending revocations, after `retry_connect`, and after an administrator retry. Each trigger runs one batch of up to 10 rows, and runs overlapping in one process are skipped. `runOnce()` itself also refuses unless the flag is set, so no entry point can call Canva without it.
- **Operator command** (`apps/api/src/canva/oauth/canva-operations.main.ts`):

  ```sh
  pnpm --filter @adflow/api build                         # required first: canva:ops runs dist/…/canva-operations.main.js
  pnpm --filter @adflow/api canva:ops inspect             # read-only queue summary and T1 preview
  pnpm --filter @adflow/api canva:ops run-once            # dry run: the same preview
  pnpm --filter @adflow/api canva:ops run-once --execute  # one batch; calls Canva's revoke endpoint
  pnpm --filter @adflow/api canva:ops maintain --execute  # expiry, abandon, purge, hold sweep; no Canva call
  pnpm --filter @adflow/api canva:ops keys                # key-version inventory and retirement safety
  pnpm --filter @adflow/api canva:ops reseal --execute    # re-encrypt under the current key; no Canva call
  pnpm --filter @adflow/api canva:ops inspect --json      # any command: one JSON report on stdout
  ```

  - **Build prerequisite**: `canva:ops` runs the compiled `dist/canva/oauth/canva-operations.main.js`, so it needs `pnpm --filter @adflow/api build` from the same commit as the running API. A deployment image should contain the built `dist`; there is no ts-node variant.
  - Every command is a dry run unless `--execute` is given. `inspect` and `keys` are read-only and refuse `--execute`; they and the dry runs only read: no locks, no writes, no Canva request. `--json` changes only the output format, never what runs.
  - `runCanvaOperationsProcess` parses the command, validates the whole environment, and applies every refusal before it boots the application context, which is what opens database connections; tests prove that `boot` is never called for a refused command.
  - It refuses before booting anything or opening a database connection: inside a test process (`VITEST` or `NODE_ENV=test`), in mock mode (the development default), and without `CANVA_OAUTH_PERSISTENCE_ENABLED=true`. `run-once --execute` also needs `CANVA_REVOCATION_WORKER_ENABLED=true`.
  - **Exit codes** (Stage 2.8; `CANVA_OPERATION_EXIT_CODES`):

    | Code | Status | Meaning | Scheduler action |
    | --- | --- | --- | --- |
    | `0` | `ok` | Done; nothing needs attention | None |
    | `1` | `failed` | Failed or interrupted (for example a lost database connection, an interrupted reseal, or an application that could not start); every step is resumable | Rerun on the next schedule; alert if repeated |
    | `2` | `refused` | A safety check refused; nothing was done | Alert: configuration drift |
    | `3` | `degraded` | Done, but a degraded state needs attention | Alert; do not retry immediately |

    Before Stage 2.8 a degraded state exited `0`. The degraded states, each defined by a count the command reads:
    - `exhausted_revocations`: `inspect` (and the dry runs) see exhausted rows, or a batch exhausted one;
    - `crashed_calls`: `inspect` sees `in_flight` rows with an expired claim (normally recovered by the next batch; alert only if it persists);
    - `missing_encryption_keys`: a batch could not send because the token's key version is not configured (`keyUnavailable`), `inspect` (and the dry runs) see unfinished revocations last requeued for that reason (`health.revocationKeyUnavailable`), `keys` (or the `reseal` dry run) finds stored values under an unconfigured version, or a reseal counted `missingKey`;
    - `configuration_errors`: a batch got Canva's client-credential refusal (`configurationErrors`), or `inspect` (and the dry runs) see unfinished revocations whose last attempt got it (`health.revocationConfigurationErrors`) or connections whose last token-endpoint refusal was a configuration problem (`health.connectionConfigurationErrors`, the status's `configurationError`);
    - `send_deadline_missed`: a batch did not send because the process stalled past the 5-second send deadline (`abandoned`);
    - `undecryptable_values`: a reseal found values a configured key cannot open.

    In text mode a degraded run ends with `Status: degraded (<reasons>)`.

    **What `inspect` can and cannot see** (Stage 2.8.1). Its `health` counts come from the last recorded outcome of each unfinished revocation (`lastErrorKind`) and each connection (`lastProviderErrorKind`, cleared by the next successful refresh or reconnect). So a configuration problem shows only after a revocation or refresh has actually been refused, and it clears only after the next success. With no queued revocations and no refresh since the credentials broke (for example a client secret rotated at Canva but not in AdFlow), `inspect` reports healthy. It never calls Canva, so it cannot test the credentials itself. A missing encryption key for stored credentials or candidates (rather than queue rows) is visible only to `keys`.
  - **`--json`** prints exactly one line on stdout: a JSON object with `command`, `execute`, `status`, `exitCode`, `degraded` (the reasons above), and, by command, `queue` (`queued`, `inFlight`, `exhausted`, `finished`, `due`, `crashed`, `preview`, and `health` with `revocationConfigurationErrors`, `revocationKeyUnavailable`, and `connectionConfigurationErrors`), `worker` (the batch summary), `maintenance`, `keys` (including `missingKeyVersions`), or `reseal`. Refusals and failures carry a fixed `message` instead. In JSON mode the application's log lines go to stderr, so stdout holds only the report. An application that cannot start is reported as `failed` (exit `1`) with a JSON report, rather than crashing; the context is created with `abortOnError: false`. Example (`inspect --json`, with one exhausted row):

    ```json
    {"command":"inspect","execute":false,"status":"degraded","exitCode":3,"degraded":["exhausted_revocations"],"queue":{"queued":2,"inFlight":0,"exhausted":1,"finished":4,"due":2,"crashed":0,"preview":[{"id":"revocation-1","organizationId":"org-1","reason":"disconnect","state":"queued","attempts":0,"recovering":false,"wouldDo":"send"}],"health":{"revocationConfigurationErrors":0,"revocationKeyUnavailable":0,"connectionConfigurationErrors":0}}}
    ```

  - Output, text or JSON, carries counts, revocation and organization IDs, key versions, and reasons; never tokens, authorization codes, PKCE verifiers, ciphertext, keys, client secrets, Canva IDs, or display names. The JSON report is built field by field, so extra fields a store might return cannot reach it, and a failure's error text is never printed (tests check both).
  - **Shutdown** (Stage 2.11): the report is printed before the application context closes. If `close()` fails, the exit code stays the one the report states (the operation's writes had already committed or not), stdout is unchanged, and stderr gets one fixed line, `Warning: the application did not shut down cleanly; the result reported above stands.`, without the error. Nothing can escape as an unhandled rejection; the entry point sets exit code `1` only if writing the output itself failed, when no report was printed.
  - **Tests of the process wiring** (`canva-operations.cli.spec.ts`): the in-process tests drive `runCanvaOperationsCli`, the function the entry point calls, with a fake application context: one JSON document on stdout, log lines on stderr, exit codes `0`, `1`, and `3`, an application that cannot start, a failed shutdown (exit code unchanged, fixed stderr warning), and redaction. The child-process tests run the real `canva-operations.main.ts` through ts-node, with an environment built from scratch, but **only on paths refused before the application starts** (exit `2`): the real entry point's ok, failed, and degraded paths need a database and have not been run end to end.
- **Scheduling**: see [Scheduling and monitoring (proposal)](#scheduling-and-monitoring-proposal-not-deployed) below. The scheduled command calls the same `runOnce()` and `maintain()`, so the lease, per-user locking, retry, audit, and crash-recovery behavior is unchanged.
- **Policy** (proposal §2.4):
  - at most 8 attempts, counted when a call is started;
  - backoff of `min(60 s × 2^(n−1), 1 h)` with ±20% jitter, or `Retry-After` if longer;
  - a refusal of the client credentials pauses the row for 15 minutes without consuming an attempt, and the row is exhausted once it is 7 days old. That is `401 invalid_access_token`, which [Canva's revoke reference](https://www.canva.dev/docs/connect/api-reference/authentication/revoke-token/) documents for an invalid client secret and for missing credentials (corrected in Stage 2.8: it was treated as an ordinary rejection, which used up attempts and exhausted rows within hours), and the RFC 6749 codes `401 invalid_client` and `400 unauthorized_client`, which the revoke reference does not list but which are kept. Any other `4xx` remains an ordinary, attempt-consuming rejection;
  - 5xx, timeouts, and network failures widen the possible-effect window by 120 seconds;
  - nothing is sent more than 5 seconds after T1 committed.
- **Crashes**: a row left `in_flight` with an expired claim is recovered by the next worker. Its window is extended to `callStartedAt + 135 s`, and the guard runs again before any new call.
- **Exhausted rows** keep their ciphertext and are counted in the status's `exhaustedRevocations`. Each exhaustion writes the audit event `canva.connection.revocation_exhausted` and an error-level log line. An administrator can retry or dismiss the row; `maintain()` abandons it after 30 days.
- **Monitor**:
  - `pendingRevocations` and `exhaustedRevocations` in the status;
  - audit actions `canva.connection.revocation_finished`, `…_exhausted`, `…_retried`, and `…_dismissed`;
  - warn-level logs "revocation not sent", which are expected occasionally (a lost claim or a deadline);
  - repeated `retry_connect` callback outcomes.
- **Maintenance** (`maintain()`): expires candidates and queues their tokens, abandons old exhausted rows, deletes finished rows after 90 days, releases stale account holds, and deletes unheld, unreferenced accounts after 90 days. It makes no external call.
- **Alerts**: see the proposal below.
- **Manual retry procedure**:
  1. Run `canva:ops inspect` and read the preview. `skip_shared_consent` is expected when the Canva user has reconnected; nothing will be sent for that row.
  2. For a due row, run `canva:ops run-once --execute` once and read the summary. Do not loop it: the backoff is stored in `nextAttemptAt`.
  3. For an exhausted row, an administrator uses **Retry** in the Canva panel (or `POST …/revocations/:id/retry`), which resets its attempts and audits `revocation_retried`; the next run sends it. If Canva keeps failing, **Dismiss** deletes the stored token without revoking it (audited); the Canva user can still remove AdFlow from their Canva account.
  4. A client-credential refusal (`401 invalid_access_token`, `401 invalid_client`, or `400 unauthorized_client`) pauses rows for 15 minutes without using attempts (`lastErrorKind = configuration`, `configuration_errors` in `canva:ops`): fix the client credentials first; the rows then retry on their own.

### Scheduling and monitoring (proposal, not deployed)

**Status: proposal only.** Nothing schedules the worker or maintenance today, no monitoring is configured, and nothing here has been run against a real database. Install it only after live use is approved, with `CANVA_OAUTH_PERSISTENCE_ENABLED=true` and `CANVA_REVOCATION_WORKER_ENABLED=true` in that environment. It is deployment-neutral: cron with `flock`, a systemd timer, a Kubernetes CronJob, or a cloud scheduled task all fit.

**Jobs**:

| Job | Schedule | Concurrency | Time limit |
| --- | --- | --- | --- |
| `canva:ops run-once --execute --limit 50 --json` | Every minute | Skip a run while the previous one is still running (`flock -n`, `concurrencyPolicy: Forbid`, or the scheduler's equivalent) | 50 s |
| `canva:ops maintain --execute --json` | Hourly, offset from the worker (for example minute 17) | Same | 10 min |
| `canva:ops inspect --json` | Every 5 minutes | Same | 1 min |
| `canva:ops keys --json` | Daily, and after every key change | Same | 1 min |

- **One scheduled worker per environment**: one job definition, not one per API instance. The in-process triggers on API instances stay on; they only make revocations faster.
- **Overlap is already safe in the database** (claims use `FOR UPDATE SKIP LOCKED` and claim tokens; T2 records only under the matching claim; T1 re-runs the guard), so skip-if-running only saves work. Do not configure automatic retries of a failed run: the next minute is the retry, and a retry loop would ignore the stored backoff.
- **Dropped triggers stop mattering**: a trigger that arrives while a batch runs is dropped by design, and the one-minute schedule picks up any due row within about 60 seconds.
- **50 rows per run** gives 3,000 rows an hour; raise `--limit` (up to 1000) only if `due` keeps growing. Each row's call is bounded by the 10-second request timeout and the 5-second send deadline after T1.

**Crash during a revocation call**: no new code is needed. The row stays `in_flight` with a 60-second claim; the next run claims it as a crashed call, extends its possible-effect window to `callStartedAt + 135 s`, and runs the guard again before any resend. Until then that Canva user cannot reconnect (`retry_connect`). `inspect` reports these as `crashed`.

**Alerts** (on the exit code and the JSON fields):

| Alert | Signal | Threshold |
| --- | --- | --- |
| Failed runs | `run-once` or `maintain` exit `1` | 3 consecutive runs |
| Refused run | any exit `2` | Immediately: configuration drift (flags, mode, or environment) |
| Stale worker | no `run-once` finished with exit `0` or `3` | More than 5 minutes |
| Stuck queue | `inspect`: `queue.due` above 0 and not falling | 3 consecutive inspections |
| Crashed calls | `inspect`: `queue.crashed` above 0 | More than 5 minutes |
| Exhausted retries | `degraded` contains `exhausted_revocations`; the status's `exhaustedRevocations`; audit `canva.connection.revocation_exhausted` | Any: an administrator must retry or dismiss |
| Missing keys | `degraded` contains `missing_encryption_keys` (`worker.keyUnavailable`, `keys.missingKeyVersions`, `reseal.missingKey`) | Any: restore the key version on every instance |
| Configuration errors | `degraded` contains `configuration_errors`; the status's `configurationError` | Any: check the Canva client ID and secret |
| Send deadline | `degraded` contains `send_deadline_missed` | Repeated: the host is stalling |
| Reauthorization required | the status's `reauthorizationRequired` (`rotation_lost`, `invalid_grant`, `undecryptable`, `identity_mismatch`) | Per organization: notify its administrators to reconnect |

**Logging and health**: keep each run's stdout (the JSON report) and stderr (the application log) together with the run's timestamp and exit code. Neither contains tokens, ciphertext, keys, secrets, Canva IDs, or display names. The health check is `inspect --json`: read-only, no locks, no Canva request.

**Recovery**:
- A failed run (`1`): nothing to do; the next run resumes. If it repeats, check database connectivity, then run `inspect`.
- A refused run (`2`): restore the intended configuration; nothing was done.
- Missing keys: restore the key version on every instance, run `keys`, and finish any rotation with `reseal --execute` until `0 remaining`. Never delete rows to clear the alert.
- Exhausted rows: an administrator uses **Retry** or **Dismiss** in the Canva panel (see the manual retry procedure above).
- Never edit `canva_pending_revocations` by hand.

**Pausing revocation sending safely**: set `CANVA_REVOCATION_WORKER_ENABLED=false` on every instance and the scheduler. `run-once --execute` then refuses (exit `2`, so the refused-run alert fires; silence it for the pause), triggers do nothing, and every row stays queued with its ciphertext and attempts. `maintain`, `inspect`, and `keys` keep working. Re-enable the flag to resume; due rows are sent on the next run, with their windows and backoff intact. Do not pause by disabling `CANVA_OAUTH_PERSISTENCE_ENABLED`: that disables the whole real-mode connection flow.

### Key rotation (reseal)

`CanvaTokenResealService` (§5.11) re-encrypts stored Canva values under the current key: credentials, pending candidates, unfinished queue rows (exhausted included), and unconsumed attempt verifiers. It makes no external call. No key rotation has been performed.

**Safe rotation order** (Stage 2.3). Each step is a full deployment to every instance before the next begins, so no instance ever reads a version it lacks, and nothing writes the old key after it is retired:

1. **Pre-stage**: add the new key to `CANVA_TOKEN_ENCRYPTION_PREVIOUS_KEYS` under a new, higher version, keeping the current key current. Every instance can now read rows sealed with either key; all still write the old one. Do not reseal in this state: the reseal refuses while a newer key is only pre-staged.
2. **Promote**: make the new key `CANVA_TOKEN_ENCRYPTION_KEY` with its version in `CANVA_TOKEN_ENCRYPTION_KEY_VERSION`, and move the old key into `CANVA_TOKEN_ENCRYPTION_PREVIOUS_KEYS`. During this rollout, old-configuration instances still write the old key and new ones the new key, and both can read both.
3. **Reseal** once every instance runs the promoted configuration: run `canva:ops reseal --execute` (bounded by `--limit`, default 1000) until it reports `0 remaining`, then `canva:ops keys`.
4. **Retire**: remove the old key only when `keys` reports it `safe to retire` (no row of any kind is sealed with it), in one more deployment. Every instance already writes the new key, so nothing can write the old one afterwards.

Never reuse a version number for a different key: a value sealed with the old key would then fail to open under that version and look corrupt rather than missing.

Guarantees and limits (mocked tests only; gate 5 is the database evidence):

- Each value is opened, sealed again with the same associated data, and verified by opening the new value before anything is written.
- Each write is one conditional statement on the row's key version, and for a credential also its `version`, `writeId`, and no active refresh lease. It never changes `version`, `writeId`, or anything a protocol decision reads, so a concurrent refresh, reconnect, disconnect, consumption, or worker change always wins, and the row is picked up by a later run. Credential reseals are audited (`canva.credential.resealed`) in the same transaction.
- Resumable and idempotent: rows are visited in id order with a cursor; a store failure stops the run (`interrupted`, exit code 1) without a partial write, and a rerun continues.
- **Deviation from §5.11**: a row whose key is not configured, or whose value does not open (bad IV or tag length, non-base64 ciphertext, a failed authentication tag), is counted and left untouched, never marked `undecryptable` or deleted. A key removed too early is an operator error that restoring the key repairs; destroying rows would make it permanent.
- **A missing key fails closed everywhere** (Stage 2.3). No path clears encrypted data or deletes a credential because a key is not configured:
  - refresh: the credential is kept, nothing is marked, and `CanvaKeyUnavailableError` is raised; it becomes usable when the key is configured again. Only a value that a *configured* key cannot open is marked `undecryptable`;
  - revocation worker: the row is requeued after the 15-minute configuration pause without consuming an attempt or opening a window (no request is sent), and counted as `keyUnavailable`. A value that a configured key cannot open is `exhausted` with its ciphertext kept, for an administrator to retry after a fix or to dismiss; it is no longer finished and cleared;
  - reseal: counted and left untouched, as before; rows sealed with a newer key than this process's current one are left alone (`newerKey`), and the reseal refuses to run while a newer key is only pre-staged, so rows never move backwards;
  - disconnect and activation copy ciphertext without opening it; a callback whose verifier cannot be opened answers `failed` (the attempt is single-use anyway).
- **Rolling deployments**: covered by the order above. Tests prove an old-key instance keeps (rather than marks or clears) rows a promoted instance sealed, a promoted instance reads old-key rows and writes the new key, and a pre-staged instance can read new-key rows but refuses to reseal.
- Plaintext exists only in local variables; logs and output carry counts and key versions only.

### Database migration (instructions only, not run)

Two migration files implement the schema:

- `20261027120000_canva_reauthorization_status` adds the enum value. It is separate so the value is committed before anything could use it.
- `20261027120100_canva_oauth_persistence` adds the six connection columns, five tables, indexes, and `ON UPDATE RESTRICT` foreign keys, including unique indexes on `users(id, "organizationId")` and `auth_sessions(id, "userId")`.

Both are additive. Applying them requires separate, explicit approval. Then:

1. Back up the target database and confirm the target (`DATABASE_URL`) is the intended one.
2. `pnpm db:generate` to regenerate the Prisma client. The new stores use raw SQL and do not need it, but other code may.
3. `pnpm db:deploy` (`prisma migrate deploy`) on the approved database. A failed run is recovered with `prisma migrate resolve` (gate F).
4. On a large deployment, the two unique indexes on `users` and `auth_sessions` take table locks. Create them `CONCURRENTLY` in a separate migration instead.

### PostgreSQL gates (how to run later)

**All 27 gates passed on PostgreSQL 18.6 on 2026-10-28 (Stage 2.5)**, on an isolated, disposable cluster. The results, seeds, the defects found in the gates themselves and fixed during the run, and the limits of what the run proves are in [the runbook](canva-postgresql-gate-runbook.md) (§11, §12). **Stage 2.9** reran batches 3 and 6 on a new isolated cluster (PostgreSQL 18.6) after the Stage 2.8 and 2.8.1 changes, with Gate C extended for Canva's documented `401 invalid_access_token`: all 20 selected gates passed (runbook §13). The other batches were not rerun.

The harness (`canva-gate-harness.ts`, `canva-gate-actors.ts`, `commit-drop-proxy.ts`) provides:
- independent one-connection actors, each with `lock_timeout = 5s` and `statement_timeout = 15s`, and an observer that confirms lock waits through `pg_stat_activity`;
- named pause points injected at the store boundary (after a matching statement, holding its locks, or before commit);
- an in-process fake Canva reached only through the injected fetch (it refuses any other host, rotates each refresh token once, records requests by token hash, and can hold, fail, or drop a response), with the global `fetch` stubbed to throw;
- a loopback commit-dropping proxy that withholds a COMMIT (rollback) or cuts the client off after the server has acknowledged it (committed but unconfirmed). It handles both wire protocols: statements are classified when they execute (a simple `Q`, or a `B`ind of a named or unnamed prepared statement), so a cached prepared COMMIT is counted each time and an unnamed one once. Drops are armed by what the transaction executed (`within`, for example the T2 `UPDATE`), not by counting COMMITs. It forwards only to the validated `127.0.0.1` server and forces `sslmode=disable`. Its unit tests use a fake protocol server, never a database.
- **Proxy assumptions, checked at runtime.** How Prisma frames transactions on the wire is not documented, and its compiled engine only shows that it issues explicit `COMMIT`/`ROLLBACK`/`SET TRANSACTION ISOLATION LEVEL` statements. Gates A, B, and O therefore first calibrate against the real server and fail with "Proxy assumption not met: …" unless (1) an autocommitted raw query sends no transaction control, (2) a protocol transaction sends exactly BEGIN and COMMIT, (3) each armed operation really dropped a matching COMMIT, and (4) the client reconnects after a dropped connection. **Prisma's reconnect behavior is not proven** until these gates run on PostgreSQL.
- the invariant checker after every gate in both files: INV-1, INV-3, INV-5 (`checkInvariants`) and INV-2 (reported only), INV-4, INV-6, INV-7 (`checkExtendedInvariants`), plus INV-6 at the moment a revoke reaches the fake.

Every gate creates its own `g<gate>_<epoch>_<random>` schema, applies the reviewed migrations, and drops the schema in `finally` (kept on failure with `ADFLOW_GATE_KEEP=1`; leftovers older than an hour are dropped by the next run). Proxies are closed in `finally`. Rows are backdated with SQL instead of waiting.

**Gate status** (Stage 2.5 results, PostgreSQL 18.6, 2026-10-28):

| Gate | Scenario | Invariants | Setup beyond the harness | Expected result | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | Duplicate and forged state consumption | 1, 3, 5; single use | Holder transaction | One consumer gets the attempt; a wrong cookie matches nothing; verifier cleared | PASS |
| 2 | Two processes refresh at once | 1–7 | Fake holds the token response | One refresh at Canva; version +1; lease cleared; one audit event | PASS |
| 3 | Late writer after a lease takeover | 1–7 | Fake holds, then `invalid_grant`; lease backdated | Late write lands; taker's mark refused; still connected; nothing queued | PASS |
| 4 | Stale refresh after a different-user reconnect | 1–7 | Fake holds the refresh | Write refused; orphan and replaced grant queued for the old user only; worker revokes only the old user | PASS |
| 5 | Reseal versus refresh, both orders, and queue rows | 1–7 | Pause after the reseal listing; two keyrings | Refresh wins or reseal lands first; lease skips; old key safe to retire | PASS |
| 6 | Disconnect versus refresh | 1–7 | Fake holds the refresh | No resurrection; `DISCONNECTED`; disconnect and orphan queued | PASS |
| 7 | Failed audit write in every transaction | 1–7 | Failing audit service | Each of candidate creation, disconnect, activation, reject, mark, refresh, T1, T2 leaves no partial change | PASS |
| 8 | First-connect conflict; stale generation | 1–7 | Pause after the connection lock | One candidate, the other `conflict` with tokens queued; stale confirmation | PASS |
| 9 | Raw-SQL bypass of ownership constraints | 1, 3, 5, 4 | — | Every bypassing insert and update fails | PASS |
| A | Ambiguous commit that committed | 1–7 | Proxy: after-ack, armed by transaction content; calibration | Candidate, activation, and refresh verified by `writeId`; nothing queued or revoked | PASS |
| B | Ambiguous commit that did not commit, unverifiable | 1–7 | Proxy: before-forward, then refuse; calibration | Candidate absent, nothing queued; refresh retryable with `outcomeUnknown`, credential unchanged | PASS |
| C | Response policy, crash recovery, exhaustion | 1–7 | Scripted fake responses; claim backdated | 503/429/401/400/200 policy; one call per T1; exhausted keeps ciphertext | PASS |
| D | Same-user guard | 1–7 | — | Same-user replacement unqueued; queued row skipped; no revoke | PASS |
| E | Randomized lock order | 1–7 after every step | 6 actors, printed seed (`ADFLOW_GATE_SEED`) | No unhandled deadlock; invariants hold | PASS |
| F | Migration safety and failed-migration recovery | Schema equality | (part) a schema without the Canva migrations; (rest) the guarded Prisma CLI runner and `ADFLOW_PG_MIGRATE_RUNNER=run` | Existing rows keep values with new defaults; a migration failing halfway leaves nothing behind, `migrate resolve --rolled-back` and a redeploy produce the reference schema | PASS (both parts; the recovery part with its extra opt-in) |
| G | Browser binding and confirmation | 7 | Playwright's bundled Chromium, two temporary profiles, fake authorize page, web-origin stand-in, authorize override | Only the launching browser completes; wrong host, replay, and injected callbacks consume nothing; acknowledgements required | PASS (Playwright 1.56.1, bundled Chromium 141) |
| H | T1 versus candidate creation, both orders | 1, 3, 5, 2, 4, 6, 7 | Holder transactions | (a) skip, no revoke; (b) `retry_connect`, new grant not queued | PASS |
| I | Revocation in flight or ambiguous versus a new connection | 1–7 | Fake holds or drops the revoke; window moved | Refused inside the window, accepted after | PASS |
| J | Same user, two organizations (and held through a credential or candidate) | 1–7 | Holder transaction | One candidate; `account_unavailable`; nothing queued | PASS |
| K | Replacement versus the released user elsewhere | 1–7 | Pause before the activation commit | Both queued rows skipped; no revoke | PASS |
| L | Refresh versus same-user reconnect versus orphan | 1–7 | Fake holds the refresh | Orphan skipped; new credential refreshes | PASS |
| M | Disconnect versus worker versus reconnect; D14 | 1–7 | Fake holds the revoke | Skip in (a), `retry_connect` in (b); both lineages queued in (c) | PASS |
| N | Claim expiry, fencing, send deadline, F20, F21 | 1–7 | Fake holds; claims backdated; deliberate 3 s and >5 s lock waits | No late send; fenced T2; 60 s claim; lock timeout counts nothing; crash recovered | PASS |
| O | Ambiguous commits in `E`, T1, T2 | 1–7 | Proxy armed by the `E`, T1, and T2 statements; calibration | One queue row; no call after unconfirmed T1; recovered T2 | PASS |
| P | Randomized hold, release, sweep | 1–7 after every step | 4 actors, printed seed | Sweep never releases a referenced hold | PASS |
| Q | Exhausted retention and administrator actions | 1–7 | Rows backdated 31 days | Ciphertext kept, retry resets, dismiss and abandon clear; audited; window kept | PASS |
| R | Account-row deletion versus lock and `E` | 1–7 | Pause after the account insert; sweep actor | Retried onto a fresh row; exactly one queue row | PASS |

Invariants and where each is checked: INV-1 (credential and candidate held by their organization) and INV-4 (uniqueness) are enforced by the database and checked after every gate; INV-2 (no stale holds) is reported, never failed, because stale holds are safe; INV-3 (credential version equals the connection's) and INV-5 (queue ciphertext, attempts, claim) after every gate; INV-6 (no revoke while the user holds a grant; no candidate inside a window) after every gate and at each revoke; INV-7 (no secrets or Canva IDs in audit metadata) after every gate. Concurrency safety is claimed only once these gates pass; the in-memory and scripted doubles prove nothing about PostgreSQL.

**Gate F (rest): the guarded migrate runner** (`src/pg/prisma-migrate-runner.ts`). It can only run `prisma migrate deploy` or `prisma migrate resolve --rolled-back <name>`, and every check runs before a command line exists:
- opt-in: `ADFLOW_PG_GATES=run` **and** `ADFLOW_PG_MIGRATE_RUNNER=run`; never with `NODE_ENV=production`;
- target: `ADFLOW_PG_TEST_URL` must pass the isolated-URL guard (`127.0.0.1:55432`, `*_test`) and must not name a schema itself; the schema must be a gate F schema (`gf_<epoch>_<hex>`), never `public` or another gate's;
- files: a fresh `adflow-gate-f-*` directory directly in the OS temp directory, holding a copy of the schema and migrations; the repository's migrations are never the target; the migration name must exist there;
- process: the server identity check (`assertIsolatedServer`) runs before `spawn`; the child gets an environment built from scratch (`PATH`, the Windows system root, the computed `DATABASE_URL`, Prisma's quiet flags) and no shell, so a developer `DATABASE_URL` or any secret is never inherited.
24 unit tests prove that every refused request never reaches `spawn`. Procedure (not run): with the isolated cluster, set `ADFLOW_PG_TEST_URL`, the marker and data-directory variables, `ADFLOW_PG_GATES=run`, and `ADFLOW_PG_MIGRATE_RUNNER=run`, then `pnpm --filter @adflow/api test:pg src/pg/canva-oauth-gates.pg.spec.ts`. The gate copies the migrations, injects `SELECT 1 / 0` halfway through the persistence migration, deploys (expecting failure), fails explicitly as a *finding* if any of its tables were created (Prisma did not apply it atomically), resolves it as rolled back, restores the file, redeploys, and compares the catalog with a schema built from the same SQL by the harness. Both schemas and the temp directory are removed in `finally`.

**Gate G: browser binding** (`src/pg/canva-browser.pg.spec.ts`, harness `canva-browser-harness.ts`).

- **Status**: reported **PASS in Stage 2.5** (2026-10-28, PostgreSQL 18.6, Playwright 1.56.1 with its bundled Chromium 141, fresh temporary profiles; runbook §11 and §12). That is the only run. Gate G has not been rerun since, and no browser test was run in Stage 2.8 or 2.8.1.
- **Driver**: `playwright` `1.56.1` (exact) is an `apps/api` dev dependency, approved and installed in Stage 2.5. Its browser binaries are in the git-ignored `.playwright-browsers/` cache through `PLAYWRIGHT_BROWSERS_PATH`, never in a user's browser; the gate launches the bundled Chromium only (no `channel`). Without the driver (for example a checkout without `node_modules`), `loadBrowserDriver()` returns null and the gate registers a todo instead of failing.
- **History** (kept for the record): before Stage 2.5 the repository had no headless browser driver and this gate was blocked. The proposal then was the exact-pinned `playwright` package, Chromium only, with the binaries in a git-ignored cache, because gate G must prove what no HTTP-level test can: `SameSite=Lax` and host-only cookies across a top-level form POST and cross-site redirects, with each profile isolated by its own `userDataDir`.

What was built and tested without a browser before the driver existed (19 tests, still run in the default suite): `TempBrowserProfile` creates a fresh profile in the OS temp directory and refuses any path that is not one (the user's Chrome, Edge, or Firefox profile, the home directory, nested or other-prefixed paths), and removes only a gate profile; `FakeAuthorizeServer` plays Canva's authorize page on `127.0.0.1`, refusing an unregistered `redirect_uri` or non-S256 PKCE, and can redirect or capture the callback for replay; `WebOriginStandIn` posts the launch form exactly as the web app does; `loadBrowserDriver()` returns null while the package is absent, so the gate registers a todo instead of failing. The test-only **authorize override** (`CANVA_AUTHORIZE_ENDPOINT`) has no environment variable: `CanvaModule` provides Canva's URL as a constant, only a Nest testing-module override can replace it, and the service refuses to construct (so the application fails to boot) unless the override is plain `http` on `127.0.0.1`, `ADFLOW_PG_GATES=run`, and `NODE_ENV` is not production. Scenarios the gate covers (all passed in Stage 2.5): the normal flow to `pending_confirmation`; a launch on the wrong host (`localhost`) consumes nothing; the victim's callback replayed in a second profile consumes nothing, and the original browser then completes it; an attacker's callback injected into the victim's browser creates nothing for the victim; confirmation requires every acknowledgement.

The gates run only in the `pg` Vitest project, which exists only when `ADFLOW_PG_TEST_URL` is set **and** `ADFLOW_PG_GATES=run`, so a URL left in a shell cannot turn `pnpm test` into a database run. They refuse a production process and any database except `127.0.0.1:55432/*_test` whose comment carries `adflow-isolated-test:<ADFLOW_PG_TEST_MARKER>` and whose data directory equals `ADFLOW_PG_TEST_DATA_DIR`.

Each gate creates its own schema `g<gate>_<epoch>_<random>` and applies every migration to it. Each actor is a separate one-connection client with `lock_timeout = 5s` and `statement_timeout = 15s`, and an observer confirms lock waits through `pg_stat_activity`. After the gate the invariant checker runs, and the schema is dropped; `ADFLOW_GATE_KEEP=1` keeps a failed gate's schema. Schemas left behind for more than an hour are dropped by the next run.

Unit tests (`src/pg/canva-gate-guard.spec.ts`) check these refusals without a database.

**How to run them: [the execution runbook](canva-postgresql-gate-runbook.md)** (cluster requirements, environment variables, preflight checklist, batch order and commands, stop conditions, cleanup, and the result table). Do **not** use `setup-local-postgres.ps1` for the gates: it targets the developer database on port 5432 and runs `prisma migrate deploy` there (earlier versions of this section said otherwise; that was wrong). Never run `test:pg` without a spec file, which would also run the older suites that write into the test database's `public` schema. They were run in Stage 2.5 (runbook §11).

### Remaining steps before real use

1. Done in Stage 2.5: all 27 gates passed on PostgreSQL 18.6 (runbook §11). Rerun them after any change to the stores, the worker, the migrations, Prisma, or PostgreSQL.
2. Install the scheduler and alerts from [the proposal](#scheduling-and-monitoring-proposal-not-deployed). Stage 2.8 added the `--json` report and exit codes they rely on; nothing is installed.
3. Confirm the capabilities response shape and whether `scope` is always returned (assumption A-S1).
4. Register one Canva integration per environment, with the exact redirect URL and the four scopes.
5. Run one consent test with an eligible account, after separate approval.

### Scopes and prerequisites

Requested scopes (`CANVA_OAUTH_SCOPES`), the minimum for brand-template Autofill:

- `brandtemplate:meta:read`: find brand templates
- `brandtemplate:content:read`: read a template's dataset
- `design:content:write`: create the Autofill job

`design:meta:read` is added only if the design's details or URLs are read after the job. `asset:read`/`asset:write` are added only when image or logo fields upload branch assets. The same scopes must be enabled on the app in the Canva Developer Portal.

**`profile:read`** (in `CANVA_OAUTH_SCOPES`): the administrator confirmation needs the Canva display name (`GET /v1/users/me/profile`, `CanvaProfileClient`) and the account's `autofill` and `brand_template` capabilities (`GET /v1/users/me/capabilities`, `CanvaCapabilitiesClient`), and both endpoints require `profile:read`. The stable user and team IDs come from `GET /v1/users/me` (`CanvaIdentityClient`), which needs no scope. All three clients are implemented and tested against an injected fake. The capabilities response is parsed as `{ capabilities: string[] }`; any other shape is refused (assumption A-S1). See [the proposal](canva-oauth-persistence-proposal.md#23-administrator-review-and-confirmation-of-the-canva-identity).

**External prerequisites:**

- **Eligibility:** Canva's current Autofill reference lists availability for users on Canva Pro (including Education and Nonprofits), Canva Teams, or Canva Enterprise, with usage limits planned. Older Canva pages describe it as Enterprise-only. AdFlow therefore checks each account's capabilities at confirmation rather than assuming a plan.
- **Integration type:** private integrations are available only to teams on an Enterprise plan; public integrations must pass Canva's review.
- **Redirect URLs:** local `127.0.0.1` redirect URLs must be removed before review.

**Revocation:** revoking a refresh token at Canva also revokes its lineage and the user's consent for the app. This is why one Canva user may serve only one AdFlow organization, and why AdFlow never revokes a token whose Canva user still has a stored grant.

## Future real-provider requirements

The current adapter is the replacement seam. A real provider must not be enabled until a Canva developer app and an eligible Canva account are confirmed. Canva's current REST API authorization uses OAuth 2.0 Authorization Code with PKCE (S256), `state`, and a registered redirect URI. Keep the authorization-code exchange on the API, validate state, and keep client secrets and access/refresh tokens server-side with encryption at rest. Implement token refresh, revocation, expiry handling, and redacted logs before adding OAuth routes. Do not send a client secret or provider token to the browser.

For an initial design Autofill flow, Canva's current guide lists these scopes for the documented workflow: `design:content:read`, `design:content:write`, `design:meta:read`, `brandtemplate:meta:read`, `brandtemplate:content:read`, and `asset:read`/`asset:write`. The Autofill job creation endpoint specifically requires `design:content:write`; final scope selection must be checked against the exact dataset, template, and asset operations this product will use. Request only the necessary scopes.

The eventual flow should inspect the design or brand-template dataset, submit an Autofill job, persist its provider job ID, and poll the job status endpoint asynchronously. Never block an API request waiting for Canva to finish. Map provider statuses/errors into the existing job model and keep retries idempotent. Do not assume that Canva Autofill is enabled for a particular app or account.

Because a `QUEUED` job can be resumed while an earlier request for it is still in flight, the same job may call `prepareDesign` more than once. The mock is safe because its result is derived only from the revision ID. A real adapter must make repeated calls for the same job produce a single external effect, for example by deriving a provider-side request key from the job ID or by looking up an existing provider job before submitting a new one. It must also reject only when no external effect occurred; a timeout or ambiguous response must not be reported as a definite failure, since that would store `FAILED` for work that may have happened.

Before enabling real access, verify in the Canva Developer Portal that the app has Connect API access and the required scopes, its registered redirect URI matches deployment configuration, and the authorizing account holds the `autofill` and `brand_template` capabilities (checked through `GET /v1/users/me/capabilities`; plan rules are described under [Scopes and prerequisites](#scopes-and-prerequisites)). Run an explicit consent and Autofill test using an eligible account; do not treat mock tests as evidence of provider eligibility.

The real-provider variables are now validated (see [Configuration](#configuration)), but with `CANVA_PROVIDER_MODE=mock`, the default, none of them is used. Supply them from the deployment secret manager and never add development values to source control. The encryption key is separate from the OAuth client secret and supports rotation through key versions.

Official references:

- [Authentication (OAuth, PKCE, refresh)](https://www.canva.dev/docs/connect/authentication/)
- [Generate an access token](https://www.canva.dev/docs/connect/api-reference/authentication/generate-access-token/)
- [Revoke a token](https://www.canva.dev/docs/connect/api-reference/authentication/revoke-token/)
- [Get current user](https://www.canva.dev/docs/connect/api-reference/users/users-me/), [profile](https://www.canva.dev/docs/connect/api-reference/users/users-profile/), and [capabilities](https://www.canva.dev/docs/connect/api-reference/users/get-user-capabilities/)
- [Scopes](https://www.canva.dev/docs/connect/appendix/scopes/)
- [Create design autofill job](https://www.canva.dev/docs/connect/api-reference/autofills/create-design-autofill-job/)
- [Creating integrations](https://www.canva.dev/docs/connect/creating-integrations/) and [security recommendations](https://www.canva.dev/docs/connect/guidelines/security/)

These pages were reviewed on 2026-10-26; the persistence proposal lists exactly what each establishes and what remains unverified.
