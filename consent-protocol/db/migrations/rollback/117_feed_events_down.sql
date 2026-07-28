BEGIN;

DROP TRIGGER IF EXISTS connected_system_audit_feed_fanout ON connected_system_audit_events;
DROP FUNCTION IF EXISTS feed_events_from_connected_system_audit();

DROP TRIGGER IF EXISTS one_location_events_feed_fanout ON one_location_events;
DROP FUNCTION IF EXISTS feed_events_from_one_location_events();

DROP TRIGGER IF EXISTS consent_audit_feed_fanout ON consent_audit;
DROP FUNCTION IF EXISTS feed_events_from_consent_audit();

DROP TABLE IF EXISTS feed_events;

COMMIT;
