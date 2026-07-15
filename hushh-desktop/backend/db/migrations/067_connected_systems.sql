-- Connected Systems: approval-gated external CRM MCP intents and metadata-only audit.

CREATE TABLE IF NOT EXISTS connected_system_intents (
  intent_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update')),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'approved', 'rejected', 'succeeded', 'partial', 'failed')
  ),
  target TEXT NOT NULL,
  object_type TEXT NOT NULL,
  record_id TEXT,
  approval_id TEXT,
  request_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  readback_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  field_names_json JSONB NOT NULL DEFAULT '{"fields":[]}'::jsonb,
  result_class TEXT,
  result_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  readback_result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connected_system_intents_user_system_status
  ON connected_system_intents (user_id, system_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_connected_system_intents_record
  ON connected_system_intents (system_id, object_type, record_id)
  WHERE record_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS connected_system_record_bindings (
  binding_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  target TEXT NOT NULL,
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'deleted', 'disconnected')),
  created_intent_id TEXT,
  last_intent_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_connected_system_record_bindings_active_unique
  ON connected_system_record_bindings (user_id, system_id, object_type)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_connected_system_record_bindings_user_status
  ON connected_system_record_bindings (user_id, system_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_connected_system_record_bindings_record
  ON connected_system_record_bindings (system_id, object_type, record_id);

CREATE TABLE IF NOT EXISTS connected_system_audit_events (
  event_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  target TEXT NOT NULL,
  object_type TEXT NOT NULL,
  action TEXT NOT NULL,
  record_id TEXT,
  intent_id TEXT,
  approval_id TEXT,
  field_names_json JSONB NOT NULL DEFAULT '{"fields":[]}'::jsonb,
  mcp_result_class TEXT,
  readback_result_class TEXT,
  status TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connected_system_audit_user_created
  ON connected_system_audit_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_connected_system_audit_system_record
  ON connected_system_audit_events (system_id, object_type, record_id, created_at DESC)
  WHERE record_id IS NOT NULL;
