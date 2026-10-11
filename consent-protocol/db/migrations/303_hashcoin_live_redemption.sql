-- Allow a redemption to consume only a wallet in the same Stripe mode.
-- Runtime still requires an explicit UAT live-withdrawal flag.
BEGIN;

DO $$ DECLARE constraint_name TEXT; BEGIN
  FOR constraint_name IN SELECT conname FROM pg_constraint
    WHERE conrelid='hashcoin_ledger_entries'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%entry_kind%'
  LOOP
    EXECUTE format('ALTER TABLE hashcoin_ledger_entries DROP CONSTRAINT %I',constraint_name);
  END LOOP;
END $$;
ALTER TABLE hashcoin_ledger_entries
  DROP CONSTRAINT IF EXISTS hashcoin_ledger_entry_kinds_check;
ALTER TABLE hashcoin_ledger_entries
  ADD CONSTRAINT hashcoin_ledger_entry_kinds_check CHECK (entry_kind IN
    ('earning','sandbox_earning','reversal','sandbox_reversal','redemption',
      'redemption_reversal'));
ALTER TABLE hashcoin_ledger_entries
  DROP CONSTRAINT IF EXISTS hashcoin_ledger_entry_sign_check;
ALTER TABLE hashcoin_ledger_entries
  ADD CONSTRAINT hashcoin_ledger_entry_sign_check CHECK (
    (entry_kind IN ('earning','sandbox_earning','redemption_reversal') AND amount_coins>0)
    OR (entry_kind IN ('reversal','sandbox_reversal','redemption') AND amount_coins<0)
  );

ALTER TABLE hashcoin_redemptions
  DROP CONSTRAINT IF EXISTS hashcoin_redemptions_stripe_mode_check;
ALTER TABLE hashcoin_redemptions
  ADD CONSTRAINT hashcoin_redemptions_stripe_mode_check
  CHECK (stripe_mode IN ('test','live'));
ALTER TABLE hashcoin_redemptions
  ADD COLUMN IF NOT EXISTS source_request_id UUID REFERENCES drive_request_owner_payouts(request_id);
ALTER TABLE hashcoin_redemptions
  ADD COLUMN IF NOT EXISTS source_charge_id TEXT;
ALTER TABLE hashcoin_redemptions
  ADD COLUMN IF NOT EXISTS source_payment_intent_id TEXT;
ALTER TABLE hashcoin_redemptions
  ADD COLUMN IF NOT EXISTS source_gross_cents BIGINT;
ALTER TABLE hashcoin_redemptions
  ADD COLUMN IF NOT EXISTS source_refund_cents BIGINT;
ALTER TABLE hashcoin_redemptions
  ADD COLUMN IF NOT EXISTS last_provider_checked_at TIMESTAMPTZ;
ALTER TABLE hashcoin_redemptions
  ADD COLUMN IF NOT EXISTS provider_review_reason TEXT;
ALTER TABLE hashcoin_redemptions
  ADD COLUMN IF NOT EXISTS provider_reversed_amount_coins BIGINT NOT NULL DEFAULT 0;
ALTER TABLE hashcoin_redemptions
  ADD COLUMN IF NOT EXISTS reversal_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE hashcoin_redemptions
  ADD COLUMN IF NOT EXISTS stripe_reversal_id TEXT;
ALTER TABLE hashcoin_redemptions
  ADD COLUMN IF NOT EXISTS reversal_attempt_id UUID;
ALTER TABLE hashcoin_redemptions
  ADD COLUMN IF NOT EXISTS reversal_first_dispatch_at TIMESTAMPTZ;
ALTER TABLE hashcoin_redemptions
  ADD COLUMN IF NOT EXISTS reversal_lease_expires_at TIMESTAMPTZ;
ALTER TABLE hashcoin_redemptions
  ADD COLUMN IF NOT EXISTS reversal_next_check_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp();
ALTER TABLE hashcoin_redemptions
  ADD COLUMN IF NOT EXISTS reversal_review_reason TEXT;
ALTER TABLE hashcoin_redemptions
  DROP CONSTRAINT IF EXISTS hashcoin_redemptions_reversal_state_check;
ALTER TABLE hashcoin_redemptions
  ADD CONSTRAINT hashcoin_redemptions_reversal_state_check CHECK (
    reversal_status IN ('none','due','unknown','reversed','manual_review') AND
    (reversal_status<>'reversed' OR (stripe_mode='live' AND status='succeeded'
      AND stripe_reversal_id LIKE 'trr_%')) AND
    (reversal_status='reversed' OR stripe_reversal_id IS NULL) AND
    (reversal_status='none' OR (stripe_mode='live' AND status='succeeded'))
  );
CREATE UNIQUE INDEX IF NOT EXISTS hashcoin_redemption_reversal_unique
  ON hashcoin_redemptions(stripe_reversal_id) WHERE stripe_reversal_id IS NOT NULL;
ALTER TABLE hashcoin_redemptions
  DROP CONSTRAINT IF EXISTS hashcoin_redemptions_provider_review_check;
ALTER TABLE hashcoin_redemptions
  ADD CONSTRAINT hashcoin_redemptions_provider_review_check CHECK (
    provider_review_reason IS NULL OR
    (stripe_mode='live' AND status='succeeded' AND
      provider_review_reason IN ('transfer_reversed','transfer_mismatch'))
  );
ALTER TABLE hashcoin_redemptions
  DROP CONSTRAINT IF EXISTS hashcoin_redemptions_provider_reversed_amount_check;
