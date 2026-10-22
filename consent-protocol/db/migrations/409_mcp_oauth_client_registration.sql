-- OAuth registration confers transport identity only. No consent/key rows change.
BEGIN;
ALTER TABLE developer_apps DROP CONSTRAINT IF EXISTS developer_apps_kind_check;
ALTER TABLE developer_apps ADD CONSTRAINT developer_apps_kind_check
  CHECK (kind IN ('self_serve', 'partner_crm', 'oauth_dynamic'));
ALTER TABLE developer_apps DROP CONSTRAINT IF EXISTS developer_apps_dynamic_policy_check;
ALTER TABLE developer_apps ADD CONSTRAINT developer_apps_dynamic_policy_check CHECK (
  kind <> 'oauth_dynamic' OR (
    owner_firebase_uid IS NULL AND crm_id IS NULL
    AND NOT oauth_client_credentials_enabled AND schema_profile = 'standard'
    AND allowed_tool_groups = '["core_consent"]'::jsonb AND allowed_capabilities = '[]'::jsonb
  )
);
ALTER TABLE developer_oauth_clients
  ADD COLUMN IF NOT EXISTS registration_method TEXT NOT NULL DEFAULT 'portal'
    CHECK (registration_method IN ('portal', 'dcr', 'cimd')),
  ADD COLUMN IF NOT EXISTS token_endpoint_auth_method TEXT NOT NULL DEFAULT 'client_secret_basic'
    CHECK (token_endpoint_auth_method IN ('none', 'client_secret_basic', 'client_secret_post'));
ALTER TABLE developer_oauth_clients DROP CONSTRAINT IF EXISTS developer_oauth_public_client_check;
ALTER TABLE developer_oauth_clients ADD CONSTRAINT developer_oauth_public_client_check CHECK (
  (token_endpoint_auth_method <> 'none' AND client_secret_hash <> '') OR
  (token_endpoint_auth_method = 'none' AND registration_method <> 'portal'
    AND client_secret_hash = '' AND client_secret_prefix = '')
);
ALTER TABLE developer_oauth_clients DROP CONSTRAINT IF EXISTS developer_oauth_registration_policy_check;
ALTER TABLE developer_oauth_clients ADD CONSTRAINT developer_oauth_registration_policy_check CHECK (
  registration_method = 'portal' OR (
    allowed_grant_types <@ '["authorization_code", "refresh_token"]'::jsonb
    AND allowed_grant_types @> '["authorization_code"]'::jsonb
    AND mcp_execution_mode = 'execute'
    AND (registration_method <> 'cimd' OR token_endpoint_auth_method = 'none')
  )
);
ALTER TABLE developer_oauth_authorizations ADD COLUMN IF NOT EXISTS resource TEXT;
ALTER TABLE developer_oauth_tokens ADD COLUMN IF NOT EXISTS resource TEXT;
CREATE INDEX IF NOT EXISTS idx_developer_oauth_tokens_active_family
  ON developer_oauth_tokens (app_id, authorization_id) WHERE revoked_at IS NULL;
COMMENT ON COLUMN developer_oauth_clients.registration_method IS
  'Client onboarding provenance, never evidence of verified identity or information consent.';
COMMIT;
