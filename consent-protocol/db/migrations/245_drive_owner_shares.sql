-- The owner shares Drive files with a connection from chat, without a request
-- from them. One row per owner search and recipient. The search runs only on
-- the owner's tap, under the owner's own authority, and the files it found are
-- sealed here so a share binds exactly what the owner saw. Nothing in this
-- table is shown to the recipient; they get only the shared originals.
-- Replay-safe: every deploy re-runs this file, and every statement is
-- IF NOT EXISTS or idempotent.
BEGIN;

CREATE TABLE IF NOT EXISTS drive_owner_shares (
  request_id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  client_request_id UUID NOT NULL,
  query_digest TEXT NOT NULL,
  files_envelope JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','shared')),
  share_request_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() + INTERVAL '1 hour',
  CHECK (user_id <> recipient_user_id),
  CHECK ((status = 'shared') = (share_request_id IS NOT NULL)),
  UNIQUE (user_id, client_request_id, recipient_user_id)
);
CREATE INDEX IF NOT EXISTS drive_owner_shares_owner
  ON drive_owner_shares(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS drive_owner_shares_recipient
  ON drive_owner_shares(recipient_user_id);

ALTER TABLE drive_owner_shares ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON drive_owner_shares FROM PUBLIC;
DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON drive_owner_shares FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON drive_owner_shares TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;
COMMIT;
