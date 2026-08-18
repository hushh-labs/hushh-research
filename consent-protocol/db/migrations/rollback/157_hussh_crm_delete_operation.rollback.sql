-- Rollback for 157_hussh_crm_delete_operation.sql
-- Removes only the crm_003 delete operation endpoint that migration 157 added.

BEGIN;

DELETE FROM crm_operation_endpoints
WHERE crm_id = 'crm_003'
  AND operation = 'delete';

COMMIT;
