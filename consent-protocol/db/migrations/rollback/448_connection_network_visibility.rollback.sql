BEGIN;
ALTER TABLE actor_profiles DROP COLUMN IF EXISTS connection_list_shared;
COMMIT;
