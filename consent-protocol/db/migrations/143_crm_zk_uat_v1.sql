-- CRM ZK UAT v1: isolated confidentiality-only compatibility profile.
--
-- Full crm-zk.v1 remains unchanged. This profile is default-off and may be
-- enabled only for a MuleSoft sandbox connector after conformance testing.

BEGIN;

ALTER TABLE enterprise_crm_registry
  ADD COLUMN IF NOT EXISTS crm_zk_uat_v1_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE enterprise_crm_registry
  DROP CONSTRAINT IF EXISTS enterprise_crm_registry_crm_zk_profile_exclusive;

ALTER TABLE enterprise_crm_registry
  ADD CONSTRAINT enterprise_crm_registry_crm_zk_profile_exclusive CHECK (
    NOT (crm_zk_v1_enabled AND crm_zk_uat_v1_enabled)
  );

ALTER TABLE crm_operation_endpoints
  ADD COLUMN IF NOT EXISTS crm_zk_uat_tool_name TEXT;

CREATE TABLE IF NOT EXISTS crm_zk_uat_recipient_keys (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_zk_uat_recipient_keys_one_active
  ON crm_zk_uat_recipient_keys (crm_id)
  WHERE status = 'active';

ALTER TABLE connected_system_intents
  DROP CONSTRAINT IF EXISTS connected_system_intents_delivery_mode_check;

ALTER TABLE connected_system_intents
  ADD CONSTRAINT connected_system_intents_delivery_mode_check CHECK (
    delivery_mode IN ('legacy', 'crm-zk.v1', 'crm-zk-uat.v1')
  );

ALTER TABLE connected_system_intents
  DROP CONSTRAINT IF EXISTS connected_system_intents_crm_zk_uat_shape;

ALTER TABLE connected_system_intents
  ADD CONSTRAINT connected_system_intents_crm_zk_uat_shape CHECK (
    delivery_mode <> 'crm-zk-uat.v1'
    OR (
      encrypted_fields_json IS NOT NULL
      AND zk_metadata_json IS NOT NULL
      AND request_payload_json = '{}'::jsonb
      AND readback_payload_json = '{}'::jsonb
      AND envelope_digest ~ '^sha256:[0-9a-f]{64}$'
      AND client_operation_id IS NOT NULL
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_connected_system_intents_zk_uat_client_operation
  ON connected_system_intents (user_id, system_id, action, client_operation_id)
  WHERE delivery_mode = 'crm-zk-uat.v1';

COMMIT;
