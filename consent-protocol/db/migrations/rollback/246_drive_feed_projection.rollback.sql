BEGIN;
DROP TRIGGER IF EXISTS drive_share_events_feed_projection ON drive_share_events;
DROP TRIGGER IF EXISTS drive_query_events_feed_projection ON drive_query_events;
DROP FUNCTION IF EXISTS feed_events_from_drive_events();
DROP FUNCTION IF EXISTS project_drive_event_to_feed(TEXT, UUID, UUID, TEXT, TEXT, TIMESTAMPTZ);
COMMIT;
