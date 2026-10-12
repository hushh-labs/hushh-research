-- Rollback for 307_connect_bank_payout_snapshot.sql. Drops only the deposit
-- snapshot columns it added (their CHECKs go with them). Deposit rows, amounts,
-- statuses and the signed event history all stay.
BEGIN;
-- Retain the widened event CHECK: signed events of the added types may already
-- be recorded, and a rollback must never delete or invalidate their audit trail.
ALTER TABLE stripe_connect_bank_payouts
  DROP COLUMN IF EXISTS destination_id,
  DROP COLUMN IF EXISTS destination_kind,
  DROP COLUMN IF EXISTS destination_bank_name,
  DROP COLUMN IF EXISTS destination_last4,
  DROP COLUMN IF EXISTS payout_method,
  DROP COLUMN IF EXISTS automatic,
  DROP COLUMN IF EXISTS trace_status,
  DROP COLUMN IF EXISTS trace_value,
  DROP COLUMN IF EXISTS reconciliation_status,
  DROP COLUMN IF EXISTS provider_observed_at,
  DROP COLUMN IF EXISTS status_changed_at,
  DROP COLUMN IF EXISTS paid_at,
  DROP COLUMN IF EXISTS failed_at;
COMMIT;
