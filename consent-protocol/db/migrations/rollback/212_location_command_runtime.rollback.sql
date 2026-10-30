BEGIN;
-- Stop command traffic before rollback. Preserve receipts and encrypted recovery
-- metadata in a dedicated rollback archive; owner capsules are removed because
-- the previous runtime cannot resume them. Existing typed/chat clients keep working.
CREATE TABLE one_command_receipts_212_archive AS
  SELECT * FROM one_action_directive_ledger WHERE channel='command';
DELETE FROM one_action_directive_ledger WHERE channel='command';
DELETE FROM one_adk_sessions WHERE app_name='one.location.commands.v1';
DROP INDEX one_command_checkpoint_expiry;
DROP INDEX one_command_step_identity;
DROP INDEX one_command_operation_identity;
ALTER TABLE one_action_directive_ledger DROP CONSTRAINT command_identity_required;
ALTER TABLE one_action_directive_ledger DROP COLUMN command_step;
ALTER TABLE one_action_directive_ledger DROP COLUMN operation_id;
ALTER TABLE one_action_directive_ledger DROP COLUMN execution_receipt_hash;
ALTER TABLE one_action_directive_ledger DROP CONSTRAINT one_action_directive_ledger_channel_check;
ALTER TABLE one_action_directive_ledger DROP CONSTRAINT one_action_directive_ledger_check;
ALTER TABLE one_action_directive_ledger ADD CONSTRAINT one_action_directive_ledger_channel_check
  CHECK (channel IN ('typed_chat','voice'));
ALTER TABLE one_action_directive_ledger ADD CONSTRAINT one_action_directive_ledger_check CHECK (
  (channel='typed_chat' AND conversation_id IS NOT NULL AND session_id IS NULL)
  OR (channel='voice' AND session_id IS NOT NULL AND conversation_id IS NULL)
);
ALTER TABLE one_action_directive_ledger DROP COLUMN command_effect;
ALTER TABLE one_action_directive_ledger DROP COLUMN step_hmac;
ALTER TABLE one_adk_sessions DROP COLUMN command_status;
ALTER TABLE one_adk_sessions DROP COLUMN command_plan_hmac;
COMMIT;
