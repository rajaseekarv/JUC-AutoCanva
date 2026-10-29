# Proposal: durable storage for real Canva OAuth (revision 5)

**Status: implemented in code and schema files (Stages 2 to 2.3); gated on an isolated test cluster (Stage 2.5); not applied to any real database; not enabled.**

- The schema is in `prisma/schema.prisma`, with two migration files (§15).
- **No migration has been applied to any development, shared, or production database.** The gates applied the migrations only to disposable schemas on a dedicated test cluster created for Stage 2.5.
- The PostgreSQL stores, the worker, the confirmation flow (API and web), the key reseal, and the operator command are implemented and covered by mocked tests and by the PostgreSQL gates.
- The 27 PostgreSQL gates (§10) passed on PostgreSQL 18.6 on 2026-10-28 (Stage 2.5; `canva-postgresql-gate-runbook.md` §11 and §12).

Real mode still fails closed unless `CANVA_OAUTH_PERSISTENCE_ENABLED=true`. Without it, `CanvaModule` wires the "unavailable" stores, so no authorization can start or complete. §15 records how the implementation follows this specification and where it deviates.

**What revision 5 changes** (Stage 1.6 review; documentation only, no application code changed):

- **Revocation timing gap.** The database side is closed by a per-Canva-user row, `canva_accounts`, that every connect, activation, disconnect, and revocation decision locks. A two-transaction revocation protocol records a _possible-effect window_, so a grant obtained while an earlier revocation might still take effect at Canva is discarded, never stored (§2.5, §2.7, §5.10). The external race cannot be made atomic with a database transaction; §11 states exactly what remains.
- **Ownership across pending connections.** One Canva user, one organization, is now enforced by the database across active credentials _and_ pending candidates, through composite foreign keys to `canva_accounts` (§2.2, §3.6). Revision 4's unique index covered active credentials only (finding F12).
- **Identity, profile, capabilities, and scopes.** The remaining clients, the scope check, the confirmation rules, and identity-change behavior are specified (§2.3, §2.8, §8).
- **Exhausted revocations** keep their ciphertext until an administrator retries or dismisses them. Revision 4 cleared it on every finish, which made its own manual retry impossible (F14).
- **Validation plan.** The 16 revision 4 gates are restated with scenario, isolation, invariant, pass condition, and cleanup, and 11 gates are added (§10). §10.4 maps every gate to its actors, invariants, and cleanup.
- **New sections:** guarantees, assumptions, and external races (§11); decision log (§12); risk register (§13); readiness checklist (§14).
- **Final review corrections** (Stage 1.6, applied to this revision):
  - the account lock row can be deleted by the sweep between `INSERT … ON CONFLICT DO NOTHING` and `SELECT … FOR UPDATE`; every account lock now retries on a missing row, and `E` retries on a foreign-key violation (F19, §4, §5.13, gate R);
  - the worker's claim lifetime uses `clock_timestamp()` and T1 has a `lock_timeout`, so a lock wait cannot shorten the claim (F20, §5.10);
  - an `in_flight` row whose worker crashed blocks reconnection of that Canva user until a worker recovers it; a `retry_connect` outcome now triggers the worker (F21, §2.7);
  - a disconnect with a pending candidate for the same Canva user now queues both token sets instead of discarding the candidate's (D14, §5.9);
  - assumption A-R6 and external race X7 record what is left at Canva after a same-user reconnect or disconnect (§11).

## 0. Evidence levels

Every statement is one of four kinds:

- **Official Canva documentation**, with the exact URL. These pages were read on 2026-10-26; no Canva API was called.
- **Offline tooling.** A scratch copy of the schema with this revision applied passes `prisma validate` (Prisma 6.19.3), and `prisma migrate diff --from-schema-datamodel … --to-schema-datamodel …` (schema to schema, no database) produced the additive SQL summarized in §9. The repository's `schema.prisma` was not changed.
- **Verified in code by mocked tests only.**
  - **Token client:** error classification (`canva-token.client.ts`).
  - **Credential contract:** `writeId` and `chainId`, definite versus ambiguous write errors, and verify-before-revoke recovery (`canva-oauth.stores.ts`, `canva-access-token.service.ts`, `canva-oauth.service.ts`).
  - **Identity client:** `GET /v1/users/me` classification (`canva-identity.client.ts`).
  - **Same-user guard:** `revokeUnlessShared` (`canva-revocation.ts`), the only caller of `CanvaTokenClient.revoke`.
  - **Clock:** store-owned state expiry.
  - **Launch URL:** `canvaLaunchUrl`.

  The in-memory double cannot model PostgreSQL locking, commit uncertainty, or cross-process timing, so **no mocked test proves database transaction semantics**. Only the gates in §10 can.

- **Proposed SQL, assumptions, and residual risks.** Everything else, labeled where it appears and collected in §11.

## 1. What Canva's documentation establishes

| Topic                | Fact                                                                                                                                                                                                                                                                                                                                                                                     | Source                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Authorization URL    | `https://www.canva.com/api/oauth/authorize` with `code_challenge`, `code_challenge_method=S256`, space-separated `scope`, `response_type=code`, `client_id`, `state` (recommended), and `redirect_uri` (must be registered). Scopes must also be enabled in the Developer Portal                                                                                                         | https://www.canva.dev/docs/connect/authentication/                                                         |
| PKCE                 | S256 only. The verifier is 43–128 characters from `[A-Za-z0-9-._~]`, unique per request, and must not be accessible to the user or the browser. `state` must not carry the verifier                                                                                                                                                                                                      | https://www.canva.dev/docs/connect/authentication/                                                         |
| Token exchange       | `POST https://api.canva.com/rest/v1/oauth/token`, `application/x-www-form-urlencoded`, Basic client authentication recommended (body credentials are allowed), backend only. `authorization_code` requires `code` and `code_verifier`, and `redirect_uri` if one was sent in the authorization URL                                                                                       | https://www.canva.dev/docs/connect/api-reference/authentication/generate-access-token/                     |
| Token lifetime       | `expires_in`; access tokens are "currently 4 hours" and that is "subject to change". Tokens can be up to 4 KB                                                                                                                                                                                                                                                                            | same                                                                                                       |
| Rotation             | "Each refresh token can only be used once." A refresh returns a new refresh token                                                                                                                                                                                                                                                                                                        | https://www.canva.dev/docs/connect/authentication/                                                         |
| Errors               | 400 `invalid_grant` (for example "Invalid refresh token"), `invalid_request`, `unauthorized_client`, `invalid_scope`, …; 401 `invalid_client`, `invalid_access_token`, `unauthorized_user`; 429 `too_many_requests`                                                                                                                                                                      | https://www.canva.dev/docs/connect/api-reference/authentication/generate-access-token/                     |
| Revocation           | `POST https://api.canva.com/rest/v1/oauth/revoke` with `token`, client authentication, backend only; success is `200` with an empty JSON body. **Revoking a refresh token also revokes its lineage, the access tokens created from it, and the user's consent for the app; the user must authorize again.** 400 `bad_request_params` means "Token is neither an access or refresh token" | https://www.canva.dev/docs/connect/api-reference/authentication/revoke-token/                              |
| Identity             | `GET https://api.canva.com/rest/v1/users/me` returns `team_user.user_id` and `team_user.team_id` and "requires no specific scopes"                                                                                                                                                                                                                                                       | https://www.canva.dev/docs/connect/api-reference/users/users-me/                                           |
| Display name         | `GET https://api.canva.com/rest/v1/users/me/profile` returns `profile.display_name` and requires `profile:read`                                                                                                                                                                                                                                                                          | https://www.canva.dev/docs/connect/api-reference/users/users-profile/                                      |
| Capabilities         | `GET https://api.canva.com/rest/v1/users/me/capabilities` requires `profile:read`. It reports `autofill` ("required to call autofill APIs") and `brand_template` ("required to use brand template APIs")                                                                                                                                                                                 | https://www.canva.dev/docs/connect/api-reference/users/get-user-capabilities/                              |
| Autofill eligibility | `POST https://api.canva.com/rest/v1/autofills` requires `design:content:write`. The reference states availability on "Canva Pro (including Canva Education and Canva for Nonprofits), Canva Teams, or Canva Enterprise" and "Usage limits will be introduced in the future"                                                                                                              | https://www.canva.dev/docs/connect/api-reference/autofills/create-design-autofill-job/                     |
| Integration types    | "Private apps are only available to teams on an Enterprise plan"; public apps must pass review                                                                                                                                                                                                                                                                                           | https://www.canva.dev/docs/connect/creating-integrations/                                                  |
| Local redirect URLs  | The quickstart registers `http://127.0.0.1:3001/oauth/redirect` and advises "Don't use `localhost:3000`". Local domains (`127.0.0.1`, `localhost`) "must" be removed after local development and testing                                                                                                                                                                                 | https://www.canva.dev/docs/connect/quickstart/ and https://www.canva.dev/docs/connect/guidelines/security/ |
| Token storage        | "User access tokens should be encrypted and stored separately from refresh tokens"; "Use a database to store tokens"; delete tokens when no longer needed or when consent is revoked                                                                                                                                                                                                     | https://www.canva.dev/docs/connect/guidelines/security/                                                    |

**Not established by the documentation** (treated as unverified, §11.3):

- what happens when a spent refresh token is reused;
- whether revoking an _access_ token affects the lineage or consent;
- whether revoking an already-revoked token returns `200` or an error;
- the authorization-code and refresh-token lifetimes;
- whether a revocation request can take effect after Canva has answered it, or after the client abandoned it;
- whether consent granted after a revocation was processed survives that revocation;
- the exact JSON shape of the capabilities response;
- whether the token response always includes `scope`, and whether a user can grant fewer scopes than requested.

**Conflicting documentation:** older Canva pages and announcements describe Autofill as Enterprise-only, while the current endpoint and capability references above list Pro, Teams, and Enterprise. This proposal relies on neither claim: eligibility is checked per account with the capabilities endpoint (§2.3).

## 2. Decisions

### 2.1 The OAuth state is created at launch, not at start

**Decision.**

- `POST …/oauth/authorize` creates an _attempt_ holding only ownership, `baseGeneration`, and the hash of a 60-second one-time launch token.
- `POST …/oauth/launch` generates the state, the PKCE verifier, and the browser-binding value, all in the conditional update that consumes the launch token (§5.2). It then redirects to the Canva URL built from them.

**Rationale.**

- The Canva URL needs the raw state, and storing it until launch would add a replayable secret at rest.
- The 10-minute state lifetime starts when the user actually leaves for Canva.
- A leaked launch token is useless after its first use or after 60 seconds.

### 2.2 One Canva user cannot be connected to more than one AdFlow organization

**Decision.**

- Every Canva user ID that AdFlow has seen has one row in `canva_accounts` (§3.6). Its `organizationId` is the **only** organization that may hold that user's credential or pending candidate. `NULL` means no organization holds it.
- Credentials and candidates reference `canva_accounts ("canvaUserId", "organizationId")` with a composite foreign key. The database therefore rejects a credential or candidate for a Canva user held by another organization, and `ON UPDATE RESTRICT` stops the hold from moving or being released while anything still references it.
- `canvaUserId` is also unique within each table: at most one active credential and at most one pending candidate per Canva user.
- Within the holding organization, the credential and one pending candidate for the same Canva user may coexist (a same-user reconnect awaiting confirmation).
- A callback for a Canva user held by another organization ends with the generic outcome `account_unavailable`. Its tokens are **discarded without revocation**, because revoking them would end the other organization's consent.
- **Release:** the transaction that deletes the last credential or candidate for a Canva user sets the hold to `NULL` (§5.5, §5.6, §5.8, §5.9). A missed release, for example after a cascade delete of a `canva_connections` row, leaves a _stale hold_. That only refuses connections, it never allows a second organization. The sweep (§5.13) repairs it.

**Rationale.** Canva documents that revoking a refresh token revokes "the user's consent for your app" (§1). Consent belongs to the Canva user, not to an AdFlow organization. So if one Canva user served two organizations, a disconnect in one would silently break the other. Different Canva users from the same Canva team may serve different organizations.

The generic outcome avoids confirming to one organization that the account is connected elsewhere. **Residual risk:** a timing or uniqueness side channel. This is accepted; the outcome reveals nothing about which organization holds it.

### 2.3 Administrator review and confirmation of the Canva identity

The callback never activates a credential. It stores a **candidate**, and the administrator who started the flow must confirm it in the authenticated web app.

**Scopes (minimum set).** `CANVA_OAUTH_SCOPES` requests exactly:

- `brandtemplate:meta:read`, `brandtemplate:content:read`, and `design:content:write` for Brand Template Autofill;
- `profile:read`, the only scope not used by Autofill itself. It is required by both `/users/me/profile` and `/users/me/capabilities`. Without it there is no display name to confirm and no eligibility check before activation, so it stays.

`design:meta:read`, `asset:read`, and `asset:write` stay excluded until a feature needs them (`canva.md`). Adding any scope requires a proposal update and forces existing connections to reconnect before the new feature can use them.

**Server-side calls at the callback** (§5.4), in order, all through the injected-fetch pattern with a 10-second timeout and `redirect: 'error'`:

