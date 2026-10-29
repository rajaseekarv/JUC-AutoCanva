# AdFlow Architecture Overview

## Boundary

AdFlow owns:

- organizations
- branches
- users and access
- campaigns
- template metadata
- assets
- creatives and versions
- configurable workflows
- approvals and change requests
- comments and notifications
- exports/distribution orchestration
- audit history

Canva owns:

- design editing
- Canva templates
- supported Autofill operations
- supported exports

## Provider boundary

External services must be accessed through adapters. The Canva implementation will later conform to a provider interface so a mock provider can be used during development and tests.

## Async work

Use background jobs for:

- Canva Autofill
- Canva export
- notifications
- publishing
- asset processing

Never block an HTTP request while waiting for a long-running external job.

## Multi-branch model

A campaign can target many branches through a join entity. Branch-specific campaign data is localized at the campaign-branch level rather than duplicating the campaign.

## Workflow model

Workflow definitions are organization-scoped and consist of numbered configuration versions, ordered stages, and explicit declarative transitions. Definitions require exactly one entry stage, unique stage keys and orders, valid transition endpoints, and no outgoing transitions from terminal stages. There is no arbitrary expression execution. An enabled workflow pins an immutable version; edits create a new version and clear the enabled selection until the new version is validated and enabled. Disabling a workflow prevents new instances while existing instances continue on their pinned version.

Workflow instances capture their organization, branch, creative, exact creative revision, workflow, and immutable configuration version. The latest instance's current stage is the operational source of truth. `Creative.status` is a compatibility projection of that stage key, including the terminal stage after completion, written in the same transaction as instance starts and transitions; it remains `DRAFT` before a workflow starts. Creative edits are rejected while an instance is running, so the tracked revision cannot silently advance. After completion a new creative revision can be made, and a later workflow start snapshots that revision.

Review stages opt in with `requiresReview` and must configure exactly one assignment: a specific user or a permission. A user assignment permits only that user; a permission assignment is a single task that the first eligible user may complete. Each task accepts one decision, so multiple/all-reviewer quorum is not implied. Review transitions are explicitly tagged `APPROVED` or `CHANGES_REQUESTED`; ordinary workflow transition routes cannot bypass a review decision. The decision, task completion, optional change request, stage transition, creative status projection, and transition history commit in one serializable transaction. Decisions pin the exact revision ID and number and are rejected if the creative pointer or workflow stage has moved.

Change requests originate from a changes-requested decision and remain attached to that original revision. Status changes are explicit: `OPEN` to `IN_PROGRESS`, then `RESOLVED` or `CANCELLED`; open requests may also be resolved or cancelled directly. New creative revisions do not resolve them automatically. Revision comments are append-only and may optionally reply only within the same creative revision. Approval decisions, comments, and change requests all carry organization and branch context and are checked against the authenticated user's branch access. Sprint 8 records these mutations in the same transaction and creates scoped in-app notices for identified participants.

Tasks are stage assignments to an organization user and/or permission. Assigned users must be active organization members and have access to the instance branch when the task is created. Transitions require the caller's `workflows:transition` permission plus any permissions declared on the current/destination stage or transition. The API determines destinations from stored transition rows; callers submit only a transition key. State, task, creative status projection, and append-only transition history are updated transactionally. A partial unique database index permits at most one running workflow per creative. History has read-only API access.

API workflow permissions are `workflows:read`, `workflows:manage`, `workflows:start`, and `workflows:transition`. Review routes additionally use `approvals:read`, `approvals:decide`, `change_requests:read`, `change_requests:create`, `change_requests:resolve`, `comments:read`, and `comments:create`. Definition operations derive organization from the authenticated principal; every instance, review, comment, and change-request operation rechecks branch membership server-side. Workflow/review audit entries and in-app notices now commit with the associated business transaction. Direct-user task assignments notify that user; permission-based assignments do not broadcast because they do not identify one recipient.

## Security

Authorization is server-side. The frontend is never a security boundary.

