BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM drive_bulk_shares WHERE v1_statement_search)
    OR EXISTS (SELECT 1 FROM drive_request_bulk_removals WHERE v1_statement_search) THEN
    RAISE EXCEPTION 'V1 bulk share removals still require isolated reconciliation';
  END IF;
END $$;
DROP INDEX IF EXISTS drive_request_bulk_removals_v1_due;
DROP TRIGGER IF EXISTS drive_bulk_share_v1_removal_source ON drive_bulk_shares;
DROP FUNCTION IF EXISTS mark_drive_bulk_share_v1_removal_source();
ALTER TABLE drive_request_bulk_removals DROP COLUMN IF EXISTS v1_statement_search;
ALTER TABLE drive_bulk_shares DROP COLUMN IF EXISTS v1_statement_search;
COMMIT;
