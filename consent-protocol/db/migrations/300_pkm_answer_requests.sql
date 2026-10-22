-- Paid answers: one person asks another's private agent a question, the owner
-- approves the exact question, scopes and price, and the answer is produced on
-- the owner's device and delivered sealed to the requester.
--
-- This is a SIBLING of the Drive document lane (migration 262), not a
-- replacement and not a reuse of its tables: `drive_request_payment_orders`
-- keys on `drive_share_requests(request_id)` and cannot host a question.
-- Drive behaviour is untouched here.
--
-- Settlement binding. `terms_digest` is a SHA-256 over the canonical question,
-- the sorted approved scopes, both participants and the quoted amount. The
-- owner's approval fixes it and the order copies it. A payment therefore
-- authorizes exactly one question at exactly one price over exactly one scope
-- set between exactly those two people; re-opening the question, re-pricing it
-- or widening the scopes produces a different digest and the old payment
-- cannot settle against it.
--
-- Webhook dedupe is per-lane (`pkm_answer_payment_webhook_events`) because
-- migration 262's table has a foreign key to its own obligations row. A split
-- is safe here only because the single Stripe endpoint routes deterministically
-- on `metadata.payment_kind`: an event carrying 'pkm_answer' is never offered
-- to the Drive handler and vice versa, so one event id can never need two rows.
--
-- The answer itself is ciphertext sealed to the requester's key. The server
-- never holds the plaintext answer and never holds a key that could read it.
--
-- Replay-safe: every statement is guarded.

BEGIN;

-- ---------------------------------------------------------------- requests --

CREATE TABLE IF NOT EXISTS pkm_answer_requests (
  request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id TEXT NOT NULL,
  requester_user_id TEXT NOT NULL,
  -- The requester's question, as they wrote it. Visible to the owner, who
  -- approves this exact text. Never a PKM value.
  question TEXT NOT NULL CHECK (char_length(question) BETWEEN 8 AND 2000),
  -- Optional reporting period. Required by the client when the resolved scopes
  -- are period-bearing; the database only enforces ordering when both are set.
  period_start DATE,
  period_end DATE,
  status TEXT NOT NULL DEFAULT 'pending_resolution' CHECK (status IN (
    'pending_resolution', 'awaiting_owner', 'approved', 'declined',
    'answering', 'answered', 'expired', 'cancelled'
  )),
  -- Set by the owner at approval, same bounds and whole-dollar rule as the
  -- Drive lane (see drive_owner_allowed.py).
  amount_cents INTEGER CHECK (amount_cents IS NULL OR
    (amount_cents BETWEEN 100 AND 50000 AND amount_cents % 100 = 0)),
  currency TEXT NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  terms_digest TEXT CHECK (terms_digest IS NULL OR terms_digest ~ '^[0-9a-f]{64}$'),
  -- How the question became a scope set. 'agent' is the required semantic
  -- stage; 'skipped' records that the stage did not run, so a missing
  -- intelligence is visible instead of indistinguishable from a real answer.
  resolution_mode TEXT CHECK (resolution_mode IS NULL OR
    resolution_mode IN ('agent', 'skipped')),
  resolution_skipped_reason TEXT,
  approved_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,
  -- Set when payment settles; the fulfilment deadline quoted before checkout.
  answer_deadline_at TIMESTAMPTZ,
  answered_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + INTERVAL '30 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pkm_answer_requests_not_self CHECK (owner_user_id <> requester_user_id),
  CONSTRAINT pkm_answer_requests_period_order CHECK (
    period_start IS NULL OR period_end IS NULL OR period_start <= period_end),
  -- An approved request carries its full priced terms or it is not approved.
  CONSTRAINT pkm_answer_requests_approved_terms CHECK (
    status NOT IN ('approved', 'answering', 'answered')
    OR (amount_cents IS NOT NULL AND terms_digest IS NOT NULL AND approved_at IS NOT NULL)),
  CONSTRAINT pkm_answer_requests_answered_at CHECK ((status = 'answered') = (answered_at IS NOT NULL)),
  -- A skipped semantic stage must say why; an agent resolution must not.
  CONSTRAINT pkm_answer_requests_skip_reason CHECK (
    (resolution_mode = 'skipped') = (resolution_skipped_reason IS NOT NULL))
);

DO $$
BEGIN
  IF to_regclass('public.idx_pkm_answer_requests_owner') IS NULL THEN
    CREATE INDEX idx_pkm_answer_requests_owner
      ON pkm_answer_requests (owner_user_id, status, created_at DESC);
  END IF;
  IF to_regclass('public.idx_pkm_answer_requests_requester') IS NULL THEN
    CREATE INDEX idx_pkm_answer_requests_requester
      ON pkm_answer_requests (requester_user_id, created_at DESC);
  END IF;
  -- The owner's device sweep claims paid, undelivered work from here.
  IF to_regclass('public.idx_pkm_answer_requests_answering') IS NULL THEN
    CREATE INDEX idx_pkm_answer_requests_answering
      ON pkm_answer_requests (owner_user_id) WHERE status = 'answering';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE oid = 'public.pkm_answer_requests'::regclass AND relrowsecurity
  ) THEN
    ALTER TABLE pkm_answer_requests ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

