-- Forward-only additive release: preserve public evidence and owner handoff
-- receipts if the feature is disabled. The runtime flag is the rollback switch.
BEGIN;
SELECT 1;
COMMIT;
