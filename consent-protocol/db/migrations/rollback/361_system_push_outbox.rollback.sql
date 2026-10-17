BEGIN;
DROP TRIGGER IF EXISTS system_push_share ON one_location_share_grants;
DROP TRIGGER IF EXISTS system_push_location_request ON one_location_access_requests;
DROP TRIGGER IF EXISTS system_push_connection_request ON connection_requests;
DROP TRIGGER IF EXISTS system_push_circle_member ON one_location_circle_memberships;
DROP FUNCTION IF EXISTS queue_system_push();
DROP TABLE IF EXISTS system_push_device_deliveries;
DROP TABLE IF EXISTS system_push_outbox;
COMMIT;
