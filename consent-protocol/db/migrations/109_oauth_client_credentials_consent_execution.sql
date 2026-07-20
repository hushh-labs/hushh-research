-- Client credentials authenticate a partner application; explicit user
-- approval and the resulting scoped grant remain the information authority.
-- Promote already provisioned partner MCP clients from catalog-only discovery
-- to the canonical consent lifecycle without rotating their credentials.

BEGIN;

UPDATE developer_oauth_clients AS clients
SET mcp_execution_mode = 'execute'
FROM developer_apps AS apps
WHERE clients.app_id = apps.app_id
  AND clients.revoked_at IS NULL
  AND apps.status = 'active'
  AND apps.kind = 'partner_crm'
  AND apps.oauth_client_credentials_enabled = TRUE
  AND clients.allowed_grant_types ? 'client_credentials';

COMMENT ON COLUMN developer_oauth_clients.mcp_execution_mode IS
  'execute runs the consent lifecycle; catalog_only is reserved for integrations that explicitly request discovery-only behavior.';

COMMIT;
