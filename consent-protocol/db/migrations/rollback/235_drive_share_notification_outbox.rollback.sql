-- Data-preserving rollback: stop scheduling the Drive-share notification worker.
-- Do not drop outbox rows, attempts, leases, or settled-dispatch evidence.
BEGIN;
SELECT 1;
COMMIT;
