# Codex Sprint 0 Prompt

You are implementing Sprint 0 for the AdFlow repository.

Read these files first:
- AGENTS.md
- README.md
- docs/architecture/overview.md
- docs/decisions/ADR-001-monorepo.md
- docs/decisions/ADR-002-canva-adapter.md
- docs/decisions/ADR-003-workflow-state-machine.md
- docs/decisions/ADR-004-creative-versioning.md
- prisma/schema.prisma

## Goal

Create a clean, runnable monorepo foundation.

## Required stack

- pnpm workspaces
- React + TypeScript + Vite
- NestJS + TypeScript
- Prisma + PostgreSQL
- Docker Compose for PostgreSQL and Redis
- ESLint + Prettier
- Vitest or the framework's standard testing setup

## Scope

Implement only:
1. Workspace/package setup.
2. Web app bootstrapping.
3. API bootstrapping.
4. Prisma client setup.
5. PostgreSQL migration for the existing Sprint 0 schema.
6. Redis connectivity placeholder/configuration.
7. Environment validation.
8. Health endpoint: GET /api/v1/health.
9. Basic web page that calls the health endpoint and displays API status.
10. Basic automated tests.
11. README setup instructions.

Do not implement:
- Canva integration
- OAuth
- AI
- publishing
- workflow engine
- approvals
- change requests
- notifications
- production authentication

## Process

Before editing:
1. Inspect the repository.
2. Identify conflicts or missing prerequisites.
3. Explain the intended file changes briefly.

Then implement.

After implementation:
1. Run typecheck.
2. Run lint.
3. Run tests.
4. Run Prisma validation/generate/migration checks.
5. Start the services if practical and verify the health endpoint.
6. Report exactly what changed.
7. Report any remaining issues.

Do not silently expand scope.
