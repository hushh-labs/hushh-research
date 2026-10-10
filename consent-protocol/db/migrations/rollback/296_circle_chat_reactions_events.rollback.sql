BEGIN;
DROP TRIGGER IF EXISTS circle_chat_membership_event ON one_location_circle_memberships;
DROP FUNCTION IF EXISTS record_circle_chat_membership_event();
DROP TABLE IF EXISTS circle_chat_membership_events;
DROP TABLE IF EXISTS circle_chat_reactions;
COMMIT;
