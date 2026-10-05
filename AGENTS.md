# AdFlow — Agent Engineering Rules

## Product boundary
AdFlow is a multi-branch advertising operations platform. Canva is an external creative engine, not a replacement for Canva.

## Current sprint boundary
Sprint 0 is infrastructure only.

Do NOT implement:
- Canva integration
- Canva OAuth
- AI generation
- social publishing
- approval workflow
- change requests
- production business logic

## Architecture rules
1. Use TypeScript throughout application code.
2. Use React + Vite for web and NestJS for API.
3. Use PostgreSQL with Prisma.
4. Use pnpm workspaces.
5. Keep modules isolated and dependency direction clear.
6. Never put secrets in source control.
7. Never trust authorization decisions made by the frontend.
8. Branch access must eventually be enforced server-side.
9. Workflow transitions must eventually be server-side state-machine operations.
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
