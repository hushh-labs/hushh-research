BEGIN;
LOCK TABLE one_action_directive_ledger IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM one_action_directive_ledger WHERE channel='pod_chat') THEN
    RAISE EXCEPTION 'Private review history must be retained; disable the capability and keep the compatible schema';
  END IF;
END $$;
ALTER TABLE one_action_directive_ledger
  DROP CONSTRAINT one_action_directive_ledger_channel_check,
  DROP CONSTRAINT one_action_directive_ledger_check;
ALTER TABLE one_action_directive_ledger
  ADD CONSTRAINT one_action_directive_ledger_channel_check CHECK (
    channel IN ('typed_chat','voice','command','document_review','adk_chat')),
  ADD CONSTRAINT one_action_directive_ledger_check CHECK (
    (channel='typed_chat' AND conversation_id IS NOT NULL AND session_id IS NULL)
    OR (channel IN ('voice','command','adk_chat') AND session_id IS NOT NULL AND conversation_id IS NULL)
    OR (channel='document_review' AND conversation_id IS NULL AND session_id IS NULL));
COMMIT;
