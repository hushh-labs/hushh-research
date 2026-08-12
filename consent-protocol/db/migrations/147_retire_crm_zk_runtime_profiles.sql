-- Retire inactive CRM-ZK profile configuration. Applied profile artifacts stay
-- available as immutable audit history; no runtime may select them again.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM connected_system_intents
    WHERE delivery_mode IN ('crm-zk.v1', 'crm-zk-uat.v1')
      AND status NOT IN ('rejected', 'succeeded', 'partial', 'failed')
  ) THEN
    RAISE EXCEPTION
      'CRM-ZK retirement requires all non-terminal legacy encrypted intents to be settled or cancelled first';
  END IF;
END $$;

UPDATE enterprise_crm_registry
SET crm_zk_v1_enabled = FALSE,
    crm_zk_uat_v1_enabled = FALSE,
    mulesoft_connector_ref = NULL,
    updated_at = NOW()
WHERE crm_zk_v1_enabled IS TRUE
   OR crm_zk_uat_v1_enabled IS TRUE
   OR mulesoft_connector_ref IS NOT NULL;

UPDATE crm_operation_endpoints
SET crm_zk_tool_name = NULL,
    crm_zk_uat_tool_name = NULL;

ALTER TABLE enterprise_crm_registry
  DROP CONSTRAINT IF EXISTS enterprise_crm_registry_crm_zk_profile_exclusive;
ALTER TABLE enterprise_crm_registry
  DROP CONSTRAINT IF EXISTS enterprise_crm_registry_legacy_crm_zk_profiles_retired;
ALTER TABLE enterprise_crm_registry
  ADD CONSTRAINT enterprise_crm_registry_legacy_crm_zk_profiles_retired CHECK (
    NOT crm_zk_v1_enabled
    AND NOT crm_zk_uat_v1_enabled
  );

COMMIT;
