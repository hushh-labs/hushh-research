-- Reverse 159: remove the system-Circle marker and its delete guard.
--
-- The SMS Circles themselves are deliberately LEFT IN PLACE, as ordinary
-- Circles. By the time anyone rolls this back the migration hook has run for
-- real owners: the Circle holds their emergency contacts, and its members are
-- connected through the connection graph exactly like any other Circle's. That
-- state is not an artefact of `is_system` -- dropping the flag does not unmake
-- a membership or a connection, and deleting the Circles to "clean up" would
-- destroy the contact list SOS reads.
--
-- So a rollback returns the SHAPE (no marker, no guard, Circles freely
-- deletable again) and keeps the DATA. The pre-159 world is one where these are
-- just Circles, which is precisely what they become.
--
-- `one_location_sms_contacts` is untouched by 159 and by this file. It is still
-- the row-for-row record of who each owner picked, kept deliberately for one
-- release as the fallback SOS can read if the Circle path has to be backed out.

BEGIN;

DROP TRIGGER IF EXISTS one_location_circles_block_system_delete
  ON one_location_circles;

DROP FUNCTION IF EXISTS one_location_circles_block_system_delete();

DROP INDEX IF EXISTS uq_one_location_circles_owner_system;

ALTER TABLE one_location_circles
  DROP COLUMN IF EXISTS is_system;

COMMIT;
