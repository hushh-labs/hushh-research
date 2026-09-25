-- Disable the feature to roll back; retain pending claim bindings and public revisions.
BEGIN;
SELECT 1;
COMMIT;
