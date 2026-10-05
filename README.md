# AdFlow

Multi-branch advertising operations platform with Canva as the creative engine.

## V1 principle
AdFlow manages branches, campaigns, creative workflow, approvals, versions, distribution and auditability. Canva remains the design/editing engine.

## Sprint 0
This repository is the foundation only. Do not implement Canva, AI generation, publishing, or the workflow engine yet.

## Planned stack
- Frontend: React + TypeScript + Vite
- Backend: NestJS + TypeScript
- Database: PostgreSQL + Prisma
- Queue: Redis + BullMQ
- Monorepo: pnpm workspaces

## Development
1. Copy `.env.example` to `.env`.
2. Start PostgreSQL and Redis.
3. Install dependencies with `pnpm install`.
4. Run database migrations.
5. Start web and API in development mode.

See `AGENTS.md` for implementation rules.
