BEGIN;

DROP TRIGGER IF EXISTS block_kai_gmail_receipts_writes ON kai_gmail_receipts;
DROP TRIGGER IF EXISTS block_kai_receipt_memory_artifact_writes
  ON kai_receipt_memory_artifacts;
DROP FUNCTION IF EXISTS block_gmail_receipt_cache_writes();

COMMIT;
