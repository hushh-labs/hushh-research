BEGIN;

-- Existing phase hashes cannot be reversed or safely paired. Historical rows
-- deliberately remain uncorrelated; only new dispatch/SDK observations fill it.
ALTER TABLE one_product_activity_observations
  ADD COLUMN IF NOT EXISTS operation_key CHAR(64)
    CHECK (operation_key IS NULL OR operation_key ~ '^[a-f0-9]{64}$');
CREATE INDEX IF NOT EXISTS one_product_activity_operation
  ON one_product_activity_observations(user_id,generation,agent_id,operation_key,observed_at)
  WHERE operation_key IS NOT NULL;
COMMENT ON COLUMN one_product_activity_observations.operation_key IS
  'Phase-independent opaque execution correlation. NULL means uncorrelated; absence of a terminal observation is not confirmed abandonment or a business outcome.';

COMMIT;
