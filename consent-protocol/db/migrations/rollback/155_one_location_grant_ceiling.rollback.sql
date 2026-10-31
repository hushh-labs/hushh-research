-- Reverse 155.
--
-- Dropping the column drops the ceiling with it. That is the correct loss:
-- the ceiling only ever informs how far a self-serve duration edit is
-- allowed to regrow without asking again -- it grants nothing on its own,
-- and every grant's live `expires_at`/`duration_hours` (the actual access)
-- is untouched by removing it. A rollback just returns every duration edit
-- to comparing against the live expiry, exactly as it did before 155.

BEGIN;

ALTER TABLE one_location_share_grants
  DROP CONSTRAINT IF EXISTS one_location_share_grants_ceiling_bounds;

ALTER TABLE one_location_share_grants
  DROP COLUMN IF EXISTS ceiling_expires_at;

COMMIT;
