BEGIN;

-- Roll back migration 139.
--
-- Drops only the three provenance labels. The narrative fields they describe
-- (services_offered, fee_structure, min_engagement_amount, bio) stay exactly
-- as they are: those are values on a live profile, and dropping the label is
-- not a reason to delete what it labelled.
ALTER TABLE ria_profiles
  DROP COLUMN IF EXISTS profile_source,
  DROP COLUMN IF EXISTS profile_source_url,
  DROP COLUMN IF EXISTS profile_source_filed_on;

COMMIT;
