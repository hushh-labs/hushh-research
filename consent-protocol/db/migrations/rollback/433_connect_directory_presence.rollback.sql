-- Rollback 433: remove the directory presence columns. Destructive by design;
-- run only after no deployed code reads directory_listed or role_label.
BEGIN;
ALTER TABLE actor_profiles
  DROP CONSTRAINT IF EXISTS actor_profiles_role_label_length_check;
ALTER TABLE actor_profiles
  DROP COLUMN IF EXISTS directory_listed,
  DROP COLUMN IF EXISTS role_label;
COMMIT;
