BEGIN;

-- "Who actually looked at my location?"
--
-- `location_share_viewed` has been written on every envelope read since the
-- feature shipped, and nothing has ever projected it: the event exists in the
-- audit ledger and in the in-app Activity list, but never reaches the Feed. So
-- the one question a person asks after sharing -- did they actually look? --
-- had no answer on the screen built to answer it.
--
-- THE REASON IT COULD NOT SIMPLY BE PROJECTED
--
-- A viewer watching a live share polls for the envelope, so a single afternoon
-- of watching writes hundreds of these events. Fanning one Feed row per event
-- would bury every other kind of activity under one person refreshing a map.
--
-- So the row is deduplicated to one per grant, per viewer, per day, using the
-- unique index migration 179 already added over
-- (user_id, source_domain, event_type, source_row_id). `ON CONFLICT DO NOTHING`
-- makes the second and four-hundredth view of the day free -- the Feed says
-- "Ankit saw your location" once, which is the fact the owner wanted, rather
-- than four hundred times, which is noise.
--
-- Only the OWNER gets a row. "You viewed their location" is not news to the
-- person who did the viewing, and writing it would put every recipient's own
-- polling back in their Feed.
--
-- The viewer's name is resolved HERE rather than stamped at write time,
-- because the emitting path is a hot read that a recipient hits on a timer and
-- it should not pay for an identity lookup it does not use.

CREATE OR REPLACE FUNCTION feed_events_viewed_from_one_location_events()
RETURNS TRIGGER AS $$
DECLARE
  viewer_label TEXT;
BEGIN
  IF NEW.event_type <> 'location_share_viewed' THEN
    RETURN NEW;
  END IF;

  -- Nothing to tell the owner about their own read.
  IF NEW.actor_user_id IS NULL OR NEW.actor_user_id = NEW.owner_user_id THEN
    RETURN NEW;
  END IF;

  -- Same sanitiser migration 179 uses for owner_label: never a raw user id, a
  -- `ria:` handle, a bare UUID, or an unbroken 20+ character token.
  SELECT CASE
    WHEN NULLIF(BTRIM(display_name), '') IS NOT NULL
     AND BTRIM(display_name) <> NEW.actor_user_id
     AND BTRIM(display_name) !~* '^ria:'
     AND BTRIM(display_name) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     AND NOT (
       BTRIM(display_name) !~ '[@[:space:]]'
       AND LENGTH(BTRIM(display_name)) >= 20
     )
    THEN LEFT(BTRIM(display_name), 160)
  END
    INTO viewer_label
    FROM actor_identity_cache
   WHERE user_id = NEW.actor_user_id;

  INSERT INTO feed_events (
    user_id, source_domain, event_type, actor_label, metadata, source_row_id
  )
  VALUES (
    NEW.owner_user_id,
    'location',
    NEW.event_type,
    viewer_label,
    jsonb_strip_nulls(jsonb_build_object(
      'counterpart_label', COALESCE(viewer_label, 'A trusted person')
    )),
    -- One row per grant, per viewer, per day.
    CONCAT(
      COALESCE(NEW.grant_id::TEXT, NEW.id::TEXT),
      ':viewer:', NEW.actor_user_id,
      ':', TO_CHAR(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
    )
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS one_location_viewed_events_feed_fanout
  ON one_location_events;
CREATE TRIGGER one_location_viewed_events_feed_fanout
  AFTER INSERT ON one_location_events
  FOR EACH ROW
  EXECUTE FUNCTION feed_events_viewed_from_one_location_events();

COMMENT ON FUNCTION feed_events_viewed_from_one_location_events() IS
  'Tells an owner who opened their shared location, once per viewer per grant per day.';

COMMIT;
