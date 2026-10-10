BEGIN;
DROP TRIGGER IF EXISTS drive_owner_earning_feed_wake ON drive_request_owner_payouts;
DROP FUNCTION IF EXISTS public.notify_document_owner_earning_changed();
ALTER TABLE pkm_owner_payout_accounts DROP COLUMN IF EXISTS account_ready;
COMMIT;
