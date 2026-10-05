# ADR-003: Workflow is a configurable state machine

## Decision
Approval and review flows will be represented as workflow definitions, steps, runtime instances and tasks.

## Why
Different campaigns and branches may require different approval paths. Approval can also be enabled or disabled.

## Consequence
Business code must not hard-code one universal approval sequence.
