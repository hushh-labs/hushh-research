BEGIN;

-- ============================================================================
-- Migration 152: the person a location is shared WITH gets a Feed row
-- ============================================================================
-- Migration 117 fans one_location_events out into feed_events, and writes
-- every row to NEW.owner_user_id -- the person who shared. The person shared
-- WITH was never written a row at all.
--
-- So: Ankit shares his location with Jamai. Ankit's Feed says "Started
-- sharing location". Jamai's Feed says nothing, and keeps saying nothing when
-- the share stops or expires. Jamai's only signal was the push notification,
-- which is gone the moment it is dismissed. The reported symptom was "the feed
-- is not real time" -- but for the recipient the row did not exist at any
-- refresh rate, so no amount of polling was ever going to show it.
--
-- The three share-lifecycle events are the ones a recipient is owed, because
-- each changes what that person can see:
--   location_share_created  -- someone's location is now visible to you
--   location_share_revoked  -- it is not any more
--   location_share_expired  -- it ran out
--
-- Requests and approvals are deliberately NOT mirrored: those already notify
-- the side that has to act, and the owner's row names the decision they made.
--
-- WHY A SECOND TRIGGER RATHER THAN EDITING THE FIRST
-- feed_events_from_one_location_events() is being changed in parallel to
-- de-duplicate approval-born shares. Two migrations doing CREATE OR REPLACE on
-- one function means whichever lands second silently reverts the other. This
-- is an independent concern -- a different audience, not different filtering --
-- so it gets its own function and its own trigger, and the two compose in
-- either merge order.
--
-- one_location_events remains the domain's audit authority and is untouched.
-- feed_events stays presentation-only: the row carries a display label and no
-- ciphertext, no coordinates, no vault-protected content.
-- ============================================================================

CREATE OR REPLACE FUNCTION feed_events_recipient_from_one_location_events()
RETURNS TRIGGER AS $$
DECLARE
  owner_label TEXT;
BEGIN
  -- A share with no recipient, or one a person made to themselves, has no
  -- second audience to write to.
  IF NEW.recipient_user_id IS NULL
     OR NEW.recipient_user_id = NEW.owner_user_id THEN
    RETURN NEW;
  END IF;

  IF NEW.event_type NOT IN (
    'location_share_created',
    'location_share_revoked',
    'location_share_expired'
  ) THEN
    RETURN NEW;
  END IF;

  -- The event's own `counterpart_label` was resolved for the owner's row, so it
  -- holds the RECIPIENT's name -- reading it back to the recipient would show
  -- them their own name. The counterpart from this side is the owner.
  SELECT NULLIF(BTRIM(COALESCE(display_name, '')), '')
    INTO owner_label
    FROM actor_identity_cache
   WHERE user_id = NEW.owner_user_id;

  INSERT INTO feed_events (
    user_id, source_domain, event_type, metadata, source_row_id
  )
  VALUES (
    NEW.recipient_user_id,
    'location',
    NEW.event_type,
    COALESCE(NEW.metadata, '{}'::jsonb)
      || jsonb_build_object(
           -- Read by the client to pick wording. Without it the recipient's
           -- revoke row renders the owner's sentence, "You stopped sharing
           -- location", to the one person who did not.
           'feed_audience', 'recipient',
           'counterpart_label', COALESCE(owner_label, 'A trusted person')
         ),
    NEW.id::TEXT
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION feed_events_recipient_from_one_location_events() IS
  'Fans share-lifecycle one_location_events out to the RECIPIENT feed, with the owner as counterpart. Companion to the owner-scoped feed_events_from_one_location_events().';

DROP TRIGGER IF EXISTS one_location_events_feed_fanout_recipient ON one_location_events;
CREATE TRIGGER one_location_events_feed_fanout_recipient
  AFTER INSERT ON one_location_events
  FOR EACH ROW
  EXECUTE FUNCTION feed_events_recipient_from_one_location_events();

COMMIT;
