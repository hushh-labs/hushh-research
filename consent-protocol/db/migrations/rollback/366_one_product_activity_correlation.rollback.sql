BEGIN;
DROP INDEX IF EXISTS one_product_activity_operation;
ALTER TABLE one_product_activity_observations DROP COLUMN IF EXISTS operation_key;
COMMIT;
