-- Expand only: preserve 225's API-key rows and legacy encrypted envelopes.
-- Rollback is code/feature disablement; do not drop ciphertext or generations.
BEGIN;

ALTER TABLE external_mcp_connectors
  ADD COLUMN IF NOT EXISTS transport_kind TEXT NOT NULL DEFAULT 'mcp',
  ADD COLUMN IF NOT EXISTS capability_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS registered_redirect_uris JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE user_external_connector_connections
  ADD COLUMN IF NOT EXISTS connection_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credential_version BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS envelope_version SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS credential_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pending_attempt_id TEXT,
  ADD COLUMN IF NOT EXISTS refresh_lease_id TEXT,
  ADD COLUMN IF NOT EXISTS refresh_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS validation_state TEXT NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS verified_policy_hash TEXT,
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revocation_outcome TEXT NOT NULL DEFAULT 'not_attempted',
  ADD COLUMN IF NOT EXISTS revocation_pending_until TIMESTAMPTZ;

ALTER TABLE user_external_connector_connections
  DROP CONSTRAINT IF EXISTS user_external_connector_connections_status_check;
ALTER TABLE user_external_connector_connections
  ADD CONSTRAINT user_external_connector_connections_status_check
    CHECK (status IN ('connected', 'revoked', 'error', 'verifying', 'needs_reauth'));

ALTER TABLE external_connector_oauth_attempts
  ADD COLUMN IF NOT EXISTS attempt_version SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS connection_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS oauth_client_id TEXT,
  ADD COLUMN IF NOT EXISTS flow TEXT NOT NULL DEFAULT 'web',
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS invalidated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pending_credential_ciphertext TEXT,
  ADD COLUMN IF NOT EXISTS pending_credential_iv TEXT,
  ADD COLUMN IF NOT EXISTS pending_credential_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_connector_transport_check' AND conrelid = 'external_mcp_connectors'::regclass) THEN
    ALTER TABLE external_mcp_connectors ADD CONSTRAINT external_connector_transport_check
      CHECK (transport_kind IN ('mcp', 'google_drive_rest'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_connector_policy_shape_check' AND conrelid = 'external_mcp_connectors'::regclass) THEN
    ALTER TABLE external_mcp_connectors ADD CONSTRAINT external_connector_policy_shape_check
      CHECK (jsonb_typeof(capability_policy) = 'object' AND jsonb_typeof(registered_redirect_uris) = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_connector_versions_check' AND conrelid = 'user_external_connector_connections'::regclass) THEN
    ALTER TABLE user_external_connector_connections ADD CONSTRAINT external_connector_versions_check
      CHECK (connection_generation >= 0 AND credential_version >= 0 AND envelope_version IN (1, 2));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_connector_refresh_lease_check' AND conrelid = 'user_external_connector_connections'::regclass) THEN
    ALTER TABLE user_external_connector_connections ADD CONSTRAINT external_connector_refresh_lease_check
      CHECK ((refresh_lease_id IS NULL) = (refresh_lease_expires_at IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_connector_validation_check' AND conrelid = 'user_external_connector_connections'::regclass) THEN
    ALTER TABLE user_external_connector_connections ADD CONSTRAINT external_connector_validation_check
      CHECK (validation_state IN ('unverified', 'verified', 'unavailable', 'policy_drift'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_connector_revocation_check' AND conrelid = 'user_external_connector_connections'::regclass) THEN
    ALTER TABLE user_external_connector_connections ADD CONSTRAINT external_connector_revocation_check
      CHECK (revocation_outcome IN ('not_attempted', 'pending', 'revoked', 'failed', 'unavailable'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_connector_attempt_check' AND conrelid = 'external_connector_oauth_attempts'::regclass) THEN
    ALTER TABLE external_connector_oauth_attempts ADD CONSTRAINT external_connector_attempt_check
      CHECK (attempt_version IN (1, 2) AND connection_generation >= 0 AND flow IN ('web', 'native'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_connector_pending_envelope_check' AND conrelid = 'external_connector_oauth_attempts'::regclass) THEN
    ALTER TABLE external_connector_oauth_attempts ADD CONSTRAINT external_connector_pending_envelope_check
      CHECK ((pending_credential_ciphertext IS NULL) = (pending_credential_iv IS NULL));
  END IF;
END $$;

-- Attempts are ten-minute workflow state. Owner/connector lookup is bounded by
-- one active pointer; the expiry index supports opportunistic ciphertext purge.
CREATE INDEX IF NOT EXISTS external_connector_attempts_owner_idx
  ON external_connector_oauth_attempts (user_id, connector_id);
CREATE INDEX IF NOT EXISTS external_connector_attempts_expiry_idx
  ON external_connector_oauth_attempts (expires_at);

COMMIT;
