-- The single external CRM encrypted-fields profile.
--
-- Historical crm-zk migrations remain immutable ledger entries. This migration
-- activates a new, deliberately narrow contract without reusing their runtime
-- flags, tools, or key tables.

BEGIN;

ALTER TABLE enterprise_crm_registry
  ADD COLUMN IF NOT EXISTS crm_encrypted_fields_v1_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE crm_operation_endpoints
  ADD COLUMN IF NOT EXISTS crm_encrypted_fields_tool_name TEXT;

CREATE TABLE IF NOT EXISTS crm_encrypted_fields_recipient_keys (
  crm_id TEXT NOT NULL REFERENCES enterprise_crm_registry(crm_id) ON DELETE CASCADE,
  key_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  public_key_fingerprint TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment = 'sandbox'),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'retiring', 'retired', 'revoked')),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retires_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (crm_id, key_id),
  CHECK (public_key_fingerprint ~ '^sha256:[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_encrypted_fields_recipient_keys_one_active
  ON crm_encrypted_fields_recipient_keys (crm_id)
  WHERE status = 'active';

-- Gateway-authenticated MuleSoft rows do not carry a CRM credential in Hussh.
-- The gateway credential is runtime secret configuration; CRM credentials are
-- owned by MuleSoft. Existing encrypted credential rows remain valid history.
ALTER TABLE enterprise_crm_registry
  DROP CONSTRAINT IF EXISTS crm_registry_credential_shape;
ALTER TABLE enterprise_crm_registry
  ADD CONSTRAINT crm_registry_credential_shape CHECK (
    auth_header_style = 'bearer'
    OR (
      encryption_algorithm = 'aes-256-gcm'
      AND crm_client_id_ciphertext IS NOT NULL
      AND crm_client_secret_ciphertext IS NOT NULL
    )
    OR (
      encryption_algorithm = 'pbkdf2-hmacsha256-aes256-cbc'
      AND crm_client_id_blob IS NOT NULL
      AND crm_client_secret_blob IS NOT NULL
    )
  );

ALTER TABLE connected_system_intents
  DROP CONSTRAINT IF EXISTS connected_system_intents_delivery_mode_check;
ALTER TABLE connected_system_intents
  ADD CONSTRAINT connected_system_intents_delivery_mode_check CHECK (
    delivery_mode IN ('legacy', 'crm-zk.v1', 'crm-zk-uat.v1', 'crm-encrypted-fields.v1')
  );

ALTER TABLE connected_system_intents
  DROP CONSTRAINT IF EXISTS connected_system_intents_crm_encrypted_fields_shape;
ALTER TABLE connected_system_intents
  ADD CONSTRAINT connected_system_intents_crm_encrypted_fields_shape CHECK (
    delivery_mode <> 'crm-encrypted-fields.v1'
    OR (
      encrypted_fields_json IS NOT NULL
      AND zk_metadata_json IS NOT NULL
      AND request_payload_json = '{}'::jsonb
      AND readback_payload_json = '{}'::jsonb
      AND envelope_digest ~ '^sha256:[0-9a-f]{64}$'
      AND client_operation_id IS NOT NULL
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_connected_system_intents_encrypted_fields_client_operation
  ON connected_system_intents (user_id, system_id, action, client_operation_id)
  WHERE delivery_mode = 'crm-encrypted-fields.v1';

COMMIT;
