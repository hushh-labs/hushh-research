-- Bind a durable Drive search and bulk share to one existing document request.
-- Request identity is opaque; recipient and file metadata remain encrypted.
BEGIN;

ALTER TABLE drive_share_requests
  ADD COLUMN IF NOT EXISTS bulk_search_started_at TIMESTAMPTZ;

ALTER TABLE drive_owner_search_jobs
  ADD COLUMN IF NOT EXISTS unshareable_count INTEGER NOT NULL DEFAULT 0
  CHECK (unshareable_count BETWEEN 0 AND 10000);

ALTER TABLE drive_bulk_shares
  ADD COLUMN IF NOT EXISTS origin_request_id UUID,
  ADD COLUMN IF NOT EXISTS origin_request_revision BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'drive_bulk_origin_request_fk'
                   AND conrelid = 'drive_bulk_shares'::regclass) THEN
    ALTER TABLE drive_bulk_shares
      ADD CONSTRAINT drive_bulk_origin_request_fk
        FOREIGN KEY (origin_request_id,user_id)
        REFERENCES drive_share_requests(request_id,user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'drive_bulk_origin_request_revision_check'
                   AND conrelid = 'drive_bulk_shares'::regclass) THEN
    ALTER TABLE drive_bulk_shares
      ADD CONSTRAINT drive_bulk_origin_request_revision_check
        CHECK ((origin_request_id IS NULL) = (origin_request_revision IS NULL));
  END IF;
END $$;

-- Migration 259 permits several immutable batches per request and drops this
-- index. Release deploys replay older migrations, so do not recreate the old
-- one-batch rule after 259 has already upgraded this database.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'drive_bulk_shares'::regclass
      AND attname = 'progressive_batch'
      AND attnum > 0 AND NOT attisdropped
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS drive_bulk_origin_request_unique
      ON drive_bulk_shares(user_id,origin_request_id)
      WHERE origin_request_id IS NOT NULL;
  END IF;
END $$;

COMMIT;
