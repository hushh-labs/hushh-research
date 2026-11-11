BEGIN;

-- All rows are operational, owner-bound state. No full Gmail body or PKM
-- record is persisted. Human-readable fields and provider refs are sealed by
-- the application with a dedicated follow-up key and row-specific AAD.
CREATE TABLE IF NOT EXISTS calendar_email_followup_monitors (
  user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  notifications_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  historical_start_at TIMESTAMPTZ NOT NULL,
  time_zone TEXT NOT NULL,
  reminder_lead_days SMALLINT NOT NULL DEFAULT 1 CHECK (reminder_lead_days BETWEEN 0 AND 14),
  reminder_hour SMALLINT NOT NULL DEFAULT 9 CHECK (reminder_hour BETWEEN 0 AND 23),
  grant_epoch_digest TEXT NOT NULL CHECK (grant_epoch_digest ~ '^[a-f0-9]{64}$'),
  provider_subject_sha256 TEXT NOT NULL CHECK (provider_subject_sha256 ~ '^[a-f0-9]{64}$'),
  mail_generation UUID NOT NULL,
  calendar_connected_at TIMESTAMPTZ NOT NULL,
  calendar_grant_revision TEXT,
  generation UUID NOT NULL DEFAULT gen_random_uuid(),
  checkpoint_ciphertext TEXT,
  scan_state TEXT NOT NULL DEFAULT 'pending' CHECK (scan_state IN ('pending','partial','complete','disabled')),
  scan_error_code TEXT,
  last_complete_at TIMESTAMPTZ,
  next_scan_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_id UUID,
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(user_id, account_id)
);
CREATE INDEX IF NOT EXISTS calendar_email_followup_scan_due
  ON calendar_email_followup_monitors(next_scan_at)
  WHERE enabled = TRUE;

CREATE TABLE IF NOT EXISTS calendar_email_followup_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  thread_hmac TEXT NOT NULL CHECK (thread_hmac ~ '^[a-f0-9]{64}$'),
  thread_ref_ciphertext TEXT NOT NULL,
  subject_ciphertext TEXT NOT NULL,
  sender_ciphertext TEXT NOT NULL,
  latest_internal_date_ms BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, account_id, thread_hmac),
  UNIQUE(id, user_id, account_id),
  FOREIGN KEY(user_id, account_id) REFERENCES calendar_email_followup_monitors(user_id, account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS calendar_email_followup_conversations_recent
  ON calendar_email_followup_conversations(user_id, account_id, latest_internal_date_ms DESC);

CREATE TABLE IF NOT EXISTS calendar_email_followup_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  evidence_hmac TEXT NOT NULL CHECK (evidence_hmac ~ '^[a-f0-9]{64}$'),
  source_message_hmac TEXT NOT NULL CHECK (source_message_hmac ~ '^[a-f0-9]{64}$'),
  source_message_ref_ciphertext TEXT NOT NULL,
  source_body_digest TEXT NOT NULL CHECK (source_body_digest ~ '^[a-f0-9]{64}$'),
  source_internal_date_ms BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('action','deadline','meeting')),
  state TEXT NOT NULL CHECK (state IN ('needs_review','pending','done','snoozed','dismissed','cancelled','source_unavailable')),
  title_ciphertext TEXT NOT NULL,
  quote_ciphertext TEXT NOT NULL,
  due_wording_ciphertext TEXT,
  due_date DATE,
  due_relation TEXT CHECK (due_relation IN ('before','on','by')),
  proposed_date DATE,
  proposed_at TIMESTAMPTZ,
  time_zone TEXT,
  responsibility TEXT NOT NULL CHECK (responsibility IN ('owner','other','unclear')),
  ambiguities JSONB NOT NULL DEFAULT '[]'::jsonb,
  reminder_at TIMESTAMPTZ,
  reminder_is_manual BOOLEAN NOT NULL DEFAULT FALSE,
  reminder_sent_revision INTEGER,
  booking_event_ref_ciphertext TEXT,
  booking_confirmed_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_source_internal_date_ms BIGINT NOT NULL,
  last_checked_at TIMESTAMPTZ,
  reminder_lease_id UUID,
  reminder_lease_until TIMESTAMPTZ,
  reminder_retry_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, account_id, evidence_hmac),
  FOREIGN KEY(conversation_id, user_id, account_id)
    REFERENCES calendar_email_followup_conversations(id, user_id, account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS calendar_email_followup_reminders_due
  ON calendar_email_followup_requests(reminder_at)
  WHERE state IN ('pending','snoozed') AND reminder_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS calendar_email_followup_requests_group
  ON calendar_email_followup_requests(conversation_id, source_internal_date_ms);

CREATE TABLE IF NOT EXISTS calendar_email_followup_scanned_messages (
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  message_hmac TEXT NOT NULL CHECK (message_hmac ~ '^[a-f0-9]{64}$'),
  thread_hmac TEXT NOT NULL CHECK (thread_hmac ~ '^[a-f0-9]{64}$'),
  body_digest TEXT NOT NULL CHECK (body_digest ~ '^[a-f0-9]{64}$'),
  internal_date_ms BIGINT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(user_id, account_id, message_hmac),
  FOREIGN KEY(user_id, account_id) REFERENCES calendar_email_followup_monitors(user_id, account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS calendar_email_followup_mutations (
  request_id UUID NOT NULL REFERENCES calendar_email_followup_requests(id) ON DELETE CASCADE,
  idempotency_key UUID NOT NULL,
  resulting_revision INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(request_id, idempotency_key)
);

ALTER TABLE calendar_email_followup_monitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_email_followup_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_email_followup_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_email_followup_scanned_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_email_followup_mutations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON calendar_email_followup_monitors, calendar_email_followup_conversations,
  calendar_email_followup_requests, calendar_email_followup_scanned_messages,
  calendar_email_followup_mutations FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT ALL ON calendar_email_followup_monitors, calendar_email_followup_conversations,
      calendar_email_followup_requests, calendar_email_followup_scanned_messages,
      calendar_email_followup_mutations TO service_role;
  END IF;
END $$;
SELECT install_account_deletion_write_guards();

COMMIT;
