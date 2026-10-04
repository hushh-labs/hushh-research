-- Stage 1 of the Gmail receipt privacy cutover.
--
-- Existing receipt and preview rows stay readable so current users retain their
-- history. The database, not only application code, rejects every new or
-- mutated plaintext-derived cache row while browser/device-owned Gmail reads
-- are introduced. Deletes remain permitted for disconnect and account erasure.

BEGIN;

CREATE OR REPLACE FUNCTION block_gmail_receipt_cache_writes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Gmail receipt cache is read-only during the private on-device cutover'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS block_kai_gmail_receipts_writes ON kai_gmail_receipts;
CREATE TRIGGER block_kai_gmail_receipts_writes
  BEFORE INSERT OR UPDATE ON kai_gmail_receipts
  FOR EACH ROW
  EXECUTE FUNCTION block_gmail_receipt_cache_writes();

DROP TRIGGER IF EXISTS block_kai_receipt_memory_artifact_writes
  ON kai_receipt_memory_artifacts;
CREATE TRIGGER block_kai_receipt_memory_artifact_writes
  BEFORE INSERT OR UPDATE ON kai_receipt_memory_artifacts
  FOR EACH ROW
  EXECUTE FUNCTION block_gmail_receipt_cache_writes();

COMMIT;
