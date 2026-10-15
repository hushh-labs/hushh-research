-- Additive rollback: retain reader columns and owner continuity receipts.
-- Reverting the application must never erase hosting choices or pod assignments.
BEGIN;
SELECT 1;
COMMIT;
