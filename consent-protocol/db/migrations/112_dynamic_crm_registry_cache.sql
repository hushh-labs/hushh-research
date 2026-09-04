-- Generic CRM registry revision, normalized schema catalogue cache, and
-- operator audit trail. This is platform infrastructure: partner rows are
-- provisioned by the validated crm-registry.v1 CLI and never by migrations.

BEGIN;

ALTER TABLE enterprise_crm_registry
  ADD COLUMN IF NOT EXISTS configuration_revision BIGINT NOT NULL DEFAULT 1;

ALTER TABLE enterprise_crm_registry
  ADD COLUMN IF NOT EXISTS validated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS crm_schema_catalog_cache (
  crm_id                 TEXT NOT NULL
                         REFERENCES enterprise_crm_registry(crm_id) ON DELETE CASCADE,
  object_type            TEXT NOT NULL,
  configuration_revision BIGINT NOT NULL,
  schema_fingerprint     TEXT NOT NULL,
  schema_json            JSONB NOT NULL,
  refreshed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fresh_until            TIMESTAMPTZ NOT NULL,
  stale_until            TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (crm_id, object_type, configuration_revision, schema_fingerprint),
  CHECK (jsonb_typeof(schema_json) = 'object'),
  CHECK (fresh_until >= refreshed_at),
  CHECK (stale_until >= fresh_until)
);

CREATE INDEX IF NOT EXISTS idx_crm_schema_catalog_cache_lookup
  ON crm_schema_catalog_cache (crm_id, object_type, configuration_revision, refreshed_at DESC);

CREATE TABLE IF NOT EXISTS crm_registry_audit_events (
  event_id                 TEXT PRIMARY KEY,
  crm_id                   TEXT NOT NULL,
  action                   TEXT NOT NULL
                           CHECK (action IN ('check', 'probe', 'activate', 'update', 'deactivate')),
  operator_identity        TEXT NOT NULL,
  configuration_fingerprint TEXT NOT NULL,
  configuration_revision  BIGINT,
  capabilities_json        JSONB NOT NULL DEFAULT '[]'::jsonb,
  validation_result        TEXT NOT NULL
                           CHECK (validation_result IN ('passed', 'failed', 'deactivated')),
  validation_summary_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(capabilities_json) = 'array'),
  CHECK (jsonb_typeof(validation_summary_json) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_crm_registry_audit_events_crm_created
  ON crm_registry_audit_events (crm_id, created_at DESC);

COMMIT;
