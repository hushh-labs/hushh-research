-- Migration 200: serialize directory contact policy with graph mutations
-- ======================================================================
-- Contact sync treats a missing v1 preference as the verified Connect
-- directory default. These triggers close the absent-row race: a concurrent
-- directory hide or explicit contact preference change must take the same
-- per-user advisory lock that graph activation already holds.

BEGIN;

CREATE OR REPLACE FUNCTION lock_contact_sync_directory_policy_user()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected_user_id TEXT;
BEGIN
  affected_user_id := CASE
    WHEN TG_OP = 'DELETE' THEN OLD.user_id
    ELSE NEW.user_id
  END;
  IF affected_user_id IS NOT NULL AND BTRIM(affected_user_id) <> '' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(affected_user_id, 171));
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- A default actor row has the same eligibility as no actor row. Do not add a
-- graph lock to routine identity/profile hydration, which can already hold
-- identity locks. An inserted explicit or malformed preference does change
-- policy and must serialize even when no previous actor row exists.
-- Multi-user policy writers must acquire sorted graph-user locks before
-- touching identity or graph rows, just as the application setter does.
DROP TRIGGER IF EXISTS actor_profiles_contact_sync_policy_insert_lock ON actor_profiles;
CREATE TRIGGER actor_profiles_contact_sync_policy_insert_lock
BEFORE INSERT ON actor_profiles
FOR EACH ROW
WHEN (
  NEW.contact_sync_consent_rule_version IS DISTINCT FROM 0
  OR NEW.contact_sync_consent_enabled_at IS NOT NULL
  OR NEW.contact_sync_consent_contract_version IS NOT NULL
)
EXECUTE FUNCTION lock_contact_sync_directory_policy_user();

DROP TRIGGER IF EXISTS actor_profiles_contact_sync_policy_lock ON actor_profiles;
CREATE TRIGGER actor_profiles_contact_sync_policy_lock
BEFORE UPDATE OF
  contact_discoverable,
  contact_sync_consent_enabled_at,
  contact_sync_consent_rule_version,
  contact_sync_consent_contract_version
ON actor_profiles
FOR EACH ROW
EXECUTE FUNCTION lock_contact_sync_directory_policy_user();

DROP TRIGGER IF EXISTS marketplace_profiles_contact_sync_policy_lock
  ON marketplace_public_profiles;
CREATE TRIGGER marketplace_profiles_contact_sync_policy_lock
BEFORE INSERT OR DELETE OR UPDATE OF is_discoverable
ON marketplace_public_profiles
FOR EACH ROW
EXECUTE FUNCTION lock_contact_sync_directory_policy_user();

COMMIT;
