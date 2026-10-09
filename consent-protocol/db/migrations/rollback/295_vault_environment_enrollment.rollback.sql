-- Additive rollback: roll application code back and keep the stamp column.
-- Dropping it would forget who has used this environment; the previous
-- directory rule simply ignores it.
BEGIN;
SELECT 1;
COMMIT;
