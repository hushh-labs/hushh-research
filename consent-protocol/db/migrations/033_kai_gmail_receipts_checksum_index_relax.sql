-- Migration 033: Relax Gmail receipt checksum dedupe index to avoid false positive drops.
-- Message identity remains enforced by UNIQUE(user_id, gmail_message_id).

BEGIN;

DROP INDEX IF EXISTS uq_kai_gmail_receipts_user_checksum;

CREATE INDEX IF NOT EXISTS idx_kai_gmail_receipts_user_checksum
    ON kai_gmail_receipts(user_id, receipt_checksum)
    WHERE receipt_checksum IS NOT NULL;

COMMIT;
