BEGIN;
-- Private conversations remain in the owner's pod. Shared ADK's session FK
-- stays intact; only the existing metadata ledger accepts this bounded channel.
ALTER TABLE one_action_directive_ledger
  DROP CONSTRAINT IF EXISTS one_action_directive_ledger_channel_check,
  DROP CONSTRAINT IF EXISTS one_action_directive_ledger_check,
  DROP CONSTRAINT IF EXISTS pod_chat_action_identity;
ALTER TABLE one_action_directive_ledger
  ADD CONSTRAINT one_action_directive_ledger_channel_check CHECK (
    channel IN ('typed_chat','voice','command','document_review','adk_chat','pod_chat')),
  ADD CONSTRAINT one_action_directive_ledger_check CHECK (
    (channel='typed_chat' AND conversation_id IS NOT NULL AND session_id IS NULL)
    OR (channel IN ('voice','command','adk_chat','pod_chat') AND session_id IS NOT NULL AND conversation_id IS NULL)
    OR (channel='document_review' AND conversation_id IS NULL AND session_id IS NULL)),
  ADD CONSTRAINT pod_chat_action_identity CHECK (
    channel <> 'pod_chat' OR (
      adk_app_name IS NULL AND action_id='connector.mcp.invoke' AND requires_confirmation
      AND trusted_activation_required AND resource_binding_hmac IS NOT NULL));
COMMIT;
