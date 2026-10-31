BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM drive_request_payment_obligations WHERE v1_statement_search)
    OR EXISTS (SELECT 1 FROM drive_request_owner_payouts WHERE v1_statement_search) THEN
    RAISE EXCEPTION 'V1 payment obligations still require isolated reconciliation';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION mirror_drive_request_payment_obligation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO drive_request_payment_obligations
    (request_id,payer_ref,amount_cents,currency,status,checkout_attempt_id,
     stripe_checkout_session_id,stripe_payment_intent_id,paid_at,reconciliation_required)
  VALUES (NEW.request_id,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      NEW.request_id::text || ':' || NEW.requester_user_id,'UTF8')),'hex'),
    NEW.amount_cents,NEW.currency,NEW.status,NEW.checkout_attempt_id,
    NEW.stripe_checkout_session_id,NEW.stripe_payment_intent_id,NEW.paid_at,
    NEW.reconciliation_required)
  ON CONFLICT (request_id) DO UPDATE SET
    status=EXCLUDED.status,checkout_attempt_id=EXCLUDED.checkout_attempt_id,
    stripe_checkout_session_id=EXCLUDED.stripe_checkout_session_id,
    stripe_payment_intent_id=EXCLUDED.stripe_payment_intent_id,
    paid_at=EXCLUDED.paid_at,
    reconciliation_required=drive_request_payment_obligations.reconciliation_required
      OR EXCLUDED.reconciliation_required,
    updated_at=clock_timestamp();
  RETURN NEW;
END $$;
DROP INDEX IF EXISTS drive_request_owner_payouts_v1_due;
DROP INDEX IF EXISTS drive_request_payment_obligations_v1_due;
ALTER TABLE drive_request_owner_payouts DROP COLUMN IF EXISTS v1_statement_search;
ALTER TABLE drive_request_payment_obligations DROP COLUMN IF EXISTS v1_statement_search;
DROP INDEX IF EXISTS drive_owner_search_v1_due;
ALTER TABLE drive_owner_search_jobs DROP COLUMN IF EXISTS v1_statement_search;
COMMIT;
