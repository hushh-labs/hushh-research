-- Backfill the verified demo lifecycle response contracts onto the active
-- Macy's enterprise registry row. Migration 103 covered the historical public
-- alias but the deployed enterprise row is `crm_001`; missing contracts make
-- otherwise configured operations fail closed.

BEGIN;

UPDATE crm_operation_endpoints
SET response_contract = jsonb_build_object(
  'version', 'crm-record-collection.v1',
  'recordsPath', jsonb_build_array('payload', 'records'),
  'recordIdPath', jsonb_build_array('Id'),
  'requestStyle', 'id_or_verified_identity.v1'
)
WHERE crm_id IN (
  SELECT crm_id
  FROM enterprise_crm_registry
  WHERE crm_id = 'crm_001'
     OR LOWER(REPLACE(crm_enterprise_name, '''', '')) = 'macys'
)
  AND operation = 'read';

UPDATE crm_operation_endpoints
SET response_contract = jsonb_build_object(
  'version', 'crm-mutation-result.v1',
  'successPath', jsonb_build_array('payload', 'success'),
  'successValue', true,
  'recordIdPath', jsonb_build_array('payload', 'id'),
  'requestStyle', 'basic_identity_fields.v1'
)
WHERE crm_id IN (
  SELECT crm_id
  FROM enterprise_crm_registry
  WHERE crm_id = 'crm_001'
     OR LOWER(REPLACE(crm_enterprise_name, '''', '')) = 'macys'
)
  AND operation = 'create';

UPDATE crm_operation_endpoints
SET response_contract = jsonb_build_object(
  'version', 'crm-mutation-result.v1',
  'successPolicy', 'mcp_is_error_false',
  'requestStyle', 'id_additional_fields.v1'
)
WHERE crm_id IN (
  SELECT crm_id
  FROM enterprise_crm_registry
  WHERE crm_id = 'crm_001'
     OR LOWER(REPLACE(crm_enterprise_name, '''', '')) = 'macys'
)
  AND operation = 'update';

UPDATE crm_operation_endpoints
SET response_contract = jsonb_build_object(
  'version', 'crm-mutation-result.v1',
  'successPolicy', 'mcp_is_error_false',
  'requestStyle', 'id_only.v1'
)
WHERE crm_id IN (
  SELECT crm_id
  FROM enterprise_crm_registry
  WHERE crm_id = 'crm_001'
     OR LOWER(REPLACE(crm_enterprise_name, '''', '')) = 'macys'
)
  AND operation = 'delete';

COMMIT;