| Call                            | Scope          | Required | Failure handling                                                                                                                                                                                                   |
| ------------------------------- | -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/users/me`              | none           | yes      | Identity unknown: discard the tokens, **never revoke**. Outcome `unavailable` if retryable, else `failed` (implemented)                                                                                            |
| `GET /v1/users/me/capabilities` | `profile:read` | yes      | Retryable failure → `unavailable`; definite failure (401, 403, malformed) → `failed`. The identity is known, so the tokens are queued `connect_failed` under the guard                                             |
| Capability check                | —              | yes      | `autofill` or `brand_template` missing → `account_ineligible`; tokens queued `connect_ineligible` under the guard. No candidate is created                                                                         |
| Granted-scope check             | —              | yes      | Token response `scope` reported and missing a requested scope → `insufficient_scope`; tokens queued under the guard. `scope` not reported → candidate stored with empty `scopes`, shown as "not reported by Canva" |
| `GET /v1/users/me/profile`      | `profile:read` | no       | Any failure → display name `NULL`; confirmation then requires an explicit acknowledgement                                                                                                                          |

The display name is untrusted text. It is stripped of C0 and C1 control characters and of Unicode bidirectional overrides and isolates (U+202A–U+202E, U+2066–U+2069), trimmed, and capped at 256 characters; an empty result is `NULL`. It is rendered as text only and never logged or written to audit metadata (§7).

**The confirmation screen** (`GET …/oauth/candidate`, JWT plus `canva:integration:manage`, same user and session as the attempt) shows:

- the Canva display name, prominently;
- the shortened Canva user and team IDs;
- granted versus required scopes, or "not reported by Canva";
- both capabilities;
- the AdFlow organization, who started the flow, and when;
- a countdown to the 10-minute expiry;
- a warning when the Canva user differs from the organization's currently or previously connected user, when the display name is missing, or when scopes were not reported.

**Activation** (`POST …/oauth/candidate/confirm`) requires all of the following, then runs §5.5:

- the same user and session;
- the `canva:integration:manage` permission, re-checked by the JWT guard;
- an unexpired candidate and an unchanged `connectionGeneration`;
- both capabilities, from the values stored at the callback (not re-fetched);
- an explicit boolean acknowledgement in the request body for each warning shown. A missing acknowledgement is a `400` that leaves the candidate in place.

**Reject** (`POST …/oauth/candidate/reject`) runs §5.6.

**Residual risks:** an admin who confirms without reading (hence the mandatory display name, warnings, and acknowledgements), and a capability lost after activation, for example through a plan change. The second surfaces later as a provider error on Autofill jobs and is out of scope for this proposal.

### 2.4 Bounded, durable revocation retries with a visible exhausted state

**Decision.**

- **Attempts:** at most **8**. An attempt is counted when a call is _started_ (§5.10, T1), so a worker that crashes mid-call still consumes one, and a crash loop cannot retry forever.
- **Delay:** after the _n_th failure, wait `min(60 s × 2^(n−1), 1 h)` with ±20% jitter, or `Retry-After` if that is longer. The schedule is written to `nextAttemptAt`, so it survives restarts.
- **Classification** (each response also sets the possible-effect window, §2.7):

| Response                                        | Effect at Canva       | Row result                                                                                                       |
| ----------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `200`                                           | Revoked               | Finished, outcome `revoked`                                                                                      |
| `400 bad_request_params`                        | None (token unusable) | Finished, outcome `not_revocable`. Its meaning for an already-revoked token is unverified (§1)                   |
| `401 invalid_access_token` (Canva's documented code for an invalid or missing client secret; added in Stage 2.8), `401 invalid_client`, `400 unauthorized_client` | None                  | Configuration pause (§5.12): retry in 15 min, attempt refunded. Paused longer than 7 days in total → `exhausted` |
| `429`                                           | Assumed none          | Retry with `Retry-After`                                                                                         |
| Other `4xx`                                     | Assumed none          | Retry, `lastErrorKind = rejected`                                                                                |
| `5xx`, timeout, network, unreadable `2xx`       | **Unknown**           | Retry; ambiguous window                                                                                          |

- **Exhausted:** state `exhausted`, an audit event (`canva.connection.revocation_exhausted`), and an error-level log. The **ciphertext is kept** (still encrypted, still resealed by §5.11), so an admin can act:
  - **Retry** resets `attempts = 0` and the state to `queued` (audited).
  - **Dismiss** clears the ciphertext and finishes the row with outcome `dismissed` (audited).
  - After 30 days an exhausted row is finished automatically as `abandoned` and its ciphertext cleared.
- **Status** shows `pendingRevocations` and `exhaustedRevocations` counts to admins.
- **Retention:** ciphertext is cleared the moment a row finishes; finished rows are deleted after 90 days.

### 2.5 Revocation guard: same Canva user, not just same chain

Because revocation also revokes the user's consent, a refresh token for Canva user U is sent to Canva only when a transaction **holding U's `canva_accounts` row lock** finds **no credential and no candidate for U in any organization** (§5.10, T1). Otherwise the row finishes `skipped_shared_consent` and the token is discarded. Consequences:

- **Reconnect by the same Canva user:** the replaced tokens are discarded, not queued. Revoking them would revoke the new grant's consent.
- **Reconnect by a different Canva user:** the replaced grant is queued for revocation.
- **Disconnect:** queued for revocation, which is intended to end consent; the guard still applies.
- **Identity unknown** (the `/users/me` fetch failed): the tokens are discarded, **never queued**. Without the user ID the guard cannot be applied.

**Everything goes through the durable queue.** With persistence, no request path calls Canva's revoke endpoint. Every token AdFlow gives up is queued in the same transaction as the state change that gave it up (§4), and only the worker's T1 decides whether it is sent.

**Code status (Stage 1.5):** implemented as `revokeUnlessShared` (`canva-revocation.ts`), the only caller of `CanvaTokenClient.revoke`. It asks `CanvaCredentialStore.hasGrantForCanvaUser`; a failing query means discard. That check and the revoke call are separate steps with no shared lock, so it has the timing gap this revision closes. It is safe today only because real mode fails closed. Stage 2 replaces it with enqueueing plus the worker (§8).

### 2.6 Access and refresh tokens are encrypted separately in one row

Canva's guidance is that access tokens "should be encrypted and stored separately from refresh tokens". Each token is sealed independently, with its own IV and its own associated data (`canva:access-token:<org>` and `canva:refresh-token:<org>`), in separate columns.

**Decision:** keep both in one row. A rotation must replace both atomically under one version check, and splitting them across tables would re-introduce torn writes. The residual risk is that read access to the row gives both ciphertexts; neither can be opened without the key.

### 2.7 Possible-effect window: never store a grant that a revocation may still reach

**Problem.** A database lock cannot span an HTTP request. After the worker decides to revoke a token for Canva user U and sends the request, the same Canva user can consent again through a new attempt in any organization. Canva revokes the user's consent, not only the token (§1). If Canva processes the revocation _after_ that new consent, the new grant may be dead even though AdFlow stored it as healthy. Database locking cannot prevent this ordering at Canva.

**Decision.**

1. **Fence before the call.** The worker's T1 commits `state = 'in_flight'` and `callStartedAt = clock_timestamp()` (database time when the statement runs, not the transaction start, which may precede a lock wait) _before_ the request is sent. While a row is `in_flight`, the window is unbounded.
2. **Close the window when the call settles** (T2): `possibleEffectUntil = GREATEST(possibleEffectUntil, end)`, where `end` is:
   - `clock_timestamp()` in T2 for a definite response (`200`, `400`, `401`, `429`, other `4xx`). Assumption A-R1: a revocation cannot take effect after Canva has answered the request.
   - `GREATEST(clock_timestamp(), callStartedAt + 15 s) + 120 s` for an ambiguous outcome (`5xx`, timeout, network failure, unreadable body). Assumption A-R2: Canva does not apply a request more than 120 seconds after the client abandoned it.
   - `callStartedAt + 135 s` when a later worker finds the row `in_flight` with an expired claim (crash or pause). That is the 5-second send deadline, plus the 10-second request timeout, plus the 120-second allowance.
3. **Send deadline.** The worker sends the request only if fewer than 5 seconds of monotonic time have passed since T1 committed; otherwise it abandons the call without sending and the row is recovered as in step 2. This bounds how late a paused process can send.
4. **Check at candidate creation.** In the transaction that would create a candidate for U, after U's account row is locked, any queue row for U with `state = 'in_flight' OR possibleEffectUntil > attempt.launchedAt` means the outcome is **`retry_connect`**. The new tokens are **discarded, never queued**: if the revocation reaches them the grant is already dead, and if it does not, revoking them would kill it.

`attempt.launchedAt` is the database time at which the browser was sent to Canva (§5.2), so consent for this attempt cannot predate it. Comparing the window with `launchedAt`, not with the callback time, keeps the check correct even when the user lingers on Canva's consent page.

**Why the database race is closed.** T1 and candidate creation both lock U's account row first, and each runs its check as a separate statement after the lock. Under `READ COMMITTED` each statement takes a new snapshot, so whichever transaction runs second sees the other's commit:

- **The candidate commits first:** T1 sees it and finishes `skipped_shared_consent`; nothing is sent.
- **T1 commits first:** the candidate transaction sees `in_flight` and returns `retry_connect`.

Activation needs no fence check: the candidate held U from its creation to its conversion into a credential, in one transaction under U's lock, so no T1 for U can have committed in between without seeing it.

**What it does not solve** (§11.4): Canva applying a request later than A-R1 or A-R2 allow; consent granted outside AdFlow's attempts, for example by another deployment that shares the Canva client ID; and a process pause between the send-deadline check and the socket write that exceeds the 120-second allowance.

**Cost.** An admin who connects a Canva user while a revocation for that user is in flight, or within about two minutes of an ambiguous one, gets `retry_connect`, shown generically as "The Canva connection could not be completed. Try again in a few minutes." The message does not reveal where or why the account was revoked.

**Liveness of `in_flight`.** An `in_flight` row is treated as an unbounded window, even though the send deadline and the request timeout bound the call to `callStartedAt + 135 s` under A-R2. That is deliberate: it keeps the check independent of the worker having behaved. The cost is that a crashed worker's row blocks every new connection of U until some worker recovers it. Because there is no scheduler, the callback that returns `retry_connect` runs the worker for U's rows after its transaction has rolled back, so the next attempt a few minutes later finds the row recovered and its window computed (finding F21).

### 2.8 Identity changes on reconnect and disconnect

| Situation                                                | Behavior                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reconnect, same Canva user                               | The candidate may coexist with the credential (§2.2). Activation discards the replaced tokens without queuing them. Rejection or expiry of that candidate also discards its tokens: the credential still holds U, so a revocation would end its consent                                                                                                                             |
| Reconnect, different Canva user                          | Confirmation warns and requires an acknowledgement. Activation deletes the old credential, releases the old user's hold, and queues the old tokens as `replaced_other_user`                                                                                                                                                                                                         |
| Reconnect with a Canva user held by another organization | `account_unavailable`; tokens discarded                                                                                                                                                                                                                                                                                                                                             |
| Disconnect                                               | The credential is deleted, the hold released, and the tokens queued `disconnect`. A pending candidate in the same organization is superseded and its tokens queued too, even for the same Canva user (§5.9, D14)                                                                                                                                                                    |
| Same-user reconnect, old lineage                         | The replaced lineage is discarded, not revoked, so it stays valid at Canva until it expires. Revoking it would end the consent the new grant relies on. This is residual race X7 (§11.4)                                                                                                                                                                                            |
| The disconnected user reconnects before the worker's T1  | The row finishes `skipped_shared_consent`. The old lineage remains valid at Canva until it expires, but AdFlow no longer holds it, and the user has consented again anyway                                                                                                                                                                                                          |
| A stored credential's identity no longer matches         | Not expected within one lineage. Refresh never changes `canvaUserId`, and AdFlow does not re-check identity on refresh. Any later `/users/me` call made with a stored credential that returns a different `user_id` marks `REAUTHORIZATION_REQUIRED` with reason `identity_mismatch` (§5.8), discards the tokens (ownership is unclear, so never revoke), and writes an audit event |
| Canva team change                                        | `canvaTeamId` is informational, stored at activation and not used for ownership                                                                                                                                                                                                                                                                                                     |

## 3. Tables (proposed; validated offline)

All new ownership foreign keys use **`onUpdate: Restrict`**. Prisma's default is `ON UPDATE CASCADE`, which would silently move child rows to another organization if a parent key were ever updated (finding F4). The offline diff of this revision contains no `ON UPDATE CASCADE` on any new constraint.

### 3.1 `canva_oauth_attempts`

```prisma
model CanvaOAuthAttempt {
  id                     String    @id @default(cuid())
  launchTokenHash        String    @unique                 // SHA-256; raw never stored
  stateHash              String?   @unique                 // set at launch
  browserBindingHash     String?                           // set at launch
  organizationId         String
  userId                 String
  sessionId              String
  baseGeneration         Int
  codeVerifierKeyVersion Int?                              // set at launch, cleared at consume
  codeVerifierIv         String?
  codeVerifierCiphertext String?
  codeVerifierTag        String?
  redirectUri            String
  createdAt              DateTime  @default(now())
  launchExpiresAt        DateTime                          // now() + 60 s
  launchedAt             DateTime?
  expiresAt              DateTime?                         // now() + 10 min, set at launch
  consumedAt             DateTime?

  organization Organization              @relation(fields: [organizationId], references: [id], onDelete: Cascade, onUpdate: Restrict)
  user         User                      @relation(fields: [userId, organizationId], references: [id, organizationId], onDelete: Cascade, onUpdate: Restrict)
  session      AuthSession               @relation(fields: [sessionId, userId], references: [id, userId], onDelete: Cascade, onUpdate: Restrict)
  candidate    CanvaConnectionCandidate?

  @@index([organizationId, launchExpiresAt])
  @@index([organizationId, expiresAt])
  @@map("canva_oauth_attempts")
}
```

### 3.2 `canva_connection_candidates`

```prisma
model CanvaConnectionCandidate {
  id                     String   @id @default(cuid())
  organizationId         String   @unique                  // one pending candidate per organization
  attemptId              String   @unique
  userId                 String
  sessionId              String
  baseGeneration         Int
  chainId                String   @unique
  writeId                String   @unique                  // verifies an ambiguous commit
  keyVersion             Int
  accessTokenIv          String
  accessTokenCiphertext  String
  accessTokenTag         String
  refreshTokenIv         String
  refreshTokenCiphertext String
  refreshTokenTag        String
  accessTokenExpiresAt   DateTime
  scopes                 String[]                          // empty: not reported by Canva
  canvaUserId            String   @unique                  // one pending candidate per Canva user
  canvaTeamId            String
  canvaDisplayName       String?                           // sanitized (§2.3); never logged
  hasAutofill            Boolean
  hasBrandTemplates      Boolean
  createdAt              DateTime @default(now())
  expiresAt              DateTime                          // now() + 10 min

  connection CanvaConnection   @relation(fields: [organizationId], references: [organizationId], onDelete: Cascade, onUpdate: Restrict)
  account    CanvaAccount      @relation(fields: [canvaUserId, organizationId], references: [canvaUserId, organizationId], onDelete: Restrict, onUpdate: Restrict)
  attempt    CanvaOAuthAttempt @relation(fields: [attemptId], references: [id], onDelete: Cascade, onUpdate: Restrict)
  user       User              @relation(fields: [userId, organizationId], references: [id, organizationId], onDelete: Cascade, onUpdate: Restrict)
  session    AuthSession       @relation(fields: [sessionId, userId], references: [id, userId], onDelete: Cascade, onUpdate: Restrict)

  @@map("canva_connection_candidates")
}
```

Rows exist only while pending. Confirmation, rejection, expiry, and supersession delete them in the same transaction that activates the credential or queues the tokens. Attempt cleanup (§5.1) must expire candidates (§5.6) before deleting old attempts, because the attempt relation cascades.

### 3.3 `canva_connections`: additive changes

```prisma
enum CanvaConnectionStatus { CONNECTED DISCONNECTED REAUTHORIZATION_REQUIRED }   // value added

