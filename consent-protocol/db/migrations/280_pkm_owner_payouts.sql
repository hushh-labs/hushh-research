-- Owner payouts: hussh pays packet owners their earnings through Stripe Connect.
--
-- pkm_owner_payout_accounts maps an owner to their Stripe Express account and
-- whether Stripe has enabled payouts on it. Each order gains an owner earning
-- lifecycle: 'none' until the packet is delivered, then 'due', then
-- 'transferred' once hussh sends amount_cents - platform_fee_cents to the
-- owner's account ('void' if it can never be paid). A delivered order is not
-- refunded: the buyer has the data.
--
-- Replay-safe: every statement is guarded.

BEGIN;

CREATE TABLE IF NOT EXISTS pkm_owner_payout_accounts (
  user_id TEXT PRIMARY KEY,
  stripe_account_id TEXT NOT NULL UNIQUE,
  details_submitted BOOLEAN NOT NULL DEFAULT FALSE,
  payouts_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE pkm_packet_orders
  ADD COLUMN IF NOT EXISTS owner_earning_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE pkm_packet_orders ADD COLUMN IF NOT EXISTS stripe_transfer_id TEXT;
ALTER TABLE pkm_packet_orders ADD COLUMN IF NOT EXISTS transferred_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pkm_packet_orders_owner_earning_status'
  ) THEN
    ALTER TABLE pkm_packet_orders ADD CONSTRAINT pkm_packet_orders_owner_earning_status
      CHECK (owner_earning_status IN ('none', 'due', 'transferred', 'void'));
  END IF;
  IF to_regclass('public.idx_pkm_packet_orders_earning_due') IS NULL THEN
    CREATE INDEX idx_pkm_packet_orders_earning_due
      ON pkm_packet_orders (owner_user_id) WHERE owner_earning_status = 'due';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE oid = 'public.pkm_owner_payout_accounts'::regclass AND relrowsecurity
  ) THEN
    ALTER TABLE pkm_owner_payout_accounts ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

REVOKE ALL ON pkm_owner_payout_accounts FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON pkm_owner_payout_accounts FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON pkm_owner_payout_accounts TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;

COMMENT ON TABLE pkm_owner_payout_accounts IS
  'Packet owner -> Stripe Connect Express account and payout readiness. Deleted with the account.';

COMMIT;
