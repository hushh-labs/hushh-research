BEGIN;

DROP TABLE IF EXISTS connected_system_intent_approval_challenges;
DROP INDEX IF EXISTS idx_connected_system_zk_contexts_client_operation;
DROP TABLE IF EXISTS connected_system_zk_contexts;
DROP INDEX IF EXISTS idx_connected_system_intents_zk_digest;
ALTER TABLE connected_system_intents
  DROP CONSTRAINT IF EXISTS connected_system_intents_crm_zk_shape;
ALTER TABLE connected_system_intents
  DROP COLUMN IF EXISTS approval_challenge_id,
  DROP COLUMN IF EXISTS client_operation_id,
  DROP COLUMN IF EXISTS envelope_digest,
  DROP COLUMN IF EXISTS zk_metadata_json,
  DROP COLUMN IF EXISTS encrypted_fields_json,
  DROP COLUMN IF EXISTS delivery_mode;

DROP TABLE IF EXISTS connected_system_owner_signing_keys;
DROP TABLE IF EXISTS crm_zk_recipient_keys;

ALTER TABLE crm_operation_endpoints
  DROP COLUMN IF EXISTS crm_zk_tool_name;

ALTER TABLE enterprise_crm_registry
  DROP COLUMN IF EXISTS mulesoft_connector_ref,
  DROP COLUMN IF EXISTS crm_zk_v1_enabled;

COMMIT;
