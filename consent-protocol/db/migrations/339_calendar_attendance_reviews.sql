BEGIN;
-- Minimal submission ledger: no Calendar contents or email drafts at rest.
CREATE TABLE IF NOT EXISTS calendar_attendance_reviews (
  review_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared', 'executing', 'complete')),
  result_json JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS calendar_attendance_reviews_expiry ON calendar_attendance_reviews (expires_at);
COMMENT ON TABLE calendar_attendance_reviews IS 'Ten-minute owner-bound idempotency ledger; no event contents, drafts, credentials or capabilities. Purged on next review and cascaded on account deletion.';
SELECT install_account_deletion_write_guards();
COMMIT;