model CanvaConnection {
  // existing columns unchanged …
  credentialVersion         Int       @default(0)   // every credential write
  connectionGeneration      Int       @default(0)   // activate, disconnect, mark only
  reauthorizationReason     String?                 // invalid_grant | undecryptable | rotation_lost
  reauthorizationRequiredAt DateTime?
  lastProviderErrorKind     String?                 // configuration
  lastProviderErrorAt       DateTime?
  credential                CanvaCredential?
  candidate                 CanvaConnectionCandidate?
  pendingRevocations        CanvaPendingRevocation[]
}
```

`reauthorizationReason` gains the value `identity_mismatch` (§2.8).

### 3.4 `canva_credentials`

```prisma
model CanvaCredential {
  id                     String    @id @default(cuid())
  organizationId         String    @unique
  connectedById          String
  chainId                String    @unique
  writeId                String
  version                Int
  keyVersion             Int
  accessTokenIv          String
  accessTokenCiphertext  String
  accessTokenTag         String
  refreshTokenIv         String
  refreshTokenCiphertext String
  refreshTokenTag        String
  accessTokenExpiresAt   DateTime
  scopes                 String[]
  canvaUserId            String    @unique                 // decision 2.2
  canvaTeamId            String
  refreshLeaseOwner      String?
  refreshLeaseUntil      DateTime?
  createdAt              DateTime  @default(now())
  updatedAt              DateTime  @updatedAt

  connection  CanvaConnection @relation(fields: [organizationId], references: [organizationId], onDelete: Cascade, onUpdate: Restrict)
  account     CanvaAccount    @relation(fields: [canvaUserId, organizationId], references: [canvaUserId, organizationId], onDelete: Restrict, onUpdate: Restrict)
  connectedBy User            @relation(fields: [connectedById, organizationId], references: [id, organizationId], onDelete: Restrict, onUpdate: Restrict)

  @@index([keyVersion])
  @@map("canva_credentials")
}
```

### 3.5 `canva_pending_revocations`

```prisma
model CanvaPendingRevocation {
  id                     String    @id @default(cuid())
  organizationId         String
  chainId                String
  canvaUserId            String                            // the guard (§2.5) and the window (§2.7)
  reason                 String    // disconnect | replaced_other_user | candidate_rejected | candidate_expired |
                                   // candidate_superseded | connect_conflict | connect_failed |
                                   // connect_ineligible | orphaned_rotation
  state                  String    @default("queued")      // queued | in_flight | exhausted | finished
  keyVersion             Int?
  refreshTokenIv         String?                           // cleared when finished
  refreshTokenCiphertext String?
  refreshTokenTag        String?
  attempts               Int       @default(0)
  nextAttemptAt          DateTime  @default(now())
  claimToken             String?                           // fencing token of the current claim
  claimedUntil           DateTime?
  callStartedAt          DateTime?                         // last T1 (database time)
  possibleEffectUntil    DateTime?                         // §2.7; only ever increases
  outcome                String?   // revoked | not_revocable | skipped_shared_consent | dismissed | abandoned
  lastErrorKind          String?
  createdAt              DateTime  @default(now())
  finishedAt             DateTime?

  connection CanvaConnection @relation(fields: [organizationId], references: [organizationId], onDelete: Cascade, onUpdate: Restrict)
  account    CanvaAccount    @relation(fields: [canvaUserId], references: [canvaUserId], onDelete: Restrict, onUpdate: Restrict)

  @@unique([chainId, reason])                              // idempotent enqueue
  @@index([state, nextAttemptAt])
  @@index([canvaUserId, state])
  @@index([organizationId, finishedAt])
  @@map("canva_pending_revocations")
}
```

**States:**

- `queued` → `in_flight` (T1)
- `in_flight` → `queued` (retry), `finished`, or `exhausted` (T2), or back to `queued` when a crashed call is recovered
- `exhausted` → `queued` (admin retry), or `finished` (dismissed or abandoned)
- `queued` → `finished` (`skipped_shared_consent`, decided in T1 without a call)

`possibleEffectUntil` only ever increases. A finished row still counts toward the window check (§2.7) until it is deleted 90 days later.

### 3.6 `canva_accounts`

```prisma
model CanvaAccount {
  canvaUserId    String   @id
  organizationId String?                                   // the holding organization; NULL = unheld
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  credentials CanvaCredential[]                            // at most one (unique canvaUserId)
  candidates  CanvaConnectionCandidate[]                   // at most one (unique canvaUserId)
  revocations CanvaPendingRevocation[]

  @@unique([canvaUserId, organizationId])                  // target of the composite foreign keys
  @@index([organizationId])
  @@map("canva_accounts")
}
```

This row is both the **ownership record** and the **lock** that serializes every decision about one Canva user. It is created with `INSERT … ON CONFLICT ("canvaUserId") DO NOTHING` before any credential, candidate, or queue row for that user. It deliberately has no foreign key to `canva_connections`: a cascade that set the hold to `NULL` while child rows were still being deleted would depend on the order of referential actions, and a stale hold is the safe failure (§2.2). The row holds only an opaque Canva ID. It is deleted by the sweep (§5.13) when unheld, unreferenced, and older than 90 days.

### 3.7 Ownership constraints

**Database-enforced:**

- Every Canva child row references `canva_connections."organizationId"`, which is unique, so it cannot point at another organization's connection.
- Attempts and candidates reference `users(id, "organizationId")` and `auth_sessions(id, "userId")`, and `connectedById` references `users(id, "organizationId")`.
- **One organization per Canva user, across credentials and candidates:** both reference `canva_accounts("canvaUserId", "organizationId")`, whose primary key is `canvaUserId`. A row for `(U, B)` cannot exist while U's hold is A or `NULL`.
- **No release or move while held:** `ON UPDATE RESTRICT` on those keys rejects changing a referenced hold.
- At most one credential per organization and per Canva user; at most one candidate per organization and per Canva user; `chainId` is unique per table; queue rows are unique per `(chainId, reason)`.
- Queue rows reference `canva_accounts("canvaUserId")` with `ON DELETE RESTRICT`, so the lock row outlives its queue rows.
- All new ownership keys use `ON UPDATE RESTRICT`.

This needs two **additive unique indexes**, `users(id, "organizationId")` and `auth_sessions(id, "userId")`. Both are trivially satisfied, because each `id` is already unique, and the offline diff created both.

**Application-enforced** (dynamic or cross-row; each has a gate in §10):

- The session is active and the user is `ACTIVE` with `canva:integration:manage`, at callback and at confirmation.
- Confirmation is by the same user and session.
- `chainId` values are never reused across tables.
- A hold is set to `NULL` when nothing references it (stale holds are safe and swept).
- The same-user guard and the possible-effect window (§2.5, §2.7) run under U's account lock.
- Refresh writes never change `canvaUserId` (§2.8).

## 4. Locking, write identity, and failure semantics

**Isolation level:** `READ COMMITTED` throughout. Conflicts are serialized by explicit row locks, not by `SERIALIZABLE`.

**Read-after-lock rule:** every check that depends on another transaction's writes is a separate statement issued after the lock statement has returned. Under `READ COMMITTED` that statement takes a fresh snapshot and sees everything committed before the lock was granted. A check folded into the same statement as the lock, or run before it, would not.

**Clock rule:** every time that bounds an external call (`callStartedAt`, and the window end in T2) uses `clock_timestamp()`. PostgreSQL's `now()` is the transaction start, and a lock wait inside the transaction would make it too early, which would shorten the window. Expiry times may use `now()`, because an earlier value only shortens a lifetime. `launchedAt` (§5.2) is a single-statement transaction, and an earlier value only makes the §2.7 check stricter.

**Global lock order** for multi-row writes:

1. the `canva_connections` row (`SELECT … FOR UPDATE`); at most one per transaction
2. `canva_accounts` rows (`INSERT … ON CONFLICT DO NOTHING`, then `SELECT … FOR UPDATE`); when two are needed, in ascending `canvaUserId` order
3. `canva_credentials`
4. `canva_connection_candidates`
5. `canva_oauth_attempts`
6. `canva_pending_revocations` rows (`FOR UPDATE`), then inserts into `canva_pending_revocations` and `audit_logs`

The worker's T1 and T2 take only steps 2 and 6. The lease claim and release (§5.7), the reseal (§5.11), the launch (§5.2), and the queue claim (§5.10) are single statements that hold no other lock.

**Enqueue (`E`)**, used inside the transaction that gives a token up:

```sql
INSERT INTO "canva_accounts" ("canvaUserId") VALUES ($u) ON CONFLICT ("canvaUserId") DO NOTHING;
INSERT INTO "canva_pending_revocations" ("id","organizationId","chainId","canvaUserId","reason", <sealed refresh token>)
  VALUES (…) ON CONFLICT ("chainId","reason") DO NOTHING;
```

`E` takes no account lock; the decision is the worker's. Queuing inside the same transaction means a rollback also un-queues, and a committed give-up is never lost.

**Missing account row (finding F19).** `INSERT … ON CONFLICT DO NOTHING` takes no lock when the row already exists, so the sweep (§5.13) can delete an unheld, unreferenced account row between that statement and the next one. Two rules cover it:

- An account `SELECT … FOR UPDATE` that returns no row means the sweep won. The transaction rolls back and is retried from the start, at most 3 times. Exhaustion is a definite failure.
- `E` that fails with `23503` (foreign-key violation) on `canva_accounts` is retried the same way. If `E` runs inside a larger transaction (§5.6, §5.9), that transaction already holds U's account lock, so the sweep cannot delete the row and this cannot happen; the retry applies to `E` in its own transaction (§5.4 step 4, §5.7 step 7).

**Outcome types.**

- **Definite (nothing written):** an error or zero rows matched before `COMMIT`, a deadlock (`40P01`), a serialization failure (`40001`), a constraint violation, or persistence not configured. Deadlocks and serialization failures retry the database transaction up to 3 times with jitter; exhaustion is still definite.
- **Ambiguous:** connection loss or a timeout after `COMMIT` was sent (including Prisma `P2028` during commit) is reported as `CanvaWriteOutcomeUnknownError`. The caller re-reads and checks its write identity: `writeId` for credentials and candidates (implemented for credentials), `claimToken` plus `state` for queue rows.

**Revocation rule:** only the worker sends revocations, and only under §2.5 and §2.7. A version mismatch, a failed or ambiguous save, a conflict, or a replaced grant never causes one directly.

## 5. Protocols (proposed SQL)

### 5.1 Start: create an attempt

```sql
BEGIN;
INSERT INTO "canva_connections" ("id","organizationId","status","mode")
  VALUES ($id, $org, 'DISCONNECTED', 'CANVA') ON CONFLICT ("organizationId") DO NOTHING;
SELECT "connectionGeneration" FROM "canva_connections" WHERE "organizationId" = $org FOR UPDATE;
DELETE FROM "canva_oauth_attempts"
  WHERE "organizationId" = $org
    AND COALESCE("expiresAt", "launchExpiresAt") < now() - interval '1 day';
SELECT count(*) FROM "canva_oauth_attempts"
  WHERE "organizationId" = $org AND "consumedAt" IS NULL
    AND COALESCE("expiresAt", "launchExpiresAt") > now();           -- >= 20: ROLLBACK, 429
INSERT INTO "canva_oauth_attempts" ("id","launchTokenHash","organizationId","userId","sessionId",
  "baseGeneration","redirectUri","launchExpiresAt")
  VALUES (…, now() + interval '60 seconds');
-- audit canva.oauth.started
COMMIT;
```

The attempt cap is checked under the connection lock, so concurrent starts cannot exceed it.

### 5.2 Launch: create the state

```sql
UPDATE "canva_oauth_attempts"
SET "launchedAt" = now(), "stateHash" = $stateHash, "browserBindingHash" = $bindingHash,
    "codeVerifierKeyVersion" = $k, "codeVerifierIv" = $iv,
    "codeVerifierCiphertext" = $ct, "codeVerifierTag" = $tag,
    "expiresAt" = now() + interval '10 minutes'
WHERE "launchTokenHash" = $launchHash AND "launchedAt" IS NULL AND "launchExpiresAt" > now()
RETURNING "id", "redirectUri";
```

- **No row:** a generic failure; no cookie is set.
- **One row:** set the binding cookie (`HttpOnly`, `SameSite=Lax`, `Path=/api/v1/integrations/canva/oauth`, `Max-Age=600`, `Secure` except on `http://127.0.0.1`) and answer `303` to the Canva URL.

The raw state lives only in this response. The launch endpoint is on the callback's host (`canvaLaunchUrl`), so the cookie is first-party on the callback host. The launch is a form POST, so the token never appears in a URL.

### 5.3 Callback: consume the state

```sql
WITH target AS (
  SELECT * FROM "canva_oauth_attempts"
  WHERE "stateHash" = $stateHash AND "consumedAt" IS NULL AND "expiresAt" > now()
    AND "launchedAt" IS NOT NULL AND "browserBindingHash" = $cookieHash
  FOR UPDATE
)
UPDATE "canva_oauth_attempts" a
SET "consumedAt" = now(), "codeVerifierKeyVersion" = NULL, "codeVerifierIv" = NULL,
    "codeVerifierCiphertext" = NULL, "codeVerifierTag" = NULL
FROM target WHERE a."id" = target."id"
RETURNING target.*;
```

- **Concurrency:** a concurrent duplicate re-evaluates after the first commits and matches nothing.
- **Wrong or missing cookie:** matches nothing, so a leaked state cannot burn the victim's attempt.
- **Verifier:** cleared at consumption.

### 5.4 Callback: create a candidate

Outside any transaction, the callback:

1. Re-checks the principal.
2. Exchanges the code.
3. Fetches `/users/me`. On failure it discards the tokens without queuing them (identity unknown).
4. Fetches `/users/me/capabilities`, checks both capabilities and the granted scopes, and fetches `/users/me/profile` (§2.3). A failure or ineligibility queues the tokens with `E` in its own transaction.
5. Runs a lazy expiry (§5.6) of this organization's expired candidate, if one exists.

```sql
BEGIN;
SELECT "connectionGeneration" FROM "canva_connections" WHERE "organizationId" = $org FOR UPDATE;
SELECT 1 FROM "canva_connection_candidates" WHERE "organizationId" = $org;
--   found, unexpired → queue the new tokens with E (connect_conflict), audit, COMMIT; outcome conflict
--   found, expired   → ROLLBACK, expire it (§5.6), retry this transaction once
INSERT INTO "canva_accounts" ("canvaUserId") VALUES ($u) ON CONFLICT ("canvaUserId") DO NOTHING;
SELECT "organizationId" FROM "canva_accounts" WHERE "canvaUserId" = $u FOR UPDATE;
--   no row (deleted by the sweep) → ROLLBACK, retry (§4, F19)
--   held by another organization → ROLLBACK; outcome account_unavailable; tokens discarded (§2.2)
SELECT 1 FROM "canva_pending_revocations"
  WHERE "canvaUserId" = $u AND ("state" = 'in_flight' OR "possibleEffectUntil" > $attemptLaunchedAt)
  LIMIT 1;
--   found → ROLLBACK; outcome retry_connect; tokens discarded (§2.7)
UPDATE "canva_accounts" SET "organizationId" = $org
  WHERE "canvaUserId" = $u AND "organizationId" IS NULL;      -- no-op when already held by $org
INSERT INTO "canva_connection_candidates" (…, "writeId", "canvaUserId", "expiresAt")
  VALUES (…, now() + interval '10 minutes');
-- audit canva.oauth.pending_confirmation
COMMIT;
```

