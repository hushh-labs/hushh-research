-- Progressive batches can create several shares for one search/request.
-- Reinstating the old uniqueness rules is safe only before that happens.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM drive_bulk_shares
    WHERE progressive_batch = TRUE
    LIMIT 1
  ) OR EXISTS (
    SELECT 1 FROM drive_bulk_shares
    GROUP BY user_id, search_job_id
    HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM drive_bulk_shares
    WHERE origin_request_id IS NOT NULL
    GROUP BY user_id, origin_request_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'migration_259_rollback_refused_progressive_batches';
  END IF;
END
$$;

ALTER TABLE drive_bulk_shares
  ADD CONSTRAINT drive_bulk_shares_user_id_search_job_id_key
  UNIQUE (user_id, search_job_id);
CREATE UNIQUE INDEX IF NOT EXISTS drive_bulk_origin_request_unique
  ON drive_bulk_shares(user_id, origin_request_id)
  WHERE origin_request_id IS NOT NULL;

DROP INDEX IF EXISTS drive_bulk_request_source_position_unique;
ALTER TABLE drive_bulk_share_files
  DROP CONSTRAINT IF EXISTS drive_bulk_file_origin_request_fk,
  DROP COLUMN IF EXISTS origin_request_id;
ALTER TABLE drive_bulk_shares
  DROP CONSTRAINT IF EXISTS drive_bulk_approval_source_check,
  DROP COLUMN IF EXISTS approval_source,
  DROP COLUMN IF EXISTS progressive_batch;

COMMIT;
