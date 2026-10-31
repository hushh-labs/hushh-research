-- Application rollback is additive. Keep the strict command fence and run-first
-- lock order: restoring the old function would allow a retained workflow receipt
-- to bypass command cancellation. Existing manual v5 callers remain compatible.
BEGIN;
SELECT 1;
COMMIT;
