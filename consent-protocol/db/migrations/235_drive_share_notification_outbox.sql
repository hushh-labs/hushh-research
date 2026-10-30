-- Durable, metadata-only dispatch tracking for the existing Drive-share outbox.
-- ``delivered_at`` / ``notification_settled_at`` record a worker dispatch
-- attempt settling; neither records device display, user receipt, or approval.
BEGIN;

ALTER TABLE drive_share_events
  ADD COLUMN IF NOT EXISTS notification_state TEXT NOT NULL DEFAULT 'queued',
  ADD COLUMN IF NOT EXISTS notification_lease_id UUID,
  ADD COLUMN IF NOT EXISTS notification_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notification_attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notification_next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN IF NOT EXISTS notification_inspected_at TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
  ADD COLUMN IF NOT EXISTS notification_error_code TEXT,
  ADD COLUMN IF NOT EXISTS notification_settled_at TIMESTAMPTZ;

-- Preserve any pre-worker delivery marker as a terminal dispatch record before
-- adding the invariant below. The old marker never represented user receipt.
UPDATE drive_share_events
SET notification_state='settled', notification_lease_id=NULL,
    notification_lease_expires_at=NULL,
    notification_next_attempt_at=delivered_at,
    notification_settled_at=delivered_at,
    notification_error_code=NULL
WHERE delivered_at IS NOT NULL AND notification_settled_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='drive_share_events'::regclass
      AND conname='drive_share_event_notification_state_check') THEN
    ALTER TABLE drive_share_events ADD CONSTRAINT drive_share_event_notification_state_check
      CHECK (notification_state IN ('queued','dispatching','settled','suppressed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='drive_share_events'::regclass
      AND conname='drive_share_event_notification_attempt_check') THEN
    ALTER TABLE drive_share_events ADD CONSTRAINT drive_share_event_notification_attempt_check
      CHECK (notification_attempt_count BETWEEN 0 AND 3);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='drive_share_events'::regclass
      AND conname='drive_share_event_notification_lease_pair') THEN
    ALTER TABLE drive_share_events ADD CONSTRAINT drive_share_event_notification_lease_pair
      CHECK ((notification_lease_id IS NULL)=(notification_lease_expires_at IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='drive_share_events'::regclass
      AND conname='drive_share_event_notification_settlement') THEN
    ALTER TABLE drive_share_events ADD CONSTRAINT drive_share_event_notification_settlement
      CHECK ((notification_state='settled')=(notification_settled_at IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='drive_share_events'::regclass
      AND conname='drive_share_event_notification_error_code') THEN
    ALTER TABLE drive_share_events ADD CONSTRAINT drive_share_event_notification_error_code
      CHECK (notification_error_code IS NULL OR notification_error_code ~ '^[a-z_]{1,80}$');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS drive_share_event_notification_due
  ON drive_share_events(notification_next_attempt_at,notification_inspected_at,created_at,event_id)
  WHERE notification_state IN ('queued','dispatching');

COMMENT ON COLUMN drive_share_events.delivered_at IS
  'Legacy compatible timestamp for a settled generic push-dispatch attempt, not device or user receipt.';
COMMENT ON COLUMN drive_share_events.notification_settled_at IS
  'When the bounded notification worker settled its dispatch attempt; never user receipt evidence.';
COMMENT ON COLUMN drive_share_events.notification_error_code IS
  'Safe worker-only code. It contains no provider response, identity, filename, purpose, content or credential.';

COMMIT;
