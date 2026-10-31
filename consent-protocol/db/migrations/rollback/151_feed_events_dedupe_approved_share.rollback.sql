BEGIN;

-- Restores migration 117's fan-out, which forwards every feed-worthy
-- one_location_events row including the location_share_created written by an
-- approval-born grant (so an approval again produces two Feed rows).

CREATE OR REPLACE FUNCTION feed_events_from_one_location_events()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.event_type IN (
    'location_share_created',
    'location_share_revoked',
    'location_share_expired',
    'location_access_request',
    'location_access_approved',
    'location_access_denied'
  ) THEN
    INSERT INTO feed_events (user_id, source_domain, event_type, metadata, source_row_id)
    VALUES (
      NEW.owner_user_id,
      'location',
      NEW.event_type,
      NEW.metadata,
      NEW.id::TEXT
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION feed_events_from_one_location_events() IS
  'Fans out feed-worthy one_location_events inserts into feed_events, owner-scoped.';

COMMIT;
