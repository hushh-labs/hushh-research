-- Polling can be disabled without touching payout money state or event history.
BEGIN;
-- Retain the expanded event check: signed cancellation events may already
-- exist, and rollback must never delete or invalidate their audit trail.
DROP INDEX IF EXISTS stripe_owner_payout_accounts_bank_scan_due;
ALTER TABLE stripe_owner_payout_accounts
  DROP CONSTRAINT IF EXISTS stripe_owner_payout_bank_scan_cursor_check;
ALTER TABLE stripe_owner_payout_accounts
  DROP COLUMN IF EXISTS bank_payout_scan_cursor;
ALTER TABLE stripe_owner_payout_accounts
  DROP COLUMN IF EXISTS bank_payout_scan_started_at;
COMMIT;
