BEGIN;
DROP INDEX IF EXISTS gmail_personal_information_reply_send_action;
ALTER TABLE gmail_personal_information_requests DROP COLUMN IF EXISTS reply_send_action_id;
DROP TABLE IF EXISTS one_product_value_receipts;
COMMIT;
