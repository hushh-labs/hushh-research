-- Rollback migration 200.
BEGIN;

DROP TRIGGER IF EXISTS marketplace_profiles_contact_sync_policy_lock
  ON marketplace_public_profiles;
DROP TRIGGER IF EXISTS actor_profiles_contact_sync_policy_lock ON actor_profiles;
DROP TRIGGER IF EXISTS actor_profiles_contact_sync_policy_insert_lock ON actor_profiles;
DROP FUNCTION IF EXISTS lock_contact_sync_directory_policy_user();

COMMIT;
