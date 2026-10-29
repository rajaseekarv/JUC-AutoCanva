# AdFlow

Multi-branch advertising operations platform with Canva as the creative engine. Canva remains the external design engine; this repository provides the operations platform around it.

## Sprint 0 foundation through Sprint 9 Canva integration foundation

Sprint 0 includes the pnpm workspace, React + Vite web app, NestJS API, PostgreSQL + Prisma schema and migration, Redis URL configuration placeholder, validated API environment, and a web page that checks API health. Sprint 1 adds authentication, organization-scoped roles and permissions, revocable access sessions, and server-enforced branch access. Sprint 2 adds organization profile management, branch CRUD/status management, and user branch access administration with server-side tenant checks. Sprint 3 adds organization and branch brand profiles plus secure, permission-scoped asset storage. Sprint 4 adds organization-scoped templates, field metadata and mapping, dimensions, and immutable active versions. Sprint 5 adds branch-scoped creatives with validated content and immutable revisions linked to exact template versions. Sprint 6 adds organization-scoped versioned workflow definitions, branch-authorized creative instances, tasks, and transition history. Sprint 7 adds reviewer assignments, exact-revision approval decisions, append-only revision comments, and explicit change-request lifecycle actions. Sprint 8 adds append-only audit history and recipient-scoped in-app notifications. Sprint 9 adds the mock-only Canva provider foundation. Publishing and AI generation remain out of scope.

## Sprint 5 creatives

Creatives are branch-scoped and require creatives:read, creatives:create, or creatives:update. The API exposes GET/POST /api/v1/creatives, GET/PATCH /api/v1/creatives/:creativeId, and read-only GET /api/v1/creatives/:creativeId/revisions plus GET /api/v1/creatives/:creativeId/revisions/:revisionNumber. Organization scope is derived from the authenticated user; every list, detail, and mutation verifies the branch is active and accessible to the caller. A campaign can be linked only when its existing CampaignBranch assignment targets the same organization and branch.

Each create/edit stores a new immutable revision with validated JSON field values, creator, timestamp, optional summary, and the exact frozen template-version ID. New creatives and template-version changes require the currently active version. Existing creatives may continue using the exact version already selected even if its template is later archived; switching to another version requires an active template. Branch-only image values store asset IDs and must reference active in-scope PNG/JPEG/WebP metadata; no storage key or file path is returned. Organization-level creatives are not supported because current creative and campaign authorization is branch-based. Seeded local admin and branch operator roles receive the three creative permissions; pnpm db:seed remains idempotent. Creative/revision creation and revision-pointer advancement write audit records transactionally.

## Sprint 6 workflows

The API exposes `/api/v1/workflows` definition list/create/detail/versioned update, validation, enable, and disable; `POST /api/v1/creatives/:creativeId/workflows` starts an instance against an exact revision; `GET /api/v1/creatives/:creativeId/workflow` and `/api/v1/workflow-instances/:instanceId` read state; `GET /api/v1/workflow-instances/:instanceId/transitions` lists transitions the caller can take; `POST /api/v1/workflow-instances/:instanceId/transitions` requests a stored transition; and `/history` reads append-only history. Permissions are `workflows:read`, `workflows:manage`, `workflows:start`, and `workflows:transition`. The latest instance's current stage is operational source of truth; `Creative.status` is its transactional projection, including after terminal completion. A running workflow pins its revision and immutable definition version. Creative edits are rejected until it completes. Workflow starts and transitions write audit records transactionally. See `docs/architecture/overview.md` for lifecycle details.

## Sprint 7 reviews

Review stages require exactly one configured reviewer assignment (a specific user or permission) and tagged approval/change-request transitions. Each task is completed by one eligible reviewer; permission assignments use first eligible reviewer completion rather than an all-reviewer quorum. Decisions, task completion, optional change request, workflow transition, and history commit in one serializable transaction. Change requests remain attached to the original revision until explicitly resolved or cancelled. Comments are append-only and revision-specific. See the API and architecture documentation for endpoints and permission details.

