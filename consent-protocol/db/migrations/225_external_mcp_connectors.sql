-- External MCP connector registry + per-user connection state.
--
-- Lets a person pull their own data into Kai from outside services (Notion,
-- HubSpot, Google Workspace, ...) through a real external MCP server,
-- connected and managed the same way Calendar/Location already work. This
-- is the opposite direction from Hushh's own outward-facing MCP server
-- (mcp_server.py): here Hushh is the MCP *client*.
--
-- external_mcp_connectors is an operator-curated catalog -- "devs add a
-- connector here" -- not end-user-writable. user_external_connector_connections
-- is the per-user credential/status row, encrypted AAD-bound to the user the
-- same way google_provider_connections is (see
-- hushh_mcp/services/external_connector_credentials_service.py), separate
-- from the operator-level enterprise_crm_registry secret scheme since these
-- are personal, not operator-provisioned, credentials.

BEGIN;

CREATE TABLE IF NOT EXISTS external_mcp_connectors (
  connector_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT,
  mcp_endpoint TEXT NOT NULL,
  auth_style TEXT NOT NULL CHECK (auth_style IN ('api_key', 'oauth')),
  oauth_authorize_url TEXT,
  oauth_token_url TEXT,
  oauth_scopes TEXT,
  oauth_client_id_env TEXT,
  oauth_client_secret_env TEXT,
  api_key_header_name TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE external_mcp_connectors IS
  'Operator-curated catalog of external MCP servers users can connect (Notion, HubSpot, ...). Registered via scripts/ops/configure_external_mcp_connector.py, never end-user-writable.';

CREATE TABLE IF NOT EXISTS user_external_connector_connections (
  user_id TEXT NOT NULL,
  connector_id TEXT NOT NULL REFERENCES external_mcp_connectors(connector_id),
  status TEXT NOT NULL CHECK (status IN ('connected', 'revoked', 'error')),
  credential_ciphertext TEXT,
  credential_iv TEXT,
  credential_tag TEXT,
  credential_algorithm TEXT,
  connected_account_label TEXT,
  connected_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, connector_id)
);

COMMENT ON TABLE user_external_connector_connections IS
  'Per-user connection status and encrypted credential envelope for one external MCP connector. Credential ciphertext AAD-bound to (user_id, connector_id); never a shared operator-level key.';

CREATE TABLE IF NOT EXISTS external_connector_oauth_attempts (
  attempt_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  connector_id TEXT NOT NULL REFERENCES external_mcp_connectors(connector_id),
  code_verifier_ciphertext TEXT NOT NULL,
  code_verifier_iv TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

COMMENT ON TABLE external_connector_oauth_attempts IS
  'Short-lived PKCE attempt state for an OAuth-style external connector, mirroring google_oauth_attempts.';

-- Refresh migration 201's tombstone write guards for the new account-keyed
-- tables. Guarded so partial test schemas without 201 still apply cleanly;
-- every release lane runs 201 before this migration (manifest order).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;

COMMIT;
