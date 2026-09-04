-- Public-schema mapping cache for the manifest-owned Connected Systems child.
-- It stores schema metadata decisions only: never CRM records, verified profile
-- values, record IDs, credentials, consent material, prompts, or model output.

BEGIN;

CREATE TABLE IF NOT EXISTS crm_schema_mapping_cache (
  crm_id TEXT NOT NULL REFERENCES enterprise_crm_registry(crm_id) ON DELETE CASCADE,
  object_type TEXT NOT NULL,
  schema_fingerprint TEXT NOT NULL,
  model_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'invalidated', 'failed')),
  mapping_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  failure_code TEXT,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (crm_id, object_type, schema_fingerprint, model_name),
  CONSTRAINT crm_schema_mapping_cache_mapping_object
    CHECK (jsonb_typeof(mapping_json) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_crm_schema_mapping_cache_lookup
  ON crm_schema_mapping_cache (crm_id, object_type, model_name, status, expires_at DESC);

COMMIT;
