-- New Drive request orders may create one owner earning in their INSERT
-- transaction. There is deliberately no backfill: already paid orders are not
-- retroactively enrolled. The row survives request/account erasure without a
-- user ID so uncertain transfers and reversals can still be reconciled.
BEGIN;

CREATE TABLE IF NOT EXISTS drive_request_owner_payouts (
  request_id UUID PRIMARY KEY REFERENCES drive_request_payment_obligations(request_id),
  gross_amount_cents INTEGER NOT NULL CHECK (gross_amount_cents BETWEEN 100 AND 50000),
  currency TEXT NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  commission_bps SMALLINT NOT NULL DEFAULT 300 CHECK (commission_bps = 300),
  status TEXT NOT NULL DEFAULT 'awaiting_delivery' CHECK (status IN (
    'awaiting_delivery','awaiting_refund','awaiting_fee','awaiting_account','due',
    'dispatching','unknown','manual_review','transferred',
    'reversal_due','reversal_unknown','reversed','void')),
  expected_files INTEGER CHECK (expected_files >= 0),
  confirmed_files INTEGER CHECK (confirmed_files >= 0),
  retained_amount_cents INTEGER,
  refund_amount_cents INTEGER,
  platform_fee_cents INTEGER,
  actual_processing_fee_cents INTEGER,
  allocated_processing_fee_cents INTEGER,
  owner_earning_cents INTEGER,
  finalized_at TIMESTAMPTZ,
  stripe_payment_intent_id TEXT,
  stripe_charge_id TEXT UNIQUE,
  stripe_balance_transaction_id TEXT UNIQUE,
  destination_account_id TEXT,
  stripe_transfer_id TEXT UNIQUE,
  transfer_attempt_id UUID UNIQUE,
  first_dispatch_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  next_check_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  transferred_at TIMESTAMPTZ,
  reversal_amount_cents INTEGER,
  stripe_reversal_id TEXT UNIQUE,
  reversal_attempt_id UUID UNIQUE,
  reversal_first_dispatch_at TIMESTAMPTZ,
  reversal_lease_expires_at TIMESTAMPTZ,
  reversed_at TIMESTAMPTZ,
  erased_at TIMESTAMPTZ,
  -- Set only while the live paid order still exists. This is the durable
  -- authority for settling a finalized delivery after either party erases.
  eligible_at_erasure BOOLEAN NOT NULL DEFAULT FALSE,
  safe_error_code TEXT CHECK (safe_error_code IS NULL OR safe_error_code IN (
    'provider_unavailable','provider_mismatch','idempotency_window_elapsed',
    'account_unavailable','charge_unavailable','refund_mismatch',
    'delivery_unsettled','account_erased','external_debit')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((expected_files IS NULL AND confirmed_files IS NULL AND
          retained_amount_cents IS NULL AND refund_amount_cents IS NULL AND
          platform_fee_cents IS NULL AND actual_processing_fee_cents IS NULL AND
          allocated_processing_fee_cents IS NULL AND owner_earning_cents IS NULL AND
          finalized_at IS NULL) OR
         (expected_files IS NOT NULL AND confirmed_files IS NOT NULL AND
          confirmed_files <= expected_files AND retained_amount_cents IS NOT NULL AND
          refund_amount_cents IS NOT NULL AND platform_fee_cents IS NOT NULL AND
          finalized_at IS NOT NULL AND
          retained_amount_cents + refund_amount_cents = gross_amount_cents AND
          retained_amount_cents = CASE WHEN expected_files=0 THEN 0 ELSE
            (2 * gross_amount_cents * confirmed_files + expected_files) / (2 * expected_files) END AND
          platform_fee_cents = (retained_amount_cents * commission_bps + 5000) / 10000 AND
          ((actual_processing_fee_cents IS NULL AND allocated_processing_fee_cents IS NULL
            AND owner_earning_cents IS NULL) OR
           (actual_processing_fee_cents IS NOT NULL AND allocated_processing_fee_cents IS NOT NULL
            AND owner_earning_cents IS NOT NULL AND actual_processing_fee_cents >= 0 AND
            allocated_processing_fee_cents = LEAST(actual_processing_fee_cents,
              retained_amount_cents - platform_fee_cents) AND
            owner_earning_cents = retained_amount_cents - platform_fee_cents -
              allocated_processing_fee_cents)))),
  CHECK (reversal_amount_cents IS NULL OR
    (owner_earning_cents IS NOT NULL AND reversal_amount_cents > 0 AND
     reversal_amount_cents <= owner_earning_cents)),
  CHECK (stripe_transfer_id IS NULL OR transfer_attempt_id IS NOT NULL),
  CHECK (stripe_reversal_id IS NULL OR reversal_attempt_id IS NOT NULL)
);

-- A pre-release 292 rehearsal may have created the table before this
-- authority snapshot was added. Replaying the migration must stay fail-closed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid='drive_request_owner_payouts'::regclass
      AND attname='eligible_at_erasure' AND NOT attisdropped) THEN
    ALTER TABLE drive_request_owner_payouts
      ADD COLUMN eligible_at_erasure BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS drive_request_owner_payouts_due
  ON drive_request_owner_payouts(next_check_at,updated_at)
  WHERE status IN ('awaiting_delivery','awaiting_refund','awaiting_fee','awaiting_account',
    'due','dispatching','unknown','reversal_due','reversal_unknown');

