BEGIN;

-- ============================================================================
-- Migration 151: one Feed row per real-world moment for location approvals
-- ============================================================================
-- Approving one location request produced THREE Feed rows for the owner:
--
--   "Requested your location"          <- location_access_request  (the ask)
--   "Started sharing location"         <- location_share_created   (the answer)
--   "You approved the location request" <- location_access_approved (the answer)
--
-- The last two are the same tap. `approve_request` calls `create_grant`, which
-- writes `location_share_created`, and then writes `location_access_approved`
-- itself; migration 117's fan-out forwards both to the owner's feed.
--
-- one_location_events is the domain's audit authority and still records both —
-- nothing here changes what is durably logged. Only the presentation fan-out
-- is de-duplicated, and it keeps `location_access_approved` because that row
-- names the decision the owner actually made. This mirrors the rule already
-- applied to push notifications in one_location_agent_service.create_grant
-- ("Request approval has its own richer notification immediately after this
-- call. Sending share-created as well produces two alerts for one user
-- action.") — the Feed simply never got the same treatment.
--
-- A share started directly (not from a request) carries no such reason and is
-- forwarded exactly as before.
-- ============================================================================

CREATE OR REPLACE FUNCTION feed_events_from_one_location_events()
RETURNS TRIGGER AS $$
BEGIN
  -- An approval-born share is already reported by the `location_access_approved`
  -- row that follows it. Rows written before this migration have no `reason`
  -- key, so `->>` yields NULL and they fan out unchanged.
  IF NEW.event_type = 'location_share_created'
     AND NEW.metadata->>'reason' = 'request_approved' THEN
    RETURN NEW;
  END IF;

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
  'Fans out feed-worthy one_location_events inserts into feed_events, owner-scoped. Skips the location_share_created row of an approval-born grant, which location_access_approved already reports.';

COMMIT;
