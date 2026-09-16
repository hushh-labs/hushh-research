BEGIN;

-- A domain-issued resource locator is receipt metadata. Names, member lists,
-- personal inputs and model text remain outside the directive ledger.
ALTER TABLE one_action_directive_ledger ADD COLUMN IF NOT EXISTS result_resource_kind TEXT;
ALTER TABLE one_action_directive_ledger ADD COLUMN IF NOT EXISTS result_resource_id UUID;
ALTER TABLE one_action_directive_ledger DROP CONSTRAINT IF EXISTS one_command_resource_receipt_check;
ALTER TABLE one_action_directive_ledger ADD CONSTRAINT one_command_resource_receipt_check CHECK (
  (result_resource_kind IS NULL AND result_resource_id IS NULL) OR
  (channel='command' AND command_effect='action' AND result_resource_kind='circle'
    AND result_resource_id IS NOT NULL)
);

COMMIT;
