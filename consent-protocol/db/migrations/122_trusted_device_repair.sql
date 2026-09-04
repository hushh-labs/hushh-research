BEGIN;

-- A repair authorization may replace one prior device only after the new
-- PKCE grant is consumed. This remains metadata-only: no credential, vault
-- material, or plaintext information is stored here.
ALTER TABLE trusted_device_authorizations
  ADD COLUMN IF NOT EXISTS replaces_device_id TEXT;

CREATE INDEX IF NOT EXISTS idx_trusted_device_authorizations_replacement
  ON trusted_device_authorizations (replaces_device_id)
  WHERE replaces_device_id IS NOT NULL;

COMMIT;
