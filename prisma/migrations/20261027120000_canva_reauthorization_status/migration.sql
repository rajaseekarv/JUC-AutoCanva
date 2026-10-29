-- Real Canva OAuth, part 1 of 2 (docs/integrations/canva-oauth-persistence-proposal.md).
-- A separate migration so the new enum value is committed before anything
-- could use it: PostgreSQL forbids using a value added by ALTER TYPE ... ADD
-- VALUE in the transaction that added it. Nothing below uses it.
ALTER TYPE "CanvaConnectionStatus" ADD VALUE 'REAUTHORIZATION_REQUIRED';
