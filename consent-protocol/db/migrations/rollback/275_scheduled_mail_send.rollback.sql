BEGIN;

-- Refuse while any row depends on the scheduled lifecycle. The restored state
-- CHECK cannot hold them, and dropping send_at would strand a waiting send.
DO $$
BEGIN
  IF to_regclass('public.gmail_owner_send_actions') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM gmail_owner_send_actions
       WHERE state IN ('scheduled', 'cancelled')
     ) THEN
    RAISE EXCEPTION
      'migration_275_rollback_refused_scheduled_rows: cancel or drain them first';
  END IF;
END
$$;

DROP INDEX IF EXISTS idx_gmail_owner_send_actions_scheduled_send_at;

ALTER TABLE IF EXISTS gmail_owner_send_actions
  DROP CONSTRAINT IF EXISTS gmail_owner_send_actions_schedule_time_check;

ALTER TABLE IF EXISTS gmail_owner_send_actions DROP COLUMN IF EXISTS notified_at;
ALTER TABLE IF EXISTS gmail_owner_send_actions DROP COLUMN IF EXISTS attempt_count;
ALTER TABLE IF EXISTS gmail_owner_send_actions DROP COLUMN IF EXISTS subject;
ALTER TABLE IF EXISTS gmail_owner_send_actions DROP COLUMN IF EXISTS recipient_display;
ALTER TABLE IF EXISTS gmail_owner_send_actions DROP COLUMN IF EXISTS payload_sealed;
ALTER TABLE IF EXISTS gmail_owner_send_actions DROP COLUMN IF EXISTS send_at;

ALTER TABLE IF EXISTS gmail_owner_send_actions
  DROP CONSTRAINT IF EXISTS gmail_owner_send_actions_state_check;
ALTER TABLE IF EXISTS gmail_owner_send_actions
  ADD CONSTRAINT gmail_owner_send_actions_state_check CHECK (state IN (
    'prepared', 'sending', 'sent', 'failed', 'outcome_unknown', 'expired'
  ));

COMMIT;
