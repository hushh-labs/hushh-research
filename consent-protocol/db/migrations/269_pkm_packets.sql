-- PKM packets: an owner's bundles of their own PKM details, priced for sale.
--
-- A packet is a named group of PKM scopes ("Bank statements", "Lifestyle", or a
-- custom one) with an owner-set dollar price and credit cost. Contents are
-- references only ({domain, scopeHandle, label}): the values stay in the
-- encrypted PKM and move to a buyer only through an approved marketplace request
-- sealed to the buyer's key. This table never holds a PKM value.
--
-- A packet is listed for sale only when it has contents, a price and a credit
-- cost. Ten standard kinds exist once per owner; custom packets are unlimited.
-- Rows are user-owned (owner_user_id): removed on account reset and deletion.
--
-- Replay-safe: every statement is guarded.

BEGIN;

CREATE TABLE IF NOT EXISTS pkm_packets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id TEXT NOT NULL,
  packet_kind TEXT NOT NULL CHECK (packet_kind IN (
    'net_worth_scorecard', 'bank_statements', 'brokerage_statements', 'tax_documents',
    'insurance', 'will_trust', 'business_documents', 'lifestyle', 'full_financial',
    'complete_supermodel', 'custom'
  )),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  description TEXT CHECK (description IS NULL OR char_length(description) <= 280),
  contents JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(contents) = 'array'),
  price_cents INTEGER CHECK (price_cents IS NULL OR price_cents BETWEEN 50 AND 10000000),
  credit_cost INTEGER CHECK (credit_cost IS NULL OR credit_cost BETWEEN 1 AND 1000),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  for_sale BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pkm_packets_sale_ready CHECK (
    NOT for_sale
    OR (price_cents IS NOT NULL AND credit_cost IS NOT NULL AND jsonb_array_length(contents) > 0)
  )
);

DO $$
BEGIN
  IF to_regclass('public.idx_pkm_packets_owner') IS NULL THEN
    CREATE INDEX idx_pkm_packets_owner ON pkm_packets (owner_user_id, created_at);
  END IF;
  -- One of each standard kind per owner; custom packets are unlimited.
  IF to_regclass('public.uq_pkm_packets_owner_standard_kind') IS NULL THEN
    CREATE UNIQUE INDEX uq_pkm_packets_owner_standard_kind
      ON pkm_packets (owner_user_id, packet_kind) WHERE packet_kind <> 'custom';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE oid = 'public.pkm_packets'::regclass AND relrowsecurity
  ) THEN
    ALTER TABLE pkm_packets ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

REVOKE ALL ON pkm_packets FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON pkm_packets FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON pkm_packets TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;

COMMENT ON TABLE pkm_packets IS
  'Owner-defined, priced bundles of PKM scope references (never values). Listed for sale only with contents, price_cents and credit_cost. Deleted on account reset and deletion.';

COMMIT;
