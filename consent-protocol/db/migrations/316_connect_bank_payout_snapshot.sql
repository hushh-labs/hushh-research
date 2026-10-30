-- Bank deposit snapshot (#6) and same-status provider updates (#10).
-- Each deposit keeps the masked bank it was sent to (write-once), Stripe's
-- payout method, bank trace reference and reconciliation status, and the time
-- of the provider read that orders same-status updates. Every column is
-- nullable: rows written earlier fill in on their next provider read. Release
-- replay runs this on every deploy, so an applied database is only inspected:
-- replay takes no table lock and re-validates nothing.
BEGIN;

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_attribute
      WHERE attrelid = 'stripe_connect_bank_payouts'::regclass AND NOT attisdropped
        AND attname IN ('destination_id','destination_kind','destination_bank_name',
          'destination_last4','payout_method','automatic','trace_status','trace_value',
          'reconciliation_status','provider_observed_at','status_changed_at','paid_at',
          'failed_at')) < 13
    OR (SELECT count(*) FROM pg_constraint
      WHERE conrelid = 'stripe_connect_bank_payouts'::regclass
        AND conname IN ('stripe_connect_bank_payouts_destination_id_check',
          'stripe_connect_bank_payouts_destination_kind_check',
          'stripe_connect_bank_payouts_destination_bank_name_check',
          'stripe_connect_bank_payouts_destination_last4_check',
          'stripe_connect_bank_payouts_payout_method_check',
          'stripe_connect_bank_payouts_trace_status_check',
          'stripe_connect_bank_payouts_trace_value_check',
          'stripe_connect_bank_payouts_reconciliation_status_check')) < 8 THEN
    ALTER TABLE stripe_connect_bank_payouts
      ADD COLUMN IF NOT EXISTS destination_id TEXT,
      ADD COLUMN IF NOT EXISTS destination_kind TEXT,
      ADD COLUMN IF NOT EXISTS destination_bank_name TEXT,
      ADD COLUMN IF NOT EXISTS destination_last4 TEXT,
      ADD COLUMN IF NOT EXISTS payout_method TEXT,
      ADD COLUMN IF NOT EXISTS automatic BOOLEAN,
      ADD COLUMN IF NOT EXISTS trace_status TEXT,
      ADD COLUMN IF NOT EXISTS trace_value TEXT,
      ADD COLUMN IF NOT EXISTS reconciliation_status TEXT,
      ADD COLUMN IF NOT EXISTS provider_observed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ,
      DROP CONSTRAINT IF EXISTS stripe_connect_bank_payouts_destination_id_check,
      ADD CONSTRAINT stripe_connect_bank_payouts_destination_id_check CHECK (
        destination_id IS NULL OR destination_id ~ '^(ba|card)_[A-Za-z0-9_]{1,250}$'),
      DROP CONSTRAINT IF EXISTS stripe_connect_bank_payouts_destination_kind_check,
      ADD CONSTRAINT stripe_connect_bank_payouts_destination_kind_check CHECK (
        destination_kind IS NULL OR destination_kind IN ('bank_account','card')),
      DROP CONSTRAINT IF EXISTS stripe_connect_bank_payouts_destination_bank_name_check,
      ADD CONSTRAINT stripe_connect_bank_payouts_destination_bank_name_check CHECK (
        destination_bank_name IS NULL OR char_length(destination_bank_name) BETWEEN 1 AND 80),
      DROP CONSTRAINT IF EXISTS stripe_connect_bank_payouts_destination_last4_check,
      ADD CONSTRAINT stripe_connect_bank_payouts_destination_last4_check CHECK (
        destination_last4 IS NULL OR destination_last4 ~ '^[0-9]{4}$'),
      DROP CONSTRAINT IF EXISTS stripe_connect_bank_payouts_payout_method_check,
      ADD CONSTRAINT stripe_connect_bank_payouts_payout_method_check CHECK (
        payout_method IS NULL OR payout_method IN ('standard','instant')),
      DROP CONSTRAINT IF EXISTS stripe_connect_bank_payouts_trace_status_check,
      ADD CONSTRAINT stripe_connect_bank_payouts_trace_status_check CHECK (
        trace_status IS NULL OR trace_status IN ('pending','supported','unsupported')),
      DROP CONSTRAINT IF EXISTS stripe_connect_bank_payouts_trace_value_check,
      ADD CONSTRAINT stripe_connect_bank_payouts_trace_value_check CHECK (
        trace_value IS NULL OR char_length(trace_value) BETWEEN 1 AND 128),
      DROP CONSTRAINT IF EXISTS stripe_connect_bank_payouts_reconciliation_status_check,
      ADD CONSTRAINT stripe_connect_bank_payouts_reconciliation_status_check CHECK (
        reconciliation_status IS NULL
        OR reconciliation_status IN ('in_progress','completed','not_applicable'));
    COMMENT ON COLUMN stripe_connect_bank_payouts.destination_id IS
      'Bank account or card the deposit was sent to; write-once and never returned to clients.';
    COMMENT ON COLUMN stripe_connect_bank_payouts.destination_bank_name IS
      'Masked bank name read with the deposit; write-once, so it outlives a removed bank.';
    COMMENT ON COLUMN stripe_connect_bank_payouts.trace_value IS
      'Stripe bank trace for the deposit, shown to the owner as the bank reference.';
    COMMENT ON COLUMN stripe_connect_bank_payouts.provider_observed_at IS
      'Time of the newest applied Stripe read; an older same-status read is ignored.';
    COMMENT ON COLUMN stripe_connect_bank_payouts.status_changed_at IS
      'Time of the read that first showed the current status; same-status reads keep it.';
    COMMENT ON COLUMN stripe_connect_bank_payouts.paid_at IS
      'Time of the read that first showed a move into paid; NULL if first read already paid.';
    COMMENT ON COLUMN stripe_connect_bank_payouts.failed_at IS
      'Time of the read that first showed a move into failed; NULL if first read already failed.';
  END IF;
END $$;

-- Widen only: keep every installed event type and add Stripe's balance and
-- payout-reconciliation events. An installed superset is left untouched.
DO $$
DECLARE installed TEXT[];
BEGIN
  SELECT ARRAY(SELECT DISTINCT hit[1] FROM regexp_matches(
    pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') AS hit) INTO installed
  FROM pg_constraint c
  WHERE c.conrelid = 'stripe_connect_bank_payout_events'::regclass
    AND c.conname = 'stripe_connect_bank_payout_events_event_type_check';
  IF NOT COALESCE(installed @> ARRAY[
    'account.updated','account.external_account.created','account.external_account.updated',
    'account.external_account.deleted','payout.created','payout.updated','payout.paid',
    'payout.failed','payout.canceled','balance.available',
    'payout.reconciliation_completed']::TEXT[], FALSE) THEN
    ALTER TABLE stripe_connect_bank_payout_events
      DROP CONSTRAINT IF EXISTS stripe_connect_bank_payout_events_event_type_check;
    ALTER TABLE stripe_connect_bank_payout_events
      ADD CONSTRAINT stripe_connect_bank_payout_events_event_type_check CHECK (event_type IN
        ('account.updated','account.external_account.created','account.external_account.updated',
         'account.external_account.deleted','payout.created','payout.updated','payout.paid',
         'payout.failed','payout.canceled','balance.available',
         'payout.reconciliation_completed'));
  END IF;
END $$;

COMMIT;
