-- 105_agentforce_mcp_compatibility.sql
--
-- Capability-safe MCP projections for constrained clients. Existing developer
-- apps remain on the standard v0.3 catalog and cannot use client credentials
-- unless an operator explicitly enables it.

BEGIN;

ALTER TABLE developer_apps
    ADD COLUMN IF NOT EXISTS schema_profile TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE developer_apps
    ADD COLUMN IF NOT EXISTS oauth_client_credentials_enabled BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'developer_apps_schema_profile_check'
    ) THEN
        ALTER TABLE developer_apps
            ADD CONSTRAINT developer_apps_schema_profile_check
            CHECK (schema_profile IN ('standard', 'flat'));
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS developer_connector_keys (
    app_id TEXT NOT NULL REFERENCES developer_apps(app_id) ON DELETE CASCADE,
    connector_key_id TEXT NOT NULL,
    connector_public_key TEXT NOT NULL,
    recipient_key_fingerprint TEXT NOT NULL,
    connector_wrapping_alg TEXT NOT NULL DEFAULT 'X25519-AES256-GCM',
    status TEXT NOT NULL DEFAULT 'active',
    created_at BIGINT NOT NULL,
    retired_at BIGINT,
    revoked_at BIGINT,
    PRIMARY KEY (app_id, connector_key_id),
    CONSTRAINT developer_connector_keys_algorithm_check
        CHECK (connector_wrapping_alg = 'X25519-AES256-GCM'),
    CONSTRAINT developer_connector_keys_status_check
        CHECK (status IN ('active', 'retired', 'revoked'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_developer_connector_keys_one_active_per_app
    ON developer_connector_keys(app_id)
    WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_developer_connector_keys_fingerprint
    ON developer_connector_keys(app_id, recipient_key_fingerprint);

-- Client-credentials access tokens represent an application, not a human
-- OAuth subject. Authorization-code and refresh tokens retain their subject.
ALTER TABLE developer_oauth_tokens
    ALTER COLUMN subject_firebase_uid DROP NOT NULL;
ALTER TABLE developer_oauth_tokens
    ADD COLUMN IF NOT EXISTS grant_type TEXT NOT NULL DEFAULT 'authorization_code';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'developer_oauth_tokens_grant_type_check'
    ) THEN
        ALTER TABLE developer_oauth_tokens
            ADD CONSTRAINT developer_oauth_tokens_grant_type_check
            CHECK (grant_type IN ('authorization_code', 'client_credentials'));
    END IF;
END
$$;

COMMENT ON COLUMN developer_apps.schema_profile IS
  'Authenticated MCP catalog projection. standard preserves v0.3; flat is explicitly provisioned for constrained hosts.';
COMMENT ON COLUMN developer_apps.oauth_client_credentials_enabled IS
  'Allows OAuth client_credentials only when explicitly provisioned by an operator.';
COMMENT ON TABLE developer_connector_keys IS
  'Partner-owned X25519 public keys registered per developer app. Private keys are never stored by Hussh.';

COMMIT;
