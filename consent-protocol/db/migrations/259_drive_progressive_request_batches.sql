-- A request may freeze several independent, owner-approved batches while its
-- encrypted Drive search continues. A source position can enter only one batch.
BEGIN;

ALTER TABLE drive_bulk_shares
  ADD COLUMN IF NOT EXISTS progressive_batch BOOLEAN NOT NULL DEFAULT FALSE;

-- Approval authority belongs to each immutable batch. An old request's
-- encrypted trusted marker is not authority over a later owner-approved batch.
ALTER TABLE drive_bulk_shares
  ADD COLUMN IF NOT EXISTS approval_source TEXT;

UPDATE drive_bulk_shares
SET approval_source='owner'
WHERE approved_at IS NOT NULL AND approval_source IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname='drive_bulk_approval_source_check'
                   AND conrelid='drive_bulk_shares'::regclass) THEN
    ALTER TABLE drive_bulk_shares
      ADD CONSTRAINT drive_bulk_approval_source_check
      CHECK ((approved_at IS NULL AND approval_source IS NULL)
        OR (approved_at IS NOT NULL AND approval_source IN ('owner','trusted_auto')));
  END IF;
END $$;

-- Backfill only on the first upgrade. A later owner batch may intentionally
-- release an earlier batch's file claim by setting this column to NULL.
-- Replaying the backfill would reclaim that position and can conflict with
-- the replacement batch's unique source-position claim.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'drive_bulk_share_files'::regclass
      AND attname = 'origin_request_id'
      AND attnum > 0 AND NOT attisdropped
  ) THEN
    ALTER TABLE drive_bulk_share_files ADD COLUMN origin_request_id UUID;
    UPDATE drive_bulk_share_files f
    SET origin_request_id = b.origin_request_id
    FROM drive_bulk_shares b
    WHERE b.share_id = f.share_id
      AND b.origin_request_id IS NOT NULL
      AND f.origin_request_id IS NULL;
  END IF;
END $$;

ALTER TABLE drive_bulk_share_files
  DROP CONSTRAINT IF EXISTS drive_bulk_file_origin_request_fk;
ALTER TABLE drive_bulk_share_files
  ADD CONSTRAINT drive_bulk_file_origin_request_fk
  FOREIGN KEY (origin_request_id,user_id)
  REFERENCES drive_share_requests(request_id,user_id);

CREATE UNIQUE INDEX IF NOT EXISTS drive_bulk_request_source_position_unique
  ON drive_bulk_share_files(user_id,origin_request_id,source_position)
  WHERE origin_request_id IS NOT NULL;

ALTER TABLE drive_bulk_shares
  DROP CONSTRAINT IF EXISTS drive_bulk_shares_user_id_search_job_id_key;
DROP INDEX IF EXISTS drive_bulk_origin_request_unique;

COMMIT;