-- A partial refund records its exact amount. NULL remains valid for legacy
-- full-refund rows; payout settlement never treats NULL as a matching partial.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid='drive_request_payment_refunds'::regclass
      AND attname='amount_cents' AND NOT attisdropped) THEN
    ALTER TABLE drive_request_payment_refunds
      ADD COLUMN amount_cents INTEGER CHECK (amount_cents BETWEEN 1 AND 50000);
  END IF;
END $$;

-- Account retention deletes batch rows before it deletes the payment order.
-- Capture an already terminal delivery ratio before that evidence disappears.
-- An unsettled batch leaves the financial obligation for manual review.
CREATE OR REPLACE FUNCTION preserve_drive_owner_delivery_basis()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_status TEXT;
DECLARE requester TEXT;
DECLARE erasure_snapshot BOOLEAN := FALSE;
DECLARE expected_count INTEGER;
DECLARE confirmed_count INTEGER;
DECLARE unsettled_count INTEGER;
DECLARE gross_cents INTEGER;
DECLARE retained_cents INTEGER;
DECLARE refund_cents INTEGER;
BEGIN
  IF OLD.origin_request_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM drive_request_owner_payouts
    WHERE request_id=OLD.origin_request_id AND status='awaiting_delivery') THEN
    RETURN OLD;
  END IF;
  SELECT status,recipient_user_id INTO request_status,requester
    FROM drive_share_requests WHERE request_id=OLD.origin_request_id;
  -- Account erasure snapshots grant evidence before deleting batches. A
  -- progressive request may still be pending after a settled approved batch;
  -- preserve that known delivery basis before its effects disappear.
  SELECT COALESCE(status='paid' AND NOT reconciliation_required
      AND delivery_confirmed_at_erasure AND NOT delivery_unsettled_at_erasure,FALSE)
    INTO erasure_snapshot FROM drive_request_payment_obligations
    WHERE request_id=OLD.origin_request_id;
  IF (request_status NOT IN ('completed','partial','no_match')
      AND NOT erasure_snapshot) OR EXISTS (
    SELECT 1 FROM drive_bulk_shares
    WHERE origin_request_id=OLD.origin_request_id
      AND status IN ('review_ready','queued','running')
      AND (approved_at IS NOT NULL OR NOT erasure_snapshot)) THEN
    RETURN OLD;
  END IF;
  WITH file_outcomes AS (
    SELECT f.file_digest,
      bool_or(e.state IN ('succeeded','preexisting')) AS confirmed,
      bool_or(e.state IS NULL OR e.state NOT IN
        ('succeeded','preexisting','skipped','failed','absent') OR
        (e.state='failed' AND e.safe_error_code='permission_outcome_unknown')) AS unsettled
    FROM drive_bulk_shares b
    JOIN drive_bulk_share_files f ON f.share_id=b.share_id
    JOIN drive_bulk_share_recipients recipient
      ON recipient.share_id=b.share_id AND recipient.recipient_user_id=requester
    LEFT JOIN drive_bulk_share_effects e
      ON e.share_id=f.share_id AND e.position=f.position AND
         e.recipient_user_id=recipient.recipient_user_id
    WHERE b.origin_request_id=OLD.origin_request_id AND b.approved_at IS NOT NULL
      AND (b.progressive_batch=FALSE OR f.origin_request_id=OLD.origin_request_id)
    GROUP BY f.file_digest
  ) SELECT COUNT(*),COUNT(*) FILTER (WHERE confirmed),
      COUNT(*) FILTER (WHERE unsettled)
    INTO expected_count,confirmed_count,unsettled_count FROM file_outcomes;
  IF expected_count=0 OR unsettled_count>0 THEN
    RETURN OLD;
  END IF;
  SELECT gross_amount_cents INTO gross_cents FROM drive_request_owner_payouts
    WHERE request_id=OLD.origin_request_id FOR UPDATE;
  retained_cents := (2*gross_cents*confirmed_count+expected_count)/(2*expected_count);
  refund_cents := gross_cents-retained_cents;
  UPDATE drive_request_owner_payouts SET
    expected_files=expected_count,confirmed_files=confirmed_count,
    retained_amount_cents=retained_cents,refund_amount_cents=refund_cents,
    platform_fee_cents=(retained_cents*commission_bps+5000)/10000,
    finalized_at=clock_timestamp(),
    status=CASE WHEN refund_cents>0 THEN 'awaiting_refund' ELSE 'awaiting_fee' END,
    updated_at=clock_timestamp()
  WHERE request_id=OLD.origin_request_id AND status='awaiting_delivery';
  RETURN OLD;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgname='drive_request_owner_delivery_preserve'
      AND tgrelid='drive_bulk_shares'::regclass) THEN
    CREATE TRIGGER drive_request_owner_delivery_preserve
      BEFORE DELETE ON drive_bulk_shares FOR EACH ROW
      EXECUTE FUNCTION preserve_drive_owner_delivery_basis();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION preserve_drive_request_owner_payout()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE settlement_eligible BOOLEAN := FALSE;
