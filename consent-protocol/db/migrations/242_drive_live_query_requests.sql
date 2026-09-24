-- A connection's Drive question that runs live only after the owner allows it.
-- Deliberately separate from drive_share_requests: no preparation worker scans
-- this table, so a pending question can never cause a Drive read.
BEGIN;

CREATE TABLE IF NOT EXISTS drive_live_query_requests (
  request_id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  requester_user_id TEXT NOT NULL CHECK (requester_user_id <> user_id),
  client_request_id UUID NOT NULL,
  query_envelope JSONB NOT NULL CHECK (jsonb_typeof(query_envelope) = 'object'),
  query_digest TEXT NOT NULL CHECK (query_digest ~ '^[0-9a-f]{64}$'),
  answer_envelope JSONB CHECK (answer_envelope IS NULL OR jsonb_typeof(answer_envelope) = 'object'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','answered','denied')),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_error_code TEXT
    CHECK (last_error_code IS NULL OR last_error_code IN ('reconnect_required','drive_query_unavailable')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  decided_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + interval '7 days'),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '31 days'),
  CHECK ((status = 'answered') = (answer_envelope IS NOT NULL)),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  UNIQUE (requester_user_id, client_request_id)
);
CREATE INDEX IF NOT EXISTS drive_live_query_requests_owner
  ON drive_live_query_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS drive_live_query_requests_requester
  ON drive_live_query_requests(requester_user_id, created_at DESC);

ALTER TABLE drive_live_query_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON drive_live_query_requests FROM PUBLIC;
DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON drive_live_query_requests FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON drive_live_query_requests TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;
COMMIT;