- **Ambiguous outcome:** re-read by the candidate's `writeId`. Found → `pending_confirmation`. Not found and the re-read succeeded → definite failure: queue the tokens with `E` (`connect_failed`) in a new transaction. Unverifiable → discard the tokens (never queue tokens that may also be stored) and answer `failed`.
- **Callback outcome:** `pending_confirmation`.

**Concurrency, and what enforces it:**

| Race                                                 | Serialized by                                                                          | Result                                              | Database backstop if the check were skipped                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------- |
| Two callbacks, same organization                     | The connection row                                                                     | One candidate; the other gets `conflict`            | `candidates.organizationId` unique                            |
| Two callbacks, same Canva user, two organizations    | U's account row (the first `INSERT` blocks the second on the primary key until commit) | One candidate; the other gets `account_unavailable` | The composite foreign key and `candidates.canvaUserId` unique |
| Callback versus a held user's activation elsewhere   | U's account row                                                                        | `account_unavailable`                               | The composite foreign key                                     |
| Callback versus the revocation worker for the same U | U's account row                                                                        | `skipped_shared_consent`, or `retry_connect` (§2.7) | None: this is a protocol guarantee, proven by gates H and I   |

### 5.5 Confirm and activate

```sql
BEGIN;
SELECT "connectionGeneration", "credentialVersion" FROM "canva_connections"
  WHERE "organizationId" = $org FOR UPDATE;
SELECT * FROM "canva_connection_candidates"
  WHERE "id" = $c AND "organizationId" = $org AND "userId" = $user AND "sessionId" = $session
    AND "expiresAt" > now();                                                    -- none → 404
SELECT "canvaUserId" FROM "canva_credentials" WHERE "organizationId" = $org;    -- old user U0, if any
SELECT 1 FROM "canva_accounts" WHERE "canvaUserId" IN ($u, $u0)
  ORDER BY "canvaUserId" FOR UPDATE;
-- stale generation or missing capabilities: run §5.6 (connect_conflict), COMMIT, respond 409
-- missing acknowledgement: ROLLBACK, respond 400 (candidate kept)
SELECT * FROM "canva_credentials" WHERE "organizationId" = $org FOR UPDATE;
-- existing credential: same user → discard its tokens; different user → E (replaced_other_user, U0)
DELETE FROM "canva_credentials" WHERE "organizationId" = $org;
UPDATE "canva_accounts" SET "organizationId" = NULL
  WHERE "canvaUserId" = $u0 AND $u0 <> $u;                                      -- release U0
INSERT INTO "canva_credentials" (…, "canvaUserId", "version") VALUES (…, $u, $credentialVersion + 1);
UPDATE "canva_connections" SET "status" = 'CONNECTED', "mode" = 'CANVA',
  "connectionGeneration" = "connectionGeneration" + 1, "credentialVersion" = "credentialVersion" + 1,
  "connectedById" = $user, "connectedAt" = now(),
  "reauthorizationReason" = NULL, "reauthorizationRequiredAt" = NULL,
  "lastProviderErrorKind" = NULL, "lastProviderErrorAt" = NULL
  WHERE "organizationId" = $org;
DELETE FROM "canva_connection_candidates" WHERE "id" = $c;
-- audit canva.connection.connected
COMMIT;
```

- The credential's `canvaUserId` cannot change between the plain read and the lock, because every credential write takes the connection lock first (the reseal changes only ciphertext).
- The old credential is deleted **before** U0 is released, and the candidate's hold on U is already `$org`. In either order the database would reject a release while referenced (`ON UPDATE RESTRICT`).
- A stale generation, a racing first-time connect, a disconnect, or a reconnect is caught by `connectionGeneration` (definite `409`). Last-writer-wins is impossible.
- No fence check is needed (§2.7): the candidate has held U since creation.

### 5.6 Reject, expire, or supersede a candidate

One transaction, following the lock order:

1. Lock the connection row, then U's account row.
2. If this organization's credential is also for U (a same-user reconnect), discard the candidate's tokens. Otherwise queue them with `E` (`candidate_rejected`, `candidate_expired`, or `candidate_superseded`).
3. Delete the candidate.
4. If no credential for U remains, release U (`organizationId = NULL`).
5. Write `canva.oauth.candidate_rejected` with `{ reason }`.

Expiry is applied lazily, on start, the callback (§5.4 step 5), candidate read, confirmation, and the worker sweep.

### 5.7 Refresh

1. **Fast path (implemented):** a lock-free read.
2. **Lease claim:** a single statement using database time.

   ```sql
   WITH prior AS (
     SELECT "refreshLeaseOwner" AS previous_owner, "refreshLeaseUntil" AS previous_until
     FROM "canva_credentials" WHERE "organizationId" = $org FOR UPDATE
   )
   UPDATE "canva_credentials" c
   SET "refreshLeaseOwner" = $owner, "refreshLeaseUntil" = now() + interval '60 seconds'
   FROM prior
   WHERE c."organizationId" = $org AND (prior.previous_until IS NULL OR prior.previous_until < now())
   RETURNING c.*, prior.previous_owner IS NOT NULL AS took_over,
             EXTRACT(EPOCH FROM (c."refreshLeaseUntil" - now())) AS seconds_left;
   ```

   - **No row:** poll `read` every 250 ms for up to 15 seconds, then return a retryable error.
   - **Before calling Canva:** re-query `seconds_left`. If fewer than 20 seconds remain, release the lease and retry.

3. **Re-check (implemented):** a fresh token is returned without calling Canva.
4. **Canva call**, outside any transaction.
5. **Write**, following the lock order and conditioned on `version` and `chainId`, never on the lease owner:

   ```sql
   BEGIN;
   SELECT "credentialVersion" FROM "canva_connections" WHERE "organizationId" = $org FOR UPDATE;
   UPDATE "canva_credentials" SET <sealed tokens>, "keyVersion" = $k, "writeId" = $write,
     "version" = $old + 1, "accessTokenExpiresAt" = $exp, "scopes" = $scopes,
     "refreshLeaseOwner" = NULL, "refreshLeaseUntil" = NULL
     WHERE "organizationId" = $org AND "version" = $old AND "chainId" = $chain;   -- 0 rows → ROLLBACK, stale
   UPDATE "canva_connections" SET "credentialVersion" = $old + 1,
     "lastProviderErrorKind" = NULL, "lastProviderErrorAt" = NULL WHERE "organizationId" = $org;
   -- audit canva.credential.refreshed
   COMMIT;
   ```

   A late holder whose version is still current may land its rotation, because discarding a rotation Canva already performed is the worse outcome.

6. **Release** on every other exit: `… WHERE "organizationId" = $org AND "refreshLeaseOwner" = $owner`.
7. **Recovery after a failed write (implemented, with the same-user guard):**
   - Re-read the credential.
   - Our `writeId` is stored: success.
   - Same chain, someone else's write: re-read, and revoke nothing.
   - No credential, or a different chain: the rotated grant is orphaned. Queue it as `orphaned_rotation`; **the same-user guard applies** (§2.5).
   - The re-read fails: revoke nothing; return a retryable error flagged `outcomeUnknown`.
8. **Takeover grace:** a claimant with `took_over` that receives `invalid_grant` waits up to 15 seconds and re-reads before marking (refused-mark handling is implemented).

The orphaned rotation in step 7 is queued with `E` in its own transaction, which takes no account lock; the worker's T1 decides.

### 5.8 Mark reauthorization required

This runs in one transaction, following the lock order:

1. `DELETE … WHERE "version" = $expected`. Zero rows → `ROLLBACK`, return `false` (implemented contract).
2. Set `REAUTHORIZATION_REQUIRED`, the reason, and the time, and advance both counters.
3. Write `canva.connection.reauthorization_required`.

The dead or lost token is not queued. The same transaction releases U's hold unless a candidate for U is pending in this organization. Reason `identity_mismatch` (§2.8) uses the same protocol.

### 5.9 Disconnect

One transaction, following the lock order:

1. Lock the connection row. Read the credential (user U) and any pending candidate (user U2).
2. Lock the account rows for U and U2, in ascending order.
3. Lock the credential, queue its tokens with `E` (`disconnect`), and delete it.
4. A pending candidate is superseded: queue its tokens with `E` (`candidate_superseded`) whether or not U2 = U, then delete it. Revision 5's first draft discarded them when U2 = U, relying on the disconnect's revocation also ending the candidate's lineage. That relies on A-R6, which is unverified, so both lineages are now queued (D14). The guard still applies to each row; when U2 = U the second call is redundant at worst, and A-R3 covers its answer.
5. Release U and U2.
6. Set `DISCONNECTED` and advance both counters.
7. Write `canva.connection.disconnected` with `{ mode, revocation: 'queued' }`.

After commit, run the worker for the new rows immediately. A refresh in flight fails its version check and cannot bring the credential back; its rotation is queued as orphaned.

### 5.10 Revocation worker

**Claim** (a single statement):

```sql
UPDATE "canva_pending_revocations"
SET "claimToken" = $token, "claimedUntil" = now() + interval '60 seconds'
WHERE "id" IN (SELECT "id" FROM "canva_pending_revocations"
  WHERE ("state" = 'queued' AND "nextAttemptAt" <= now()
         AND ("claimedUntil" IS NULL OR "claimedUntil" < now()))
     OR ("state" = 'in_flight' AND "claimedUntil" < now())          -- crashed or paused call
  ORDER BY "nextAttemptAt" LIMIT 10 FOR UPDATE SKIP LOCKED)
RETURNING "id", "canvaUserId";
```

**T1, decide and fence** (for each claimed row):

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';                                     -- a timeout is a definite rollback
SELECT 1 FROM "canva_accounts" WHERE "canvaUserId" = $u FOR UPDATE; -- always exists (queue FK, §3.5)
SELECT * FROM "canva_pending_revocations"
  WHERE "id" = $id AND "claimToken" = $token FOR UPDATE;           -- none → ROLLBACK; claim lost
-- recover a crashed call: state in_flight →
UPDATE "canva_pending_revocations" SET "state" = 'queued',
  "possibleEffectUntil" = GREATEST(COALESCE("possibleEffectUntil", '-infinity'), "callStartedAt" + interval '135 seconds')
  WHERE "id" = $id AND "state" = 'in_flight';
SELECT 1 FROM "canva_credentials" WHERE "canvaUserId" = $u
UNION ALL
SELECT 1 FROM "canva_connection_candidates" WHERE "canvaUserId" = $u LIMIT 1;
--   found → finish: outcome skipped_shared_consent, clear ciphertext, audit; COMMIT; no call
--   attempts >= 8 → state exhausted, audit; COMMIT; no call
UPDATE "canva_pending_revocations"
  SET "state" = 'in_flight', "attempts" = "attempts" + 1, "callStartedAt" = clock_timestamp(),
      "claimedUntil" = clock_timestamp() + interval '60 seconds'
  WHERE "id" = $id;
COMMIT;
```

`claimedUntil` uses `clock_timestamp()` (finding F20). With `now()`, a T1 that waited on U's lock would start its claim at the transaction start and could expire it before the call even began, letting a second worker recover the row and call again. That is not unsafe, because the recovery window covers the first call, but it wastes an attempt and a call. The `lock_timeout` bounds the wait in any case.

**The call**, outside any transaction:

- If more than 5 seconds of monotonic time have passed since T1 committed, abandon it without sending (§2.7 step 3).
- Otherwise, open the refresh token (associated data checked) and call revoke, with a 10-second timeout.

**T2, record:**

```sql
UPDATE "canva_pending_revocations"
SET "state" = $next, "outcome" = $outcome, "lastErrorKind" = $kind, "nextAttemptAt" = $next_at,
    "attempts" = "attempts" - $refund,                       -- 1 for a configuration pause
    "possibleEffectUntil" = GREATEST(COALESCE("possibleEffectUntil", '-infinity'), $effect_end),
    "claimedUntil" = NULL,
    <ciphertext cleared and "finishedAt" = now() when $next = 'finished'>
WHERE "id" = $id AND "claimToken" = $token AND "state" = 'in_flight';
-- audit revocation_finished or revocation_exhausted
```

`$effect_end` follows §2.7 step 2. `claimToken` is kept, so an ambiguous T2 commit can be verified by `claimToken = $token AND state <> 'in_flight'`.

**Failure handling:**

| Failure                                         | Handling                                                                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Claim lost before T1                            | T1 matches no row; skip                                                                                                                      |
| T1 `lock_timeout` on U's account row            | Definite rollback, nothing changed; the claim expires and another pass retries. No attempt is counted                                        |
| T1 commit ambiguous                             | Re-read by `claimToken` and `state = 'in_flight'`. Unverifiable → do not call; the claim expires and the crash recovery applies              |
| Crash or pause after T1, before or after send   | The next claimer sets the 135-second window, re-runs the guard, and may call again. The attempt is already counted                           |
| T2 matches zero rows (claim lost while calling) | Nothing written. The recovering worker's window covers this call: the send deadline (5 s) plus the timeout (10 s) plus the allowance (120 s) |
| T2 commit ambiguous                             | Re-read. Unverifiable → leave it; the row is recovered as a crash, and a repeat call returns `200` or `400` (A-R3)                           |
| Exhausted                                       | §2.4                                                                                                                                         |

**A new connection racing the revocation of the same Canva user:**

| When the candidate transaction gets U's lock                             | Result                                                                |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Row `queued` or claimed, T1 not yet committed                            | Candidate created; T1 then finishes `skipped_shared_consent`; no call |
| T1 committed; call unsettled (`in_flight`)                               | `retry_connect`; new tokens discarded                                 |
| Call settled after this attempt's `launchedAt`, or ambiguous window open | `retry_connect`                                                       |
| Every window for U closed before `launchedAt`                            | Candidate created                                                     |
| Activation of an existing candidate for U                                | Unaffected: T1 sees the candidate and skips                           |
| Refresh of an active credential for U                                    | Unaffected: no row for U can be sent while the credential exists      |

The worker runs after the transaction that queued work, on status reads, and from an operator command. There is no scheduler in the codebase. Every step is idempotent and resumes after a crash.

### 5.11 Key reseal

```sql
UPDATE "canva_credentials"
SET "keyVersion" = $newKey, <ciphertext, IV, and tag for both tokens under the current key>
WHERE "organizationId" = $org AND "version" = $v AND "writeId" = $w AND "keyVersion" = $oldKey
  AND ("refreshLeaseUntil" IS NULL OR "refreshLeaseUntil" < now());
