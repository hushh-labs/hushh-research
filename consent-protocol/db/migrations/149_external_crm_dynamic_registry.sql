-- Isolate the external CRM gateway identity from the shared Omni Gateway and
-- model MuleSoft's deployed dynamic-registry tool contract explicitly.

BEGIN;

ALTER TABLE enterprise_crm_registry
  ADD COLUMN IF NOT EXISTS gateway_credential_profile TEXT NOT NULL DEFAULT 'shared',
  ADD COLUMN IF NOT EXISTS crm_connection_mode TEXT NOT NULL DEFAULT 'managed',
  ADD COLUMN IF NOT EXISTS crm_connection_base_url TEXT,
  ADD COLUMN IF NOT EXISTS crm_connection_mcp_endpoint TEXT,
  ADD COLUMN IF NOT EXISTS crm_connection_token_url TEXT;

ALTER TABLE enterprise_crm_registry
  DROP CONSTRAINT IF EXISTS enterprise_crm_registry_gateway_credential_profile_check,
  DROP CONSTRAINT IF EXISTS enterprise_crm_registry_connection_mode_check,
  DROP CONSTRAINT IF EXISTS enterprise_crm_registry_dynamic_connection_shape;

ALTER TABLE enterprise_crm_registry
  ADD CONSTRAINT enterprise_crm_registry_gateway_credential_profile_check CHECK (
    gateway_credential_profile IN ('shared', 'external_crm')
  ),
  ADD CONSTRAINT enterprise_crm_registry_connection_mode_check CHECK (
    crm_connection_mode IN ('managed', 'dynamic_registry')
  ),
  ADD CONSTRAINT enterprise_crm_registry_dynamic_connection_shape CHECK (
    crm_connection_mode <> 'dynamic_registry'
    OR (
      auth_header_style = 'bearer'
      AND gateway_credential_profile = 'external_crm'
      AND crm_connection_base_url IS NOT NULL
      AND crm_connection_mcp_endpoint IS NOT NULL
      AND crm_connection_token_url IS NOT NULL
      AND encryption_algorithm = 'pbkdf2-hmacsha256-aes256-cbc'
      AND crm_client_id_blob IS NOT NULL
      AND crm_client_secret_blob IS NOT NULL
    )
  );

COMMIT;
