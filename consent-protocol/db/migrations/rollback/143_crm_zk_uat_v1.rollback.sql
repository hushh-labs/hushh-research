BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM connected_system_intents
    WHERE delivery_mode = 'crm-zk-uat.v1'
  ) THEN
    RAISE EXCEPTION
      'Migration 143 rollback requires zero crm-zk-uat.v1 intents; disable the feature and retain audit rows instead';
  END IF;
END $$;

DROP INDEX IF EXISTS idx_connected_system_intents_zk_uat_client_operation;

ALTER TABLE connected_system_intents
  DROP CONSTRAINT IF EXISTS connected_system_intents_crm_zk_uat_shape;

ALTER TABLE connected_system_intents
  DROP CONSTRAINT IF EXISTS connected_system_intents_delivery_mode_check;

ALTER TABLE connected_system_intents
  ADD CONSTRAINT connected_system_intents_delivery_mode_check CHECK (
    delivery_mode IN ('legacy', 'crm-zk.v1')
  );

DROP TABLE IF EXISTS crm_zk_uat_recipient_keys;

ALTER TABLE crm_operation_endpoints
  DROP COLUMN IF EXISTS crm_zk_uat_tool_name;

ALTER TABLE enterprise_crm_registry
  DROP CONSTRAINT IF EXISTS enterprise_crm_registry_crm_zk_profile_exclusive;

ALTER TABLE enterprise_crm_registry
  DROP COLUMN IF EXISTS crm_zk_uat_v1_enabled;

COMMIT;
