BEGIN;
SELECT pg_advisory_xact_lock(2690001);
LOCK TABLE scope_commerce_purchases IN ACCESS EXCLUSIVE MODE;
DO $rollback$
BEGIN
 IF EXISTS(SELECT 1 FROM scope_commerce_purchases WHERE status='awaiting_owner') THEN
  RAISE EXCEPTION 'awaiting owner reservations require forward recovery before rollback';
 END IF;
END
$rollback$;
ALTER TABLE scope_commerce_purchases DROP CONSTRAINT scope_commerce_upfront_owner_check;
ALTER TABLE scope_commerce_purchases DROP CONSTRAINT scope_commerce_purchases_status_check;
ALTER TABLE scope_commerce_purchases ADD CONSTRAINT scope_commerce_purchases_status_check
 CHECK(status IN ('awaiting_payment','reserved','preparing','staged','revoked','expired'));
COMMIT;
