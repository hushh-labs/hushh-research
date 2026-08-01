BEGIN;

-- Application rollback is intentionally schema-preserving. Older application
-- versions safely ignore these additive columns, while dropping them would
-- erase the exact consent mode attached to already-issued grants.
COMMENT ON COLUMN one_location_share_grants.location_mode IS
  'Persisted privacy mode for each location grant; retained across application rollback.';
COMMENT ON COLUMN one_location_share_grants.approximate_radius_m IS
  'Approximate-area radius in metres; retained across application rollback.';

COMMIT;
