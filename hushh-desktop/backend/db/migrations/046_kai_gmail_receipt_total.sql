ALTER TABLE IF EXISTS kai_gmail_connections
    ADD COLUMN IF NOT EXISTS receipt_total INTEGER NOT NULL DEFAULT 0;

WITH receipt_counts AS (
    SELECT user_id, COUNT(*)::integer AS total
    FROM kai_gmail_receipts
    GROUP BY user_id
)
UPDATE kai_gmail_connections AS connections
SET receipt_total = receipt_counts.total
FROM receipt_counts
WHERE connections.user_id = receipt_counts.user_id;
