# ADR-001: Use a pnpm TypeScript monorepo

## Decision
Use pnpm workspaces with separate web and API applications plus shared packages.

## Why
- One repository gives coding agents a complete architectural context.
- Shared types and validation can be reused.
- Frontend and backend changes can be reviewed together.
- CI can validate the whole product.

## Consequences
The repository must maintain clear package boundaries and avoid creating circular dependencies.
