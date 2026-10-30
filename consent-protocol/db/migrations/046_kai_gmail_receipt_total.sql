-- Replay guard: ADD COLUMN IF NOT EXISTS takes ACCESS EXCLUSIVE on
-- kai_gmail_connections before it finds the column. Skip it only when the
-- column is already there; otherwise run the original statement unchanged.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = to_regclass('kai_gmail_connections')
      AND attname = 'receipt_total'
      AND attnum > 0
      AND NOT attisdropped
  ) THEN
    ALTER TABLE IF EXISTS kai_gmail_connections
        ADD COLUMN IF NOT EXISTS receipt_total INTEGER NOT NULL DEFAULT 0;
  END IF;
END
$$;

WITH receipt_counts AS (
    SELECT user_id, COUNT(*)::integer AS total
    FROM kai_gmail_receipts
    GROUP BY user_id
)
UPDATE kai_gmail_connections AS connections
SET receipt_total = receipt_counts.total
FROM receipt_counts
WHERE connections.user_id = receipt_counts.user_id;
