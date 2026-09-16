BEGIN;

-- Extend the existing metadata ledger; no personal inputs or audio are stored.
ALTER TABLE one_action_directive_ledger DROP CONSTRAINT IF EXISTS one_action_directive_ledger_channel_check;
ALTER TABLE one_action_directive_ledger DROP CONSTRAINT IF EXISTS one_action_directive_ledger_check;
ALTER TABLE one_action_directive_ledger ADD CONSTRAINT one_action_directive_ledger_channel_check
  CHECK (channel IN ('typed_chat','voice','command'));
ALTER TABLE one_action_directive_ledger ADD CONSTRAINT one_action_directive_ledger_check CHECK (
  (channel='typed_chat' AND conversation_id IS NOT NULL AND session_id IS NULL)
  OR (channel IN ('voice','command') AND session_id IS NOT NULL AND conversation_id IS NULL)
);
ALTER TABLE one_action_directive_ledger ADD COLUMN IF NOT EXISTS command_effect TEXT NOT NULL DEFAULT 'action' CHECK (command_effect IN ('action','screen'));
ALTER TABLE one_action_directive_ledger ADD COLUMN IF NOT EXISTS step_hmac TEXT;
ALTER TABLE one_action_directive_ledger ADD COLUMN IF NOT EXISTS command_step INTEGER;
ALTER TABLE one_action_directive_ledger ADD COLUMN IF NOT EXISTS operation_id TEXT;
ALTER TABLE one_action_directive_ledger ADD COLUMN IF NOT EXISTS execution_receipt_hash TEXT;
ALTER TABLE one_action_directive_ledger DROP CONSTRAINT IF EXISTS command_identity_required;
ALTER TABLE one_action_directive_ledger ADD CONSTRAINT command_identity_required CHECK (
  channel <> 'command' OR (command_step IS NOT NULL AND command_step >= 0 AND command_step < 12 AND operation_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_command_step_identity
  ON one_action_directive_ledger(user_id,session_id,command_step) WHERE channel='command';
CREATE UNIQUE INDEX IF NOT EXISTS one_command_operation_identity
  ON one_action_directive_ledger(operation_id) WHERE operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS one_command_checkpoint_expiry
  ON one_adk_sessions(created_at) WHERE app_name='one.location.commands.v1';

ALTER TABLE one_adk_sessions ADD COLUMN IF NOT EXISTS command_status TEXT;
ALTER TABLE one_adk_sessions ADD COLUMN IF NOT EXISTS command_plan_hmac TEXT;

COMMIT;
