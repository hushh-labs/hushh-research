BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM wallet_card_requests) THEN
  RAISE EXCEPTION 'wallet_card_requests_rollback_requires_empty_table';
 END IF;
END; $$;
DROP TABLE wallet_card_requests;
DROP FUNCTION guard_wallet_card_request();
COMMIT;