```

It changes neither `version` nor `writeId`.

- **A refresh commits first:** the reseal matches zero rows.
- **The reseal lands first:** the refresh still passes its version check and overwrites the row with tokens sealed under the current key.
- **Lease active:** the reseal is skipped.

Candidates, queue rows, and launched-but-unconsumed attempt verifiers are resealed the same way, conditioned on `id` and `keyVersion`. Rows that can no longer be opened are marked `undecryptable` (§5.8). Old keys are retired only when no row references them.

### 5.12 Configuration-error status

A configuration rejection (`invalid_client`, `unauthorized_client`, …) during refresh or revocation keeps the credential and sets `lastProviderErrorKind = 'configuration'`, throttled to one write per 5 minutes. Status shows `configurationError: true` until a successful refresh or activation clears it. Temporary outages persist nothing.

### 5.13 Account hold sweep

Run by the worker:

1. Select held accounts with no credential and no candidate, `FOR UPDATE SKIP LOCKED`.
2. Re-check in a separate statement (read-after-lock).
3. Set `organizationId = NULL`.

Unheld accounts with no queue rows, no credential, no candidate, and older than 90 days are deleted, again with a read-after-lock re-check (`FOR UPDATE SKIP LOCKED`, then a separate check). The foreign keys reject the delete if a reference appears anyway.

A concurrent `INSERT … ON CONFLICT DO NOTHING` that runs _while_ the delete is uncommitted waits for it and then inserts a fresh row. One that ran _before_ the delete did nothing and took no lock, so its transaction's next `SELECT … FOR UPDATE` finds no row, or its `E` fails `23503`; both are retried (§4, F19). Gate R covers both orders.

## 6. Failure classification

| Situation                                                     | Stored credential                         | Handling                                                                                          | Recovery                                                                        |
| ------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 408/425/429/5xx                                               | Unchanged                                 | Retryable, with `Retry-After` (implemented)                                                       | Automatic                                                                       |
| Network failure, timeout, unreadable 2xx                      | Unchanged; the rotation may have happened | Retryable, `outcomeUnknown` (implemented)                                                         | Automatic. A later `invalid_grant` means the rotation was lost: admin reconnect |
| Other 4xx                                                     | Unchanged                                 | Configuration flag (§5.12)                                                                        | Operator                                                                        |
| `invalid_grant`                                               | Dead                                      | Version-conditioned mark (implemented)                                                            | Admin reconnect                                                                 |
| Undecryptable                                                 | Unusable                                  | Mark `undecryptable` (implemented)                                                                | Admin reconnect or restore the key                                              |
| Stale or ambiguous write after rotation                       | Varies                                    | Verify by `writeId`; queue the orphan with `E`                                                    | Automatic                                                                       |
| Persistence keeps failing after rotation                      | Spent token stored                        | Mark `rotation_lost` when possible                                                                | Admin reconnect                                                                 |
| Lease takeover, then `invalid_grant` after grace              | Spent                                     | Mark                                                                                              | Admin reconnect                                                                 |
| Identity fetch fails at callback                              | None                                      | Discard tokens; never queue                                                                       | Admin retries                                                                   |
| Capabilities fail, ineligible account, or missing scope       | None                                      | Queue tokens under the guard; `unavailable`, `failed`, `account_ineligible`, `insufficient_scope` | Admin retries, or uses an eligible account                                      |
| Canva user held by another organization                       | None                                      | Discard tokens; `account_unavailable`                                                             | That organization disconnects                                                   |
| Revocation for the same Canva user in flight or in its window | None                                      | Discard tokens; `retry_connect`                                                                   | Admin retries after a few minutes                                               |
| Revocation ambiguous or worker crash                          | —                                         | Retry; window extended (§2.7)                                                                     | Automatic                                                                       |
| Revocation exhausted                                          | —                                         | Ciphertext kept; audit; status count                                                              | Admin retry or dismiss                                                          |
| Session revoked between the principal check and the exchange  | —                                         | Accepted window of seconds; confirmation re-checks the session                                    | —                                                                               |

## 7. Audit events

`AuditService` rejects metadata keys matching `/password|secret|token|authorization|cookie|file.?content|upload/i`, and metadata over 4 KB. Every key below passes that rule. System events use `actorUserId: null`. Values never include tokens, codes, states, verifiers, launch tokens, cookie values, ciphertext, Canva display names, or Canva user or team IDs.

| Event                                       | Transaction                                 | Metadata keys                                           |
| ------------------------------------------- | ------------------------------------------- | ------------------------------------------------------- |
| `canva.oauth.started`                       | §5.1                                        | `mode`, `expiresAt`                                     |
| `canva.oauth.pending_confirmation`          | §5.4                                        | `mode`, `expiresAt`, `hasAutofill`, `hasBrandTemplates` |
| `canva.oauth.candidate_rejected`            | §5.5 conflict, §5.6, §5.9                   | `reason`                                                |
| `canva.oauth.failed`                        | Own transaction, attributable failures only | `outcome`                                               |
| `canva.connection.connected`                | §5.5                                        | `mode`, `scopes`, `replacedPrevious`, `sameCanvaUser`   |
| `canva.credential.refreshed`                | §5.7                                        | `fromVersion`, `toVersion`, `scopesChanged`             |
| `canva.connection.reauthorization_required` | §5.8                                        | `reason`                                                |
| `canva.connection.disconnected`             | §5.9                                        | `mode`, `revocation` (`queued`)                         |
| `canva.connection.revocation_finished`      | §5.10 T1 or T2                              | `reason`, `outcome`, `attempts`                         |
| `canva.connection.revocation_exhausted`     | §5.10                                       | `reason`, `attempts`                                    |
| `canva.connection.revocation_retried`       | Admin retry                                 | `reason`, `previousAttempts`                            |
| `canva.connection.revocation_dismissed`     | Admin dismiss or 30-day abandon             | `reason`, `outcome`                                     |
| `canva.credential.resealed`                 | §5.11                                       | `fromKeyVersion`, `toKeyVersion`                        |

Every event shares the transaction of its change, so a rollback removes both. The disconnect records `queued`, and the worker records the outcome, so no event claims a result before it is known. Individual call starts (T1 to `in_flight`) are not audited, only outcomes; the row itself records them.

## 8. Code status

**Implemented (Stage 1.3, mocked tests):**

- `writeId` and `chainId`; definite and ambiguous write errors.
- Verify-before-revoke recovery.
- The `conflict` outcome.
- Store-owned expiry, with `consume(stateHash)` taking no caller time.
- `canvaLaunchUrl`.

**Implemented (Stage 1.5, mocked tests):**

- **F1:** the same-user guard (§2.5), applied to every revocation path: failed or ambiguous saves, conflicts, replaced grants, orphaned rotations, and disconnect.
- **F3:** `profile:read` in `CANVA_OAUTH_SCOPES`, documented in `canva.md`.
- `CanvaIdentityClient` for `/users/me` (injected fetch, mocked tests). The callback stores `canvaUserId` and `canvaTeamId`, and discards the tokens if the read fails.
- The `account_unavailable` callback outcome (`CanvaAccountUnavailableError`).

**Stage 1.6:** documentation only (this revision). No application code changed.

**Stage 2 (implemented; mocked tests only; see §15):** items 1–7 below, plus the PostgreSQL stores, routes, queue, worker, sweep, lease protocol, status fields, and real-mode disconnect from the Stage 2 list. Exceptions:

- the web screens are not built;
- the reseal job (§5.11) is not built;
- `rotation_lost` is a defined reason that no code path emits yet;
- `verifyStoredIdentity` (item 7) exists, but nothing calls it yet.

**Stage 2.1** builds the web screens, the reseal job, and the `rotation_lost` mark (§15.4). `verifyStoredIdentity` stays uncalled by design: its intended caller is the real Autofill provider adapter, once per job before its first design call, and that adapter is not built.

**Must change before persistence work (code only, no database):**

1. **`CanvaProfileClient.displayName(accessToken)`** for `GET /v1/users/me/profile`. Mocked tests:
   - success and request shape: Bearer token, `GET`, no body, `redirect: 'error'`, timeout signal;
   - sanitization: control characters, bidirectional overrides and isolates, whitespace-only, over-long, and non-string values (empty results become `null`);
   - 401, 403 (including a missing `profile:read`), 429 with `Retry-After`, 5xx, network failure and timeout, and a malformed or non-JSON body;
   - no token or response body in errors or logs;
   - refusal in mock mode; the global `fetch` stubbed to throw and never called.
2. **`CanvaCapabilitiesClient.capabilities(accessToken)`** for `GET /v1/users/me/capabilities`, returning `{ autofill, brandTemplate }`, with the same error matrix. Further tests:
   - unknown capability values ignored;
   - a missing or non-array field → `invalid_response`;
   - duplicates tolerated.
     The exact response shape must be confirmed against the reference before implementation (§11.3).
3. **Granted-scope check:** a pure function over the token response's `scope` and `CANVA_OAUTH_SCOPES`. Test reported-and-complete, reported-and-missing, not reported, extra scopes, and duplicate or whitespace-separated values.
4. **Callback outcomes** `pending_confirmation`, `account_ineligible`, `insufficient_scope`, and `retry_connect`. Service tests for each §2.3 row: which calls ran, whether the tokens were discarded or queued, and that nothing calls revoke inline.
5. **Store contract:**
   - replace `hasGrantForCanvaUser` plus the inline `revokeUnlessShared` with enqueueing (`E`) inside the store's write operations;
   - add a `CanvaRevocationWorker` over an injectable queue store, whose pure decision function (response → next state, refund, window end) is unit-tested for every §2.4 row;
   - make the memory double model accounts, candidates, holds, `in_flight`, and windows, so service tests cover `skipped_shared_consent` and `retry_connect`. These remain mocked tests, not database evidence.
6. **Confirmation service:** tests for the same user and session, the permission re-check, expiry, a stale generation, missing capabilities, missing scopes, missing name, a different Canva user (each acknowledgement required), `account_unavailable` at activation, and the same-user reconnect discard.
7. **Identity mismatch:** mark `identity_mismatch`, discard without queuing, audit.

**Stage 2 (after approval):**

- PostgreSQL stores.
- The launch, candidate, confirm, and reject routes.
- The queue, worker, and sweep.
- Lease polling, takeover grace, and release.
- Status fields.
- Real-mode disconnect routing.
- The web Connect, Confirm, Reject, Disconnect, and revocation Retry and Dismiss screens.

## 9. Schema and migration (validated offline, not applied)

The offline `prisma migrate diff` of revision 5 (schema to schema, no database) produced 230 lines of **additive** SQL, in this order:

1. `ALTER TYPE "CanvaConnectionStatus" ADD VALUE 'REAUTHORIZATION_REQUIRED'`. The value is not used in the same migration.
2. `ALTER TABLE "canva_connections" ADD COLUMN …`, six columns with defaults or `NULL`.
3. `CREATE TABLE` for the five new tables, including `canva_accounts`.
4. Unique and plain indexes, including `users_id_organizationId_key` and `auth_sessions_id_userId_key` on existing tables, and `canva_accounts_canvaUserId_organizationId_key`.
5. Foreign keys, including the composite `(canvaUserId, organizationId)` references to `canva_accounts`, the `(userId, organizationId)`, `(sessionId, userId)`, and `(connectedById, organizationId)` references, and the references to `canva_connections."organizationId"`. Every new constraint is `ON UPDATE RESTRICT`.

Nothing is dropped, renamed, or retyped.

**Required adjustments and notes:**

- `onUpdate: Restrict` is now present on every new ownership relation (F4, resolved in the proposed schema).
- Creating the two unique indexes on `users` and `auth_sessions` takes a lock on each table. That is fine at the current size; a large production table would need `CREATE UNIQUE INDEX CONCURRENTLY` in a separate, non-transactional migration.
- The generated SQL contains no explicit transaction. Whether Prisma 6.19 applies each PostgreSQL migration in one transaction is **unverified**. Gate F must cover a deliberately failed migration and `prisma migrate resolve` recovery.

**Open decisions:** none in the design. Approval is still needed for the schema itself, including `canva_accounts`.

## 10. PostgreSQL validation gates (isolated database; not run)

Mocked tests are not evidence for any gate below. None of them has been run.

### 10.1 Harness (applies to every gate)

- **Database:** only the guarded `127.0.0.1:55432` database whose name ends in `_test` and which contains the marker row, checked as in the existing `*.pg.spec.ts` guard. The guard runs before any client connects for writing, and refuses everything else.
- **Isolation:**
  - each gate creates a fresh schema named `g<gate>_<random>` and applies the reviewed migration SQL to it, so no gate shares rows with another or with development data;
  - gates run serially (`fileParallelism: false`).
- **Independent actors:**
  - each "process" is its own `PrismaClient` with `connection_limit=1` and `application_name=gate-<gate>-<actor>`, so every actor is a separate backend connection with its own transactions;
  - actors are sequenced by named pause points injected at the store boundary (for example `after-account-lock`, `after-t1-commit`, `before-commit`). Tests never sleep to create an ordering;
  - an observer connection asserts that a transaction is really waiting (`pg_locks`, and `pg_stat_activity.wait_event_type = 'Lock'`) before releasing the other.
- **Hang protection:** `lock_timeout = 5s` and `statement_timeout = 15s` on every actor, so a lock-order bug fails fast instead of hanging.
- **Fake Canva:**
  - a local HTTP server on `127.0.0.1`, reached through the injected `CANVA_FETCH`, which rewrites only `api.canva.com` URLs to the fake and throws for any other host;
  - it records every request (endpoint, a hash of the token, arrival time) and can hold, delay, fail, or drop responses;
  - the global `fetch` is stubbed to throw.
- **Ambiguous commits:** a local TCP proxy between one actor and PostgreSQL drops the connection right after forwarding `COMMIT`. Whether the commit landed is then read from the observer.
- **Invariant check:** after every gate, and after every step of the randomized gates (E, P), the checker below runs.
- **Cleanup and recovery:**
  - `afterEach` closes every client, the proxy, and the fake server, and drops the gate schema (`DROP SCHEMA … CASCADE`);
  - with `ADFLOW_GATE_KEEP=1` a failed gate's schema is kept for inspection and its name printed;
  - a pre-run sweep drops leftover `g*_` schemas older than one hour, so an aborted run is repaired by the next one;
  - nothing exists outside the test database, and no secret is used. Test keys are generated per run, and fake tokens are random strings.

**Invariant checker:**

| ID    | Invariant                                                                                                                                                                                                                                 | Enforced by              |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| INV-1 | Every credential and candidate `(U, O)` has `canva_accounts(U).organizationId = O`                                                                                                                                                        | Database (foreign key)   |
| INV-2 | A held account has a credential or candidate for U, except stale holds left by a cascade delete (reported, not a failure)                                                                                                                 | Application; sweep       |
| INV-3 | `credential.version = connection.credentialVersion` whenever a credential exists                                                                                                                                                          | Application              |
| INV-4 | At most one candidate per organization and per Canva user; at most one credential per organization and per Canva user                                                                                                                     | Database (unique)        |
| INV-5 | `finished` rows have no ciphertext; `queued`, `in_flight`, and `exhausted` rows have ciphertext; `attempts <= 8`; `in_flight` rows have a `claimToken`                                                                                    | Application              |
| INV-6 | **Revocation safety:** for every revoke the fake received for U, no credential or candidate for U existed when its T1 committed, and every candidate for U created afterwards has `attempt.launchedAt >= possibleEffectUntil` of that row | Application (§2.5, §2.7) |
| INV-7 | No token, code, state, verifier, cookie value, display name, or Canva ID appears in audit metadata or captured logs                                                                                                                       | Application              |

### 10.2 Revision 4 gates, reviewed

Each gate lists its scenario, its sequence, and its pass condition. The invariant checker and the §10.1 cleanup apply to all of them; extra cleanup is noted where needed.

**Gate 1. One-time state consumption; an attacker cannot burn an attempt.**

- **Sequence:** a launched attempt; actors A (correct cookie) and B (wrong cookie) run the §5.3 statement, both paused at `before-commit`; then a third actor C with the correct cookie runs after A commits.
- **Pass:** A returns one row; B and C return none; the verifier columns are `NULL`; the observer saw C waiting on A's row lock before A committed.
- **Change from revision 4:** C was added; revision 4 did not prove that a duplicate blocked and then matched nothing.

**Gate 2. A single refresh across processes.**

- **Sequence:** an expiring credential; A and B run the lease claim at the same pause point.
- **Pass:** exactly one claim; the fake counts one refresh; `version` +1; the lease is cleared; one `canva.credential.refreshed`.

**Gate 3. A late writer after a lease takeover.**

- **Sequence:** A holds the lease and is held in the fake past 60 s (the lease is backdated with SQL instead of waiting); B takes over and gets `invalid_grant`; A resumes within the grace period.
- **Pass:** A's write lands; B's mark is refused; status `CONNECTED`; no queue row.

**Gate 4. A stale write after a reconnect by a different user.**

- **Sequence:** A refresh is in flight; another Canva user's candidate is confirmed (U0 is released).
- **Pass:**
  - the refresh write matches zero rows;
  - the new credential is intact;
  - the orphaned rotation is queued for U0, and the worker revokes it (one revoke, for U0's chain);
  - the new chain is untouched; INV-6 holds.

**Gate 5. Reseal versus refresh.**

- **Sequence:** an old `keyVersion`; the reseal and the refresh interleaved in both orders.
- **Pass:** the final row holds the refresh's tokens under the current key; only the refresh advanced `version`; nothing queued.
- **Extension:** reseal queue rows, including `exhausted` ones, with the same conditions.

**Gate 6. Disconnect versus refresh.**

- **Sequence:** a refresh is in flight; the disconnect commits first.
- **Pass:** no credential; status `DISCONNECTED`; U released; queue rows for the disconnect and the orphaned rotation; no resurrection.

**Gate 7. A failed audit write rolls back.**

- **Sequence:** the audit insert is forced to fail in activation, mark, disconnect, refresh, candidate creation, reject, worker T1 (skip), and worker T2.
- **Pass:** each transaction leaves no partial change to the credential, connection, candidate, account hold, queue, or counters.

**Gate 8. First-connect conflict and generation.**

- **Sequence:** two admins' callbacks in one organization, paused after the connection lock; then a disconnect racing a confirmation.
- **Pass:** one candidate; the other gets `conflict` with its tokens queued; a stale-generation confirmation gets `409`.

**Gate 9. Ownership constraints.**

- **Sequence:** raw SQL inserts that bypass the application:
  - no connection; a cross-organization user; a session belonging to another user; `connectedById` in another organization;
  - a duplicate `canvaUserId`; a candidate `(U, B)` while U is held by A; a credential `(U, A)` while U is unheld;
  - `UPDATE canva_accounts SET "organizationId" = NULL` while referenced; `UPDATE users SET "organizationId"` on a referenced user.
- **Pass:**
  - every bad insert fails its foreign key or unique index, and both updates fail (`ON UPDATE RESTRICT`);
  - deleting a `canva_connections` row cascades to its children and leaves a stale hold, which the sweep releases. Organization deletion is not tested, because `AuditLog` restricts it.

**Gate A. Ambiguous commit that committed.**

- **Sequence:** the proxy drops the connection after `COMMIT` in refresh, activation, and candidate creation.
- **Pass:** each is verified by `writeId`; no revocation; the credential is usable and the candidate confirmable.

**Gate B. Ambiguous commit that did not commit and cannot be verified.**

- **Sequence:** the proxy drops before `COMMIT`, and the re-read is made to fail.
- **Pass:** retryable `outcomeUnknown`; nothing queued and no revocation; the credential is unchanged; a callback's tokens are discarded.

**Gate C. Worker recovery and policy.**

- **Sequence:** queue rows; kill a worker mid-batch; run two workers; fake responses `503`, `429` with `Retry-After`, `401`, `400 bad_request_params`, `200`.
- **Pass:**
  - each T1 leads to at most one call;
  - claims expire and resume;
  - backoff follows §2.4, and `401` refunds the attempt;
  - outcomes are correct; `exhausted` after 8, with its ciphertext kept and an audit event.
- **Change from revision 4:** "each row is processed once" was not achievable, because a crash after sending repeats the call, so it was replaced.

**Gate D. The same-user guard.**

- **Sequence:** the same Canva user reconnects in one organization; separately, a disconnect is queued for U, and U's candidate is created in another organization before T1.
- **Pass:** the replaced tokens are discarded without a queue row; the queued row finishes `skipped_shared_consent`; the fake receives no revoke for U.

**Gate E. Lock order.**

- **Sequence:** randomized concurrent mixes (fixed seed, printed) of activation, mark, disconnect, refresh write, reseal, candidate creation, reject, sweep, and worker T1 and T2, including two-account activations.
- **Pass:** no unhandled `40P01`; retried deadlocks end definitely; INV-1 to INV-6 hold after every step.

**Gate F. Migration safety.**

- **Sequence:** apply the reviewed migration to a schema built from the current migrations, holding existing `canva_connections` rows; repeat with a failure injected halfway.
- **Pass:** existing rows keep their values with the new defaults; a failed run is recoverable with `migrate resolve`, and the schema matches after re-applying.
- **Cleanup:** drop the gate schema even when `migrate resolve` fails.

**Gate G. Browser binding and confirmation.**

- **Sequence:**
  - an isolated headless browser profile (never the user's profile), with the web on `localhost:5173`, the API on `127.0.0.1:3000`, and a fake authorize server;
  - run a normal flow, a wrong-host launch, a launch in a second profile, and injected attacker code.
- **Pass:**
  - the normal flow reaches `pending_confirmation`;
  - the wrong host yields no consumable state;
  - the second profile and the injection produce at most a candidate that only the original session can confirm, showing the foreign display name;
  - the confirmation requires every acknowledgement.
- **Cleanup:** the profile directory is temporary and deleted.

### 10.3 Added gates

**Gate H. Revocation versus candidate creation (database race).**

- **Sequence:** a queued row for U.
  - (a) The callback holds U's lock, paused at `after-account-lock`, while T1 waits (confirmed by the observer).
  - (b) T1 holds U's lock, paused before commit, while the callback waits.
- **Pass:**
  - (a) the candidate is created, T1 finishes `skipped_shared_consent`, and the fake receives no revoke;
  - (b) the callback returns `retry_connect`, no candidate exists, there is no queue row for the new chain, and the fake receives exactly one revoke (the old chain).

**Gate I. Revocation in flight versus a new connection (external race).**

- **Sequence:**
  - (a) The fake holds the revoke response; an attempt for U is launched after T1, and its callback arrives. Then the response is released as `200`; a second attempt is launched after T2.
  - (b) The fake times the revoke out; attempts are launched inside the window and after it (the window end is moved with SQL instead of waiting).
- **Pass:**
  - (a) the first callback returns `retry_connect` and the second creates a candidate;
  - (b) the attempt inside the window is refused and the one after it succeeds;
  - INV-6 holds.

**Gate J. Concurrent callbacks for one Canva user across organizations.**

- **Sequence:** orgs A and B, paused so both reach the account `INSERT` together; repeat with U already held by A through a credential, and through a candidate.
- **Pass:** exactly one candidate; the other callback gets `account_unavailable` with its tokens discarded (no queue row); INV-1 and INV-4 hold.

**Gate K. Activation with replacement, versus the released user connecting elsewhere.**

- **Sequence:** org A replaces U0 with U1. Concurrently, a callback for U0 in org B, and a queued row for U1 from an earlier disconnect elsewhere.
- **Pass:**
  - U1's row finishes `skipped_shared_consent`;
  - for U0, either B's candidate exists and U0's `replaced_other_user` row is skipped, or the row's call settled before B's `launchedAt`, or B got `retry_connect`;
  - INV-6 holds.

**Gate L. Refresh versus a same-user reconnect versus the orphan revocation.**

- **Sequence:** a refresh is in flight; the same Canva user's candidate is confirmed in the same organization; the orphaned rotation is queued for U.
- **Pass:** the orphan finishes `skipped_shared_consent`; the fake receives no revoke; the new credential refreshes successfully.

**Gate M. Disconnect versus the worker versus a reconnect.**

- **Sequence:** the disconnect commits.
  - (a) The worker is paused before T1 while a callback for U in org B creates a candidate.
  - (b) T1 commits first.
- **Pass:** (a) `skipped_shared_consent` and no revoke; (b) the callback returns `retry_connect`. The disconnect's audit records `queued` in both.
- **Variant (c), D14:** org A holds a credential and a pending candidate for the same U when the disconnect commits. Pass: two queue rows (`disconnect`, `candidate_superseded`), both for U, U released, and the fake receives at most one revoke per row, each after its own T1.

**Gate N. Worker lease expiry and fencing.**

- **Sequence:** W1 runs T1 and is paused past `claimedUntil`; W2 claims and recovers. Variants:
  - W1 resumes before sending (its send deadline has passed);
  - W1 resumes after sending, before T2.
- **Pass:**
  - W1 does not send in the first variant;
  - W1's T2 matches zero rows in the second;
  - `possibleEffectUntil >= callStartedAt + 135 s` after recovery;
  - `attempts` equals the number of T1 commits; the fake receives at most one call per T1;
  - the row eventually finishes.
- **Variant, F20:** T1 waits on U's account lock (held by a paused callback) for 3 seconds before it commits. Pass: `claimedUntil - callStartedAt` is 60 s, not 57 s, and no second worker claims the row while W1 is inside its send deadline. A second run holds the lock past 5 s: T1 times out, `attempts` is unchanged, and nothing is sent.
- **Variant, F21:** W1 crashes after T1 (the row stays `in_flight`, claim expired); a callback for U gets `retry_connect` and runs the worker. Pass: the row is recovered with its 135-second window, and a second attempt launched after that window creates a candidate.

**Gate O. Ambiguous commits on the revocation path.**

- **Sequence:** the proxy drops after `COMMIT` in `E`, T1, and T2, then the same before `COMMIT`.
- **Pass:**
  - `E` retried → one row (`ON CONFLICT`);
  - an unverifiable T1 → no call;
  - an unverifiable T2 → recovered as a crash, and a repeat call is answered `200` or `400`;
  - INV-5 and INV-6 hold.

**Gate P. Hold, release, and sweep consistency.**

- **Sequence:** randomized mixes of candidate creation, reject, expiry, activation, disconnect, mark, and the sweep across three organizations and three Canva users.
- **Pass:** the sweep never releases an account that is still referenced (read-after-lock re-check); INV-1, INV-2, and INV-4 hold after every step; no unhandled deadlock.

**Gate Q. Exhausted retention and administrator actions.**

- **Sequence:** 8 failures; then an admin retry; then exhaustion again and a dismiss; then a third row backdated 30 days and swept.
- **Pass:**
  - `exhausted` keeps its ciphertext;
  - the retry resets `attempts` and resumes;
  - dismiss and abandon clear the ciphertext;
  - each action writes its audit event;
  - the window from earlier calls is preserved.

**Gate R. Account-row deletion versus lock acquisition (finding F19).**

- **Sequence:** an unheld, unreferenced account row for U, backdated past 90 days.
  - (a) The callback runs its `INSERT … ON CONFLICT DO NOTHING` (row exists, no lock taken) and pauses at `after-account-insert`; the sweep deletes and commits; the callback resumes.
  - (b) The sweep's delete is paused before commit; the callback's insert is observed waiting on it; the sweep commits.
  - (c) As (a), but with `E` in its own transaction (a `connect_failed` enqueue) instead of the callback.
- **Pass:**
  - (a) the callback's `SELECT … FOR UPDATE` returns no row, it retries, and ends with a candidate on a fresh account row;
  - (b) the insert creates a fresh row and the callback proceeds without a retry;
  - (c) the queue insert fails `23503`, the retry inserts both rows, and exactly one queue row exists;
  - in all three, no queue row, credential, or candidate references a missing account, and INV-1 holds.

### 10.4 Gate matrix

Every gate runs in its own `g<gate>_<random>` schema with the §10.1 guard, timeouts, fake Canva, and teardown. "Actors" are separate `PrismaClient` connections (`connection_limit=1`); "obs" is the observer connection that confirms lock waits. Extra cleanup is listed only where §10.1 is not enough.

| Gate | Scenario covered                                                     | Actors                                     | Invariants checked         | Extra cleanup or recovery                      |
| ---- | -------------------------------------------------------------------- | ------------------------------------------ | -------------------------- | ---------------------------------------------- |
| 1    | Duplicate and forged state consumption                               | A, B, C, obs                               | INV-7; single consumption  | —                                              |
| 2    | Two processes refresh at once                                        | A, B, obs                                  | INV-3, INV-7               | —                                              |
| 3    | Late writer after a lease takeover                                   | A, B                                       | INV-3                      | Lease backdated with SQL; no wall-clock wait   |
| 4    | Stale refresh after a different-user reconnect                       | refresh, confirm, worker                   | INV-1, INV-3, INV-6        | —                                              |
| 5    | Reseal versus refresh, both orders                                   | reseal, refresh                            | INV-3, INV-5               | Per-run test keys discarded                    |
| 6    | Disconnect versus refresh                                            | refresh, disconnect                        | INV-1, INV-2, INV-3, INV-5 | —                                              |
| 7    | Failed audit write in every transaction                              | one actor per transaction, obs             | INV-1 to INV-5             | Audit fault trigger dropped with the schema    |
| 8    | First-connect conflict; stale generation                             | two callbacks, disconnect, confirm         | INV-1, INV-4               | —                                              |
| 9    | Raw-SQL bypass of ownership constraints                              | one raw-SQL actor                          | INV-1, INV-4               | —                                              |
| A    | Ambiguous commit that committed                                      | actor behind proxy, obs                    | INV-1, INV-3, INV-6        | Proxy closed in `afterEach`                    |
| B    | Ambiguous commit that did not commit, unverifiable                   | actor behind proxy, obs                    | INV-3, INV-5, INV-6        | Proxy closed in `afterEach`                    |
| C    | Worker crash, two workers, response policy, exhaustion               | W1, W2, obs                                | INV-5, INV-6               | Killed worker's client force-closed            |
| D    | Same-user guard                                                      | callback (two orgs), disconnect, worker    | INV-1, INV-6               | —                                              |
| E    | Randomized lock order                                                | 6 to 8 actors, seeded                      | INV-1 to INV-6, every step | Seed printed for replay                        |
| F    | Migration and failed-migration recovery                              | migrator, obs                              | Schema equality            | Schema dropped even if `migrate resolve` fails |
| G    | Browser binding and confirmation                                     | two headless profiles, API, fake authorize | INV-7                      | Temporary profile directories deleted          |
| H    | Revocation T1 versus candidate creation, both orders                 | callback, worker, obs                      | INV-1, INV-6               | —                                              |
| I    | Revocation in flight or ambiguous versus a new connection            | callbacks, worker, fake holds or times out | INV-6                      | Window moved with SQL; held responses released |
| J    | Same Canva user, two organizations, concurrent callbacks             | callback A, callback B, obs                | INV-1, INV-4               | —                                              |
| K    | Activation with replacement versus the released user elsewhere       | confirm, callback, worker                  | INV-1, INV-2, INV-6        | —                                              |
| L    | Refresh versus same-user reconnect versus the orphan revocation      | refresh, confirm, worker                   | INV-3, INV-6               | —                                              |
| M    | Disconnect versus worker versus reconnect; same-user candidate (D14) | disconnect, worker, callback               | INV-2, INV-5, INV-6        | —                                              |
| N    | Worker claim expiry, fencing, lock wait, crash recovery              | W1, W2, callback, obs                      | INV-5, INV-6               | Claims backdated with SQL                      |
| O    | Ambiguous commits in `E`, T1, and T2                                 | actor behind proxy, worker, obs            | INV-5, INV-6               | Proxy closed in `afterEach`                    |
| P    | Randomized hold, release, and sweep                                  | 4 to 6 actors, seeded                      | INV-1, INV-2, INV-4        | Seed printed for replay                        |
| Q    | Exhausted retention, admin retry and dismiss, 30-day abandon         | worker, admin actor                        | INV-5, INV-6, INV-7        | Rows backdated with SQL                        |
| R    | Account-row deletion versus lock acquisition and `E`                 | callback or `E`, sweep, obs                | INV-1                      | —                                              |

**Coverage of the Stage 1.6 races:**

| Race                                         | Gates      |
| -------------------------------------------- | ---------- |
| Revocation versus pending-candidate creation | H, I, M, R |
| Revocation versus activation                 | D, K       |
| Revocation versus refresh                    | 4, L       |
| Revocation versus disconnect                 | 6, M       |
| Worker claim expiry and fencing              | C, N       |
| Ambiguous commits                            | A, B, O    |
| Cross-organization ownership                 | 9, J, P    |

## 11. Guarantees, assumptions, and external races

### 11.1 Guaranteed by the database (once the schema is applied; gate 9)

- A Canva user's credential and pending candidate can only belong to the one organization that holds the user, and the hold cannot move or be released while referenced.
- At most one pending candidate and at most one credential per organization and per Canva user.
- Ownership keys cannot be re-pointed (`ON UPDATE RESTRICT`).
- A queue row cannot outlive its account lock row.

### 11.2 Guaranteed by the protocol, under the lock order and read-after-lock rule (gates E, H, J, K, M, N, P, R)

- No revocation is decided while a credential or candidate for the same Canva user exists, in any organization.
- No candidate is created for a Canva user while a revocation for that user is `in_flight`, or after a revocation window that overlaps the attempt.
- Every token AdFlow gives up is queued in the same transaction that gave it up, or deliberately discarded (identity unknown, shared consent, unverifiable commit); none is revoked inline.
- Activation, reject, expiry, disconnect, and mark keep the hold, the credential, and the candidate consistent in one transaction.

### 11.3 Assumptions (not verified; each needs confirmation or explicit acceptance)

- **A-R1:** a revocation cannot take effect at Canva after Canva has answered the request.
- **A-R2:** Canva does not apply a revocation more than 120 seconds after the client abandoned the request.
- **A-R3:** revoking an already-revoked or spent token returns `200` or `400 bad_request_params` and has no further effect.
- **A-R4:** consent granted after a revocation was processed is not affected by it.
- **A-R5:** `429` and other `4xx` responses mean the revocation did not happen.
- **A-R6:** revoking one refresh token ends every other lineage of the same Canva user for this app, because it revokes the consent. AdFlow does not rely on it: D14 queues every lineage it gives up, and a same-user reconnect cannot be revoked anyway (X7).
- **A-S1:** the token response reports granted scopes (otherwise confirmation requires an acknowledgement), and the capabilities response shape matches §8.
- **A-I1:** `user_id` is stable for a Canva user and never reused (the `[\w-]{1,256}` format check is AdFlow's, not Canva's).
- **A-D1:** database time is the only clock used for windows and expiry; a worker's local clock is used only for the monotonic send deadline.
- The revision 4 assumptions about Canva, browsers, and Prisma also remain:
  - reuse of a spent refresh token; access-token revocation; the code and refresh-token lifetimes; the redirect method; `localhost` redirect URLs; the conflicting eligibility pages;
  - cookies on cross-site top-level form-POST responses and `Lax` cookies on Canva's redirect, in Chrome, Firefox, and Safari; Chrome's public-to-loopback rules (gate G);
  - Prisma's per-migration transactions (gate F), its mapping of commit failures (gates A, B, O), raw SQL for the CTE and `SKIP LOCKED` statements, and `ON CONFLICT` used in raw SQL rather than `upsert`.

### 11.4 Unavoidable external races (residual risk, with the safer behavior chosen)

| ID  | Race                                                                                               | Safer behavior chosen                                                                  | Residual effect                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| X1  | Canva applies a revocation later than A-R1 or A-R2 allow, after the same user consented again      | The window is conservative (135 s from call start); new grants inside it are discarded | A stored grant could be dead. Its first refresh gets `invalid_grant` → reauthorization required. Availability only |
| X2  | The same Canva user consents through another deployment or tool that shares the Canva client ID    | Use one Canva integration (client ID) per environment (§14)                            | A revocation here may end consent there, outside AdFlow's view                                                     |
| X3  | A worker pauses between the send-deadline check and the socket write for longer than the allowance | 5-second send deadline; 120-second allowance                                           | Same as X1; requires a pause of over 2 minutes in a window of microseconds                                         |
| X4  | A disconnected user reconnects before the worker's T1                                              | Skip the revocation (never risk the new consent)                                       | The old lineage stays valid at Canva until it expires; AdFlow holds no copy                                        |
| X5  | A revocation stays ambiguous and then exhausts                                                     | Ciphertext kept; admin retry or dismiss                                                | The token may or may not be revoked; the user can also remove the app in Canva                                     |
| X6  | A user revokes the app in Canva while AdFlow holds a credential                                    | Detected on the next refresh (`invalid_grant` → mark)                                  | The connection shows as connected until then                                                                       |
| X7  | A same-user reconnect replaces a lineage that cannot be revoked without ending the new consent     | Discard, never revoke (§2.8)                                                           | The old lineage stays valid at Canva until it expires, unless A-R6 holds; AdFlow keeps no copy                     |
| X8  | A worker crashes after T1 and no worker runs for a long time                                       | `in_flight` blocks new connections of U; `retry_connect` runs the worker (F21)         | Availability only: U cannot be connected until the row is recovered                                                |

## 12. Decision log

| ID  | Decision                                                                                                     | Revision | Alternatives rejected, and why                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Create the state at launch (§2.1)                                                                            | 3        | Creating it at start would store a replayable secret, and the lifetime would start too early                                                                                                                                         |
| D2  | One Canva user per organization (§2.2)                                                                       | 3        | Sharing a user would couple consent across organizations                                                                                                                                                                             |
| D3  | Authenticated confirmation with the display name, capabilities, and scopes (§2.3)                            | 3, 5     | Auto-activation allows account substitution                                                                                                                                                                                          |
| D4  | Bounded durable retries, 8 attempts (§2.4)                                                                   | 3        | Unbounded retries hide failures; immediate-only revocation loses work on a crash                                                                                                                                                     |
| D5  | Same-user guard (§2.5)                                                                                       | 4        | A chain-only guard revokes the consent of the user's newer grant                                                                                                                                                                     |
| D6  | Separately sealed tokens in one row (§2.6)                                                                   | 4        | Separate tables reintroduce torn rotations                                                                                                                                                                                           |
| D7  | `canva_accounts` as the ownership record and per-user lock, with composite foreign keys (§3.6)               | 5        | A unique index on credentials only misses candidates; advisory locks are invisible to constraints and easy to bypass; `SERIALIZABLE` alone does not stop check-then-insert across two tables without predicate locks on every reader |
| D8  | Two-transaction worker with a possible-effect window; discard and `retry_connect` inside the window (§2.7)   | 5        | Holding the lock across the HTTP call cannot make it atomic and blocks callbacks; accepting the grant would store a possibly dead credential                                                                                         |
| D9  | All revocations through the queue, enqueued in the giving-up transaction (§4)                                | 5        | Inline revocation has the timing gap and is lost on a crash                                                                                                                                                                          |
| D10 | Exhausted rows keep their ciphertext for 30 days (§2.4)                                                      | 5        | Clearing it on exhaustion made manual retry impossible                                                                                                                                                                               |
| D11 | Capabilities and scopes checked at the callback; ineligible accounts get no candidate (§2.3)                 | 5        | Creating a candidate that can never be confirmed holds the user for 10 minutes                                                                                                                                                       |
| D12 | `READ COMMITTED` with explicit locks and read-after-lock statements (§4)                                     | 5        | `SERIALIZABLE` adds retries without removing the need for the account lock                                                                                                                                                           |
| D13 | `clock_timestamp()` for every time that bounds an external call (§4)                                         | 5        | `now()` is the transaction start and can precede a lock wait, which would shorten the window                                                                                                                                         |
| D14 | A disconnect queues a same-user pending candidate's tokens instead of discarding them (§5.9)                 | 5        | Discarding relied on A-R6 (unverified); an extra guarded call costs one request                                                                                                                                                      |
| D15 | Treat `in_flight` as an unbounded window and repair liveness by running the worker on `retry_connect` (§2.7) | 5        | Bounding `in_flight` at `callStartedAt + 135 s` in the candidate check would make safety depend on the worker honoring its send deadline                                                                                             |

## 13. Risk register

| ID  | Severity | Risk or finding                                                                                                                                                                               | Mitigation                                                                                | Status              | Residual                                                             |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------- |
| F1  | High     | Revoking a refresh token revokes the lineage _and the user's consent_; Stage 1.3 code revoked by `chainId` alone                                                                              | Same-user guard (§2.5); implemented with mocked tests                                     | Mitigated in code   | Timing gap (F13) until the queue exists; unreachable (fail closed)   |
| F2  | High     | `canva.md` said Autofill requires Canva Enterprise; current references list Pro, Teams, and Enterprise, and older pages conflict                                                              | `canva.md` corrected; per-account capability check (§2.3)                                 | Closed in docs      | Plan-based usage limits announced                                    |
| F3  | Medium   | `display_name` and capabilities require `profile:read`                                                                                                                                        | Scope added in code (Stage 1.5)                                                           | Closed              | One more consent scope shown to users                                |
| F4  | Medium   | The offline migrate diff generated `ON UPDATE CASCADE` on ownership foreign keys                                                                                                              | `onUpdate: Restrict` in the proposed schema; the revision 5 diff has no cascade on update | Closed in design    | Must be kept when the schema is applied (gate 9)                     |
| F5  | Medium   | Canva: access tokens "should be … stored separately from refresh tokens"                                                                                                                      | Separately sealed columns (§2.6)                                                          | Accepted            | Row-level read access exposes both ciphertexts (still key-protected) |
| F6  | Medium   | Reuse and idempotent revocation behavior are undocumented                                                                                                                                     | Grace period, `not_revocable`, bounded retries, A-R3                                      | Open                | Confirmed only against a fake server (gate C)                        |
| F7  | Medium   | Consent is per Canva user                                                                                                                                                                     | One user per organization, now including candidates (D7)                                  | Closed in design    | Uniqueness side channel                                              |
| F8  | Low      | The generated migration has no explicit transaction                                                                                                                                           | Gate F and `migrate resolve`                                                              | Open                | Unverified Prisma behavior                                           |
| F9  | Low      | Index creation on `users` and `auth_sessions` locks those tables                                                                                                                              | `CONCURRENTLY` for large deployments                                                      | Accepted            | Brief locks                                                          |
| F10 | Low      | Local `127.0.0.1` redirect URLs must be removed before public review                                                                                                                          | Checklist (§14)                                                                           | Open                | Operational                                                          |
| F11 | Low      | Private integrations require an Enterprise team                                                                                                                                               | Choose the integration type (§14)                                                         | Open                | Operational                                                          |
| F12 | High     | Revision 4 enforced one-organization-per-user only on active credentials; candidates for the same user could exist in two organizations, and the §5.4 check was an unlocked check-then-insert | `canva_accounts` with composite foreign keys and a per-user lock (D7)                     | Closed in design    | Stale holds (safe; swept)                                            |
| F13 | High     | Revocation timing gap: the guard's check and the revoke call are not atomic, and Canva can apply the revocation after a new consent                                                           | Account lock, fence, window, `retry_connect` (D8); gates H, I, K, M, N                    | Mitigated in design | X1–X3 (§11.4)                                                        |
| F14 | Medium   | Revision 4 cleared ciphertext on exhaustion but offered a manual retry                                                                                                                        | Keep it for 30 days (D10)                                                                 | Closed in design    | Encrypted token retained longer                                      |
| F15 | Medium   | Revision 4 gate C required "processed once", which a crash after sending makes impossible                                                                                                     | "At most one call per T1"; attempts counted at T1                                         | Closed in design    | Duplicate calls rely on A-R3                                         |
| F16 | Medium   | Environments sharing one Canva client ID share user consent                                                                                                                                   | One integration per environment (§14)                                                     | Open                | X2                                                                   |
| F17 | Low      | Attempt cleanup cascades to candidates, which could drop tokens without queuing them                                                                                                          | Expire candidates before deleting attempts (§3.2)                                         | Closed in design    | None                                                                 |
| F18 | Low      | Display names are attacker-chosen text shown to admins                                                                                                                                        | Sanitize, cap, render as text only, never log (§2.3)                                      | Closed in design    | Look-alike names (the IDs and warnings are shown too)                |
| F19 | Medium   | The sweep can delete an account row between `INSERT … ON CONFLICT DO NOTHING` (no lock on an existing row) and `SELECT … FOR UPDATE`, or before `E`'s queue insert                            | Retry on a missing row or `23503` (§4); sweep re-checks after locking (§5.13); gate R     | Closed in design    | Up to 3 retries, then a definite failure                             |
| F20 | Low      | T1 set `claimedUntil` from `now()`, so a lock wait shortened the claim and allowed a premature takeover and duplicate call                                                                    | `clock_timestamp()` and `lock_timeout` in T1 (§5.10); gate N                              | Closed in design    | None beyond A-R3                                                     |
| F21 | Low      | A crashed `in_flight` row blocks reconnection of its Canva user, and there is no scheduler                                                                                                    | `retry_connect` runs the worker (§2.7, D15); gate N                                       | Closed in design    | X8                                                                   |

## 14. Implementation-readiness checklist

**Verified facts:**

- [x] OAuth and PKCE parameters, the token endpoint, Basic client authentication, rotation ("only be used once"), the error codes, and revocation including lineage and consent: Canva URLs in §1.
- [x] Identity is available without a scope (`/users/me`); the display name and capabilities need `profile:read`.
- [x] The revision 5 schema is valid Prisma 6.19.3; the composite foreign keys to `canva_accounts` (with a nullable `organizationId`) and the relations to the unique `canva_connections."organizationId"` are accepted; the migration is additive, with no `ON UPDATE CASCADE` on new constraints (offline validate and diff).
- [x] Mocked tests: token classification, write identity, verify-before-revoke, store-owned expiry, launch URL, the identity client, and the same-user guard. **Not** evidence of database semantics.

**Design decisions (recorded in §12):**

- [x] D1–D15.

**Required before persistence implementation:**

- [x] Approval to implement this schema and its migration files (given for Stage 2). Applying the migrations, the window constants (5 s, 10 s, 120 s) in live use, and acceptance of X1–X8 still need explicit approval.
- [x] Code-only fixes F1 and F3, plus the `/users/me` identity client, with mocked tests.
- [x] The §8 code-only items 1–7 with mocked tests (Stage 2).
- [x] The Stage 2 implementation (§15), with mocked tests only.
- [ ] Confirm the capabilities response shape and whether `scope` is always returned (A-S1).
- [ ] Choose a private (Enterprise team) or public (reviewed) Canva integration, with **one integration per environment** (F16); register the redirect URL; enable exactly the four scopes.

**Required before live use:**

- [ ] Apply the migrations to an approved database (instructions in `canva.md`).
- [x] All 27 gates (1–9, A–R) pass on the isolated database and browser profile (Stage 2.5, PostgreSQL 18.6; runbook §11).
- [x] The reseal job (§5.11), the web confirmation flow, and an operator command for the worker (Stage 2.1, mocked tests). A scheduler is documented in `canva.md`, not installed.
- [ ] Confirm the §11.3 assumptions, or accept them explicitly.
- [ ] Remove `127.0.0.1` redirect URLs before public review.
- [ ] One eligible-account consent test, after separate approval.

**Unresolved:** the assumptions in §11.3 and the external races in §11.4. None blocks schema approval; gates C, F, G, I, and N must settle what they can before live use.

## 15. Stage 2 implementation record

### 15.1 Where the code is

| Specification                                      | Implementation                                                                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| §3 tables                                          | `prisma/schema.prisma`; `prisma/migrations/20261027120000_canva_reauthorization_status`, `prisma/migrations/20261027120100_canva_oauth_persistence` |
| §4 runner, lock helpers, `E`                       | `apps/api/src/canva/oauth/canva-prisma.transaction.ts`                                                                                              |
| §5.1–5.3 attempts                                  | `canva-oauth-attempt.prisma-store.ts`                                                                                                               |
| §5.4–5.9, §5.12 credentials, candidates, holds     | `canva-credential.prisma-store.ts`                                                                                                                  |
| §5.10, §5.13 queue, T1, T2, admin actions, sweep   | `canva-revocation.prisma-store.ts`                                                                                                                  |
| §2.4 policy; the worker                            | `canva-revocation.ts` (pure); `canva-revocation.worker.ts` (the only caller of `CanvaTokenClient.revoke`; a test enforces it)                       |
| §2.3 clients, scope check, sanitizer               | `canva-account.clients.ts`, `canva-identity.client.ts`                                                                                              |
| §2.1, §2.3, §5.4 flow; confirmation; admin actions | `canva-oauth.service.ts`, `canva-oauth-callback.controller.ts`, `canva.controller.ts`                                                               |
| §5.7, §5.8, §5.9 refresh, mark, disconnect         | `canva-access-token.service.ts`, `canva.service.ts`                                                                                                 |
| §10 gates                                          | `apps/api/src/pg/canva-oauth.pg.spec.ts`, `apps/api/src/pg/canva-oauth-gates.pg.spec.ts`, `canva-gate-harness.ts`, `canva-gate-actors.ts`            |
| §5.11 reseal                                       | `canva-reseal.prisma-store.ts`, `canva-token-reseal.service.ts`                                                                                      |
| Worker and reseal operation                        | `canva-operations.ts` (dispatch and refusals), `canva-operations.main.ts` (process entry)                                                            |
| §2.3 confirmation screens                          | `apps/web/src/CanvaConnection.tsx`; contract types in `packages/shared-types`                                                                       |

### 15.2 Deviations and implementation decisions

| ID  | Decision                                                                                                                                                                          | Why                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | The enum value is added in its own migration, before the tables                                                                                                                   | PostgreSQL forbids using a value added by `ALTER TYPE … ADD VALUE` in the transaction that added it. Splitting guarantees it is committed first, whatever Prisma's per-migration transaction behavior (§9) |
| I2  | The new tables are accessed with parameterized raw SQL (`Prisma.sql`), not the Prisma model API                                                                                   | The statements stay identical to the reviewed protocol, and the generated client was not regenerated (that would overwrite generated output). Run `pnpm db:generate` when the migrations are applied       |
| I3  | Every timestamp comparison and assignment converts explicitly: `now() AT TIME ZONE 'UTC'` and `clock_timestamp() AT TIME ZONE 'UTC'`. Application dates are cast from ISO strings | The columns are `timestamp(3)` without a time zone. Implicit casts would depend on the session time zone                                                                                                   |
| I4  | `E` creates **and locks** the account row before inserting the queue row (§4 said it takes no account lock)                                                                       | It closes F19 for `E` without relying on the `23503` retry, and it keeps the global lock order, because every caller either already holds that lock or holds only the connection lock                      |
| I5  | An unconfirmed T1 commit (definite or ambiguous) never leads to a call, even if a re-read could verify it (§5.10 allowed a verified call)                                         | Strictly safer and simpler. If T1 did commit, the claim expires and crash recovery applies its 135-second window                                                                                           |
| I6  | The configuration-pause limit uses the row's age, not the total time paused                                                                                                       | Row age is never shorter than the paused time, so the rule is conservative and needs no column                                                                                                             |
| I7  | An exhausted row records the time of exhaustion in `nextAttemptAt`, which drives the 30-day abandon                                                                               | No extra column                                                                                                                                                                                            |
| I8  | The "different Canva account" warning compares only with the organization's **current** credential                                                                                | The schema keeps no history of previous Canva users                                                                                                                                                        |
| I9  | Reject requires the same administrator and session, like confirmation                                                                                                             | §2.3 did not say. The stricter rule costs at most a 10-minute wait for an abandoned candidate                                                                                                              |
| I10 | Durable storage and the worker are opt-in flags (`CANVA_OAUTH_PERSISTENCE_ENABLED`, `CANVA_REVOCATION_WORKER_ENABLED`), both off by default                                       | Until the gates pass, a deployment that only sets `CANVA_PROVIDER_MODE=canva` must keep failing closed, and no worker may call Canva                                                                       |
| I11 | The authorize response changed from `{ authorizationUrl, expiresAt }` to `{ launchUrl, launchToken, expiresAt }`                                                                  | Required by §2.1. No web code used the old shape                                                                                                                                                           |
| I12 | A callback without the binding cookie returns `expired_or_used` without touching the store                                                                                        | Nothing could match, so a store call would only add load                                                                                                                                                   |
| I13 | `account_unavailable` and `retry_connect` discard the new tokens, as specified. `retry_connect` also triggers the worker for that Canva user (D15)                                | §2.2 and §2.7                                                                                                                                                                                              |
| I14 | The refresh lease waits by polling the claim (250 ms, up to 15 s) rather than polling `read`                                                                                      | Equivalent: once the holder releases, the next claim succeeds, and the work function's freshness check returns the new token without calling Canva                                                         |
| I15 | The reseal never marks a row `undecryptable` or deletes it; a row whose key is missing or whose value does not open is counted and left (§5.11 said to mark it)                   | A key removed too early is an operator error that restoring the key repairs; marking would make it permanent. Normal use still marks an unusable credential. Retirement requires zero rows for the version |
| I16 | `rotation_lost` (§6) is marked after a definite failure of the rotation write, only if the stored credential is still the same chain and version; the rotated grant is discarded   | Same as any lost token (§5.8); if the re-read or the mark fails, nothing is given up and the next refresh marks `invalid_grant`                                                                               |
| I17 | `CanvaRevocationWorker.runOnce` also requires `CANVA_REVOCATION_WORKER_ENABLED` (Stage 2 checked it only in `trigger`)                                                           | No entry point, including the operator command, can call Canva without the flag                                                                                                                             |
| I18 | `GET …/revocations` lists exhausted rows for the Retry and Dismiss screens                                                                                                       | The status carried only counts; the actions need row IDs. No ciphertext or Canva IDs are returned                                                                                                          |
| I19 | The `pg` Vitest project also requires `ADFLOW_PG_GATES=run`                                                                                                                    | A database URL left in a shell must not turn `pnpm test` into a database run                                                                                                                              |
| I20 | Gate R(c) observes a missing account row at `E`'s own lock (I4) instead of a `23503` from the queue insert                                                                       | Same retry and the same pass condition: exactly one queue row on a fresh account row                                                                                                                        |
| I21 | `CANVA_REDIRECT_URI` must be canonical and on an origin in `CANVA_REDIRECT_ALLOWED_ORIGINS`; unset, only loopback `http` is accepted (Stage 2.2)                       | Any `https` host was accepted before. An explicit allowlist keeps a mistyped or malicious configuration from becoming the callback and launch host                                                    |
| I22 | An ambiguous rotation write whose re-read shows the same chain at the read version is marked `rotation_lost`, like a definite failure (Stage 2.2)                         | The stored refresh token is known to be spent; the version-conditioned mark cannot override a late commit. Stage 2.1 returned a retryable error and left the next refresh to fail with `invalid_grant`         |
| I23 | A missing encryption key fails closed: refresh keeps the credential (`CanvaKeyUnavailableError`); the worker requeues without an attempt or a window. A configured key that cannot open a queue row exhausts it, keeping the ciphertext (Stage 2.3) | Stage 2.2 marked the credential `undecryptable` (deleting it) and finished the row clearing its ciphertext, which a rolling deployment or an early key removal would trigger irreversibly |
| I24 | The reseal only moves forward: it refuses while a newer key is pre-staged and leaves rows sealed with a newer key alone (Stage 2.3) | Resealing on a pre-staged or rolled-back instance would rewrite promoted rows back to the old key |
| I25 | A test-only authorize endpoint override (`CANVA_AUTHORIZE_ENDPOINT`) for gate G; no environment variable; refused at construction outside a gate run, outside loopback http, or in production (Stage 2.3) | Gate G needs a fake authorize page; ordinary configuration must never be able to redirect administrators elsewhere |

### 15.3 Verification status

**Run, offline only:**

- `prisma validate`.
- `prisma migrate diff` from the previous schema to the new one (schema to schema, no database). Its output equals the two migration files, apart from comments.
- API and web typechecks, lint, Prettier, and `git diff --check`.
- The full API suite (562 tests in 40 files) and the web suite (121 tests in 13 files), Stage 2.1.
- A build into a scratch directory.
- Stage 2.1 repeated the offline comparison: the schema with the two migrations removed, diffed to the current schema, produced the same 41 statements in the same order as the migration files.

**Mocked tests (not database evidence):**

- `canva-oauth.prisma-stores.spec.ts` runs the PostgreSQL stores against a scripted Prisma double. It checks statement order (lock order, read-after-lock), rollback branches, retries, ciphertext-only writes, and definite versus ambiguous classification.
- The service and worker specs run against in-memory doubles that model holds, candidates, the queue, `in_flight`, and windows.

**Run (Stage 2.5, PostgreSQL 18.6, 2026-10-28):** every PostgreSQL gate passed (runbook §11 and §12).

- Passed: 1–9 and A–R, including both parts of F and gate G (Playwright 1.56.1, bundled Chromium 141).
- The first run found defects in the gates themselves (not in the protocol); they were fixed and the affected gates rerun (runbook §12).

The scripted double cannot show that PostgreSQL blocks, re-evaluates, or commits as the protocol assumes; only the gates can.

### 15.4 Stage 2.1

- **Confirmation workflow**: the web screens (§2.3) and `GET …/revocations`; a mocked end-to-end HTTP workflow test drives authorize, launch, callback, candidate, confirm, reject, disconnect, and the failure outcomes through the real application with in-memory stores and a fake Canva.
- **Key rotation**: the reseal (§5.11), deviation I15; gate 5 is written.
- **Worker operation**: `canva:ops` (`inspect`, `run-once`, `maintain`, `keys`, `reseal`), dry run by default, refusing in tests, in mock mode, and without storage; I17.
- **Gaps closed**: `rotation_lost` (I16); `verifyStoredIdentity` documented (§8); the OAuth response contract shared and typed (`packages/shared-types`); the `AGENTS.md` Sprint 9 boundary recorded as historical with the current OAuth plan update.
- **Validation preparation**: the gates listed in §15.3, with the harness in `canva-gate-actors.ts`. None has run.
