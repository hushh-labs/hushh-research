BEGIN;

-- Roll back migration 127.
--
DROP TABLE IF EXISTS one_location_circle_member_invites;

COMMIT;
