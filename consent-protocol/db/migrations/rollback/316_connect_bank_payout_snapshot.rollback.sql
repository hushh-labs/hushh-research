-- Rollback for 316_connect_bank_payout_snapshot.sql. Deposit rows, amounts,
-- statuses and the signed event history always stay. The snapshot columns
-- (and their CHECKs) are dropped only while no deposit holds a value in any of
-- them. Once one does, they are deposit evidence: the bank a deposit went to
-- and its bank trace cannot be read from Stripe again after the bank is
-- removed. Re-applying 316 afterwards is idempotent either way.
BEGIN;
-- Retain the widened event CHECK: signed events of the added types may already
-- be recorded, and a rollback must never delete or invalidate their audit trail.
DO $$
BEGIN
  IF to_regclass('stripe_connect_bank_payouts') IS NULL THEN
    RETURN;
  END IF;
  -- Writers wait, so no snapshot can land between this check and the drop.
  LOCK TABLE stripe_connect_bank_payouts IN SHARE ROW EXCLUSIVE MODE;
  -- Read through to_jsonb so a partly applied snapshot is checked as well.
  IF EXISTS (
    SELECT 1 FROM stripe_connect_bank_payouts AS payout
      CROSS JOIN LATERAL jsonb_each(to_jsonb(payout)) AS snapshot(name, value)
    WHERE snapshot.name IN ('destination_id','destination_kind','destination_bank_name',
        'destination_last4','payout_method','automatic','trace_status','trace_value',
        'reconciliation_status','provider_observed_at','status_changed_at','paid_at',
        'failed_at')
      AND snapshot.value <> 'null'::jsonb
  ) THEN
    RAISE NOTICE 'Kept the 316 deposit snapshot columns: deposits already hold bank or trace evidence.';
    RETURN;
  END IF;
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
END $$;
COMMIT;
