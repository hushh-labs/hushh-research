-- Expand-only: new document orders may settle to an immutable Hashcoin ledger.
-- Live money and sandbox demonstrations never share a spendable balance.
BEGIN;

CREATE TABLE IF NOT EXISTS hashcoin_wallets (
  wallet_id UUID PRIMARY KEY,
  user_id TEXT,
  stripe_mode TEXT NOT NULL CHECK (stripe_mode IN ('live','test')),
  currency TEXT NOT NULL DEFAULT 'usd' CHECK (currency='usd'),
  held BOOLEAN NOT NULL DEFAULT FALSE,
  erased_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id,stripe_mode),
  CHECK ((user_id IS NOT NULL AND erased_at IS NULL) OR
         (user_id IS NULL AND erased_at IS NOT NULL AND held))
);
CREATE TABLE IF NOT EXISTS hashcoin_ledger_entries (
  entry_id UUID PRIMARY KEY,
  wallet_id UUID NOT NULL REFERENCES hashcoin_wallets(wallet_id),
  entry_kind TEXT NOT NULL CHECK (entry_kind IN
    ('earning','sandbox_earning','reversal','sandbox_reversal','redemption')),
  source_ref UUID NOT NULL,
  amount_coins BIGINT NOT NULL CHECK (amount_coins <> 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (wallet_id,entry_kind,source_ref),
  CHECK ((entry_kind IN ('earning','sandbox_earning') AND amount_coins>0) OR
         (entry_kind IN ('reversal','sandbox_reversal','redemption') AND amount_coins<0))
);
CREATE INDEX IF NOT EXISTS hashcoin_ledger_wallet_history
  ON hashcoin_ledger_entries(wallet_id,created_at DESC,entry_id);
CREATE TABLE IF NOT EXISTS hashcoin_redemptions (
  redemption_id UUID PRIMARY KEY,
  wallet_id UUID NOT NULL REFERENCES hashcoin_wallets(wallet_id),
  request_key UUID NOT NULL,
  amount_coins BIGINT NOT NULL CHECK (amount_coins BETWEEN 1 AND 50000),
  stripe_mode TEXT NOT NULL CHECK (stripe_mode='test'),
  destination_account_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN
    ('reserved','dispatching','unknown','succeeded','failed')),
  stripe_transfer_id TEXT UNIQUE,
  first_dispatch_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  attempt_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(wallet_id,request_key),
  CHECK ((status='succeeded') = (stripe_transfer_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS hashcoin_redemption_pending
  ON hashcoin_redemptions(wallet_id,created_at)
  WHERE status IN ('reserved','dispatching','unknown');

ALTER TABLE drive_share_requests ADD COLUMN IF NOT EXISTS settlement_method TEXT
  NOT NULL DEFAULT 'stripe_transfer' CHECK (settlement_method IN ('stripe_transfer','hashcoins'));
ALTER TABLE drive_request_payment_orders ADD COLUMN IF NOT EXISTS settlement_method TEXT
  NOT NULL DEFAULT 'stripe_transfer' CHECK (settlement_method IN ('stripe_transfer','hashcoins'));
ALTER TABLE drive_request_payment_obligations ADD COLUMN IF NOT EXISTS settlement_method TEXT
  NOT NULL DEFAULT 'stripe_transfer' CHECK (settlement_method IN ('stripe_transfer','hashcoins'));
ALTER TABLE drive_request_owner_payouts ADD COLUMN IF NOT EXISTS settlement_method TEXT
  NOT NULL DEFAULT 'stripe_transfer' CHECK (settlement_method IN ('stripe_transfer','hashcoins'));
ALTER TABLE drive_request_owner_payouts ADD COLUMN IF NOT EXISTS wallet_id UUID
  REFERENCES hashcoin_wallets(wallet_id);
ALTER TABLE drive_request_owner_payouts ADD COLUMN IF NOT EXISTS sandbox_wallet_id UUID
  REFERENCES hashcoin_wallets(wallet_id);
ALTER TABLE drive_request_owner_payouts ADD COLUMN IF NOT EXISTS credited_at TIMESTAMPTZ;
ALTER TABLE drive_request_owner_payouts DROP CONSTRAINT IF EXISTS drive_request_owner_payouts_status_check;
ALTER TABLE drive_request_owner_payouts ADD CONSTRAINT drive_request_owner_payouts_status_check
  CHECK (status IN ('awaiting_delivery','awaiting_refund','awaiting_fee','awaiting_account','due',
    'dispatching','unknown','manual_review','transferred','reversal_due','reversal_unknown',
    'reversed','void','hashcoins_credited','hashcoins_held','hashcoins_reversed'));

CREATE OR REPLACE FUNCTION bind_drive_settlement_method()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_method TEXT;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.settlement_method<>OLD.settlement_method THEN
      RAISE EXCEPTION 'Settlement method is immutable';
    END IF;
  ELSIF TG_TABLE_NAME='drive_request_payment_orders' THEN
    SELECT settlement_method INTO source_method FROM drive_share_requests
      WHERE request_id=NEW.request_id;
    IF source_method IS NOT NULL AND NEW.settlement_method<>source_method THEN
      RAISE EXCEPTION 'Request settlement mismatch';
    END IF;
  ELSIF TG_TABLE_NAME IN ('drive_request_payment_obligations','drive_request_owner_payouts') THEN
    SELECT settlement_method INTO source_method FROM drive_request_payment_orders
      WHERE request_id=NEW.request_id;
    IF source_method IS NOT NULL THEN NEW.settlement_method := source_method; END IF;
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE table_name TEXT; BEGIN
  FOREACH table_name IN ARRAY ARRAY['drive_share_requests','drive_request_payment_orders',
    'drive_request_payment_obligations','drive_request_owner_payouts'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='drive_settlement_method_binding'
      AND tgrelid=table_name::regclass) THEN
      EXECUTE format('CREATE TRIGGER drive_settlement_method_binding BEFORE INSERT OR UPDATE ON %I
        FOR EACH ROW EXECUTE FUNCTION bind_drive_settlement_method()',table_name);
    END IF;
  END LOOP;
END $$;

-- This also fences old worker binaries during promotion and rollback.
CREATE OR REPLACE FUNCTION guard_hashcoin_direct_transfer()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.settlement_method='hashcoins' AND (
    NEW.status IN ('due','awaiting_account','dispatching','unknown','transferred',
      'reversal_due','reversal_unknown','reversed') OR
    NEW.stripe_transfer_id IS NOT NULL OR NEW.transfer_attempt_id IS NOT NULL OR
    NEW.stripe_reversal_id IS NOT NULL OR NEW.reversal_attempt_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Hashcoin earnings cannot transfer directly';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.wallet_id IS DISTINCT FROM OLD.wallet_id OR
      NEW.sandbox_wallet_id IS DISTINCT FROM OLD.sandbox_wallet_id) THEN
    RAISE EXCEPTION 'Earning wallet is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hashcoin_direct_transfer_guard ON drive_request_owner_payouts;
CREATE TRIGGER hashcoin_direct_transfer_guard BEFORE INSERT OR UPDATE
  ON drive_request_owner_payouts FOR EACH ROW EXECUTE FUNCTION guard_hashcoin_direct_transfer();
CREATE OR REPLACE FUNCTION reject_hashcoin_ledger_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Hashcoin entries are append-only';
END $$;
DROP TRIGGER IF EXISTS hashcoin_ledger_immutable ON hashcoin_ledger_entries;
CREATE TRIGGER hashcoin_ledger_immutable BEFORE UPDATE OR DELETE ON hashcoin_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_hashcoin_ledger_mutation();

CREATE OR REPLACE FUNCTION guard_hashcoin_redemption()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wallet_mode TEXT;
BEGIN
  SELECT stripe_mode INTO wallet_mode FROM hashcoin_wallets WHERE wallet_id=NEW.wallet_id;
  IF wallet_mode IS DISTINCT FROM 'test' OR NEW.stripe_mode<>'test' THEN
    RAISE EXCEPTION 'Sandbox redemption cannot spend live earnings';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.wallet_id IS DISTINCT FROM OLD.wallet_id OR
      NEW.request_key<>OLD.request_key OR NEW.amount_coins<>OLD.amount_coins OR
      NEW.stripe_mode<>OLD.stripe_mode OR
      NEW.destination_account_id<>OLD.destination_account_id) THEN
    RAISE EXCEPTION 'Redemption intent is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hashcoin_redemption_guard ON hashcoin_redemptions;
CREATE TRIGGER hashcoin_redemption_guard BEFORE INSERT OR UPDATE ON hashcoin_redemptions
  FOR EACH ROW EXECUTE FUNCTION guard_hashcoin_redemption();

-- Financial liabilities outlive identity erasure; the wallet is no longer usable.
CREATE OR REPLACE FUNCTION detach_hashcoin_wallet_owner()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  UPDATE hashcoin_wallets SET user_id=NULL,held=TRUE,erased_at=clock_timestamp()
    WHERE user_id=OLD.user_id;
  RETURN OLD;
END $$;
DO $$ BEGIN
  IF to_regclass('actor_profiles') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname='hashcoin_owner_erasure'
      AND tgrelid=to_regclass('actor_profiles')) THEN
    CREATE TRIGGER hashcoin_owner_erasure BEFORE DELETE ON actor_profiles
      FOR EACH ROW EXECUTE FUNCTION detach_hashcoin_wallet_owner();
  END IF;
END $$;
-- The existing retention trigger must preserve a credited liability's state.
DO $$ DECLARE body TEXT; BEGIN
  IF to_regprocedure('preserve_drive_request_owner_payout()') IS NOT NULL THEN
    SELECT pg_get_functiondef('preserve_drive_request_owner_payout()'::regprocedure) INTO body;
    IF strpos(body,'hashcoins_credited')=0 THEN
      body := replace(body, '''transferred'',''reversal_due''',
        '''hashcoins_credited'',''hashcoins_held'',''hashcoins_reversed'',''transferred'',''reversal_due''');
      EXECUTE body;
    END IF;
  END IF;
END $$;

DO $$ DECLARE table_name TEXT; DECLARE role_name TEXT; BEGIN
  FOREACH table_name IN ARRAY ARRAY['hashcoin_wallets','hashcoin_ledger_entries','hashcoin_redemptions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
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
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    REVOKE UPDATE,DELETE ON hashcoin_ledger_entries FROM service_role;
  END IF;
END $$;
DO $$ BEGIN
  IF to_regprocedure('install_account_deletion_write_guards()') IS NOT NULL THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;
COMMENT ON TABLE hashcoin_wallets IS 'Mode-isolated owner earnings wallets; one coin equals one USD cent. Identity detached on erasure.';
COMMENT ON TABLE hashcoin_ledger_entries IS 'Append-only integer earnings and reversal obligations. Sandbox demonstrations never spend live earnings.';
COMMENT ON TABLE hashcoin_redemptions IS 'Test-only payout reservations; source balance and provider destination are immutable.';
COMMIT;
