-- Rollback 140: contact discoverability for One network matching
-- ==============================================================
-- Dropping the column reverts contact matching to marketplace-only
-- eligibility. Any per-user opt-out recorded here is lost, so re-applying the
-- migration restores everyone to the discoverable default.

BEGIN;

DROP INDEX IF EXISTS idx_actor_identity_cache_phone_last4;

DROP INDEX IF EXISTS idx_actor_profiles_contact_discoverable;

ALTER TABLE actor_profiles
  DROP COLUMN IF EXISTS contact_discoverable;

COMMIT;
