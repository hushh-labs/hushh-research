BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM connected_system_intents
    WHERE delivery_mode = 'crm-encrypted-fields.v1'
  ) THEN
    RAISE EXCEPTION
      'Migration 144 rollback requires zero crm-encrypted-fields.v1 intents; retain encrypted audit rows instead';
  END IF;
END $$;

DROP INDEX IF EXISTS idx_connected_system_intents_encrypted_fields_client_operation;

ALTER TABLE connected_system_intents
  DROP CONSTRAINT IF EXISTS connected_system_intents_crm_encrypted_fields_shape;
ALTER TABLE connected_system_intents
  DROP CONSTRAINT IF EXISTS connected_system_intents_delivery_mode_check;
ALTER TABLE connected_system_intents
  ADD CONSTRAINT connected_system_intents_delivery_mode_check CHECK (
    delivery_mode IN ('legacy', 'crm-zk.v1', 'crm-zk-uat.v1')
  );

DROP TABLE IF EXISTS crm_encrypted_fields_recipient_keys;

ALTER TABLE crm_operation_endpoints
  DROP COLUMN IF EXISTS crm_encrypted_fields_tool_name;
ALTER TABLE enterprise_crm_registry
  DROP COLUMN IF EXISTS crm_encrypted_fields_v1_enabled;

ALTER TABLE enterprise_crm_registry
  DROP CONSTRAINT IF EXISTS crm_registry_credential_shape;
ALTER TABLE enterprise_crm_registry
  ADD CONSTRAINT crm_registry_credential_shape CHECK (
    (encryption_algorithm = 'aes-256-gcm'
       AND crm_client_id_ciphertext IS NOT NULL
       AND crm_client_secret_ciphertext IS NOT NULL)
    OR
    (encryption_algorithm = 'pbkdf2-hmacsha256-aes256-cbc'
       AND crm_client_id_blob IS NOT NULL
       AND crm_client_secret_blob IS NOT NULL)
  );

COMMIT;
