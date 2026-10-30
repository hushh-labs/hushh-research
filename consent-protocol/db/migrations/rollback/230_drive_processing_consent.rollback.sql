-- Disable ingestion before code rollback. Retain consent evidence and encrypted
-- indexes; old processor code must not be enabled without this admission fence.
BEGIN;
SELECT 1;
COMMIT;
