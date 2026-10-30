-- A completed request-bound search with zero matches made no Google sharing
-- attempt. Give it an outcome distinct from a partial permission failure.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='drive_share_requests'::regclass
      AND conname='drive_share_requests_status_check'
      AND pg_get_constraintdef(oid) LIKE '%no_match%'
  ) THEN
    ALTER TABLE drive_share_requests
      DROP CONSTRAINT IF EXISTS drive_share_requests_status_check;
    ALTER TABLE drive_share_requests
      ADD CONSTRAINT drive_share_requests_status_check CHECK (status IN (
        'pending','preparing','review_ready','approved','declined','cancelled',
        'expired','completed','partial','no_match'
      ));
  END IF;
END $$;

-- The Feed trigger projects the private owner outcome for both audiences.
-- Keep the requester row neutral at write time as well as at API read time.
CREATE OR REPLACE FUNCTION neutralize_drive_no_match_feed_status()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_type='document_share_outcome'
     AND NEW.metadata->>'feed_audience'='recipient'
     AND NEW.metadata->>'user_facing_status'='no_match' THEN
    NEW.metadata=jsonb_set(
      NEW.metadata,'{user_facing_status}','"no_files_shared"'::jsonb,TRUE
    );
  END IF;
  RETURN NEW;
END $$;
DO $$
BEGIN
  -- Release and isolated test schemas both resolve Feed through search_path.
  IF to_regclass('feed_events') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_trigger
       WHERE tgrelid=to_regclass('feed_events')
         AND tgname='neutralize_drive_no_match_feed_status'
     ) THEN
    CREATE TRIGGER neutralize_drive_no_match_feed_status
      BEFORE INSERT OR UPDATE OF metadata ON feed_events
      FOR EACH ROW EXECUTE FUNCTION neutralize_drive_no_match_feed_status();
  END IF;
END $$;

-- Correct already-finalized requests only when there were no search results,
-- no frozen bulk batch, and no individual grant operation. A real partial
-- permission outcome must retain its original status.
UPDATE drive_share_requests r
SET status='no_match',updated_at=clock_timestamp()
WHERE r.status='partial'
  AND EXISTS (
    SELECT 1 FROM drive_owner_search_jobs j
    WHERE j.user_id=r.user_id AND j.client_request_id=r.request_id
      AND j.status='completed' AND j.matched=0 AND j.incomplete_search=FALSE
  )
  AND NOT EXISTS (
    SELECT 1 FROM drive_bulk_shares b
    WHERE b.user_id=r.user_id AND b.origin_request_id=r.request_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM drive_share_permission_operations p
    WHERE p.user_id=r.user_id AND p.request_id=r.request_id AND p.kind='grant'
  );

-- Feed rows store the status at event creation. Correct those historical
-- outcome rows so the owner and requester see the repaired result too.
DO $$
BEGIN
  IF to_regclass('feed_events') IS NOT NULL THEN
    UPDATE feed_events e
    SET metadata=jsonb_set(
      e.metadata,'{user_facing_status}',
      CASE WHEN e.metadata->>'feed_audience'='recipient'
        THEN '"no_files_shared"'::jsonb ELSE '"no_match"'::jsonb END,TRUE
    )
    FROM drive_share_requests r
    WHERE e.source_domain='connected_systems'
      AND e.event_type='document_share_outcome'
      AND e.metadata->>'request_id'=r.request_id::text
      AND e.metadata->>'user_facing_status'='partial'
      AND r.status='no_match';
    UPDATE feed_events e
    SET metadata=jsonb_set(
      e.metadata,'{user_facing_status}','"no_files_shared"'::jsonb,TRUE
    )
    WHERE e.event_type='document_share_outcome'
      AND e.metadata->>'feed_audience'='recipient'
      AND e.metadata->>'user_facing_status'='no_match';
  END IF;
END $$;

COMMIT;
