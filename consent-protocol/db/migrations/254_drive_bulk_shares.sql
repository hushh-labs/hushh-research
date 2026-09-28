-- One owner-approved, frozen Drive search result set shared to a fixed
-- Trusted-circle recipient set. Only opaque workflow state is plaintext.
-- File metadata and recipient identity remain sealed with DRIVE_SHARING_KEY_V1.
BEGIN;

CREATE TABLE IF NOT EXISTS drive_bulk_shares (
  share_id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  search_job_id UUID NOT NULL,
  client_request_id UUID NOT NULL,
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  connection_generation BIGINT NOT NULL CHECK (connection_generation > 0),
  search_revision BIGINT NOT NULL CHECK (search_revision > 0),
  review_digest TEXT NOT NULL CHECK (review_digest ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'review_ready'
    CHECK (status IN ('review_ready','queued','running','completed','partial','stopped','failed')),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  file_count INTEGER NOT NULL CHECK (file_count BETWEEN 1 AND 10000),
  recipient_count INTEGER NOT NULL CHECK (recipient_count BETWEEN 0 AND 10),
  excluded_envelope JSONB NOT NULL CHECK (jsonb_typeof(excluded_envelope) = 'object'),
  approved_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() + INTERVAL '24 hours',
  UNIQUE (user_id,client_request_id),
  UNIQUE (user_id,search_job_id),
  UNIQUE (share_id,user_id)
);
CREATE INDEX IF NOT EXISTS drive_bulk_shares_recent
  ON drive_bulk_shares(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS drive_bulk_shares_search
  ON drive_bulk_shares(user_id,search_job_id,created_at DESC);
CREATE INDEX IF NOT EXISTS drive_bulk_shares_expiry
  ON drive_bulk_shares(expires_at);

CREATE TABLE IF NOT EXISTS drive_bulk_share_files (
  share_id UUID NOT NULL,
  user_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 10000),
  source_job_id UUID NOT NULL,
  source_position INTEGER NOT NULL CHECK (source_position BETWEEN 1 AND 10000),
  file_digest TEXT NOT NULL CHECK (file_digest ~ '^[0-9a-f]{64}$'),
  metadata_envelope JSONB NOT NULL CHECK (jsonb_typeof(metadata_envelope) = 'object'),
  PRIMARY KEY (share_id,position),
  UNIQUE (share_id,file_digest),
  FOREIGN KEY (share_id,user_id) REFERENCES drive_bulk_shares(share_id,user_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS drive_bulk_share_recipients (
  share_id UUID NOT NULL,
  user_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  identity_envelope JSONB NOT NULL CHECK (jsonb_typeof(identity_envelope) = 'object'),
  PRIMARY KEY (share_id,recipient_user_id),
  FOREIGN KEY (share_id,user_id) REFERENCES drive_bulk_shares(share_id,user_id)
    ON DELETE CASCADE,
  CHECK (user_id <> recipient_user_id)
);

CREATE TABLE IF NOT EXISTS drive_bulk_share_effects (
  share_id UUID NOT NULL,
  user_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  recipient_user_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','dispatching','unknown','succeeded','preexisting',
      'skipped','failed','present_unattributed','absent')),
  lease_id UUID,
  lease_expires_at TIMESTAMPTZ,
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  next_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  inspected_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  safe_error_code TEXT,
  receipt_envelope JSONB CHECK (receipt_envelope IS NULL OR jsonb_typeof(receipt_envelope) = 'object'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (share_id,position,recipient_user_id),
  FOREIGN KEY (share_id,user_id) REFERENCES drive_bulk_shares(share_id,user_id)
    ON DELETE CASCADE,
  FOREIGN KEY (share_id,position) REFERENCES drive_bulk_share_files(share_id,position)
    ON DELETE CASCADE,
  FOREIGN KEY (share_id,recipient_user_id)
    REFERENCES drive_bulk_share_recipients(share_id,recipient_user_id)
    ON DELETE CASCADE,
  CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL))
);
CREATE INDEX IF NOT EXISTS drive_bulk_share_effects_due
  ON drive_bulk_share_effects(next_at,inspected_at)
  WHERE state IN ('queued','dispatching','unknown');
CREATE INDEX IF NOT EXISTS drive_bulk_share_effects_job
  ON drive_bulk_share_effects(share_id,state);
CREATE INDEX IF NOT EXISTS drive_bulk_share_effects_recipient
  ON drive_bulk_share_effects(share_id,recipient_user_id,state);

CREATE TABLE IF NOT EXISTS drive_bulk_share_notifications (
  share_id UUID NOT NULL,
  user_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','dispatching','settled','unavailable')),
  lease_id UUID,
  lease_expires_at TIMESTAMPTZ,
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  next_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (share_id,recipient_user_id),
  FOREIGN KEY (share_id,recipient_user_id)
    REFERENCES drive_bulk_share_recipients(share_id,recipient_user_id)
    ON DELETE CASCADE,
  FOREIGN KEY (share_id,user_id) REFERENCES drive_bulk_shares(share_id,user_id)
    ON DELETE CASCADE,
  CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL))
);
CREATE INDEX IF NOT EXISTS drive_bulk_share_notifications_due
  ON drive_bulk_share_notifications(next_at)
  WHERE state IN ('queued','dispatching');

DO $$
DECLARE table_name TEXT; role_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'drive_bulk_shares','drive_bulk_share_files','drive_bulk_share_recipients',
    'drive_bulk_share_effects','drive_bulk_share_notifications'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', table_name);
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I',table_name,role_name);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO service_role',table_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;
COMMIT;