## Sprint 9 Canva foundation

The authenticated API exposes `GET /api/v1/integrations/canva/status`, `POST /connect`, `POST /disconnect`, `GET /jobs`, `POST /jobs`, and `GET /jobs/:jobId` beneath that route prefix. It uses only a deterministic mock provider, with organization-level connection controls, idempotent jobs for authorized branch creatives, and transactional audit events. The UI labels all mock data and makes no claim that a real Canva design exists. No Canva credentials are required. See `docs/integrations/canva.md` for the adapter boundary and future OAuth/Autofill requirements.

## Canva OAuth Stage 1 (real Canva still disabled)

Plan update: this stage extends the Sprint 9 boundary only as far as preparing real OAuth safely, with no live Canva calls and no database changes. It adds validated `CANVA_*` server configuration (mock is the default), `POST /api/v1/integrations/canva/oauth/authorize` (JWT plus `canva:integration:manage`), and an unauthenticated `GET /api/v1/integrations/canva/oauth/callback` that always redirects to the fixed web origin. It also adds single-use hashed state, S256 PKCE, a server-side token client for exchange, refresh, and revoke, AES-256-GCM token sealing with key versions, refresh logic that avoids races, and disconnect logic. Durable OAuth storage is only proposed (`docs/integrations/canva-oauth-persistence-proposal.md`), so real mode fails closed (`503`/`409`) until that migration is approved. Mock connect, status, and jobs are unchanged in mock mode. Details, scopes, and the Canva eligibility prerequisites for Brand Template Autofill (checked per account through Canva's capabilities endpoint) are in `docs/integrations/canva.md`.

## Canva OAuth Stages 2 and 2.1 (real Canva still disabled)

Plan update, at the user's explicit direction: these stages implement durable OAuth storage (schema and migration files, not applied), administrator confirmation in the web app, the durable revocation queue and worker, the key reseal job, and an operator command (`pnpm --filter @adflow/api canva:ops`), all fail-closed. Mock mode stays the default; real mode, durable storage, and the worker are each disabled by configuration; no live Canva request has been made, and the two Canva OAuth migrations have not been applied to any development, shared, or production database.

PostgreSQL evidence: all 27 PostgreSQL gates passed on an isolated, disposable PostgreSQL 18.6 cluster in Stage 2.5 (2026-10-28), which applied the migrations only to throwaway gate schemas. Stage 2.9 reran batches 3 and 6 (20 gates) on a new isolated 18.6 cluster after the Stage 2.8 changes, and all passed; the other batches were not rerun. Results and limits are in `docs/integrations/canva-postgresql-gate-runbook.md` (§11–§13). Everything else is covered by mocked tests. Real Canva remains disabled: the scheduler, monitoring, Canva app registration, and an eligible-account consent test are still outstanding (`docs/integrations/canva.md`, "Remaining steps before real use").

## Prerequisites

Sprint 9 adds a mock-only Canva integration foundation. It does not connect to Canva or create real designs; see `docs/integrations/canva.md` before planning real OAuth or Autofill work. No Canva credentials are needed for local use.

- Node.js 24.21.0 (see `.nvmrc`)
- pnpm 11.19.0 (pinned by `packageManager` in `package.json`). Run `corepack enable` once so `pnpm` is on `PATH`; the root `dev`, `build`, `typecheck`, `typecheck:api-tests`, and `test` scripts call `pnpm` themselves and fail when it is reachable only as `corepack pnpm`.
- Docker Compose

## Local setup (mock mode)

Canva stays in mock mode throughout: leave `CANVA_PROVIDER_MODE` unset or `mock`, and leave `CANVA_OAUTH_PERSISTENCE_ENABLED` and `CANVA_REVOCATION_WORKER_ENABLED` unset or `false`. No Canva credentials are needed.

The phases are separate on purpose. Phases 1 and 2 touch no database. Phases 4 and 5 change whichever database `DATABASE_URL` names, so check it first.

### 1. Install and configure (no services)

```sh
pnpm install --frozen-lockfile
cp .env.example .env
```

On Windows PowerShell use `Copy-Item .env.example .env`. In the ignored `.env`, set `JWT_ACCESS_SECRET` to a random value of at least 32 characters, and `SEED_ADMIN_PASSWORD` and `SEED_BRANCH_USER_PASSWORD` to local-only passwords of at least 12 characters. Never commit `.env`.

### 2. Offline checks (no database, Redis, or Canva)

```sh
pnpm db:generate     # writes the Prisma client into node_modules; no connection
pnpm db:validate     # schema check; no connection
pnpm lint
pnpm format:check
pnpm typecheck
pnpm typecheck:api-tests
pnpm test
```

These are the checks CI runs. The API test setup replaces `DATABASE_URL` with a blocked address, so `pnpm test` never reaches a database. The PostgreSQL gates are not part of `pnpm test`; they run only against an isolated cluster as described in `docs/integrations/canva-postgresql-gate-runbook.md`.

### 3. Start local services

```sh
docker compose up -d postgres redis
```

The Compose credentials are for local development only. The Compose file runs PostgreSQL 16, while the PostgreSQL gate evidence was recorded on 18.6 (see the runbook, §2). Redis is required by startup validation (`REDIS_URL`) but nothing connects to it yet.

### 4. Apply migrations (approval required)

```sh
pnpm db:deploy       # prisma migrate deploy
```

`pnpm db:deploy` applies **every** pending migration in `prisma/migrations` to the `DATABASE_URL` database, including the two Canva OAuth migrations (`20261027120000_canva_reauthorization_status` and `20261027120100_canva_oauth_persistence`). Prisma cannot stop before them. Under the plan in `AGENTS.md`, no migration is applied without separate explicit approval, so this is not an automatic first-run step:

- Get approval before running it against any database, and confirm `DATABASE_URL` points at the intended one.
- On a non-disposable database (anything holding data you need), back it up first; the Canva migrations are additive, and the procedure is in `docs/integrations/canva.md` ("Database migration").
- Run it from a clean checkout. The repository's `.gitattributes` keeps migration files LF; files converted to CRLF by an older checkout differ byte for byte from the committed ones.

`pnpm db:migrate` (`prisma migrate dev`) is for schema development only. It creates new migrations and can offer to reset (erase) a database that has drifted, so use it only on a disposable database.

### 5. Seed (changes data)

```sh
pnpm db:seed
```

The seed upserts the sample organization, two branches, users, roles, and permissions. For the two seeded users (matched by the `SEED_*_EMAIL` addresses), it resets the password to the `.env` value and the name and `ACTIVE` status to fixed values. It is idempotent, but run it only against a local development database, never a shared or production one.

### 6. Run the apps

```sh
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173). The web app calls `GET http://localhost:3000/api/v1/health` and displays API status. Sign in with `admin@example.local` or `branch@example.local` and the corresponding local passwords configured in `.env`.

Both development servers bind to loopback by default. To intentionally expose them on your LAN, set `API_HOST=0.0.0.0` in the local `.env` and start the web app with `pnpm --filter @adflow/web dev -- --host 0.0.0.0`. Ensure your network firewall allows only intended clients.

## Workspace commands

- `pnpm typecheck` — TypeScript checks for the API and web app.
- `pnpm typecheck:api-tests` — TypeScript check for API tests.
- `pnpm lint` — ESLint checks.
- `pnpm format:check` — Prettier formatting check.
- `pnpm test` — API and web unit tests.
- `pnpm build` — Build all applications.
- `pnpm db:studio` — Open Prisma Studio.
- `pnpm db:seed` — Upsert local-only development seed records; set both seed passwords in `.env` first.

The API validates `DATABASE_URL`, `REDIS_URL`, `API_PORT`, `API_HOST`, `WEB_ORIGIN`, and the JWT access-token secret at startup. Access tokens are short-lived (`JWT_ACCESS_TTL_SECONDS`, 15 minutes by default) and can be revoked by logout. The web app saves only the access token and its expiry in `localStorage` so a reload or new tab revalidates the existing server session through `GET /api/v1/auth/me`; see `apps/web/README.md` for the trade-offs. No refresh token is implemented, so users sign in again once the session expires. Prisma CLI scripts run from the repository root alongside the root Prisma schema and root `@prisma/client` dependency, so generated client resolution matches the API client version. Redis is configured for future queue work but is not connected or used in this sprint. The web API base URL can be overridden with `VITE_API_BASE_URL` in the repository-root `.env`, which Vite loads through its explicit `envDir`. The health endpoint is a liveness check only; dependency readiness checks are deferred to a later sprint. Docker Compose credentials are for local development only; provide managed secrets through the deployment environment outside this foundation.

## Sprint 3 brand profiles and assets

Sprint 3 adds organization brand profiles, sparse branch overrides with an effective-profile endpoint, and organization/branch-scoped image assets. Brand and asset APIs require `brand:read`, `brand:manage`, `assets:read`, or `assets:manage` permissions. Seeded organization admins receive all four and already hold `organizations:update`; organization-wide brand and asset mutations require that capability in addition to the feature permission. Branch operators receive read-only brand and asset permissions and can only read branch data for an assigned branch. Uploaded assets accept PNG, JPEG, and WebP up to 5 MB, use generated storage keys, and are stored outside the database in `.local-storage/assets` by default. Set `ASSET_STORAGE_DIR` to choose another local storage root. This local filesystem provider is behind an API storage service boundary and is not intended as a production deployment store. Asset metadata is soft-deleted; files are best-effort removed from local storage. Sprint 8 records brand and asset metadata changes without storing uploaded content or display names.

## Sprint 1 security boundary

`POST /api/v1/auth/login`, `GET /api/v1/auth/me`, and `POST /api/v1/auth/logout` provide authentication. `GET /api/v1/branches` lists only explicitly granted branches; `GET /api/v1/branches/:branchId` checks the grant and organization relationship on the server. Roles and permission codes are organization-scoped and permission guards authorize routes without relying on role names. Passwords are stored as Argon2id hashes.

Sprint 3 adds `GET/PATCH /api/v1/organization/brand`, branch brand read/update/effective endpoints, and asset list/detail/upload/update/delete endpoints. The additive migration creates brand profile, branch override, and asset metadata tables; existing models and migrations remain intact.

## Sprint 4 templates

Templates are organization-scoped and require `templates:read`, `templates:create`, `templates:edit`, `templates:activate`, or `templates:archive` according to the action. The API exposes `/api/v1/templates` list/create, template detail/update, version creation, field add/update/delete, explicit activate/archive actions, and branch-scoped preview. Creating a template starts draft version 1. Activation freezes the current version; edits after activation require `POST /api/v1/templates/:templateId/versions`, which copies the previous field definitions into a new draft version. The template stays ACTIVE on its frozen active version while that draft is edited, so creative creation is not interrupted; activating the draft switches the active version. Archived templates cannot be edited or revised. Activation, metadata updates, and field add/update/delete lock the draft version row (`SELECT … FOR UPDATE` while `immutableAt` is null) and then the template row (`FOR NO KEY UPDATE`), always in that order, and validate against data re-read under those locks. As a result, a version cannot gain, change, or lose fields after it is frozen; activation snapshots the template metadata current at lock time rather than an earlier read; metadata cannot change once the draft is frozen; and an archive that commits first is never undone by activation, update, or field changes (each returns `409`). Under those locks, activation re-counts the version's fields (`400` if none remain) and freezes the version with a conditional update (`updateMany` where `immutableAt` is null); if that update changes no row it returns `409` without updating the template's active version or writing an audit event. A competing activation returns `409` without a second audit event, and concurrent duplicate draft versions, template codes, or field keys return `409`. Unit and mocked-HTTP tests cover this logic, and `apps/api/src/pg/concurrency.pg.spec.ts` verifies the lock interleaving against a real, isolated PostgreSQL 18 database at the default `READ COMMITTED` level. The conditional freeze was added in Sprint 12 after that suite last ran; until it is re-run, the freeze is covered only by unit and mocked-HTTP tests, which check operation order and conditions but do not prove PostgreSQL interleaving. That suite runs only in the `pg` Vitest project, which exists only when `ADFLOW_PG_TEST_URL` is set and `ADFLOW_PG_GATES=run` opts in explicitly (`pnpm --filter @adflow/api test:pg`), and it refuses any database that is not `127.0.0.1:55432`, named `*_test`, and stamped with the expected test marker and data directory (`ADFLOW_PG_TEST_MARKER`, `ADFLOW_PG_TEST_DATA_DIR`). Never point it at the development database.

Fields support constrained types, safe organization/effective-brand/branch mappings, and bounded validation metadata. Mapping keys are allowlisted server-side. Preview verifies the selected branch belongs to the current organization and is available to the caller; image/logo mappings return only in-scope asset metadata. Seeded organization admins receive all five template permissions; branch operators receive read-only template access. Additive migrations `20261008100000_sprint4_templates` and `20261008103000_template_version_snapshots` add versioned fields and complete immutable metadata snapshots. Template creation, metadata update, draft version creation, activation, and archival are recorded in audit history, as are field additions, updates, and removals (`template.field_added`, `template.field_updated`, `template.field_removed`). Field events are written in the same transaction as the change, so a failed or rolled-back mutation records nothing; their metadata holds the version number, field ID, and the field's key, label, type, required flag, display order, and mapping (plus `changedFields` and before/after values for updates), but not free-form default values or validation rules.

Template write transactions translate database contention into documented responses and never retry automatically: `P2034`, or `P2010` carrying SQLSTATE `40P01`/`40001` (PostgreSQL rolled the transaction back after a deadlock or serialization failure; Prisma reports it as `P2010` when it occurs inside the raw row-lock queries), returns `409` "The change conflicted with a concurrent update and was not applied; reload and retry", and `P2028` (the transaction could not start or expired before completing) returns `503` "The database could not confirm this change in time; reload to check the current state before retrying", because Prisma cannot always tell whether a commit already reached the database. All other database errors are unchanged. The approvals and workflows services keep their existing mapping of `P2034` to `409`; other services do not yet map these codes.

Sprint 2 adds `GET/PATCH /api/v1/organization`, branch create/update/activate/deactivate endpoints, and organization-scoped user branch access endpoints under `/api/v1/users`. The seeded organization admin receives `organizations:update`, `branches:manage`, and `users:branch-access:manage`; the branch operator has `branches:read`, `brand:read`, and `assets:read` without organization-wide brand or asset management permissions. Inactive branches are not included in a user's permitted branch context and are rejected for branch-restricted access. `branches:manage` administrators may inspect inactive branches in order to reactivate them. Branch and organization identifiers in payloads are validated and organization scope comes from the authenticated principal. `pnpm db:seed` upserts the new local permissions and remains idempotent. `GET /api/v1/organization` is scoped from the current user and does not accept an organization ID. No Prisma schema change or migration is needed because the existing models and unique grants cover Sprint 2.
Meaningful business and authorization mutations are written to audit history transactionally where implemented. Session creation/revocation and template field edits remain future audit coverage items.

## Sprint 8 audit and notifications

`GET /api/v1/audit-logs` and `GET /api/v1/audit-logs/:id` require `audit:read`, seeded only for organization administrators. Filters include action, entity, branch, actor, date range and bounded pagination. Audit records are read-only through application APIs. `GET /api/v1/notifications`, `/unread-count`, `/:id`, `/:id/read`, and `/read-all` are authenticated and scoped to the current recipient. Notifications are idempotent by recipient/event key. Direct assignees and known review participants receive relevant activity; permission-based assignments do not broadcast. The authenticated shell includes notifications and displays audit history only with `audit:read`.
