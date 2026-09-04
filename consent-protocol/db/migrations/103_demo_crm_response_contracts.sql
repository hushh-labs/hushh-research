-- Verified operation response contracts for the two active demo CRM rows.
--
-- Captured against the registered Streamable HTTP MCP tools using an isolated
-- synthetic lifecycle on 2026-07-17:
-- create -> ID read -> update/readback -> delete -> absent ID read.
--
-- Update and delete intentionally produce an empty successful MCP tool result.
-- Their explicit success policy is therefore `mcp_is_error_false`, followed by
-- a registered state readback; this is not an inference from Salesforce names
-- or a non-empty response body.

BEGIN;

UPDATE crm_operation_endpoints
SET response_contract = jsonb_build_object(
  'version', 'crm-record-collection.v1',
  'recordsPath', jsonb_build_array('payload', 'records'),
  'recordIdPath', jsonb_build_array('Id'),
  'requestStyle', 'id_or_verified_identity.v1'
)
WHERE crm_id IN ('crm_002', 'salesforce-fsc-customer0')
  AND operation = 'read';

UPDATE crm_operation_endpoints
SET response_contract = jsonb_build_object(
  'version', 'crm-mutation-result.v1',
  'successPath', jsonb_build_array('payload', 'success'),
  'successValue', true,
  'recordIdPath', jsonb_build_array('payload', 'id'),
  'requestStyle', 'basic_identity_fields.v1'
)
WHERE crm_id IN ('crm_002', 'salesforce-fsc-customer0')
  AND operation = 'create';

UPDATE crm_operation_endpoints
SET response_contract = jsonb_build_object(
  'version', 'crm-mutation-result.v1',
  'successPolicy', 'mcp_is_error_false',
  'requestStyle', 'id_additional_fields.v1'
)
WHERE crm_id IN ('crm_002', 'salesforce-fsc-customer0')
  AND operation = 'update';

UPDATE crm_operation_endpoints
SET response_contract = jsonb_build_object(
  'version', 'crm-mutation-result.v1',
  'successPolicy', 'mcp_is_error_false',
  'requestStyle', 'id_only.v1'
)
WHERE crm_id IN ('crm_002', 'salesforce-fsc-customer0')
  AND operation = 'delete';

COMMIT;
