-- Verified operation response contracts for the Hussh CRM row (crm_003).
--
-- Migration 103 applied response contracts for crm_002 and salesforce-fsc-customer0,
-- but omitted crm_003. This migration sets the response contracts for crm_003
-- so that read, create, update, and delete operations pass contract validation
-- and endpoint_configured is correctly recognized as true on backend list_systems.

BEGIN;

UPDATE crm_operation_endpoints
SET response_contract = jsonb_build_object(
  'version', 'crm-record-collection.v1',
  'recordsPath', jsonb_build_array('payload', 'records'),
  'recordIdPath', jsonb_build_array('Id'),
  'requestStyle', 'id_or_verified_identity.v1'
)
WHERE crm_id = 'crm_003'
  AND operation = 'read';

UPDATE crm_operation_endpoints
SET response_contract = jsonb_build_object(
  'version', 'crm-mutation-result.v1',
  'successPath', jsonb_build_array('payload', 'success'),
  'successValue', true,
  'recordIdPath', jsonb_build_array('payload', 'id'),
  'requestStyle', 'basic_identity_fields.v1'
)
WHERE crm_id = 'crm_003'
  AND operation = 'create';

UPDATE crm_operation_endpoints
SET response_contract = jsonb_build_object(
  'version', 'crm-mutation-result.v1',
  'successPolicy', 'mcp_is_error_false',
  'requestStyle', 'id_additional_fields.v1'
)
WHERE crm_id = 'crm_003'
  AND operation = 'update';

UPDATE crm_operation_endpoints
SET response_contract = jsonb_build_object(
  'version', 'crm-mutation-result.v1',
  'successPolicy', 'mcp_is_error_false',
  'requestStyle', 'id_only.v1'
)
WHERE crm_id = 'crm_003'
  AND operation = 'delete';

COMMIT;
