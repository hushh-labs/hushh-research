-- Enterprise CRM registry: DB-backed Connected Systems with AES-256-GCM credential envelopes.
--
-- Replaces the hardcoded ConnectedSystemDefinition + unauthenticated MCP endpoint in
-- hushh_mcp/services/connected_systems_service.py. Credentials (client_id / client_secret)
-- are stored as AES-256-GCM envelopes (matching hushh_mcp/vault/encrypt.py EncryptedPayload)
-- and decrypted at request time with VAULT_DATA_KEY. No new long-lived secrets are introduced;
-- the gateway URL is non-secret config and stored in plaintext.

CREATE TABLE IF NOT EXISTS enterprise_crm_registry (
  crm_id              TEXT PRIMARY KEY,
  crm_enterprise_name TEXT NOT NULL,
  crm_type            TEXT,
  environment         TEXT NOT NULL DEFAULT 'production'
                      CHECK (environment IN ('sandbox', 'production')),

  crm_base_url        TEXT NOT NULL,
  crm_token_url       TEXT,                       -- nullable: gateway uses header auth, not OAuth token URL
  crm_mcp_endpoint    TEXT NOT NULL,              -- streamable-HTTP MCP URL (the Omni Gateway)

  -- AES-256-GCM envelopes (matches hushh_mcp/vault/encrypt.py EncryptedPayload)
  crm_client_id_ciphertext      TEXT NOT NULL,
  crm_client_id_iv              TEXT NOT NULL,
  crm_client_id_tag             TEXT NOT NULL,
  crm_client_secret_ciphertext  TEXT NOT NULL,
  crm_client_secret_iv          TEXT NOT NULL,
  crm_client_secret_tag         TEXT NOT NULL,
  encryption_algorithm          TEXT NOT NULL DEFAULT 'aes-256-gcm',
  key_id                        TEXT NOT NULL DEFAULT 'vault_data_key_v1',

  -- how the decrypted credentials map onto MCP transport headers
  auth_header_style   TEXT NOT NULL DEFAULT 'client_id_secret_headers',

  supports_create  BOOLEAN NOT NULL DEFAULT TRUE,
  supports_read    BOOLEAN NOT NULL DEFAULT TRUE,
  supports_update  BOOLEAN NOT NULL DEFAULT TRUE,
  supports_delete  BOOLEAN NOT NULL DEFAULT FALSE,

  user_object_name   TEXT DEFAULT 'Contact',
  rate_limit_per_min INTEGER,
  timeout_seconds    INTEGER NOT NULL DEFAULT 30,
  retry_count        INTEGER NOT NULL DEFAULT 3,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,

  business_owner   TEXT,
  technical_owner  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (crm_enterprise_name, crm_type, environment)
);

CREATE INDEX IF NOT EXISTS idx_enterprise_crm_registry_active
  ON enterprise_crm_registry (is_active, environment);

-- Per-operation tool catalog: each CRUD operation maps to a distinct MCP tool name.
-- read/create/update/delete differ in both their tool and required inputs, so they are
-- modeled as rows rather than a single endpoint column. http_method / path are
-- informational (MCP is JSON-RPC) and reserved for a future REST fallback.
CREATE TABLE IF NOT EXISTS crm_operation_endpoints (
  crm_id      TEXT NOT NULL REFERENCES enterprise_crm_registry(crm_id) ON DELETE CASCADE,
  operation   TEXT NOT NULL CHECK (operation IN ('schema', 'create', 'read', 'update', 'delete')),
  tool_name   TEXT NOT NULL,             -- MCP tool name, e.g. read-crm-record
  http_method TEXT,                       -- informational
  path        TEXT,                       -- informational / future REST fallback
  description TEXT,
  PRIMARY KEY (crm_id, operation)
);
