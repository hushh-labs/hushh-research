-- Restore the previous status vocabulary for an application rollback.
-- No Google permissions are changed by this rollback.
BEGIN;

DO $$
BEGIN
  IF to_regclass('feed_events') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS neutralize_drive_no_match_feed_status ON feed_events;
  END IF;
END $$;
DROP FUNCTION IF EXISTS neutralize_drive_no_match_feed_status();

DO $$
BEGIN
  IF to_regclass('feed_events') IS NOT NULL THEN
    UPDATE feed_events e
    SET metadata=jsonb_set(e.metadata,'{user_facing_status}','"partial"'::jsonb,TRUE)
    WHERE e.source_domain='connected_systems'
      AND e.event_type='document_share_outcome'
      AND e.metadata->>'user_facing_status' IN ('no_match','no_files_shared');
  END IF;
END $$;

UPDATE drive_share_requests SET status='partial',updated_at=clock_timestamp()
WHERE status='no_match';

ALTER TABLE drive_share_requests
  DROP CONSTRAINT IF EXISTS drive_share_requests_status_check;
ALTER TABLE drive_share_requests
  ADD CONSTRAINT drive_share_requests_status_check CHECK (status IN (
    'pending','preparing','review_ready','approved','declined','cancelled',
    'expired','completed','partial'
  ));

COMMIT;
