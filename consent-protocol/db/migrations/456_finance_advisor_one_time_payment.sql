BEGIN;

CREATE TABLE IF NOT EXISTS advisor_review_payments (
  request_id uuid NOT NULL REFERENCES advisor_review_requests(id) ON DELETE CASCADE,
  plan_revision integer NOT NULL CHECK(plan_revision>0),
  plan_hash text NOT NULL CHECK(plan_hash ~ '^[a-f0-9]{64}$'),
  amount_cents integer NOT NULL CHECK(amount_cents BETWEEN 100 AND 100000),
  payee_account text NOT NULL,
  attempt integer NOT NULL DEFAULT 1 CHECK(attempt>0),
  attempt_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  checkout_session_id text UNIQUE,
  payment_intent_id text UNIQUE,
  status text NOT NULL DEFAULT 'preparing'
    CHECK(status IN ('preparing','checkout_pending','processing','expired','paid','refunded','partially_refunded')),
  paid_at timestamptz,
  PRIMARY KEY(request_id,plan_revision),
  CHECK((status='preparing')=(checkout_session_id IS NULL)),
  CHECK((status IN ('paid','refunded','partially_refunded'))=(paid_at IS NOT NULL AND payment_intent_id IS NOT NULL))
);

CREATE OR REPLACE FUNCTION retire_advisor_payment_checkout() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
  IF OLD.checkout_session_id IS NOT NULL AND OLD.status IN ('checkout_pending','processing') THEN
    INSERT INTO advisor_billing_cleanup(resource_id,resource_kind,stripe_mode)
    VALUES(OLD.checkout_session_id,'checkout','test') ON CONFLICT DO NOTHING;
  END IF;
  RETURN OLD;
END; $$;
DROP TRIGGER IF EXISTS advisor_payment_retirement ON advisor_review_payments;
CREATE TRIGGER advisor_payment_retirement BEFORE DELETE ON advisor_review_payments
FOR EACH ROW EXECUTE FUNCTION retire_advisor_payment_checkout();

ALTER TABLE advisor_review_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON advisor_review_payments FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON advisor_review_payments FROM %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON advisor_review_payments TO service_role;
  END IF;
END $$;

COMMIT;
