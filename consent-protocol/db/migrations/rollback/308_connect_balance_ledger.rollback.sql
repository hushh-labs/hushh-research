-- Rollback for 308_connect_balance_ledger.sql: drops only what it added and keeps money evidence.
-- The snapshot cache and the itemisation queue are rebuilt from Stripe on demand.
-- Mirrored balance transactions are settlement evidence: they stay once any exist.
-- Re-applying 308 afterwards is idempotent.
BEGIN;
DROP TABLE IF EXISTS stripe_connect_payout_reconciliations;
DROP TABLE IF EXISTS stripe_connect_balance_snapshots;
DO $$ BEGIN
  IF to_regclass('stripe_connect_balance_transactions') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM stripe_connect_balance_transactions) THEN
      DROP TABLE stripe_connect_balance_transactions;
    END IF;
  END IF;
END $$;
COMMIT;
