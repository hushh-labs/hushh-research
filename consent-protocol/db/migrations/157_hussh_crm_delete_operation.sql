-- Complete the crm_003 (Hussh) operation set with a delete endpoint, matching
-- crm_001/crm_002 which already carry one. Migration 133 set crm_003's read/
-- create/update/delete response contracts, but the delete row never existed, so
-- its delete UPDATE matched zero rows. This adds the missing delete operation.
--
-- Env-agnostic and idempotent: it only touches crm_003 where that row exists, and
-- is a no-op on re-run. The connection transport/credentials for crm_003 are
-- environment-specific operational state configured out of band (operator apply),
-- never in a migration.

BEGIN;

INSERT INTO crm_operation_endpoints (crm_id, operation, tool_name, response_contract, object_type)
SELECT
  'crm_003',
  'delete',
  'delete-crm-record',
  jsonb_build_object(
    'version', 'crm-mutation-result.v1',
    'successPolicy', 'mcp_is_error_false',
    'requestStyle', 'id_only.v1'
  ),
  NULL
WHERE EXISTS (SELECT 1 FROM enterprise_crm_registry WHERE crm_id = 'crm_003')
ON CONFLICT (crm_id, operation) DO NOTHING;

COMMIT;
