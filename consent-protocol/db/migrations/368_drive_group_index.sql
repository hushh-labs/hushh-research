-- Sealed four-group Drive index: an organizing aid that grants no sharing, consent or search authority.
-- Explicit owner opt-in; a changed Drive connection removes both tables' rows for that owner.
BEGIN;
CREATE TABLE IF NOT EXISTS drive_group_index_state (
  user_id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL DEFAULT 'google_drive' CHECK (connector_id='google_drive'),
  connection_generation BIGINT NOT NULL CHECK (connection_generation>0),
  processing_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  disclosure_version TEXT CHECK (disclosure_version='drive-four-group-v1'),
  time_zone TEXT NOT NULL DEFAULT 'UTC' CHECK (char_length(time_zone) BETWEEN 1 AND 64),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision>0),
  lease_id UUID,
  lease_expires_at TIMESTAMPTZ,
  next_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count>=0),
  last_error_code TEXT CHECK (last_error_code ~ '^[a-z_]{1,80}$'),
  listed_files INTEGER NOT NULL DEFAULT 0 CHECK (listed_files>=0),
  listing_complete BOOLEAN NOT NULL DEFAULT FALSE,
  limited BOOLEAN NOT NULL DEFAULT FALSE,
  model_version TEXT CHECK (model_version ~ '^[0-9a-f]{12}$'),
  last_run_at TIMESTAMPTZ,
  initial_completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (user_id,connector_id)
    REFERENCES user_external_connector_connections(user_id,connector_id) ON DELETE CASCADE,
  CHECK ((lease_id IS NULL)=(lease_expires_at IS NULL)),
  -- COALESCE, because a CHECK that evaluates to NULL passes: no disclosure must fail it.
  CHECK (NOT processing_enabled OR COALESCE(disclosure_version,'')='drive-four-group-v1')
);
CREATE INDEX IF NOT EXISTS drive_group_index_state_due ON drive_group_index_state(next_at)
  WHERE processing_enabled;

CREATE TABLE IF NOT EXISTS drive_group_index (
  user_id TEXT NOT NULL,
  connector_id TEXT NOT NULL DEFAULT 'google_drive' CHECK (connector_id='google_drive'),
  connection_generation BIGINT NOT NULL CHECK (connection_generation>0),
  source_ref TEXT NOT NULL CHECK (source_ref ~ '^[0-9a-f]{64}$'),
  shelf TEXT NOT NULL CHECK (shelf IN (
    'financial_statements','non_financial_statements','insurance_statements',
    'personal_documents','kept'
  )),
  candidate TEXT CHECK (candidate IS NULL OR candidate IN (
    'financial_statements','non_financial_statements','insurance_statements','personal_documents'
  )),
  confidence REAL NOT NULL CHECK (confidence>=0 AND confidence<=1),
  reason TEXT NOT NULL CHECK (reason IN (
    'placed','fits_none','low_confidence','low_margin','disagreement','no_evidence'
  )),
  group_source TEXT NOT NULL CHECK (group_source IN ('organizer_v1','owner')),
  model_version TEXT NOT NULL CHECK (model_version ~ '^[0-9a-f]{12}$'),
  title_day DATE,
  created_time TIMESTAMPTZ,
  modified_time TIMESTAMPTZ,
  source_modified TIMESTAMPTZ NOT NULL,
  entry_envelope JSONB NOT NULL CHECK (jsonb_typeof(entry_envelope)='object'),
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id,source_ref),
  FOREIGN KEY (user_id,connector_id)
    REFERENCES user_external_connector_connections(user_id,connector_id) ON DELETE CASCADE,
  -- The aid keeps a file exactly when it did not place it; an owner's move is not bound by that.
  CHECK (group_source='owner' OR ((shelf='kept')=(reason<>'placed')))
);
CREATE INDEX IF NOT EXISTS drive_group_index_owner_shelf ON drive_group_index(user_id,shelf);
COMMENT ON TABLE drive_group_index_state IS
  'Owner opt-in, time zone, lease and counters for the four-group Drive organizing aid. No sharing, consent or search authority.';
COMMENT ON TABLE drive_group_index IS
  'One row per Drive file the organizing aid has placed. Shelf, confidence, dates and counts are server-readable organizing metadata; the file ID, name, link and any kept text start or embedding are AES-256-GCM sealed under DRIVE_DOCUMENT_KEY_V1 with owner, reference and generation as associated data. Grants no access to the file.';

CREATE OR REPLACE FUNCTION invalidate_drive_group_index()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.connector_id='google_drive' AND (
    NEW.connection_generation<>OLD.connection_generation OR NEW.status='revoked'
  ) THEN
    DELETE FROM drive_group_index WHERE user_id=NEW.user_id;
    DELETE FROM drive_group_index_state WHERE user_id=NEW.user_id;
  END IF;
  RETURN NEW;
END $$;
-- Replay re-runs this file on every deploy. DROP TRIGGER takes a lock on the hot
-- connections table before it finds nothing to do, so create the trigger only once.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname='drive_group_index_connection_invalidation'
      AND tgrelid='user_external_connector_connections'::regclass
  ) THEN
    CREATE TRIGGER drive_group_index_connection_invalidation
     AFTER UPDATE OF connection_generation,status ON user_external_connector_connections
     FOR EACH ROW EXECUTE FUNCTION invalidate_drive_group_index();
  END IF;
END $$;

ALTER TABLE drive_group_index_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_group_index ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON drive_group_index_state FROM PUBLIC;
REVOKE ALL ON drive_group_index FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON drive_group_index_state FROM anon;
    REVOKE ALL ON drive_group_index FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON drive_group_index_state FROM authenticated;
    REVOKE ALL ON drive_group_index FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON drive_group_index_state TO service_role;
    GRANT SELECT,INSERT,UPDATE,DELETE ON drive_group_index TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;
COMMIT;
