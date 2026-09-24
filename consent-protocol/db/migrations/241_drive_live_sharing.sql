-- Explicit live Drive access, separate background preparation, and private source/rule records.
BEGIN;

UPDATE external_mcp_connectors
SET oauth_scopes = 'openid email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive',
    capability_policy = '{"version":2,"profiles":{"selected":{"version":1,"access":"selected_files","mutations":false,"requireGenAiEligibility":true,"maxSelection":25},"live":{"version":1,"access":"live_drive","readTransport":"google_drive_mcp","share":"exact_file_viewer","backgroundPreparation":"separate_owner_consent"}}}'::jsonb,
    description = 'Choose selected-file or live Drive access. Connecting does not share files.',
    updated_at = clock_timestamp()
WHERE connector_id = 'google_drive'
  AND oauth_scopes = 'openid email https://www.googleapis.com/auth/drive.file'
  AND capability_policy = '{"version":1,"access":"selected_files","mutations":false,"requireGenAiEligibility":true,"maxSelection":25}'::jsonb;

CREATE TABLE IF NOT EXISTS drive_live_preferences (
  user_id TEXT PRIMARY KEY,
  connection_generation BIGINT NOT NULL CHECK (connection_generation > 0),
  background_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  disclosure_version TEXT NOT NULL DEFAULT 'live-drive-background-v1'
    CHECK (disclosure_version = 'live-drive-background-v1'),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS drive_share_live_sources (
  request_id UUID NOT NULL,
  document_id UUID NOT NULL,
  user_id TEXT NOT NULL,
  connection_generation BIGINT NOT NULL CHECK (connection_generation > 0),
  source_version TEXT NOT NULL CHECK (source_version ~ '^[0-9]{1,30}$'),
  source_envelope JSONB NOT NULL CHECK (jsonb_typeof(source_envelope) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (request_id, document_id),
  FOREIGN KEY (request_id, user_id) REFERENCES drive_share_requests(request_id, user_id)
);
CREATE INDEX IF NOT EXISTS drive_share_live_sources_owner
  ON drive_share_live_sources(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS drive_document_rules (
  rule_id UUID PRIMARY KEY,
  origin_request_id UUID NOT NULL,
  user_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL CHECK (recipient_user_id <> user_id),
  recipient_binding TEXT NOT NULL CHECK (recipient_binding ~ '^[0-9a-f]{64}$'),
  connection_generation BIGINT NOT NULL CHECK (connection_generation > 0),
  boundary_envelope JSONB NOT NULL CHECK (jsonb_typeof(boundary_envelope) = 'object'),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  revoked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((active AND revoked_at IS NULL) OR (NOT active AND revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS drive_document_rules_origin
  ON drive_document_rules(user_id, origin_request_id);
CREATE INDEX IF NOT EXISTS drive_document_rules_owner
  ON drive_document_rules(user_id, active, activated_at DESC);

ALTER TABLE drive_live_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_share_live_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_document_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON drive_live_preferences, drive_share_live_sources, drive_document_rules FROM PUBLIC;
DO $$
DECLARE table_name TEXT; role_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['drive_live_preferences','drive_share_live_sources','drive_document_rules'] LOOP
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', table_name, role_name);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO service_role', table_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;
COMMIT;