The web client persists only the short-lived access token and its expiry in `localStorage`. After a reload or in another tab it rebuilds the session solely from `GET /auth/me`, which runs the full JWT guard (signature, server session revocation and expiry, active user, active branch grants). Stored data is never trusted for identity or permissions. Persisting the token exposes it to scripts on the web origin; this is accepted for now because sessions last 15 minutes and logout revokes them server-side. See `apps/web/README.md`.

## Brand profiles and assets

An organization may have one brand profile. Branch brand data is stored as sparse overrides and resolved against the organization profile by the API. Asset binaries are stored through an injected storage provider; PostgreSQL stores only metadata and generated storage keys. The local provider is for development only and can be replaced by a production object-store adapter without changing brand or asset services. Asset and brand access is enforced by API permissions and organization/branch scope.

## Templates and versions

Templates are organization-scoped records with a unique organization code, format dimensions, and a draft/active/archived lifecycle. Field definitions and template metadata snapshots belong to a numbered template version. Activating a draft stamps that version immutable; edits after activation require creating a new version, which copies the prior complete snapshot. Creating that new draft version leaves the template ACTIVE and its `activeVersionNumber` unchanged, so new creatives keep using the frozen active version while the draft is edited; editability is determined by the current version being unfrozen, not by template status. Activating the draft switches the active version. An archived template cannot be revised or newly activated. Activation and field or metadata changes serialize on a row lock of the draft version, and activation freezes it only through a conditional update, so a frozen version cannot gain, change, or lose fields; the root README describes the conflict responses and which guarantees are verified against PostgreSQL rather than only by mocked tests. Creative versions use the exact immutable template version and never follow a later active version.

Template field mappings use a constrained source enum and allowlisted keys for organization brand, effective branch brand, or branch identity/contact data. Custom mappings accept explicit preview values only. Mapping metadata is never executed as an expression. Branch previews verify branch membership and organization scope on the API. Image/logo values resolve to asset metadata only after validating organization and branch scope.

Template creation, metadata update, new draft version creation (`template.version_created`), activation (including the previous active version number), and archival are audited transactionally. Template field changes remain a future audit coverage extension.

## Creatives and revisions

Creatives are branch-scoped, organization-owned records. They may reference an existing campaign only when the campaign's CampaignBranch assignment targets the same branch and organization. Revision rows are immutable through normal API endpoints, monotonically numbered per creative, and retain a validated JSON snapshot plus the exact immutable template-version ID. The current-revision relation is constrained to a revision belonging to that same creative. New creatives and explicit template-version changes use only the currently active version; existing revisions can continue using their frozen version after template archival. Organization-level creatives are deferred because the established authorization model grants access per branch. Creative and revision creation/pointer changes write audit records in the same transaction.

## Sprint 8 audit and in-app notifications

`AuditLog` rows are append-only through application APIs and retain scalar entity identifiers so entity/user deletion cannot cascade-delete history. The seeded organization administrator alone receives `audit:read`. Queries derive organization scope from the authenticated principal and constrain branch-linked rows to permitted branches. Metadata is object-shaped, capped at 4 KB, and rejects credential/file-content-like keys. Critical audit writes, including successful session creation/revocation, share a Prisma transaction with their business mutation.

`InAppNotification` is recipient-scoped, unique by recipient and event key, and supports idempotent read/read-all operations. Recipients come from explicit task assignments or known workflow participants. Permission-based tasks do not identify one person and are not broadcast. Notifications are in-app only; email, push, sockets, and cleanup are out of scope.

## Sprint 9 Canva integration foundation

Canva operations are isolated behind a provider contract. The current provider is deterministic mock mode only: it simulates an organization connection and prepares mock design references from an authorized creative revision. Mock references are visibly labeled and are not Canva designs. Organization-level connections contain no OAuth credentials; job records retain organization, branch, creative, immutable revision, status, and an idempotency key. Job and connection state changes are audited. Branch-scoped job access is rechecked against current branch membership on the API.

Real OAuth, design API calls, and Autofill remain outside this sprint. A future adapter must implement the backend callback/token exchange, protect client secrets and tokens with encryption at rest, handle refresh and revocation, and poll asynchronous Autofill jobs. Canva account/app eligibility and requested scopes must be verified before enabling it. See `docs/integrations/canva.md`.
