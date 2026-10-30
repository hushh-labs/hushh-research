-- Non-destructive rollback: disable private registrations while retaining
-- definition identity, encrypted connections and dependent OAuth history.
-- Legacy binaries cannot read these rows because is_active remains false.
BEGIN;
UPDATE external_mcp_connectors
SET owner_enabled = FALSE, is_active = FALSE, updated_at = now()
WHERE user_id IS NOT NULL;
COMMIT;
