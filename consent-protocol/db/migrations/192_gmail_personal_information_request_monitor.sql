-- Personal Gmail information-request monitoring is an Email Agent workflow,
-- not receipt cache state and not the one@hushh.ai KYC mailbox workflow.
-- Email bodies, subjects, recipient addresses, PKM values, OAuth tokens, and
-- rendered drafts are intentionally absent from these tables.

BEGIN;

CREATE TABLE IF NOT EXISTS gmail_personal_information_request_preferences (
  user_id TEXT PRIMARY KEY REFERENCES vault_keys(user_id) ON DELETE CASCADE,
  monitoring_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  monitoring_enabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gmail_personal_information_request_scan_states (
  user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
  gmail_message_id TEXT NOT NULL,
  source_hmac TEXT NOT NULL,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, gmail_message_id),
  CONSTRAINT gmail_personal_information_request_scan_states_source_hmac_format
    CHECK (source_hmac ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS gmail_personal_information_requests (
  workflow_id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'detected',
  gmail_message_id TEXT NOT NULL,
  gmail_thread_id TEXT NOT NULL,
  source_hmac TEXT NOT NULL,
  sender_hmac TEXT,
  received_at TIMESTAMPTZ,
  classification_confidence NUMERIC(4,3) NOT NULL,
  requested_field_labels JSONB NOT NULL DEFAULT '[]'::jsonb,
  candidate_scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT gmail_personal_information_requests_status_check
    CHECK (status IN ('detected', 'ignored', 'blocked', 'sent')),
  CONSTRAINT gmail_personal_information_requests_confidence_check
    CHECK (classification_confidence >= 0 AND classification_confidence <= 1),
  CONSTRAINT gmail_personal_information_requests_source_hmac_format
    CHECK (source_hmac ~ '^[0-9a-f]{64}$'),
  CONSTRAINT gmail_personal_information_requests_sender_hmac_format
    CHECK (sender_hmac IS NULL OR sender_hmac ~ '^[0-9a-f]{64}$'),
  CONSTRAINT gmail_personal_information_requests_unique_source
    UNIQUE (user_id, gmail_message_id)
);

CREATE INDEX IF NOT EXISTS idx_gmail_personal_information_requests_queue
  ON gmail_personal_information_requests (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gmail_personal_information_requests_terminal_retention
  ON gmail_personal_information_requests (updated_at)
  WHERE status IN ('ignored', 'blocked', 'sent');

CREATE INDEX IF NOT EXISTS idx_gmail_personal_information_request_scan_states_retention
  ON gmail_personal_information_request_scan_states (scanned_at);

COMMENT ON TABLE gmail_personal_information_request_preferences IS
  'Explicit owner opt-in for temporary server-side classification of the connected personal Gmail inbox.';
COMMENT ON TABLE gmail_personal_information_request_scan_states IS
  'Metadata-only deduplication state for the personal Gmail monitor. Never stores email content, headers, addresses, or classifier output.';
COMMENT ON TABLE gmail_personal_information_requests IS
  'Metadata-only Email Agent queue for opted-in personal Gmail information requests. Never stores email content, PKM values, or drafts.';

COMMIT;
