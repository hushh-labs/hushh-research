-- Expand only. No Drive registry activation or existing credential migration.
-- Rollback: disable connector flags / revert code; retain encrypted rows.
BEGIN;

CREATE TABLE IF NOT EXISTS drive_picker_sessions (
  session_id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  connector_id TEXT NOT NULL DEFAULT 'google_drive' CHECK (connector_id = 'google_drive'),
  connection_generation BIGINT NOT NULL CHECK (connection_generation > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes'),
  consumed_at TIMESTAMPTZ,
  FOREIGN KEY (user_id, connector_id)
    REFERENCES user_external_connector_connections(user_id, connector_id) ON DELETE CASCADE,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);
CREATE INDEX IF NOT EXISTS drive_picker_sessions_owner_idx ON drive_picker_sessions(user_id);
CREATE INDEX IF NOT EXISTS drive_picker_sessions_expiry_idx ON drive_picker_sessions(expires_at);

CREATE TABLE IF NOT EXISTS connected_documents (
  document_id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  connector_id TEXT NOT NULL DEFAULT 'google_drive' CHECK (connector_id = 'google_drive'),
  connection_generation BIGINT NOT NULL CHECK (connection_generation > 0),
  source_fingerprint TEXT NOT NULL CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  metadata_envelope JSONB NOT NULL CHECK (jsonb_typeof(metadata_envelope) = 'object'),
  source_version TEXT NOT NULL CHECK (source_version ~ '^[0-9]{1,30}$'),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'fetching', 'parsing', 'indexing', 'ready', 'stale',
    'needs_reauth', 'unsupported', 'failed_retryable'
  )),
  active_version TEXT,
  lease_id UUID,
  lease_expires_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error_code TEXT CHECK (last_error_code ~ '^[a-z_]{1,80}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_indexed_at TIMESTAMPTZ,
  UNIQUE (user_id, connector_id, source_fingerprint),
  UNIQUE (document_id, user_id),
  FOREIGN KEY (user_id, connector_id)
    REFERENCES user_external_connector_connections(user_id, connector_id) ON DELETE CASCADE,
  CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL))
);
CREATE INDEX IF NOT EXISTS connected_documents_owner_idx ON connected_documents(user_id, created_at);
CREATE INDEX IF NOT EXISTS connected_documents_jobs_idx
  ON connected_documents(next_attempt_at) WHERE status IN ('queued', 'failed_retryable', 'stale');

-- Server-readable connector processing domain, NOT client-key PKM storage.
-- No plaintext provider ID, file name, content or Google token in these tables.
COMMENT ON TABLE connected_documents IS
  'Explicit owner-selected Drive sources. Metadata AES-256-GCM sealed under the separate DRIVE_DOCUMENT_KEY_V1 with owner/document/generation AAD. No PKM or OAuth credential copies.';
COMMENT ON TABLE drive_picker_sessions IS
  'Ten-minute owner/generation-bound single-use selection sessions, with no Google tokens or source identifiers.';

-- Invalidate selected sources in the same transaction as disconnect/account
-- switch. A refresh changes credential_version only, so preserves selection.
-- Future versioned chunks/grants must FK-cascade from this catalog.
CREATE OR REPLACE FUNCTION invalidate_selected_drive_documents()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.connector_id = 'google_drive' AND (
    NEW.connection_generation <> OLD.connection_generation OR NEW.status = 'revoked'
  ) THEN
    DELETE FROM connected_documents WHERE user_id = NEW.user_id AND connector_id = NEW.connector_id;
    DELETE FROM drive_picker_sessions WHERE user_id = NEW.user_id AND connector_id = NEW.connector_id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS selected_drive_connection_invalidation ON user_external_connector_connections;
CREATE TRIGGER selected_drive_connection_invalidation
  AFTER UPDATE OF connection_generation, status ON user_external_connector_connections
  FOR EACH ROW EXECUTE FUNCTION invalidate_selected_drive_documents();

-- Match the backend-only RLS boundary used by migration 211. Cloud SQL runtime
-- currently owns the tables; service_role uses BYPASSRLS where available.
ALTER TABLE drive_picker_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE connected_documents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON drive_picker_sessions, connected_documents FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON drive_picker_sessions, connected_documents FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON drive_picker_sessions, connected_documents FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL ON drive_picker_sessions, connected_documents FROM service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON drive_picker_sessions, connected_documents TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;
COMMIT;
