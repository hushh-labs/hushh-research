-- Capability-safe Connected Systems contract.
--
-- A CRM operation is executable only when its registry capability, MCP tool,
-- and transport endpoint are all configured. Endpoints are stored per
-- operation so a connector may route delete differently without special-case
-- runtime code.

BEGIN;

ALTER TABLE crm_operation_endpoints
  ADD COLUMN IF NOT EXISTS mcp_endpoint TEXT;

UPDATE crm_operation_endpoints AS operation
SET mcp_endpoint = CASE
  WHEN operation.operation = 'delete'
    THEN COALESCE(registry.crm_delete_endpoint, registry.crm_mcp_endpoint)
  ELSE registry.crm_mcp_endpoint
END
FROM enterprise_crm_registry AS registry
WHERE registry.crm_id = operation.crm_id
  AND operation.mcp_endpoint IS NULL;

ALTER TABLE connected_system_intents
  DROP CONSTRAINT IF EXISTS connected_system_intents_action_check;

ALTER TABLE connected_system_intents
  ADD CONSTRAINT connected_system_intents_action_check
  CHECK (action IN ('create', 'update', 'delete'));

COMMIT;
