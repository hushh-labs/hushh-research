-- Reverse 156.
--
-- Drops the safety-net trigger only. The one-time backfill it shipped with
-- is not undone: those rows' ceilings are now correct data, and reverting a
-- schema migration is not a reason to make an active grant's regrow window
-- wrong again.

BEGIN;

DROP TRIGGER IF EXISTS one_location_share_grants_default_ceiling ON one_location_share_grants;
DROP FUNCTION IF EXISTS one_location_grant_default_ceiling();

COMMIT;
