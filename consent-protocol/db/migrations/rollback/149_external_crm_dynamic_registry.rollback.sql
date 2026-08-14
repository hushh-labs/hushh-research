BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM enterprise_crm_registry
    WHERE crm_connection_mode = 'dynamic_registry'
      AND is_active
  ) THEN
    RAISE EXCEPTION 'Deactivate dynamic-registry CRM rows before rolling back migration 149';
  END IF;
END $$;

ALTER TABLE enterprise_crm_registry
  DROP CONSTRAINT IF EXISTS enterprise_crm_registry_dynamic_connection_shape,
  DROP CONSTRAINT IF EXISTS enterprise_crm_registry_connection_mode_check,
  DROP CONSTRAINT IF EXISTS enterprise_crm_registry_gateway_credential_profile_check,
  DROP COLUMN IF EXISTS crm_connection_token_url,
  DROP COLUMN IF EXISTS crm_connection_mcp_endpoint,
  DROP COLUMN IF EXISTS crm_connection_base_url,
  DROP COLUMN IF EXISTS crm_connection_mode,
  DROP COLUMN IF EXISTS gateway_credential_profile;

COMMIT;
