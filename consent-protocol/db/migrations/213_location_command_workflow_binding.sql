BEGIN;

-- Opaque locator only. Owner and capability are verified on every use; the
-- workflow's own retention may outlive or precede command metadata retention.
ALTER TABLE one_action_directive_ledger
  ADD COLUMN IF NOT EXISTS workflow_run_id TEXT;
ALTER TABLE one_action_directive_ledger
  DROP CONSTRAINT IF EXISTS one_action_directive_ledger_command_effect_check;
ALTER TABLE one_action_directive_ledger
  ADD CONSTRAINT one_action_directive_ledger_command_effect_check
  CHECK (command_effect IN ('action','screen','workflow'));
ALTER TABLE one_action_directive_ledger
  DROP CONSTRAINT IF EXISTS one_command_workflow_binding_check;
ALTER TABLE one_action_directive_ledger
  ADD CONSTRAINT one_command_workflow_binding_check CHECK (
    workflow_run_id IS NULL OR (
      channel='command' AND command_effect='workflow'
      AND workflow_run_id ~ '^run_[a-z0-9]{16,96}$'
    )
  );

-- One workflow cursor has one command owner. A second command must recover
-- the existing command instead of obtaining another authority for that run.
CREATE UNIQUE INDEX IF NOT EXISTS one_command_workflow_owner
  ON one_action_directive_ledger(user_id, workflow_run_id)
  WHERE channel='command' AND workflow_run_id IS NOT NULL;

COMMIT;
