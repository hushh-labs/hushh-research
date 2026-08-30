BEGIN;

-- Stop telling owners who viewed their location. Rows already written stay:
-- deleting them would remove the only record an owner has of who looked.

DROP TRIGGER IF EXISTS one_location_viewed_events_feed_fanout
  ON one_location_events;
DROP FUNCTION IF EXISTS feed_events_viewed_from_one_location_events();

COMMIT;
