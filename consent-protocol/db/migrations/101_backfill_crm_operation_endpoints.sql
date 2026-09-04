-- Backfill the legacy Salesforce registry rows into the per-operation MCP
-- contract. Runtime no longer infers these tools: every executable operation
-- must be declared by its registry row.
--
-- Future CRMs are configured by inserting their own operation rows with their
-- own tool names and endpoints; this migration is only for pre-existing
-- Salesforce records created before the capability-safe registry existed.

BEGIN;

INSERT INTO crm_operation_endpoints (
  crm_id,
  operation,
  tool_name,
  description,
  mcp_endpoint
)
SELECT
  registry.crm_id,
  mapping.operation,
  mapping.tool_name,
  mapping.description,
  CASE
    WHEN mapping.operation = 'delete'
      THEN COALESCE(registry.crm_delete_endpoint, registry.crm_mcp_endpoint)
    ELSE registry.crm_mcp_endpoint
  END
FROM enterprise_crm_registry AS registry
CROSS JOIN (
  VALUES
    ('schema', 'object-schema', 'Discover the registered primary object schema.'),
    ('read', 'read-crm-record', 'Read a record using the registered lookup.'),
    ('create', 'create-crm-record', 'Create a record after explicit approval.'),
    ('update', 'update-crm-record', 'Update a record after explicit approval.'),
    ('delete', 'delete-crm-record', 'Delete a record after explicit approval.')
) AS mapping(operation, tool_name, description)
WHERE LOWER(COALESCE(registry.crm_type, '')) = 'salesforce'
  AND registry.is_active = TRUE
  AND (
    mapping.operation = 'schema'
    OR (mapping.operation = 'read' AND registry.supports_read)
    OR (mapping.operation = 'create' AND registry.supports_create)
    OR (mapping.operation = 'update' AND registry.supports_update)
    OR (mapping.operation = 'delete' AND registry.supports_delete)
  )
ON CONFLICT (crm_id, operation) DO NOTHING;

COMMIT;
