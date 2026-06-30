ALTER TABLE IF EXISTS consent_audit
    ALTER COLUMN metadata SET DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION consent_audit_notify()
RETURNS TRIGGER AS $$
DECLARE
  payload TEXT;
BEGIN
  payload := json_build_object(
    'user_id', NEW.user_id,
    'request_id', COALESCE(NEW.request_id, ''),
    'action', NEW.action,
    'scope', COALESCE(NEW.scope, ''),
    'agent_id', COALESCE(NEW.agent_id, ''),
    'scope_description', COALESCE(NEW.scope_description, ''),
    'issued_at', NEW.issued_at,
    'bundle_id', COALESCE(NEW.metadata->>'bundle_id', ''),
    'bundle_label', COALESCE(NEW.metadata->>'bundle_label', ''),
    'bundle_scope_count', COALESCE(NEW.metadata->>'bundle_scope_count', '1')
  )::TEXT;
  PERFORM pg_notify('consent_audit_new', payload);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS ria_pick_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ria_profile_id UUID NOT NULL REFERENCES ria_profiles(id) ON DELETE CASCADE,
  uploaded_by_user_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT 'Active picks',
  status TEXT NOT NULL DEFAULT 'active',
  source_filename TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  template_version INTEGER NOT NULL DEFAULT 1,
  activated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ria_pick_uploads_status_check
    CHECK (status IN ('active', 'archived', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ria_pick_uploads_active
  ON ria_pick_uploads(ria_profile_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_ria_pick_uploads_profile_created
  ON ria_pick_uploads(ria_profile_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ria_pick_upload_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id UUID NOT NULL REFERENCES ria_pick_uploads(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  ticker TEXT NOT NULL,
  company_name TEXT,
  sector TEXT,
  tier TEXT,
  tier_rank INTEGER,
  conviction_weight NUMERIC,
  recommendation_bias TEXT,
  investment_thesis TEXT,
  fcf_billions NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ria_pick_upload_rows_upload
  ON ria_pick_upload_rows(upload_id, sort_order ASC);

CREATE INDEX IF NOT EXISTS idx_ria_pick_upload_rows_ticker
  ON ria_pick_upload_rows(upload_id, ticker);
