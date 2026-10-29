# AdFlow — Agent Engineering Rules

## Product boundary

AdFlow is a multi-branch advertising operations platform. Canva is an external creative engine, not a replacement for Canva.

## Current sprint boundary

Sprint 9 implements a mock-first Canva integration foundation behind a provider adapter.

Do NOT implement in Sprint 9:

- Canva OAuth or real Canva API calls unless secure configuration and account eligibility are already available
- AI generation
- social publishing
- exports and distribution

Plan update (Canva OAuth stages 1 to 2.1, at the user's explicit direction; recorded in `README.md` and `docs/integrations/canva.md`): the Sprint 9 list above is historical. OAuth code, durable OAuth storage, the confirmation flow, and the revocation worker may now be implemented, but only fail-closed: mock mode stays the default; real mode, durable storage, and the worker stay disabled by configuration; and no real Canva API, OAuth, token, or revocation request is made, and no migration is applied, without separate explicit approval. AI generation, social publishing, and exports remain out of scope.

## Architecture rules

1. Use TypeScript throughout application code.
2. Use React + Vite for web and NestJS for API.
3. Use PostgreSQL with Prisma.
4. Use pnpm workspaces.
5. Keep modules isolated and dependency direction clear.
6. Never put secrets in source control.
7. Never trust authorization decisions made by the frontend.
8. Branch access must be enforced server-side.
9. Workflow transitions are server-side state-machine operations resolved from the immutable workflow version.
10. Approved creatives must never be mutated in place; create a new version.
11. External providers must be behind adapters/services.
12. Canva calls must eventually be server-side only.
13. Background operations must be retryable and idempotent.
14. Every meaningful state mutation should eventually produce an audit event.
15. Prefer small, testable services over large controllers.
16. Do not add dependencies without documenting why.
17. Do not expand a sprint's scope without updating the plan.

## Coding standards

- Strict TypeScript.
- ESLint + Prettier.
- Explicit DTO validation at API boundaries.
- Meaningful names; avoid `data`, `item`, `temp`, etc. when a domain name is available.
- No `any` unless explicitly justified.
- Tests accompany non-trivial business logic.

## Git discipline

Use small commits with imperative messages, e.g.:

- `chore: initialize pnpm workspace`
- `chore: add docker development services`
- `chore: initialize nest api`
- `chore: initialize vite web`

## Definition of done

A change is complete only when:

- Typecheck passes.
- Lint passes.
- Tests pass.
- Documentation is updated where behavior or architecture changed.
- No secrets are committed.
