BEGIN;
-- Retained-state rollback: disable DRIVE_PERIOD_PACKETS_ENABLED in deployment.
-- Immutable paid manifests, approvals and source provenance must remain readable.
-- The additive columns and FK deliberately remain for forward recovery.
COMMIT;
