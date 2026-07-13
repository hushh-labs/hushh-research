-- Migration 094: correlate a connector callback to its exact onboarding attempt.
--
-- This is opaque workflow metadata only. It must never carry OAuth codes,
-- provider tokens, email addresses, voice turns, vault material, or page
-- content. Postgres is the shared-state seam today; this compare-and-set
-- correlation can later move behind a Redis/Memorystore workflow-state seam
-- without changing the route contract.

BEGIN;

ALTER TABLE vault_keys
  ADD COLUMN IF NOT EXISTS onboarding_callback_attempt_id TEXT;

COMMIT;
