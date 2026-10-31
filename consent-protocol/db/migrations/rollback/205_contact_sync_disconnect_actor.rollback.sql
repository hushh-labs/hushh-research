BEGIN;
-- Roll back application readers first. This removes only actor annotations;
-- canonical connections, provenance, grants and Circle membership are retained.
ALTER TABLE connections DROP CONSTRAINT IF EXISTS connections_revocation_actor_pair;
ALTER TABLE connections DROP COLUMN IF EXISTS revoked_by_at;
ALTER TABLE connections DROP COLUMN IF EXISTS revoked_by_side;
SELECT install_account_deletion_write_guards();
COMMIT;
