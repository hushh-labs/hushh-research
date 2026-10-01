-- Revert the table default. Already resumed requests remain subject to the
-- worker's current authority checks and are not rewritten by this rollback.
BEGIN;
ALTER TABLE drive_live_preferences
  ALTER COLUMN background_enabled SET DEFAULT FALSE;
COMMIT;
