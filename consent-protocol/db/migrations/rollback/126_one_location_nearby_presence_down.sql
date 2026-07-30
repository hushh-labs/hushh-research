BEGIN;

-- Destructive rollback is for unshipped environments only. After release,
-- roll back application code first and retain this additive table until a
-- separately reviewed contract migration removes it.
DROP TABLE IF EXISTS one_location_nearby_presences;

COMMIT;
