-- Scheduled owner-approved Gmail sends (One Live Voice, Part 2).
--
-- A scheduled send is an ordinary gmail_owner_send_actions row that waits in
-- state 'scheduled' until its send_at, when the drain arms it to 'prepared'
-- and the existing execute() path sends it. The row never holds a plaintext
-- body or address: payload_sealed is AES-GCM ciphertext bound to the owner and
-- the action. recipient_display and subject are display-only columns for the
-- owner's scheduled list and neither is an HMAC input. recipient_display (the
-- confirmed connection's name, which the owner already said) may be spoken back
-- in the schedule and cancel confirmations; subject and payload_sealed never
-- reach the Live model.
--
-- Transitions: scheduled -> prepared -> sending -> {sent, failed,
-- outcome_unknown} (drain only); scheduled/prepared -> failed when the drain
-- refuses a row (window passed, recipient disconnected, ...), so the
-- mail_send_feed_projection trigger (sent/failed/outcome_unknown only) records
-- every unsent email; scheduled -> cancelled (owner). The existing expiry sweep
-- (state = 'prepared' AND expires_at <= NOW()) and that trigger never act on a
-- scheduled or cancelled row. On every terminal row payload_sealed and subject
-- are cleared by the drain.
--
-- Additive and replay-safe: every new column is nullable or defaulted, so the
-- existing explicit-column INSERT in prepare() is unaffected.

BEGIN;

ALTER TABLE IF EXISTS gmail_owner_send_actions
  DROP CONSTRAINT IF EXISTS gmail_owner_send_actions_state_check;
ALTER TABLE IF EXISTS gmail_owner_send_actions
  ADD CONSTRAINT gmail_owner_send_actions_state_check CHECK (state IN (
    'prepared', 'sending', 'sent', 'failed', 'outcome_unknown', 'expired',
    'scheduled', 'cancelled'
  ));

ALTER TABLE IF EXISTS gmail_owner_send_actions
  ADD COLUMN IF NOT EXISTS send_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS gmail_owner_send_actions
  ADD COLUMN IF NOT EXISTS payload_sealed TEXT;
ALTER TABLE IF EXISTS gmail_owner_send_actions
  ADD COLUMN IF NOT EXISTS recipient_display TEXT;
ALTER TABLE IF EXISTS gmail_owner_send_actions
  ADD COLUMN IF NOT EXISTS subject TEXT;
ALTER TABLE IF EXISTS gmail_owner_send_actions
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS gmail_owner_send_actions
  ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;

-- A scheduled row without a time could never fire and never expire.
ALTER TABLE IF EXISTS gmail_owner_send_actions
  DROP CONSTRAINT IF EXISTS gmail_owner_send_actions_schedule_time_check;
ALTER TABLE IF EXISTS gmail_owner_send_actions
  ADD CONSTRAINT gmail_owner_send_actions_schedule_time_check
  CHECK (state <> 'scheduled' OR send_at IS NOT NULL);

-- The drain's due-row scan: only rows still waiting are indexed.
CREATE INDEX IF NOT EXISTS idx_gmail_owner_send_actions_scheduled_send_at
  ON gmail_owner_send_actions (send_at)
  WHERE state = 'scheduled';

COMMIT;
