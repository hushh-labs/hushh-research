-- Disable the private-agent lane and export pending receipts before rollback.
BEGIN;
DROP TABLE IF EXISTS one_reply_deliveries;
COMMIT;
