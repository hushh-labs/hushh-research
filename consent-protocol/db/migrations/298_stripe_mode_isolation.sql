-- Expand-only cutover: old runtimes retain the legacy account mapping. New
-- runtimes adopt it only after authenticated provider verification in their mode.
BEGIN;
CREATE TABLE IF NOT EXISTS stripe_owner_payout_accounts (
  user_id TEXT NOT NULL,
  stripe_mode TEXT NOT NULL CHECK (stripe_mode IN ('test','live')),
  stripe_account_id TEXT NOT NULL UNIQUE,
  details_submitted BOOLEAN NOT NULL DEFAULT FALSE,
  payouts_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  account_ready BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id,stripe_mode)
);
ALTER TABLE stripe_owner_payout_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON stripe_owner_payout_accounts FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON stripe_owner_payout_accounts FROM %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON stripe_owner_payout_accounts TO service_role;
  END IF;
END $$;

ALTER TABLE drive_request_payment_orders ADD COLUMN IF NOT EXISTS stripe_mode TEXT
  NOT NULL DEFAULT 'legacy' CHECK (stripe_mode IN ('test','live','legacy'));
ALTER TABLE drive_request_payment_obligations ADD COLUMN IF NOT EXISTS stripe_mode TEXT
  NOT NULL DEFAULT 'legacy' CHECK (stripe_mode IN ('test','live','legacy'));
ALTER TABLE drive_request_owner_payouts ADD COLUMN IF NOT EXISTS stripe_mode TEXT
  NOT NULL DEFAULT 'legacy' CHECK (stripe_mode IN ('test','live','legacy'));
ALTER TABLE pkm_packet_orders ADD COLUMN IF NOT EXISTS stripe_mode TEXT
  NOT NULL DEFAULT 'legacy' CHECK (stripe_mode IN ('test','live','legacy'));

-- Old replicas can bind a Checkout after this migration but before promotion.
-- Classify that session at the write boundary and never permit retagging money.
CREATE OR REPLACE FUNCTION bind_stripe_checkout_mode()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='UPDATE' AND OLD.stripe_mode IN ('test','live')
      AND NEW.stripe_mode<>OLD.stripe_mode THEN
    RAISE EXCEPTION 'Stripe mode is immutable';
  END IF;
  IF NEW.stripe_mode='legacy' THEN
    IF left(NEW.stripe_checkout_session_id,8)='cs_live_' THEN NEW.stripe_mode := 'live';
    ELSIF left(NEW.stripe_checkout_session_id,8)='cs_test_' THEN NEW.stripe_mode := 'test';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE table_name TEXT; BEGIN
  FOREACH table_name IN ARRAY ARRAY['drive_request_payment_orders',
    'drive_request_payment_obligations','pkm_packet_orders'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='stripe_checkout_mode_binding'
      AND tgrelid=table_name::regclass) THEN
      EXECUTE format('CREATE TRIGGER stripe_checkout_mode_binding BEFORE INSERT OR UPDATE ON %I
        FOR EACH ROW EXECUTE FUNCTION bind_stripe_checkout_mode()',table_name);
    END IF;
  END LOOP;
END $$;

-- Only provider-generated Checkout prefixes prove historic mode. No environment
-- default, payout amount, or account readiness can turn unknown money into live.
UPDATE drive_request_payment_orders SET stripe_mode=CASE
  WHEN stripe_checkout_session_id LIKE 'cs\_live\_%' ESCAPE '\' THEN 'live' ELSE 'test' END
WHERE stripe_mode='legacy' AND (stripe_checkout_session_id LIKE 'cs\_live\_%' ESCAPE '\'
  OR stripe_checkout_session_id LIKE 'cs\_test\_%' ESCAPE '\');
UPDATE drive_request_payment_obligations SET stripe_mode=CASE
  WHEN stripe_checkout_session_id LIKE 'cs\_live\_%' ESCAPE '\' THEN 'live' ELSE 'test' END
WHERE stripe_mode='legacy' AND (stripe_checkout_session_id LIKE 'cs\_live\_%' ESCAPE '\'
  OR stripe_checkout_session_id LIKE 'cs\_test\_%' ESCAPE '\');
UPDATE drive_request_owner_payouts p SET stripe_mode=o.stripe_mode
FROM drive_request_payment_obligations o WHERE o.request_id=p.request_id
  AND p.stripe_mode='legacy' AND o.stripe_mode IN ('test','live');
UPDATE pkm_packet_orders SET stripe_mode=CASE
  WHEN stripe_checkout_session_id LIKE 'cs\_live\_%' ESCAPE '\' THEN 'live' ELSE 'test' END
WHERE stripe_mode='legacy' AND (stripe_checkout_session_id LIKE 'cs\_live\_%' ESCAPE '\'
  OR stripe_checkout_session_id LIKE 'cs\_test\_%' ESCAPE '\');

-- Keep the established obligation mirror untouched for rolling old runtimes.
-- This second, alphabetically later trigger copies only the immutable mode.
CREATE OR REPLACE FUNCTION mirror_drive_request_stripe_mode()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  UPDATE drive_request_payment_obligations SET stripe_mode=NEW.stripe_mode
    WHERE request_id=NEW.request_id AND stripe_mode='legacy'
      AND NEW.stripe_mode IN ('test','live');
  UPDATE drive_request_owner_payouts p SET stripe_mode=o.stripe_mode
    FROM drive_request_payment_obligations o WHERE o.request_id=NEW.request_id
      AND p.request_id=o.request_id AND p.stripe_mode='legacy'
      AND o.stripe_mode IN ('test','live');
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='drive_request_stripe_mode_mirror'
    AND tgrelid='drive_request_payment_orders'::regclass) THEN
    CREATE TRIGGER drive_request_stripe_mode_mirror AFTER INSERT OR UPDATE
      ON drive_request_payment_orders FOR EACH ROW
      EXECUTE FUNCTION mirror_drive_request_stripe_mode();
  END IF;
END $$;

-- Preserve the destination already verified at checkout. The legacy erasure
-- fallback remains valid only for legacy orders and must never cross modes.
DO $$ DECLARE body TEXT; BEGIN
  SELECT pg_get_functiondef('preserve_drive_request_owner_payout()'::regprocedure) INTO body;
  IF strpos(body,'stripe_owner_payout_accounts')=0 THEN
    body := replace(body,
      '(SELECT stripe_account_id FROM pkm_owner_payout_accounts' || E'\n       WHERE user_id=OLD.user_id)',
      '(SELECT stripe_account_id FROM stripe_owner_payout_accounts' || E'\n       WHERE user_id=OLD.user_id AND stripe_mode=OLD.stripe_mode)');
    EXECUTE body;
  END IF;
END $$;

ALTER TABLE stripe_connect_bank_payout_events
  DROP CONSTRAINT IF EXISTS stripe_connect_bank_payout_events_event_type_check;
ALTER TABLE stripe_connect_bank_payout_events
  ADD CONSTRAINT stripe_connect_bank_payout_events_event_type_check CHECK (event_type IN
    ('account.updated','account.external_account.created','account.external_account.updated',
     'account.external_account.deleted','payout.created','payout.updated','payout.paid','payout.failed'));
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;
COMMIT;
