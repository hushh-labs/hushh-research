-- Per-operation response contracts make the CRM registry the complete
-- executable integration definition. The values are non-secret MCP response
-- mappings; credentials remain on the parent registry row.
--
-- Schema contract v1 requires an explicit path to the field collection and
-- field access metadata. A missing or incomplete field access declaration is
-- display-only: runtime must never infer that a CRM field is readable or
-- writable.

BEGIN;

ALTER TABLE crm_operation_endpoints
  ADD COLUMN IF NOT EXISTS response_contract JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE crm_operation_endpoints
  DROP CONSTRAINT IF EXISTS crm_operation_endpoints_response_contract_object;

ALTER TABLE crm_operation_endpoints
  ADD CONSTRAINT crm_operation_endpoints_response_contract_object
  CHECK (jsonb_typeof(response_contract) = 'object');

-- Existing Salesforce rows currently return their describe payload at
-- details[0].fields. Backfill the response shape so the runtime can display
-- the discovered field catalogue while it keeps record operations disabled
-- until MuleSoft adds the v1 access flags to every descriptor.
UPDATE crm_operation_endpoints
SET response_contract = jsonb_build_object(
  'version', 'crm-primary-object-schema.v1',
  'fieldsPath', jsonb_build_array('payload', 'details', 0, 'fields'),
  'objectPath', jsonb_build_array('payload', 'details', 0),
  'requireFieldAccess', true
)
WHERE response_contract = '{}'::jsonb
  AND operation = 'schema'
  AND EXISTS (
    SELECT 1
    FROM enterprise_crm_registry registry
    WHERE registry.crm_id = crm_operation_endpoints.crm_id
      AND LOWER(COALESCE(registry.crm_type, '')) = 'salesforce'
  );

COMMIT;
