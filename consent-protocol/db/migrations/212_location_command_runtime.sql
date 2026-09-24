BEGIN;

-- Extend the existing metadata ledger; no personal inputs or audio are stored.
-- Replay re-runs this file on every deploy, before 231 widens both checks to
-- admit 'document_review'. Re-adding the narrow checks would fail on existing
-- document_review rows (23514, blocking every release) and, even NOT VALID,
-- would reject live document_review writes until 231 re-ran. So this only runs
-- while the channel check does not yet admit 'command' (a first apply); 231's
-- validating ADD proves the final constraints. Same trap as 158, noted in 163.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'one_action_directive_ledger'::regclass
      AND conname = 'one_action_directive_ledger_channel_check'
      AND pg_get_constraintdef(oid) LIKE '%''command''%'
  ) THEN
    ALTER TABLE one_action_directive_ledger DROP CONSTRAINT IF EXISTS one_action_directive_ledger_channel_check;
    ALTER TABLE one_action_directive_ledger DROP CONSTRAINT IF EXISTS one_action_directive_ledger_check;
    ALTER TABLE one_action_directive_ledger ADD CONSTRAINT one_action_directive_ledger_channel_check
      CHECK (channel IN ('typed_chat','voice','command')) NOT VALID;
    ALTER TABLE one_action_directive_ledger ADD CONSTRAINT one_action_directive_ledger_check CHECK (
      (channel='typed_chat' AND conversation_id IS NOT NULL AND session_id IS NULL)
      OR (channel IN ('voice','command') AND session_id IS NOT NULL AND conversation_id IS NULL)
    ) NOT VALID;
  END IF;
END $$;
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
