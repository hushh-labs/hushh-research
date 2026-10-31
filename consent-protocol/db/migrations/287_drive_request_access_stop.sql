-- A confirmed owner stop fences future request grants and durably removes only
-- direct Google permissions for which One has a successful creation receipt.
BEGIN;

ALTER TABLE drive_share_requests
  ADD COLUMN IF NOT EXISTS access_stop_requested_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS drive_request_bulk_removals (
  removal_id UUID PRIMARY KEY,
  request_id UUID NOT NULL,
  user_id TEXT NOT NULL,
  share_id UUID NOT NULL,
  position INTEGER NOT NULL,
  recipient_user_id TEXT NOT NULL,
  plan_envelope JSONB NOT NULL CHECK (jsonb_typeof(plan_envelope) = 'object'),
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','dispatching','unknown','removed','absent','needs_review','unavailable')),
  lease_id UUID,
  lease_expires_at TIMESTAMPTZ,
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  next_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  safe_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (share_id,position,recipient_user_id),
  FOREIGN KEY (request_id,user_id)
    REFERENCES drive_share_management_contexts(request_id,user_id),
  CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL))
);
CREATE INDEX IF NOT EXISTS drive_request_bulk_removals_due
  ON drive_request_bulk_removals(next_at,created_at)
  WHERE state IN ('queued','dispatching','unknown');
CREATE INDEX IF NOT EXISTS drive_request_bulk_removals_request
  ON drive_request_bulk_removals(request_id,state);

ALTER TABLE drive_request_bulk_removals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON drive_request_bulk_removals FROM PUBLIC;
DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON drive_request_bulk_removals FROM %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON drive_request_bulk_removals TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;
COMMIT;
