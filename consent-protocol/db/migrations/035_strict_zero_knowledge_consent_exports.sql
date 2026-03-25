BEGIN;

ALTER TABLE consent_exports
  ALTER COLUMN export_key DROP NOT NULL;

ALTER TABLE consent_exports
  ADD COLUMN IF NOT EXISTS wrapped_key_bundle JSONB,
  ADD COLUMN IF NOT EXISTS connector_key_id TEXT,
  ADD COLUMN IF NOT EXISTS connector_wrapping_alg TEXT,
  ADD COLUMN IF NOT EXISTS export_revision INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS export_generated_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS source_content_revision INTEGER,
  ADD COLUMN IF NOT EXISTS source_manifest_revision INTEGER,
  ADD COLUMN IF NOT EXISTS refresh_status TEXT NOT NULL DEFAULT 'current';

UPDATE consent_exports
SET wrapped_key_bundle = export_key::jsonb
WHERE wrapped_key_bundle IS NULL
  AND export_key IS NOT NULL
  AND LEFT(TRIM(export_key), 1) = '{';

UPDATE consent_exports
SET connector_key_id = COALESCE(connector_key_id, wrapped_key_bundle->>'connector_key_id'),
    connector_wrapping_alg = COALESCE(
      NULLIF(TRIM(connector_wrapping_alg), ''),
      NULLIF(TRIM(wrapped_key_bundle->>'wrapping_alg'), ''),
      'X25519-AES256-GCM'
    )
WHERE wrapped_key_bundle IS NOT NULL;

UPDATE consent_exports
SET export_key = NULL
WHERE wrapped_key_bundle IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'consent_exports_refresh_status_check'
  ) THEN
    ALTER TABLE consent_exports DROP CONSTRAINT consent_exports_refresh_status_check;
  END IF;
END $$;

ALTER TABLE consent_exports
  ADD CONSTRAINT consent_exports_refresh_status_check
  CHECK (refresh_status IN ('current', 'refresh_pending', 'stale'));

CREATE INDEX IF NOT EXISTS idx_consent_exports_refresh_status
  ON consent_exports(refresh_status, expires_at DESC);

CREATE TABLE IF NOT EXISTS consent_export_refresh_jobs (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
  consent_token TEXT NOT NULL REFERENCES consent_exports(consent_token) ON DELETE CASCADE,
  granted_scope TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  trigger_domain TEXT,
  trigger_paths JSONB NOT NULL DEFAULT '[]'::JSONB,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT consent_export_refresh_jobs_token_unique UNIQUE (consent_token)
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'consent_export_refresh_jobs_status_check'
  ) THEN
    ALTER TABLE consent_export_refresh_jobs DROP CONSTRAINT consent_export_refresh_jobs_status_check;
  END IF;
END $$;

ALTER TABLE consent_export_refresh_jobs
  ADD CONSTRAINT consent_export_refresh_jobs_status_check
  CHECK (status IN ('pending', 'processing', 'completed', 'failed'));

CREATE INDEX IF NOT EXISTS idx_consent_export_refresh_jobs_user
  ON consent_export_refresh_jobs(user_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_consent_export_refresh_jobs_status
  ON consent_export_refresh_jobs(status, updated_at DESC);

DROP TRIGGER IF EXISTS trigger_update_consent_export_refresh_jobs_timestamp
  ON consent_export_refresh_jobs;
CREATE TRIGGER trigger_update_consent_export_refresh_jobs_timestamp
  BEFORE UPDATE ON consent_export_refresh_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
