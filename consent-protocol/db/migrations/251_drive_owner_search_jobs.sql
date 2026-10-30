-- Owner-confirmed metadata search only. No file content, indexing or sharing authority.
BEGIN;
CREATE TABLE IF NOT EXISTS drive_owner_search_jobs (
  job_id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_request_id UUID NOT NULL,
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  connection_generation BIGINT NOT NULL CHECK (connection_generation > 0),
  consent_version TEXT NOT NULL CHECK (consent_version = 'drive-owner-search-v1'),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','stopped','failed','limited')),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  matched INTEGER NOT NULL DEFAULT 0 CHECK (matched BETWEEN 0 AND 10000),
  pages_scanned INTEGER NOT NULL DEFAULT 0 CHECK (pages_scanned >= 0),
  incomplete_search BOOLEAN NOT NULL DEFAULT FALSE,
  checkpoint_envelope JSONB NOT NULL CHECK (jsonb_typeof(checkpoint_envelope) = 'object'),
  lease_id UUID,
  lease_expires_at TIMESTAMPTZ,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 3),
  next_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  inspected_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  error_code TEXT CHECK (error_code IN ('provider_unavailable','connection_changed','connector_unavailable','provider_response_invalid','search_limit','search_expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() + INTERVAL '24 hours',
  UNIQUE (user_id,client_request_id),
  UNIQUE (job_id,user_id),
  CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS drive_owner_search_one_active
  ON drive_owner_search_jobs(user_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS drive_owner_search_due
  ON drive_owner_search_jobs(next_at,inspected_at) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS drive_owner_search_recent ON drive_owner_search_jobs(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS drive_owner_search_expiry ON drive_owner_search_jobs(expires_at);
CREATE TABLE IF NOT EXISTS drive_owner_search_results (
  job_id UUID NOT NULL,
  user_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 10000),
  file_digest TEXT NOT NULL CHECK (file_digest ~ '^[0-9a-f]{64}$'),
  metadata_envelope JSONB NOT NULL CHECK (jsonb_typeof(metadata_envelope) = 'object'),
  PRIMARY KEY (job_id,position),
  UNIQUE (job_id,file_digest),
  FOREIGN KEY (job_id,user_id) REFERENCES drive_owner_search_jobs(job_id,user_id) ON DELETE CASCADE
);
ALTER TABLE drive_owner_search_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_owner_search_results ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON drive_owner_search_jobs,drive_owner_search_results FROM PUBLIC;
DO $$ DECLARE table_name TEXT; role_name TEXT; BEGIN
  FOREACH table_name IN ARRAY ARRAY['drive_owner_search_jobs','drive_owner_search_results'] LOOP
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
