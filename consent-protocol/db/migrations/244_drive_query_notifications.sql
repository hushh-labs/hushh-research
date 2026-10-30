-- Notifications for Drive questions (drive_live_query_requests), in the same
-- opaque outbox shape and lease columns as drive_share_events (232 + 235).
-- A separate table because drive_share_events.request_id references
-- drive_share_requests. Rows hold opaque ids, a closed type and dispatch
-- state only: no question, answer, file or person detail. The notification
-- worker reads this table; nothing here reads Drive.
-- Replay-safe: every deploy re-runs this file, and every statement is
-- IF NOT EXISTS or idempotent.
BEGIN;

CREATE TABLE IF NOT EXISTS drive_query_events (
  event_id UUID PRIMARY KEY,
  -- An event means nothing without its question: deleting one removes both.
  request_id UUID NOT NULL REFERENCES drive_live_query_requests(request_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision>=0),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'document_share_question','document_share_answered','document_share_declined'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  delivered_at TIMESTAMPTZ,
  notification_state TEXT NOT NULL DEFAULT 'queued'
    CHECK (notification_state IN ('queued','dispatching','settled','suppressed')),
  notification_lease_id UUID,
  notification_lease_expires_at TIMESTAMPTZ,
  notification_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (notification_attempt_count BETWEEN 0 AND 3),
  notification_next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  notification_inspected_at TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
  notification_error_code TEXT
    CHECK (notification_error_code IS NULL OR notification_error_code ~ '^[a-z_]{1,80}$'),
  notification_settled_at TIMESTAMPTZ,
  CHECK ((notification_lease_id IS NULL)=(notification_lease_expires_at IS NULL)),
  CHECK ((notification_state='settled')=(notification_settled_at IS NOT NULL)),
  UNIQUE (request_id,user_id,revision,event_type)
);
CREATE INDEX IF NOT EXISTS drive_query_event_notification_due
  ON drive_query_events(notification_next_attempt_at,notification_inspected_at,created_at,event_id)
  WHERE notification_state IN ('queued','dispatching');

ALTER TABLE drive_query_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON drive_query_events FROM PUBLIC;
DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON drive_query_events FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON drive_query_events TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;
COMMIT;
