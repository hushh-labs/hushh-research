BEGIN;
-- Bind the existing metadata-only ledger to its actual encrypted Chat owner.
-- Legacy typed_chat/voice/command/document references remain unchanged.
ALTER TABLE one_action_directive_ledger ADD COLUMN IF NOT EXISTS adk_app_name TEXT;
ALTER TABLE one_action_directive_ledger
  DROP CONSTRAINT IF EXISTS one_action_directive_ledger_channel_check,
  DROP CONSTRAINT IF EXISTS one_action_directive_ledger_check,
  DROP CONSTRAINT IF EXISTS adk_chat_action_identity,
  DROP CONSTRAINT IF EXISTS adk_chat_action_session_fk;
ALTER TABLE one_action_directive_ledger
  ADD CONSTRAINT one_action_directive_ledger_channel_check CHECK (
    channel IN ('typed_chat','voice','command','document_review','adk_chat')),
  ADD CONSTRAINT one_action_directive_ledger_check CHECK (
    (channel='typed_chat' AND conversation_id IS NOT NULL AND session_id IS NULL)
    OR (channel IN ('voice','command','adk_chat') AND session_id IS NOT NULL AND conversation_id IS NULL)
    OR (channel='document_review' AND conversation_id IS NULL AND session_id IS NULL)),
  ADD CONSTRAINT adk_chat_action_identity CHECK (
    (channel='adk_chat' AND adk_app_name IS NOT NULL AND adk_app_name='hussh_one' AND requires_confirmation
      AND trusted_activation_required AND resource_binding_hmac IS NOT NULL)
    OR (channel<>'adk_chat' AND adk_app_name IS NULL)),
  ADD CONSTRAINT adk_chat_action_session_fk FOREIGN KEY (adk_app_name,user_id,session_id)
    REFERENCES one_adk_sessions(app_name,user_id,session_id) ON DELETE CASCADE;
COMMIT;
