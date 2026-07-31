BEGIN;

ALTER TABLE marketplace_public_profiles
  ADD COLUMN IF NOT EXISTS exposure_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS visibility_posture TEXT NOT NULL DEFAULT 'default_available';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'marketplace_public_profiles_visibility_posture_check'
  ) THEN
    ALTER TABLE marketplace_public_profiles
      DROP CONSTRAINT marketplace_public_profiles_visibility_posture_check;
  END IF;
END $$;

ALTER TABLE marketplace_public_profiles
  ADD CONSTRAINT marketplace_public_profiles_visibility_posture_check
  CHECK (visibility_posture IN ('private', 'consent_required', 'default_available', 'limited', 'public'));

UPDATE marketplace_public_profiles
SET
  exposure_enabled = is_discoverable,
  visibility_posture = CASE
    WHEN is_discoverable THEN 'default_available'
    ELSE 'private'
  END
WHERE exposure_enabled IS DISTINCT FROM is_discoverable
   OR visibility_posture IS NULL
   OR TRIM(visibility_posture) = '';

CREATE INDEX IF NOT EXISTS idx_marketplace_public_profiles_visibility
  ON marketplace_public_profiles(profile_type, exposure_enabled, visibility_posture)
  WHERE is_discoverable = TRUE;

COMMIT;
