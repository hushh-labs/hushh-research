-- Additive rollback: roll application code back and retain the existing choice
-- fields and pair guard. Dropping them would erase owner choices or break the
-- independently deployed parked pod lane, which uses the same canonical fields.
-- A later, evidence-gated contract migration may retire them once unused.
BEGIN;
SELECT 1;
COMMIT;