BEGIN
  -- No-match requests have no batch-delete trigger to carry their zero-file
  -- basis. Keep the full-refund obligation before erasing the live request.
  UPDATE drive_request_owner_payouts p SET
    expected_files=0,confirmed_files=0,retained_amount_cents=0,
    refund_amount_cents=p.gross_amount_cents,platform_fee_cents=0,
    finalized_at=clock_timestamp(),status='awaiting_refund',
    updated_at=clock_timestamp()
  WHERE p.request_id=OLD.request_id AND p.status='awaiting_delivery'
    AND EXISTS (SELECT 1 FROM drive_share_requests r
      WHERE r.request_id=OLD.request_id AND r.status='no_match')
    AND NOT EXISTS (SELECT 1 FROM drive_bulk_shares b
      WHERE b.origin_request_id=OLD.request_id)
    AND NOT EXISTS (SELECT 1 FROM drive_share_permission_operations op
      WHERE op.request_id=OLD.request_id AND op.kind='grant'
        AND op.state IN ('succeeded','preexisting','dispatching','unknown',
                         'present_unattributed'));
  SELECT COALESCE(
    OLD.status='paid' AND NOT OLD.reconciliation_required
      AND OLD.stripe_payment_intent_id IS NOT NULL
      AND o.status='paid' AND NOT o.reconciliation_required
      AND o.stripe_payment_intent_id=OLD.stripe_payment_intent_id
      AND o.delivery_confirmed_at_erasure
      AND NOT o.delivery_unsettled_at_erasure
      AND p.finalized_at IS NOT NULL AND p.expected_files>0
      AND p.confirmed_files>0 AND p.retained_amount_cents>0,
    FALSE) INTO settlement_eligible
  FROM drive_request_owner_payouts p
  JOIN drive_request_payment_obligations o ON o.request_id=p.request_id
  WHERE p.request_id=OLD.request_id FOR UPDATE OF p;
  UPDATE drive_request_owner_payouts SET
    erased_at=COALESCE(erased_at,clock_timestamp()),
    eligible_at_erasure=eligible_at_erasure OR settlement_eligible,
    destination_account_id=COALESCE(destination_account_id,
      (SELECT stripe_account_id FROM pkm_owner_payout_accounts
       WHERE user_id=OLD.user_id)),
    stripe_payment_intent_id=COALESCE(stripe_payment_intent_id,
      OLD.stripe_payment_intent_id),
    status=CASE
      WHEN status IN ('transferred','reversal_due','reversal_unknown','reversed',
                      'dispatching','unknown')
        THEN status
      WHEN status='awaiting_refund' THEN status
      WHEN status='void' THEN status
      WHEN settlement_eligible AND status IN ('awaiting_fee','awaiting_account','due')
        THEN status
      ELSE 'manual_review' END,
    safe_error_code=CASE WHEN status IN ('transferred','reversal_due',
      'reversal_unknown','reversed','awaiting_refund','void') OR
      (settlement_eligible AND status IN ('awaiting_fee','awaiting_account','due'))
      THEN safe_error_code ELSE 'account_erased' END,
    updated_at=clock_timestamp()
  WHERE request_id=OLD.request_id;
  RETURN OLD;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgname='drive_request_owner_payout_erasure'
      AND tgrelid='drive_request_payment_orders'::regclass) THEN
    CREATE TRIGGER drive_request_owner_payout_erasure
      BEFORE DELETE ON drive_request_payment_orders FOR EACH ROW
      EXECUTE FUNCTION preserve_drive_request_owner_payout();
  END IF;
END $$;

DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class
    WHERE oid='drive_request_owner_payouts'::regclass) THEN
    ALTER TABLE drive_request_owner_payouts ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;
REVOKE ALL ON drive_request_owner_payouts FROM PUBLIC;
DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON drive_request_owner_payouts FROM %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON drive_request_owner_payouts TO service_role;
  END IF;
END $$;

COMMENT ON TABLE drive_request_owner_payouts IS
  'New request owner earnings and provider settlement obligations; no owner identity or document metadata.';
COMMIT;
