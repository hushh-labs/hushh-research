-- Migration 092: durable, redacted One onboarding journey state
--
-- This is a resumable goal record, not a conversation log. It holds only
-- bounded phase/capability/callback metadata and the fixed setup return route.
-- Raw voice turns, private page content, vault material, and OAuth tokens never
-- belong in this table.

BEGIN;

ALTER TABLE vault_keys
  ADD COLUMN IF NOT EXISTS onboarding_journey_version INTEGER,
  ADD COLUMN IF NOT EXISTS onboarding_phase TEXT,
  ADD COLUMN IF NOT EXISTS onboarding_active_capability TEXT,
  ADD COLUMN IF NOT EXISTS onboarding_resume_route TEXT,
  ADD COLUMN IF NOT EXISTS onboarding_callback_state TEXT,
  ADD COLUMN IF NOT EXISTS onboarding_journey_updated_at BIGINT;

ALTER TABLE vault_keys
  DROP CONSTRAINT IF EXISTS vault_keys_onboarding_journey_version_check,
  ADD CONSTRAINT vault_keys_onboarding_journey_version_check
    CHECK (onboarding_journey_version IS NULL OR onboarding_journey_version = 1),
  DROP CONSTRAINT IF EXISTS vault_keys_onboarding_phase_check,
  ADD CONSTRAINT vault_keys_onboarding_phase_check
    CHECK (
      onboarding_phase IS NULL
      OR onboarding_phase IN (
        'anonymous_auth',
        'phone_required',
        'setup_hub',
        'capability_setup',
        'external_connector',
        'root_completion'
      )
    ),
  DROP CONSTRAINT IF EXISTS vault_keys_onboarding_resume_route_check,
  ADD CONSTRAINT vault_keys_onboarding_resume_route_check
    CHECK (onboarding_resume_route IS NULL OR onboarding_resume_route = '/one/setup'),
  DROP CONSTRAINT IF EXISTS vault_keys_onboarding_callback_state_check,
  ADD CONSTRAINT vault_keys_onboarding_callback_state_check
    CHECK (onboarding_callback_state IS NULL OR onboarding_callback_state IN ('none', 'pending', 'succeeded', 'cancelled', 'failed'));

COMMIT;
