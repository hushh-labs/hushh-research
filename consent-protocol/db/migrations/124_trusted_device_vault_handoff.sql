BEGIN;

-- Ciphertext-only, one-time vault-key delivery for trusted-device enrollment.
-- The handoff is consumed atomically with the existing PKCE authorization.
ALTER TABLE trusted_device_authorizations
  ADD COLUMN IF NOT EXISTS oauth_state TEXT,
  ADD COLUMN IF NOT EXISTS vault_handoff JSONB;

COMMENT ON COLUMN trusted_device_authorizations.vault_handoff IS
  'Short-lived X25519/AES-GCM ciphertext consumed with the PKCE authorization; never plaintext vault material.';

COMMIT;
