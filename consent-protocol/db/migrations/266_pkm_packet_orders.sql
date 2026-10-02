-- PKM packet orders: a buyer pays hussh for one packet; the owner still decides.
--
-- hussh is the broker. The buyer pays hussh's Stripe account (Checkout). Payment
-- files a marketplace access request (access_request_id); the owner approves or
-- denies it exactly like any other request. A denied or expired request is
-- refunded in full. platform_fee_cents is hussh's share, 0 today; the owner's
-- earning is amount_cents - platform_fee_cents, paid out in a later step.
--
-- packet_title and amount are snapshots: the owner can edit or delete the
-- packet without rewriting what the buyer paid for. Rows reference both people
-- (buyer_user_id, owner_user_id): account deletion removes them.
--
-- Replay-safe: every statement is guarded.

BEGIN;

CREATE TABLE IF NOT EXISTS pkm_packet_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_user_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  packet_id UUID NOT NULL,
  listing_id TEXT NOT NULL CHECK (listing_id ~ '^[a-z0-9][a-z0-9:-]{0,127}$'),
  packet_title TEXT NOT NULL CHECK (char_length(packet_title) BETWEEN 1 AND 80),
  amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 50 AND 10000000),
  platform_fee_cents INTEGER NOT NULL DEFAULT 0
    CHECK (platform_fee_cents >= 0 AND platform_fee_cents <= amount_cents),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  status TEXT NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN (
    'awaiting_payment', 'paid', 'refund_pending', 'refunded', 'expired'
  )),
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT,
  stripe_refund_id TEXT,
  access_request_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  CONSTRAINT pkm_packet_orders_not_self CHECK (buyer_user_id <> owner_user_id)
);

DO $$
BEGIN
  -- One unpaid checkout per buyer and packet at a time.
  IF to_regclass('public.uq_pkm_packet_orders_open_checkout') IS NULL THEN
    CREATE UNIQUE INDEX uq_pkm_packet_orders_open_checkout
      ON pkm_packet_orders (buyer_user_id, packet_id) WHERE status = 'awaiting_payment';
  END IF;
  IF to_regclass('public.idx_pkm_packet_orders_buyer') IS NULL THEN
    CREATE INDEX idx_pkm_packet_orders_buyer ON pkm_packet_orders (buyer_user_id, created_at DESC);
  END IF;
  IF to_regclass('public.idx_pkm_packet_orders_owner') IS NULL THEN
    CREATE INDEX idx_pkm_packet_orders_owner ON pkm_packet_orders (owner_user_id, status);
  END IF;
  IF to_regclass('public.idx_pkm_packet_orders_request') IS NULL THEN
    CREATE INDEX idx_pkm_packet_orders_request ON pkm_packet_orders (access_request_id)
      WHERE access_request_id IS NOT NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE oid = 'public.pkm_packet_orders'::regclass AND relrowsecurity
  ) THEN
    ALTER TABLE pkm_packet_orders ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

REVOKE ALL ON pkm_packet_orders FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON pkm_packet_orders FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON pkm_packet_orders TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;

COMMENT ON TABLE pkm_packet_orders IS
  'Buyer payments to hussh for one PKM packet. Paid orders file an owner-approved marketplace request; denied or expired requests are refunded. platform_fee_cents is hussh''s share (0 today).';

COMMIT;
