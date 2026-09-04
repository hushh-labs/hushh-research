-- Rollback 198: remove verified-phone schema enforcement
-- ========================================================
-- The migration's de-verification is intentionally irreversible: restoring a
-- phone-to-user binding without a new possession proof could restore the wrong
-- owner. This rollback drops only the schema guards. It never re-verifies a
-- user or recreates cleared phone data; affected users must re-verify.

BEGIN;

DROP INDEX IF EXISTS uq_actor_identity_cache_verified_phone;

ALTER TABLE actor_identity_cache
  DROP CONSTRAINT IF EXISTS actor_identity_cache_verified_phone_e164_check;

COMMIT;
