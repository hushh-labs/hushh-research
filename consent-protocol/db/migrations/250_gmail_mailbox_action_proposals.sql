-- Reviewed Gmail mailbox changes (archive, labels, read state, trash) proposed
-- in One's chat. A row is a short-lived confirmation hand-off: the exact
-- message IDs the owner reviewed, bound to the Gmail account they were resolved
-- in, and nothing else. No subject, sender, body or token is stored. The change
-- runs only when the owner presses the card's confirmation control.
-- Replay-safe: every deploy re-runs this file, and every statement is
-- IF NOT EXISTS or idempotent.
BEGIN;

CREATE TABLE IF NOT EXISTS gmail_mailbox_action_proposals (
  proposal_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  google_sub TEXT NOT NULL,
  action TEXT NOT NULL CHECK (
    action IN ('archive', 'add_label', 'remove_label', 'mark_read', 'mark_unread', 'trash')
  ),
  message_ids JSONB NOT NULL CHECK (
    jsonb_typeof(message_ids) = 'array'
    AND jsonb_array_length(message_ids) BETWEEN 1 AND 25
  ),
  label_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'executing', 'executed', 'failed')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((action IN ('add_label', 'remove_label')) = (label_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_gmail_mailbox_proposals_user_expiry
  ON gmail_mailbox_action_proposals (user_id, expires_at);

COMMENT ON TABLE gmail_mailbox_action_proposals IS
  'Short-lived, confirmation-bound Gmail mailbox changes; message IDs only, never mail content.';

ALTER TABLE gmail_mailbox_action_proposals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON gmail_mailbox_action_proposals FROM PUBLIC;
DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON gmail_mailbox_action_proposals FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON gmail_mailbox_action_proposals TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;
COMMIT;