-- ------------------------------------------------------------------ scopes --

-- The exact scopes the owner approved. Scope isolation is enforced by reading
-- the answer's inputs only through these rows: a scope absent here was never
-- paid for and must never reach the answer.
CREATE TABLE IF NOT EXISTS pkm_answer_request_scopes (
  request_id UUID NOT NULL REFERENCES pkm_answer_requests(request_id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope ~ '^attr\.[a-z0-9_]+(\.[a-z0-9_*]+)*$'),
  label TEXT,
  -- FALSE until the owner approves this individual scope, so the owner can
  -- approve a narrower set than the resolver proposed.
  approved BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (request_id, scope)
);

DO $$
BEGIN
  IF to_regclass('public.idx_pkm_answer_request_scopes_approved') IS NULL THEN
    CREATE INDEX idx_pkm_answer_request_scopes_approved
      ON pkm_answer_request_scopes (request_id) WHERE approved;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.pkm_answer_request_scopes'::regclass AND relrowsecurity
  ) THEN
    ALTER TABLE pkm_answer_request_scopes ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

-- ------------------------------------------------------------------ orders --

CREATE TABLE IF NOT EXISTS pkm_answer_payment_orders (
  request_id UUID PRIMARY KEY REFERENCES pkm_answer_requests(request_id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL,
  requester_user_id TEXT NOT NULL CHECK (requester_user_id <> owner_user_id),
  amount_cents INTEGER NOT NULL CHECK (
    amount_cents BETWEEN 100 AND 50000 AND amount_cents % 100 = 0),
  currency TEXT NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  -- Copied from the request at checkout. Settlement re-checks it, so a
  -- re-priced or re-scoped question cannot be settled by an older session.
  terms_digest TEXT NOT NULL CHECK (terms_digest ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'awaiting_payment'
    CHECK (status IN ('awaiting_payment','checkout_open','paid','refunded','expired')),
  checkout_attempt_id UUID,
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_checkout_url TEXT,
  stripe_checkout_expires_at TIMESTAMPTZ,
  stripe_payment_intent_id TEXT UNIQUE,
  stripe_refund_id TEXT,
  paid_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  refund_reason TEXT CHECK (refund_reason IS NULL OR refund_reason IN
    ('owner_declined','requester_cancelled','answer_timeout','empty_answer','account_erased')),
  reconciliation_required BOOLEAN NOT NULL DEFAULT FALSE,
  reconciliation_reason TEXT CHECK (reconciliation_reason IS NULL OR
    reconciliation_reason IN ('request_closed','authority_changed','empty_answer','account_erased')),
  reconciliation_at TIMESTAMPTZ,
  -- Owner earnings follow the packet lane (migration 280): nothing is due
  -- until the answer is actually delivered.
  owner_earning_status TEXT NOT NULL DEFAULT 'none'
    CHECK (owner_earning_status IN ('none','due','transferred','void')),
  platform_fee_cents INTEGER NOT NULL DEFAULT 0
    CHECK (platform_fee_cents >= 0 AND platform_fee_cents <= amount_cents),
  stripe_transfer_id TEXT,
  transferred_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status IN ('paid','refunded')) = (paid_at IS NOT NULL)),
  CHECK ((status = 'refunded') = (refunded_at IS NOT NULL)),
  CHECK (stripe_checkout_url IS NULL OR stripe_checkout_session_id IS NOT NULL),
  CHECK ((reconciliation_required AND reconciliation_reason IS NOT NULL
    AND reconciliation_at IS NOT NULL) OR (NOT reconciliation_required
    AND reconciliation_reason IS NULL AND reconciliation_at IS NULL))
);

DO $$
BEGIN
  IF to_regclass('public.idx_pkm_answer_payment_orders_requester') IS NULL THEN
    CREATE INDEX idx_pkm_answer_payment_orders_requester
      ON pkm_answer_payment_orders (requester_user_id, created_at DESC);
  END IF;
  IF to_regclass('public.idx_pkm_answer_payment_orders_earning_due') IS NULL THEN
    CREATE INDEX idx_pkm_answer_payment_orders_earning_due
      ON pkm_answer_payment_orders (owner_user_id) WHERE owner_earning_status = 'due';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.pkm_answer_payment_orders'::regclass AND relrowsecurity
  ) THEN
    ALTER TABLE pkm_answer_payment_orders ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

-- ------------------------------------------------------------- obligations --