ALTER TABLE hashcoin_redemptions
  ADD CONSTRAINT hashcoin_redemptions_provider_reversed_amount_check CHECK (
    provider_reversed_amount_coins BETWEEN 0 AND amount_coins
  );
ALTER TABLE hashcoin_redemptions
  DROP CONSTRAINT IF EXISTS hashcoin_redemptions_live_source_check;
ALTER TABLE hashcoin_redemptions
  ADD CONSTRAINT hashcoin_redemptions_live_source_check CHECK (
    (stripe_mode='test' AND source_request_id IS NULL AND source_charge_id IS NULL
      AND source_payment_intent_id IS NULL AND source_gross_cents IS NULL
      AND source_refund_cents IS NULL) OR
    (stripe_mode='live' AND source_request_id IS NOT NULL AND source_charge_id LIKE 'ch_%'
      AND source_payment_intent_id LIKE 'pi_%' AND source_gross_cents>0
      AND source_refund_cents>=0 AND source_refund_cents<source_gross_cents)
  );
CREATE UNIQUE INDEX IF NOT EXISTS hashcoin_live_source_active
  ON hashcoin_redemptions(source_request_id)
  WHERE stripe_mode='live' AND status IN ('reserved','dispatching','unknown','succeeded');

CREATE OR REPLACE FUNCTION guard_hashcoin_redemption()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wallet_mode TEXT;
DECLARE earning RECORD;
BEGIN
  SELECT stripe_mode INTO wallet_mode FROM hashcoin_wallets WHERE wallet_id=NEW.wallet_id;
  IF wallet_mode IS NULL OR NEW.stripe_mode IS DISTINCT FROM wallet_mode THEN
    RAISE EXCEPTION 'Redemption and wallet Stripe modes must match';
  END IF;
  IF TG_OP='INSERT' AND NEW.stripe_mode='live' THEN
    SELECT p.wallet_id,p.stripe_mode,p.settlement_method,p.status,
      p.stripe_charge_id,p.stripe_payment_intent_id,p.gross_amount_cents,
      p.refund_amount_cents,p.owner_earning_cents
      INTO earning FROM drive_request_owner_payouts p
      WHERE p.request_id=NEW.source_request_id;
    IF NOT FOUND OR earning.wallet_id IS DISTINCT FROM NEW.wallet_id OR
        earning.stripe_mode<>'live' OR earning.settlement_method<>'hashcoins' OR
        earning.status<>'hashcoins_credited' OR
        earning.stripe_charge_id IS DISTINCT FROM NEW.source_charge_id OR
        earning.stripe_payment_intent_id IS DISTINCT FROM NEW.source_payment_intent_id OR
        earning.gross_amount_cents IS DISTINCT FROM NEW.source_gross_cents OR
        earning.refund_amount_cents IS DISTINCT FROM NEW.source_refund_cents OR
        earning.owner_earning_cents IS DISTINCT FROM NEW.amount_coins THEN
      RAISE EXCEPTION 'Live redemption source must be a settled wallet earning';
    END IF;
  END IF;
  IF TG_OP='UPDATE' AND (NEW.wallet_id IS DISTINCT FROM OLD.wallet_id OR
      NEW.request_key<>OLD.request_key OR NEW.amount_coins<>OLD.amount_coins OR
      NEW.stripe_mode<>OLD.stripe_mode OR
      NEW.destination_account_id<>OLD.destination_account_id OR
      NEW.source_request_id IS DISTINCT FROM OLD.source_request_id OR
      NEW.source_charge_id IS DISTINCT FROM OLD.source_charge_id OR
      NEW.source_payment_intent_id IS DISTINCT FROM OLD.source_payment_intent_id OR
      NEW.source_gross_cents IS DISTINCT FROM OLD.source_gross_cents OR
      NEW.source_refund_cents IS DISTINCT FROM OLD.source_refund_cents) THEN
    RAISE EXCEPTION 'Redemption intent is immutable';
  END IF;
  RETURN NEW;
END $$;

-- Owner erasure and live provider dispatch share a wallet-scoped advisory lock.
-- Erasure waits briefly for a transfer already being written; on timeout the
-- deletion transaction fails closed and can be retried by the caller.
CREATE OR REPLACE FUNCTION detach_hashcoin_wallet_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE live_wallet UUID;
DECLARE wait_deadline TIMESTAMPTZ;
BEGIN
  FOR live_wallet IN SELECT wallet_id FROM hashcoin_wallets
    WHERE user_id=OLD.user_id AND stripe_mode='live' ORDER BY wallet_id
  LOOP
    wait_deadline := clock_timestamp()+interval '10 seconds';
    WHILE NOT pg_try_advisory_xact_lock(hashtextextended(live_wallet::text,303)) LOOP
      IF clock_timestamp()>=wait_deadline THEN
        RAISE EXCEPTION 'Live payout dispatch in progress; retry erasure';
      END IF;
      PERFORM pg_sleep(0.05);
    END LOOP;
  END LOOP;
  UPDATE hashcoin_wallets SET user_id=NULL,held=TRUE,erased_at=clock_timestamp()
    WHERE user_id=OLD.user_id;
  RETURN OLD;
END $$;

COMMENT ON TABLE hashcoin_redemptions IS
  'Mode-bound payout reservations; live debits real coin liabilities and sandbox debits test coins only.';
COMMIT;
