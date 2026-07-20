-- One app identity, one public catalog, and credential-scoped execution mode.
-- schema_profile remains only as a migration fallback for previously issued
-- bearer tokens; tools/list no longer selects a catalog from it.

BEGIN;

ALTER TABLE developer_oauth_clients
    ADD COLUMN IF NOT EXISTS allowed_grant_types JSONB
    NOT NULL DEFAULT '["authorization_code","refresh_token"]'::jsonb;
ALTER TABLE developer_oauth_clients
    ADD COLUMN IF NOT EXISTS mcp_execution_mode TEXT
    NOT NULL DEFAULT 'execute';

UPDATE developer_oauth_clients AS clients
SET allowed_grant_types = '["authorization_code","refresh_token","client_credentials"]'::jsonb,
    mcp_execution_mode = 'catalog_only'
FROM developer_apps AS apps
WHERE clients.app_id = apps.app_id
  AND apps.schema_profile = 'agentforce';

UPDATE developer_oauth_clients AS clients
SET allowed_grant_types = '["authorization_code","refresh_token","client_credentials"]'::jsonb
FROM developer_apps AS apps
WHERE clients.app_id = apps.app_id
  AND apps.kind = 'partner_crm'
  AND apps.oauth_client_credentials_enabled = TRUE
  AND apps.schema_profile <> 'agentforce';

ALTER TABLE developer_oauth_tokens
    ADD COLUMN IF NOT EXISTS mcp_execution_mode TEXT
    NOT NULL DEFAULT 'execute';

ALTER TABLE developer_oauth_tokens
    DROP CONSTRAINT IF EXISTS developer_oauth_tokens_mcp_execution_mode_check;
ALTER TABLE developer_oauth_tokens
    ADD CONSTRAINT developer_oauth_tokens_mcp_execution_mode_check
    CHECK (mcp_execution_mode IN ('execute', 'catalog_only'));

COMMENT ON COLUMN developer_oauth_clients.allowed_grant_types IS
  'OAuth grants explicitly allowed for this app client. Client credentials remain operations-provisioned.';
COMMENT ON COLUMN developer_oauth_clients.mcp_execution_mode IS
  'execute runs the consent lifecycle; catalog_only returns the safe consent-center handoff for constrained hosts.';

COMMIT;
