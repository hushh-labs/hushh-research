BEGIN;

-- Operational scheduling only. Provider event content remains authoritative at Google.
CREATE TABLE IF NOT EXISTS calendar_reminder_preferences (
  user_id TEXT PRIMARY KEY REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  show_title BOOLEAN NOT NULL DEFAULT FALSE,
  time_zone TEXT NOT NULL DEFAULT 'UTC',
  generation BIGINT NOT NULL DEFAULT 1,
  next_reconcile_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reconcile_lease_id UUID,
  reconcile_lease_until TIMESTAMPTZ,
  scan_ciphertext TEXT,
  scan_iv TEXT,
  scan_tag TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS calendar_reminder_reconcile_due
  ON calendar_reminder_preferences(next_reconcile_at) WHERE enabled;

CREATE TABLE IF NOT EXISTS calendar_reminder_instances (
  reminder_id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES calendar_reminder_preferences(user_id) ON DELETE CASCADE,
  occurrence_key TEXT NOT NULL,
  preference_generation BIGINT NOT NULL,
  locator_ciphertext TEXT NOT NULL,
  locator_iv TEXT NOT NULL,
  locator_tag TEXT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','dispatching','sending','accepted','suppressed','expired','unavailable')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_id UUID,
  lease_until TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  error_code TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, occurrence_key),
  CHECK (end_at > start_at AND due_at <= start_at)
);
CREATE INDEX IF NOT EXISTS calendar_reminder_dispatch_due
  ON calendar_reminder_instances(next_attempt_at) WHERE state IN ('queued','dispatching','sending');

CREATE TABLE IF NOT EXISTS calendar_reminder_deliveries (
  reminder_id UUID NOT NULL REFERENCES calendar_reminder_instances(reminder_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  target_id TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(reminder_id,revision,target_id)
);

COMMENT ON TABLE calendar_reminder_preferences IS 'Owner-opted Calendar reminder control metadata; fixed ten-minute offset.';
COMMENT ON TABLE calendar_reminder_instances IS 'Short-lived encrypted provider locators and scheduling state; never titles, attendee information or join URLs.';
COMMENT ON TABLE calendar_reminder_deliveries IS 'Per-target FCM acceptance only, not device delivery/read evidence. Target is a high-entropy token fingerprint, never a raw token.';
ALTER TABLE calendar_reminder_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_reminder_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_reminder_deliveries ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON calendar_reminder_preferences,calendar_reminder_instances,calendar_reminder_deliveries FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON calendar_reminder_preferences,calendar_reminder_instances,calendar_reminder_deliveries FROM authenticated;
  END IF;
END $$;
COMMIT;
