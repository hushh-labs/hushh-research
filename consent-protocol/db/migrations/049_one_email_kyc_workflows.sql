-- Migration 049: One mailbox KYC workflow state
-- ================================================================
-- Metadata-only intake lane for one@hushh.ai broker/KYC workflows.
-- Raw email bodies, tokens, vault contents, and decrypted PKM are not stored.

BEGIN;

CREATE TABLE IF NOT EXISTS one_email_mailbox_state (
  mailbox_email TEXT PRIMARY KEY,
  history_id TEXT,
  watch_status TEXT NOT NULL DEFAULT 'unknown',
  watch_expiration_at TIMESTAMPTZ,
  last_watch_renewed_at TIMESTAMPTZ,
  last_notification_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT one_email_mailbox_state_watch_status_check
    CHECK (watch_status IN ('unknown', 'active', 'expiring', 'expired', 'failed', 'not_configured'))
);

CREATE TABLE IF NOT EXISTS one_kyc_workflows (
  workflow_id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES actor_profiles(user_id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  gmail_message_id TEXT NOT NULL,
  gmail_thread_id TEXT,
  gmail_history_id TEXT,
  sender_email TEXT,
  sender_name TEXT,
  participant_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
  subject TEXT,
  snippet TEXT,
  counterparty_label TEXT,
  rfc_message_id TEXT,
  required_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  requested_scope TEXT,
  consent_request_id TEXT,
  draft_subject TEXT,
  draft_body TEXT,
  draft_status TEXT NOT NULL DEFAULT 'not_ready',
  last_error_code TEXT,
  last_error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT one_kyc_workflows_status_check
    CHECK (status IN (
      'needs_scope',
      'needs_documents',
      'drafting',
      'waiting_on_user',
      'waiting_on_counterparty',
      'completed',
      'blocked'
    )),
  CONSTRAINT one_kyc_workflows_draft_status_check
    CHECK (draft_status IN ('not_ready', 'ready', 'sent', 'rejected'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_kyc_workflows_gmail_message_id
  ON one_kyc_workflows(gmail_message_id);

CREATE INDEX IF NOT EXISTS idx_one_kyc_workflows_user_status
  ON one_kyc_workflows(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_one_kyc_workflows_consent_request
  ON one_kyc_workflows(consent_request_id)
  WHERE consent_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_one_kyc_workflows_gmail_thread
  ON one_kyc_workflows(gmail_thread_id)
  WHERE gmail_thread_id IS NOT NULL;

COMMIT;
