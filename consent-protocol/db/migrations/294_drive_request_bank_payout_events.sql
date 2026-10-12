-- Stripe Connect bank payouts are account-level deposits. They may contain
-- earnings from several document requests, so no request_id belongs here.
-- The existing owner -> Connect account mapping is the read-authorization key.
BEGIN;

CREATE TABLE IF NOT EXISTS stripe_connect_bank_payouts (
  stripe_payout_id TEXT PRIMARY KEY,
  stripe_account_id TEXT NOT NULL,
  livemode BOOLEAN NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  status TEXT NOT NULL CHECK (status IN
    ('pending','in_transit','paid','canceled','failed')),
  status_rank SMALLINT NOT NULL CHECK (status_rank BETWEEN 0 AND 4),
  expected_arrival_at TIMESTAMPTZ,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (status_rank = CASE status
    WHEN 'pending' THEN 0 WHEN 'in_transit' THEN 1 WHEN 'paid' THEN 2
    WHEN 'canceled' THEN 3 ELSE 4 END)
);

CREATE INDEX IF NOT EXISTS stripe_connect_bank_payouts_owner_recent
  ON stripe_connect_bank_payouts
  (stripe_account_id,livemode,created_at DESC,stripe_payout_id DESC);

CREATE TABLE IF NOT EXISTS stripe_connect_bank_payout_events (
  stripe_event_id TEXT PRIMARY KEY,
  stripe_account_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN
    ('account.updated','payout.created','payout.updated','payout.paid','payout.failed')),
  stripe_object_id TEXT NOT NULL,
  livemode BOOLEAN NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS stripe_connect_bank_payout_events_account
  ON stripe_connect_bank_payout_events (stripe_account_id,processed_at DESC);

ALTER TABLE stripe_connect_bank_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_connect_bank_payout_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON stripe_connect_bank_payouts FROM PUBLIC;
REVOKE ALL ON stripe_connect_bank_payout_events FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON stripe_connect_bank_payouts TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON stripe_connect_bank_payout_events TO service_role;
  END IF;
END $$;

COMMENT ON TABLE stripe_connect_bank_payouts IS
  'Connected-account aggregate bank deposits; not a document-request payout.';
COMMENT ON TABLE stripe_connect_bank_payout_events IS
  'Signed Stripe Connect event IDs consumed once after provider reconciliation.';

COMMIT;