-- Survives account or request erasure without a user id, the question text, or
-- any answer content. Mirrors migration 262's reasoning: the random request
-- UUID plus provider references are the minimum binding needed to settle a
-- late charge or an uncertain refund after the people are gone.
CREATE TABLE IF NOT EXISTS pkm_answer_payment_obligations (
  request_id UUID PRIMARY KEY,
  payer_ref TEXT NOT NULL CHECK (payer_ref ~ '^[0-9a-f]{64}$'),
  amount_cents INTEGER NOT NULL CHECK (
    amount_cents BETWEEN 100 AND 50000 AND amount_cents % 100 = 0),
  currency TEXT NOT NULL CHECK (currency = 'usd'),
  status TEXT NOT NULL CHECK (status IN
    ('awaiting_payment','checkout_open','paid','refunded','expired')),
  checkout_attempt_id UUID,
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT UNIQUE,
  paid_at TIMESTAMPTZ,
  reconciliation_required BOOLEAN NOT NULL DEFAULT FALSE,
  erased_at TIMESTAMPTZ,
  delivery_confirmed_at_erasure BOOLEAN NOT NULL DEFAULT FALSE,
  delivery_unsettled_at_erasure BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status IN ('paid','refunded')) = (paid_at IS NOT NULL))
);

CREATE OR REPLACE FUNCTION mirror_pkm_answer_payment_obligation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO pkm_answer_payment_obligations (
    request_id, payer_ref, amount_cents, currency, status, checkout_attempt_id,
    stripe_checkout_session_id, stripe_payment_intent_id, paid_at,
    reconciliation_required, updated_at
  ) VALUES (
    NEW.request_id,
    encode(digest(NEW.request_id::text || ':' || NEW.requester_user_id, 'sha256'), 'hex'),
    NEW.amount_cents, NEW.currency, NEW.status, NEW.checkout_attempt_id,
    NEW.stripe_checkout_session_id, NEW.stripe_payment_intent_id, NEW.paid_at,
    NEW.reconciliation_required, clock_timestamp()
  )
  ON CONFLICT (request_id) DO UPDATE SET
    amount_cents = EXCLUDED.amount_cents,
    status = EXCLUDED.status,
    checkout_attempt_id = EXCLUDED.checkout_attempt_id,
    stripe_checkout_session_id = EXCLUDED.stripe_checkout_session_id,
    stripe_payment_intent_id = EXCLUDED.stripe_payment_intent_id,
    paid_at = EXCLUDED.paid_at,
    reconciliation_required = EXCLUDED.reconciliation_required,
    updated_at = clock_timestamp();
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'mirror_pkm_answer_payment_obligation_trg'
  ) THEN
    CREATE TRIGGER mirror_pkm_answer_payment_obligation_trg
      AFTER INSERT OR UPDATE ON pkm_answer_payment_orders
      FOR EACH ROW EXECUTE FUNCTION mirror_pkm_answer_payment_obligation();
  END IF;
END $$;

-- --------------------------------------------------------- webhook dedupe --

CREATE TABLE IF NOT EXISTS pkm_answer_payment_webhook_events (
  stripe_event_id TEXT PRIMARY KEY,
  stripe_checkout_session_id TEXT NOT NULL,
  request_id UUID NOT NULL REFERENCES pkm_answer_payment_obligations(request_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- -------------------------------------------------------------- deliveries --

-- The sealed answer. Ciphertext only: the owner's device produces the answer
-- and seals it to the requester's ECDH recipient key, exactly as the
-- marketplace delivery sweep does. The server is a blind relay.
CREATE TABLE IF NOT EXISTS pkm_answer_deliveries (
  request_id UUID PRIMARY KEY REFERENCES pkm_answer_requests(request_id) ON DELETE CASCADE,
  recipient_key_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  sender_ephemeral_public_key_jwk JSONB NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'ECDH-P256-AES256-GCM'
    CHECK (algorithm = 'ECDH-P256-AES256-GCM'),
  -- Which memory revisions the answer was built from, so the requester can see
  -- how current it was. Revision numbers only, never values.
  source_revisions JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(source_revisions) = 'object'),
  -- FALSE when the approved scopes yielded nothing; drives the empty-answer refund.
  has_content BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE oid = 'public.pkm_answer_deliveries'::regclass AND relrowsecurity
  ) THEN
    ALTER TABLE pkm_answer_deliveries ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

-- --------------------------------------------------------------- privilege --

DO $$ DECLARE t TEXT; role_name TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pkm_answer_requests', 'pkm_answer_request_scopes', 'pkm_answer_payment_orders',
    'pkm_answer_payment_obligations', 'pkm_answer_payment_webhook_events',
    'pkm_answer_deliveries'
  ] LOOP
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

COMMENT ON TABLE pkm_answer_requests IS
  'A question one connection asks another''s private agent, with the owner-approved scopes and price. No PKM value.';
COMMENT ON TABLE pkm_answer_request_scopes IS
  'Exactly the scopes the owner approved for one question. A scope absent here was never paid for.';
COMMENT ON TABLE pkm_answer_payment_orders IS
  'Stripe order for one paid answer. Sibling of drive_request_payment_orders; terms_digest binds question, scopes, participants and quote.';
COMMENT ON TABLE pkm_answer_payment_obligations IS
  'Identity-free mirror so a late charge or refund can settle after erasure.';
COMMENT ON TABLE pkm_answer_deliveries IS
  'The answer, sealed to the requester''s key. Server is a blind relay and holds no key that can read it.';

COMMIT;
