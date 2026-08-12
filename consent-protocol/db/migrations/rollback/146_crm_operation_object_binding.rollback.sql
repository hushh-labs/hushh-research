BEGIN;

ALTER TABLE crm_operation_endpoints
  DROP COLUMN IF EXISTS object_type;

COMMIT;
