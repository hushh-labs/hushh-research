-- CRM ZK v1: pinned MuleSoft recipient keys, owner signing keys, and opaque intents.
--
-- This is additive by design. Existing CRM rows continue to use their legacy
-- transport until an operator enables crm_zk_v1 and registers an active key.

BEGIN;

ALTER TABLE enterprise_crm_registry
  ADD COLUMN IF NOT EXISTS crm_zk_v1_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS mulesoft_connector_ref TEXT;

-- The legacy tool name remains authoritative for plaintext connectors. A
-- ZK-enabled connector must opt in to dedicated partner tools so an opaque
-- envelope cannot accidentally be interpreted by a legacy CRUD tool.
ALTER TABLE crm_operation_endpoints
  ADD COLUMN IF NOT EXISTS crm_zk_tool_name TEXT;

CREATE TABLE IF NOT EXISTS crm_zk_recipient_keys (
  crm_id TEXT NOT NULL REFERENCES enterprise_crm_registry(crm_id) ON DELETE CASCADE,
  key_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  public_key_fingerprint TEXT NOT NULL,
  response_signing_public_key TEXT NOT NULL,
  response_signing_key_id TEXT NOT NULL,
  response_signing_key_fingerprint TEXT NOT NULL,
  profile TEXT NOT NULL DEFAULT 'crm-zk.v1' CHECK (profile = 'crm-zk.v1'),
  environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retiring', 'retired', 'revoked')),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retires_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (crm_id, key_id),
  CHECK (public_key_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (response_signing_key_fingerprint ~ '^sha256:[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_zk_recipient_keys_one_active
  ON crm_zk_recipient_keys (crm_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS connected_system_owner_signing_keys (
  user_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  public_key_spki TEXT NOT NULL,
  public_key_fingerprint TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'ECDSA-P256-SHA256'
    CHECK (algorithm = 'ECDSA-P256-SHA256'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, key_id),
  CHECK (public_key_fingerprint ~ '^sha256:[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_connected_system_owner_signing_key_active
  ON connected_system_owner_signing_keys (user_id)
  WHERE status = 'active';

ALTER TABLE connected_system_intents
  ADD COLUMN IF NOT EXISTS delivery_mode TEXT NOT NULL DEFAULT 'legacy'
    CHECK (delivery_mode IN ('legacy', 'crm-zk.v1')),
  ADD COLUMN IF NOT EXISTS encrypted_fields_json JSONB,
  ADD COLUMN IF NOT EXISTS zk_metadata_json JSONB,
  ADD COLUMN IF NOT EXISTS envelope_digest TEXT,
  ADD COLUMN IF NOT EXISTS client_operation_id TEXT,
  ADD COLUMN IF NOT EXISTS approval_challenge_id TEXT;

-- UAT and production run migrations with --migration-mode replay, so every
-- statement here has to survive a second application. Everything else in this
-- file already does (IF NOT EXISTS on every table, index and column); this
-- ALTER did not, and Postgres has no ADD CONSTRAINT IF NOT EXISTS. The first
-- replay after this migration landed failed the whole UAT deploy with
-- DuplicateObjectError, which blocks the release before anything ships.
ALTER TABLE connected_system_intents
  DROP CONSTRAINT IF EXISTS connected_system_intents_crm_zk_shape;

ALTER TABLE connected_system_intents
  ADD CONSTRAINT connected_system_intents_crm_zk_shape CHECK (
    delivery_mode <> 'crm-zk.v1'
    OR (
      encrypted_fields_json IS NOT NULL
      AND zk_metadata_json IS NOT NULL
      AND envelope_digest ~ '^sha256:[0-9a-f]{64}$'
    )
  );

CREATE INDEX IF NOT EXISTS idx_connected_system_intents_zk_digest
  ON connected_system_intents (envelope_digest)
  WHERE delivery_mode = 'crm-zk.v1';

CREATE UNIQUE INDEX IF NOT EXISTS idx_connected_system_intents_zk_client_operation
  ON connected_system_intents (user_id, system_id, action, client_operation_id)
  WHERE delivery_mode = 'crm-zk.v1';

CREATE TABLE IF NOT EXISTS connected_system_zk_contexts (
  context_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('read', 'update')),
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  field_names_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  schema_fingerprint TEXT,
  configuration_revision BIGINT NOT NULL,
  recipient_key_id TEXT NOT NULL,
  recipient_key_fingerprint TEXT NOT NULL,
  client_operation_id TEXT NOT NULL,
  context_digest TEXT NOT NULL,
  context_signer_key_id TEXT NOT NULL,
  context_signature TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(field_names_json) = 'array'),
  CHECK (recipient_key_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (context_digest ~ '^sha256:[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_connected_system_zk_contexts_lookup
  ON connected_system_zk_contexts (context_id, user_id, system_id, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_connected_system_zk_contexts_client_operation
  ON connected_system_zk_contexts (user_id, system_id, client_operation_id);

CREATE TABLE IF NOT EXISTS connected_system_intent_approval_challenges (
  challenge_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES connected_system_intents(intent_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  envelope_digest TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (envelope_digest ~ '^sha256:[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_connected_system_intent_approval_challenge_open
  ON connected_system_intent_approval_challenges (intent_id)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_connected_system_intent_approval_challenge_lookup
  ON connected_system_intent_approval_challenges (challenge_id, user_id, system_id, expires_at);

COMMIT;
