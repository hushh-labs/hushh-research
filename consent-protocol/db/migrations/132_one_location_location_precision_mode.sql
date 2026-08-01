BEGIN;

ALTER TABLE one_location_share_grants
  ADD COLUMN IF NOT EXISTS location_mode TEXT NOT NULL DEFAULT 'precise',
  ADD COLUMN IF NOT EXISTS approximate_radius_m INTEGER;

ALTER TABLE one_location_share_grants
  DROP CONSTRAINT IF EXISTS one_location_share_grants_location_mode_valid;
ALTER TABLE one_location_share_grants
  ADD CONSTRAINT one_location_share_grants_location_mode_valid
  CHECK (location_mode IN ('precise', 'approximate'));

ALTER TABLE one_location_share_grants
  DROP CONSTRAINT IF EXISTS one_location_share_grants_approximate_radius_valid;
ALTER TABLE one_location_share_grants
  ADD CONSTRAINT one_location_share_grants_approximate_radius_valid
  CHECK (
    (location_mode = 'precise' AND approximate_radius_m IS NULL)
    OR
    (
      location_mode = 'approximate'
      AND approximate_radius_m IS NOT NULL
      AND approximate_radius_m BETWEEN 1000 AND 20000
      AND approximate_radius_m % 250 = 0
    )
  );

COMMENT ON COLUMN one_location_share_grants.location_mode IS
  'Immutable recipient-visible precision contract: precise point or client-coarsened approximate area.';
COMMENT ON COLUMN one_location_share_grants.approximate_radius_m IS
  'Public display radius for an approximate-area grant; null for precise grants. Private coordinates remain ciphertext-only.';

COMMIT;
