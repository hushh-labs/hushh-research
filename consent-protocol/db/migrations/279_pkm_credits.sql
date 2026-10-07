-- Credits: buyers subscribe to a monthly plan and spend credits on packets.
--
-- pkm_credit_subscriptions: one row per subscriber (plan, Stripe ids, status).
-- pkm_credit_ledger: every grant, expiry, spend and refund. Balance = SUM(delta).
-- Each row is unique on (user_id, reason, ref) so a replayed Stripe event or a
-- retried refund cannot double-grant or double-credit.
--
-- Grants and spends go through pkm_grant_credits / pkm_spend_credits, which take
-- a per-user transaction advisory lock: two purchases at once cannot spend the
-- same credits, and a grant expires the unused balance before adding the new
-- month's credits ("credits refill monthly; unused credits expire").
--
-- Orders gain payment_method ('card' | 'credits') and credits_spent. A credits
-- order is refunded in credits, not money.
--
-- pkm_credit_subscription_cancellations holds only a Stripe subscription id: on
-- account deletion the subscriber row moves here (no identity), and the work
-- drain cancels it at Stripe so a deleted person is never billed again.
--
-- Replay-safe: every statement is guarded.

BEGIN;

CREATE TABLE IF NOT EXISTS pkm_credit_subscriptions (
  user_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL CHECK (plan IN ('starter', 'professional', 'enterprise')),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'incomplete'
    CHECK (status IN ('incomplete', 'active', 'past_due', 'canceled')),
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pkm_credit_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  delta INTEGER NOT NULL CHECK (delta <> 0 AND delta BETWEEN -100000 AND 100000),
  reason TEXT NOT NULL CHECK (reason IN ('grant', 'expire', 'spend', 'refund')),
  ref TEXT NOT NULL CHECK (char_length(ref) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pkm_credit_ledger_once UNIQUE (user_id, reason, ref)
);

CREATE TABLE IF NOT EXISTS pkm_credit_subscription_cancellations (
  stripe_subscription_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE pkm_packet_orders
  ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'card';
ALTER TABLE pkm_packet_orders
  ADD COLUMN IF NOT EXISTS credits_spent INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pkm_packet_orders_payment_method'
  ) THEN
    ALTER TABLE pkm_packet_orders ADD CONSTRAINT pkm_packet_orders_payment_method CHECK (
      (payment_method = 'card' AND credits_spent IS NULL)
      OR (payment_method = 'credits' AND credits_spent BETWEEN 1 AND 1000)
    );
  END IF;
  IF to_regclass('public.idx_pkm_credit_ledger_user') IS NULL THEN
    CREATE INDEX idx_pkm_credit_ledger_user ON pkm_credit_ledger (user_id, created_at);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE oid = 'public.pkm_credit_subscriptions'::regclass AND relrowsecurity
  ) THEN
    ALTER TABLE pkm_credit_subscriptions ENABLE ROW LEVEL SECURITY;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE oid = 'public.pkm_credit_ledger'::regclass AND relrowsecurity
  ) THEN
    ALTER TABLE pkm_credit_ledger ENABLE ROW LEVEL SECURITY;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.pkm_credit_subscription_cancellations'::regclass AND relrowsecurity
  ) THEN
    ALTER TABLE pkm_credit_subscription_cancellations ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

-- Grant a period's credits once per Stripe invoice, expiring what was left.
CREATE OR REPLACE FUNCTION pkm_grant_credits(p_user TEXT, p_credits INTEGER, p_ref TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_balance INTEGER;
BEGIN
  IF p_credits IS NULL OR p_credits < 1 THEN
    RAISE EXCEPTION 'pkm_grant_credits: credits must be positive';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pkm_credits:' || p_user, 0));
  IF EXISTS (
    SELECT 1 FROM pkm_credit_ledger WHERE user_id = p_user AND reason = 'grant' AND ref = p_ref
  ) THEN
    RETURN FALSE;
  END IF;
  SELECT COALESCE(SUM(delta), 0) INTO v_balance FROM pkm_credit_ledger WHERE user_id = p_user;
  IF v_balance > 0 THEN
    INSERT INTO pkm_credit_ledger (user_id, delta, reason, ref)
    VALUES (p_user, -v_balance, 'expire', p_ref);
  END IF;
  INSERT INTO pkm_credit_ledger (user_id, delta, reason, ref)
  VALUES (p_user, p_credits, 'grant', p_ref);
  RETURN TRUE;
END $$;

-- Spend credits for one order if the balance covers it. FALSE = not enough.
CREATE OR REPLACE FUNCTION pkm_spend_credits(p_user TEXT, p_cost INTEGER, p_ref TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_balance INTEGER;
BEGIN
  IF p_cost IS NULL OR p_cost < 1 THEN
    RAISE EXCEPTION 'pkm_spend_credits: cost must be positive';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pkm_credits:' || p_user, 0));
  IF EXISTS (
    SELECT 1 FROM pkm_credit_ledger WHERE user_id = p_user AND reason = 'spend' AND ref = p_ref
  ) THEN
    RETURN TRUE;
  END IF;
  SELECT COALESCE(SUM(delta), 0) INTO v_balance FROM pkm_credit_ledger WHERE user_id = p_user;
  IF v_balance < p_cost THEN
    RETURN FALSE;
  END IF;
  INSERT INTO pkm_credit_ledger (user_id, delta, reason, ref)
  VALUES (p_user, -p_cost, 'spend', p_ref);
  RETURN TRUE;
END $$;

REVOKE ALL ON pkm_credit_subscriptions FROM PUBLIC;
REVOKE ALL ON pkm_credit_ledger FROM PUBLIC;
REVOKE ALL ON pkm_credit_subscription_cancellations FROM PUBLIC;
REVOKE ALL ON FUNCTION pkm_grant_credits(TEXT, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION pkm_spend_credits(TEXT, INTEGER, TEXT) FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON pkm_credit_subscriptions FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON pkm_credit_ledger FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON pkm_credit_subscription_cancellations FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON pkm_credit_subscriptions TO service_role;
    GRANT SELECT, INSERT, DELETE ON pkm_credit_ledger TO service_role;
    GRANT SELECT, INSERT, DELETE ON pkm_credit_subscription_cancellations TO service_role;
    GRANT EXECUTE ON FUNCTION pkm_grant_credits(TEXT, INTEGER, TEXT) TO service_role;
    GRANT EXECUTE ON FUNCTION pkm_spend_credits(TEXT, INTEGER, TEXT) TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;

COMMENT ON TABLE pkm_credit_ledger IS
  'Append-only credits ledger (grant, expire, spend, refund). Balance = SUM(delta). Unique per (user_id, reason, ref) for idempotency. Deleted with the account.';
COMMENT ON TABLE pkm_credit_subscriptions IS
  'One monthly credits plan per subscriber. On account deletion the Stripe subscription id moves to pkm_credit_subscription_cancellations and is cancelled by the work drain.';

COMMIT;
