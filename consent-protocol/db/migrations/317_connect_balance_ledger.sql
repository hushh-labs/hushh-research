-- Connected-account Stripe balance ("In Stripe") and bank-payout contents.
-- Account-keyed provider evidence only: no user_id, request, bank or document
-- columns. Owners read it through the current owner-plus-mode account mapping.
-- A snapshot is a cache; refresh_started_at doubles as a single-flight lease.
-- Balance transactions mirror Stripe's ledger; stripe_payout_id is set only
-- from Stripe's own payout reconciliation, never inferred from timing.
-- Expand-only and replay-safe: every deploy re-runs this file.
BEGIN;

CREATE TABLE IF NOT EXISTS stripe_connect_balance_snapshots (
  stripe_account_id TEXT PRIMARY KEY CHECK (stripe_account_id ~ '^acct_'),
  livemode BOOLEAN NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  available_cents BIGINT,
  pending_cents BIGINT,
  next_available_on TIMESTAMPTZ,
  next_available_cents BIGINT,
  fetched_at TIMESTAMPTZ,
  refresh_started_at TIMESTAMPTZ,
  refresh_due_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stripe_connect_balance_transactions (
  stripe_balance_transaction_id TEXT PRIMARY KEY
    CHECK (stripe_balance_transaction_id ~ '^txn_'),
  stripe_account_id TEXT NOT NULL,
  livemode BOOLEAN NOT NULL,
  txn_type TEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  fee_cents BIGINT NOT NULL DEFAULT 0,
  net_cents BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','available')),
  available_on TIMESTAMPTZ,
  provider_created_at TIMESTAMPTZ,
  source_id TEXT,
  source_transfer_id TEXT,
  source_charge_id TEXT,
  stripe_payout_id TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stripe_connect_balance_transactions_account_recent
  ON stripe_connect_balance_transactions
  (stripe_account_id,livemode,provider_created_at DESC);
CREATE INDEX IF NOT EXISTS stripe_connect_balance_transactions_transfer
  ON stripe_connect_balance_transactions (source_transfer_id)
  WHERE source_transfer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stripe_connect_balance_transactions_payout
  ON stripe_connect_balance_transactions (stripe_payout_id)
  WHERE stripe_payout_id IS NOT NULL;
-- Refund-to-payment and returned-deposit lookups follow source IDs.
CREATE INDEX IF NOT EXISTS stripe_connect_balance_transactions_source
  ON stripe_connect_balance_transactions (stripe_account_id,source_id)
  WHERE source_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS stripe_connect_payout_reconciliations (
  stripe_payout_id TEXT PRIMARY KEY
    REFERENCES stripe_connect_bank_payouts(stripe_payout_id),
  stripe_account_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','complete','not_applicable')),
  cursor TEXT CHECK (cursor IS NULL OR cursor ~ '^txn_'),
  scan_started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The worker claims the oldest open reconciliation; finished rows leave it.
CREATE INDEX IF NOT EXISTS stripe_connect_payout_reconciliations_open
  ON stripe_connect_payout_reconciliations (scan_started_at ASC NULLS FIRST,stripe_payout_id)
  WHERE status IN ('pending','in_progress');

-- Each worker tick queues deposits that became ready for itemisation recently,
-- so its read grows with recent deposit changes, not with every deposit ever.
-- The predicate matches the discovery query. Built once: a replay finds it and
-- takes no lock on the deposit table.
DO $$ BEGIN
  IF to_regclass('stripe_connect_bank_payouts_reconcile_recent') IS NULL THEN
    CREATE INDEX IF NOT EXISTS stripe_connect_bank_payouts_reconcile_recent
      ON stripe_connect_bank_payouts (livemode,updated_at)
      WHERE automatic IS FALSE OR reconciliation_status IN ('completed','not_applicable');
  END IF;
END $$;

-- Replays skip the ACCESS EXCLUSIVE RLS switch once it is on.
DO $$ DECLARE table_name TEXT; DECLARE role_name TEXT; BEGIN
  FOREACH table_name IN ARRAY ARRAY['stripe_connect_balance_snapshots',
    'stripe_connect_balance_transactions','stripe_connect_payout_reconciliations'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class
      WHERE oid=to_regclass(table_name) AND relrowsecurity) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    END IF;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',table_name);
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I',table_name,role_name);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO service_role',table_name);
    END IF;
  END LOOP;
END $$;

COMMENT ON TABLE stripe_connect_balance_snapshots IS
  'Cached connected-account Stripe balance; refresh_started_at is a single-flight lease.';
COMMENT ON TABLE stripe_connect_balance_transactions IS
  'Mirror of connected-account balance transactions; payout links come only from Stripe reconciliation.';
COMMENT ON TABLE stripe_connect_payout_reconciliations IS
  'One itemisation job per automatic bank payout, resumed from a durable cursor.';

COMMIT;
