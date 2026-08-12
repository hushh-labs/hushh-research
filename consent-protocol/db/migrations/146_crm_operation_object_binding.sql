-- Registry-owned CRM object roles.
-- A Person Account create can therefore use Account while verified discovery,
-- read, update, and delete use a separately bound Contact record.

BEGIN;

ALTER TABLE crm_operation_endpoints
  ADD COLUMN IF NOT EXISTS object_type TEXT;

COMMIT;
