-- Durable refunds and owner payouts for the paid-answer lane.
--
-- Until now a refund was a best-effort call inside the request transaction: a
-- Stripe outage lost it, and the requester's money stayed taken. These tables
-- make the obligation durable, exactly as the Drive lane does
-- (drive_request_payment_refunds in migration 262, drive_request_owner_payouts
-- in 292): a row is claimed under a lease, retried on its own schedule, and
-- only a terminal state stops it.
--
-- Both tables key on pkm_answer_payment_obligations rather than on the order,
-- so a refund or a transfer can still settle after the request and both
-- accounts are erased. Neither holds a user id, the question, or any answer.
--
-- Commission matches the Drive lane at 300 bps. The owner earns
-- gross - commission - allocated processing fee, and earns nothing until the
-- answer is actually delivered with content.
--
-- Replay-safe: every statement is guarded.

BEGIN;

-- ----------------------------------------------------------------- refunds --

CREATE TABLE IF NOT EXISTS pkm_answer_payment_refunds (
  request_id UUID PRIMARY KEY REFERENCES pkm_answer_payment_obligations(request_id),
  attempt_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  reason TEXT NOT NULL CHECK (reason IN (
    'owner_declined', 'requester_cancelled', 'answer_timeout', 'empty_answer',
    'account_erased')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'dispatching', 'unknown', 'pending', 'manual_review',
    'succeeded', 'failed')),
  stripe_refund_id TEXT UNIQUE,
  first_dispatch_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  next_check_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- Closed set: a provider message is never copied into the database.
  safe_error_code TEXT CHECK (safe_error_code IS NULL OR safe_error_code IN (
    'provider_unavailable', 'provider_rejected', 'provider_mismatch',
    'idempotency_window_elapsed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (status = 'queued' OR first_dispatch_at IS NOT NULL)
);

DO $$
BEGIN
  -- The drain claims due work with this partial index.
  IF to_regclass('public.idx_pkm_answer_refunds_due') IS NULL THEN
    CREATE INDEX idx_pkm_answer_refunds_due
      ON pkm_answer_payment_refunds (next_check_at)
      WHERE status IN ('queued', 'dispatching', 'unknown', 'pending');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.pkm_answer_payment_refunds'::regclass AND relrowsecurity
  ) THEN
    ALTER TABLE pkm_answer_payment_refunds ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

-- ----------------------------------------------------------------- payouts --

CREATE TABLE IF NOT EXISTS pkm_answer_owner_payouts (
  request_id UUID PRIMARY KEY REFERENCES pkm_answer_payment_obligations(request_id),
  gross_amount_cents INTEGER NOT NULL CHECK (
    gross_amount_cents BETWEEN 100 AND 50000),
  currency TEXT NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  commission_bps SMALLINT NOT NULL DEFAULT 300 CHECK (commission_bps = 300),
  status TEXT NOT NULL DEFAULT 'awaiting_delivery' CHECK (status IN (
    'awaiting_delivery', 'awaiting_account', 'due', 'dispatching', 'unknown',
    'manual_review', 'transferred', 'void')),
  platform_fee_cents INTEGER CHECK (platform_fee_cents IS NULL OR platform_fee_cents >= 0),
  owner_earning_cents INTEGER CHECK (owner_earning_cents IS NULL OR owner_earning_cents >= 0),
  destination_account_id TEXT,
  stripe_transfer_id TEXT UNIQUE,
  transfer_attempt_id UUID UNIQUE DEFAULT gen_random_uuid(),
  lease_expires_at TIMESTAMPTZ,
  next_check_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  safe_error_code TEXT CHECK (safe_error_code IS NULL OR safe_error_code IN (
    'provider_unavailable', 'provider_rejected', 'account_not_ready')),
  finalized_at TIMESTAMPTZ,
  transferred_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'transferred') = (transferred_at IS NOT NULL)),
  -- An earning is only computed once the delivery that justifies it exists.
  CHECK (status IN ('awaiting_delivery', 'void') OR owner_earning_cents IS NOT NULL)
);

DO $$
BEGIN
  IF to_regclass('public.idx_pkm_answer_payouts_due') IS NULL THEN
    CREATE INDEX idx_pkm_answer_payouts_due
      ON pkm_answer_owner_payouts (next_check_at)
      WHERE status IN ('due', 'dispatching', 'unknown', 'awaiting_account');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.pkm_answer_owner_payouts'::regclass AND relrowsecurity
  ) THEN
    ALTER TABLE pkm_answer_owner_payouts ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

-- --------------------------------------------------------------- privilege --

DO $$ DECLARE t TEXT; role_name TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['pkm_answer_payment_refunds', 'pkm_answer_owner_payouts'] LOOP
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, role_name);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO service_role', t);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;

COMMENT ON TABLE pkm_answer_payment_refunds IS
  'Durable refund obligation for one paid answer. Retried under a lease; survives erasure. No user id, question or answer.';
COMMENT ON TABLE pkm_answer_owner_payouts IS
  'Owner earning for one delivered answer, 300 bps commission. Nothing is due until delivery with content.';

COMMIT;
