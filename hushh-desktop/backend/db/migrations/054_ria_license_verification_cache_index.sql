BEGIN;

CREATE INDEX IF NOT EXISTS idx_ria_license_verifications_cache_lookup
  ON ria_license_verifications (
    user_id,
    license_number,
    verification_source,
    status,
    created_at DESC
  );

COMMIT;
