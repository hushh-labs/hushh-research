BEGIN;
LOCK TABLE advisor_review_payments IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM advisor_review_payments WHERE status<>'expired') THEN
    RAISE EXCEPTION 'Retain advisor payment history and reconcile open checkouts before rollback';
  END IF;
END $$;
DROP TABLE advisor_review_payments;
DROP FUNCTION retire_advisor_payment_checkout();
COMMIT;
