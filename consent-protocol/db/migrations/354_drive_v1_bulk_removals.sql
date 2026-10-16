-- Keep exact owner-approved V1 share provenance after search expiry, then
-- preserve it on sealed removal rows after share or request erasure.
BEGIN;

ALTER TABLE drive_bulk_shares
  ADD COLUMN IF NOT EXISTS v1_statement_search BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE drive_request_bulk_removals
  ADD COLUMN IF NOT EXISTS v1_statement_search BOOLEAN NOT NULL DEFAULT FALSE;

-- Approval updates the frozen share while its search, request revision and
-- exact recipient are still present. Ignore caller-supplied marker values;
-- once proven, keep the marker through later status changes and retention.
CREATE OR REPLACE FUNCTION mark_drive_bulk_share_v1_removal_source()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.v1_statement_search THEN
    NEW.v1_statement_search := TRUE;
  ELSIF NEW.origin_request_id IS NULL OR NEW.progressive_batch IS NOT TRUE
      OR NEW.approval_source IS DISTINCT FROM 'owner'
      OR NEW.approved_at IS NULL OR NEW.file_count < 1
      OR NEW.recipient_count <> 1 THEN
    NEW.v1_statement_search := FALSE;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM drive_owner_search_jobs j
      JOIN drive_share_requests request
        ON request.request_id=NEW.origin_request_id AND request.user_id=NEW.user_id
      JOIN drive_bulk_share_recipients recipient
        ON recipient.share_id=NEW.share_id AND recipient.user_id=NEW.user_id
      WHERE j.job_id=NEW.search_job_id AND j.user_id=NEW.user_id
        AND j.v1_statement_search=TRUE
        AND request.revision=NEW.origin_request_revision
        AND request.recipient_user_id=recipient.recipient_user_id
    ) INTO NEW.v1_statement_search;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS drive_bulk_share_v1_removal_source ON drive_bulk_shares;
CREATE TRIGGER drive_bulk_share_v1_removal_source
  BEFORE UPDATE OF approved_at,approval_source,v1_statement_search
  ON drive_bulk_shares FOR EACH ROW
  EXECUTE FUNCTION mark_drive_bulk_share_v1_removal_source();

-- Upgrade only rows for which the original live authority can still be
-- checked. A purged search is not enough evidence to reclassify old shares.
UPDATE drive_bulk_shares b SET v1_statement_search=TRUE
WHERE b.v1_statement_search=FALSE
  AND b.origin_request_id IS NOT NULL
  AND b.progressive_batch=TRUE
  AND b.approval_source='owner' AND b.approved_at IS NOT NULL
  AND b.file_count>0 AND b.recipient_count=1
  AND EXISTS (
    SELECT 1 FROM drive_owner_search_jobs j
    JOIN drive_share_requests request
      ON request.request_id=b.origin_request_id AND request.user_id=b.user_id
    JOIN drive_bulk_share_recipients recipient
      ON recipient.share_id=b.share_id AND recipient.user_id=b.user_id
    WHERE j.job_id=b.search_job_id AND j.user_id=b.user_id
      AND j.v1_statement_search=TRUE
      AND request.revision=b.origin_request_revision
      AND request.recipient_user_id=recipient.recipient_user_id
  );

UPDATE drive_request_bulk_removals removal SET v1_statement_search=TRUE
FROM drive_bulk_shares b
WHERE removal.share_id=b.share_id AND removal.user_id=b.user_id
  AND removal.v1_statement_search=FALSE AND b.v1_statement_search=TRUE
  AND b.origin_request_id=removal.request_id
  AND b.progressive_batch=TRUE
  AND b.approval_source='owner' AND b.approved_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS drive_request_bulk_removals_v1_due
  ON drive_request_bulk_removals(next_at,created_at,removal_id)
  WHERE v1_statement_search AND state IN ('queued','dispatching','unknown');

COMMENT ON COLUMN drive_bulk_shares.v1_statement_search IS
  'Sticky server-derived proof of exact owner approval for a V1 statement batch.';
COMMENT ON COLUMN drive_request_bulk_removals.v1_statement_search IS
  'Durable V1 removal provenance copied from the approved source share.';
COMMIT;
