-- Migration 433: Connect directory presence a person controls.
--
-- Two additive, nullable columns on actor_profiles. Expand only: nothing is
-- renamed, backfilled or dropped, and every existing reader keeps working.
--
--   directory_listed  NULL  -> legacy rule (a stranger appears once their vault
--                              is enrolled in this environment)
--                     TRUE  -> listed by name even without a vault (website-only
--                              accounts can be found and connected)
--                     FALSE -> hidden from strangers; people the viewer already
--                              has a relationship with still see them
--   role_label        what the person does, in their own words ("Pediatric
--                     nurse", "Plumber", "Retired teacher"). Short, public with
--                     the name, never a persona enum: everyone is not an RIA.
BEGIN;
ALTER TABLE actor_profiles
  ADD COLUMN IF NOT EXISTS directory_listed BOOLEAN,
  ADD COLUMN IF NOT EXISTS role_label TEXT;
ALTER TABLE actor_profiles
  DROP CONSTRAINT IF EXISTS actor_profiles_role_label_length_check;
ALTER TABLE actor_profiles
  ADD CONSTRAINT actor_profiles_role_label_length_check
  CHECK (role_label IS NULL OR (char_length(role_label) BETWEEN 1 AND 80));
COMMENT ON COLUMN actor_profiles.directory_listed IS
  'Explicit people-search presence. NULL keeps the vault-enrolment rule; TRUE lists by name without a vault; FALSE hides from strangers only.';
COMMENT ON COLUMN actor_profiles.role_label IS
  'What this person does, in their own words. Shown beside the name wherever the name is shown. At most 80 characters.';
COMMIT;
