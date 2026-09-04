BEGIN;

DROP INDEX IF EXISTS idx_actor_profiles_public_person_ref;
DROP TRIGGER IF EXISTS actor_profiles_public_person_ref_immutable ON actor_profiles;
DROP FUNCTION IF EXISTS prevent_public_person_ref_change();
ALTER TABLE actor_profiles DROP COLUMN IF EXISTS public_person_ref;
ALTER TABLE actor_profiles DROP COLUMN IF EXISTS public_profile_status;

COMMIT;
