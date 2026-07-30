BEGIN;

-- First-party native device authorization. These tables contain identity,
-- device-key, replay-prevention, and metadata-only audit state. They never
-- contain a Firebase refresh token, vault passphrase, vault key, PKM plaintext,
-- or consent export key.

CREATE TABLE IF NOT EXISTS trusted_device_authorizations (
  authorization_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  device_public_key TEXT NOT NULL,
  device_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  consumed_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_trusted_device_authorizations_expiry
  ON trusted_device_authorizations (expires_at);

CREATE TABLE IF NOT EXISTS trusted_devices (
  device_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_public_key TEXT NOT NULL,
  device_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  created_at BIGINT NOT NULL,
  last_used_at BIGINT,
  revoked_at BIGINT,
  UNIQUE (user_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_trusted_devices_user
  ON trusted_devices (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS trusted_device_challenges (
  challenge_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES trusted_devices(device_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  consumed_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_trusted_device_challenges_expiry
  ON trusted_device_challenges (expires_at);

CREATE TABLE IF NOT EXISTS trusted_device_audit_events (
  event_id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT,
  event_type TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_trusted_device_audit_user
  ON trusted_device_audit_events (user_id, created_at DESC);

COMMENT ON TABLE trusted_devices IS
  'First-party trusted-device registry. Public device keys and metadata only; no user or vault secrets.';

COMMIT;
