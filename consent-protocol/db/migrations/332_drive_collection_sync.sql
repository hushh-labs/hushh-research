-- Explicit permission for continuous live Drive processing; existing opt-ins do not expand.
BEGIN;
ALTER TABLE connected_documents
  ADD COLUMN IF NOT EXISTS source_profile TEXT NOT NULL DEFAULT 'selected'
    CHECK (source_profile IN ('selected','live')),
  ADD COLUMN IF NOT EXISTS collection_revision BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS collection_seen_epoch UUID,
  ADD COLUMN IF NOT EXISTS source_changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN IF NOT EXISTS last_index_duration_ms BIGINT;
CREATE INDEX IF NOT EXISTS connected_documents_collection_due
  ON connected_documents(user_id, next_attempt_at) WHERE source_profile='live';
CREATE TABLE IF NOT EXISTS drive_collection_sync (
  user_id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL DEFAULT 'google_drive' CHECK (connector_id='google_drive'),
  connection_generation BIGINT NOT NULL CHECK (connection_generation>0),
  processing_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  disclosure_version TEXT CHECK (disclosure_version='live-drive-collection-v1'),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision>0),
  phase TEXT NOT NULL DEFAULT 'start' CHECK (phase IN ('start','bootstrap','changes')),
  checkpoint_envelope JSONB,
  lease_id UUID,
  lease_expires_at TIMESTAMPTZ,
  next_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count>=0),
  last_error_code TEXT CHECK (last_error_code ~ '^[a-z_]{1,80}$'),
  incomplete_search BOOLEAN NOT NULL DEFAULT FALSE,
  initial_started_at TIMESTAMPTZ,
  initial_completed_at TIMESTAMPTZ,
  semantic_initial_completed_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  last_indexed_at TIMESTAMPTZ,
  sync_duration_ms BIGINT NOT NULL DEFAULT 0 CHECK (sync_duration_ms>=0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (user_id,connector_id)
    REFERENCES user_external_connector_connections(user_id,connector_id) ON DELETE CASCADE,
  CHECK ((lease_id IS NULL)=(lease_expires_at IS NULL)),
  CHECK (NOT processing_enabled OR disclosure_version='live-drive-collection-v1')
);
ALTER TABLE drive_collection_sync ADD COLUMN IF NOT EXISTS semantic_initial_completed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS drive_collection_sync_due ON drive_collection_sync(next_at)
  WHERE processing_enabled;
COMMENT ON TABLE drive_collection_sync IS
  'Owner/generation/revision-bound processing permission and encrypted Drive change checkpoint. No sharing or publication authority.';
CREATE OR REPLACE FUNCTION invalidate_drive_collection_sync()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.connector_id='google_drive' AND (
    NEW.connection_generation<>OLD.connection_generation OR NEW.status='revoked'
  ) THEN
    DELETE FROM drive_collection_sync WHERE user_id=NEW.user_id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS drive_collection_connection_invalidation ON user_external_connector_connections;
CREATE TRIGGER drive_collection_connection_invalidation
 AFTER UPDATE OF connection_generation,status ON user_external_connector_connections
 FOR EACH ROW EXECUTE FUNCTION invalidate_drive_collection_sync();
ALTER TABLE drive_collection_sync ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON drive_collection_sync FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON drive_collection_sync FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON drive_collection_sync FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON drive_collection_sync TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;
COMMIT;
