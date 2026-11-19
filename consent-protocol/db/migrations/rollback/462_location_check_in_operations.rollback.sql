BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM one_location_check_in_operations) THEN
   RAISE EXCEPTION 'location_check_in_rollback_requires_empty_operations';
 END IF;
END $$;
DROP TRIGGER IF EXISTS zz_one_location_feed_membership_facts ON one_location_circle_memberships;
DROP FUNCTION IF EXISTS one_location_feed_membership_facts();
DROP TRIGGER IF EXISTS zz_one_location_feed_transition_facts ON one_location_events;
DROP FUNCTION IF EXISTS one_location_feed_transition_facts();
DROP TRIGGER IF EXISTS one_location_check_in_grant_ended ON one_location_share_grants;
DROP FUNCTION IF EXISTS one_location_check_in_grant_ended();
DROP TABLE IF EXISTS one_location_check_in_targets;
DROP TABLE IF EXISTS one_location_check_in_operations;
COMMIT;
