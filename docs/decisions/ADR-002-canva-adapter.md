# ADR-002: Isolate Canva behind an adapter

## Decision
Canva integration will be implemented behind a provider/service boundary.

## Why
- Canva API details should not leak throughout the domain.
- We need a mock provider for development and tests.
- Canva capabilities and permissions may vary by account and plan.
- Provider changes should not require rewriting campaign/workflow logic.

## Consequence
The domain layer should depend on an internal Canva provider contract, not raw HTTP calls.
