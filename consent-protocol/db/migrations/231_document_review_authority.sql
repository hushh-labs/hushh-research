-- Additive exact-file authority; never delete external-effect evidence on rollback.
BEGIN;
ALTER TABLE one_action_directive_ledger
  ADD COLUMN IF NOT EXISTS document_request_id UUID,
  ADD COLUMN IF NOT EXISTS document_request_revision BIGINT;
ALTER TABLE one_action_directive_ledger
  DROP CONSTRAINT IF EXISTS one_action_directive_ledger_channel_check,
  DROP CONSTRAINT IF EXISTS one_action_directive_ledger_check,
  DROP CONSTRAINT IF EXISTS document_review_identity_required;
ALTER TABLE one_action_directive_ledger
  ADD CONSTRAINT one_action_directive_ledger_channel_check CHECK (
    channel IN ('typed_chat','voice','command','document_review')
  ),
  ADD CONSTRAINT one_action_directive_ledger_check CHECK (
    (channel='typed_chat' AND conversation_id IS NOT NULL AND session_id IS NULL)
    OR (channel IN ('voice','command') AND session_id IS NOT NULL AND conversation_id IS NULL)
    OR (channel='document_review' AND conversation_id IS NULL AND session_id IS NULL)
  ),
  ADD CONSTRAINT document_review_identity_required CHECK (
    (channel<>'document_review' AND document_request_id IS NULL AND document_request_revision IS NULL)
    OR (channel='document_review' AND document_request_id IS NOT NULL
      AND document_request_revision IS NOT NULL AND document_request_revision>0
      AND operation_id IS NOT NULL AND requires_confirmation AND trusted_activation_required
      AND action_contract_digest ~ '^[0-9a-f]{64}$' AND slots_hmac ~ '^[0-9a-f]{64}$'
      AND resource_binding_hmac IS NOT NULL AND resource_binding_hmac ~ '^[0-9a-f]{64}$'
      AND command_step IS NULL AND step_hmac IS NULL AND command_effect='action')
  );
CREATE UNIQUE INDEX IF NOT EXISTS one_document_review_identity
  ON one_action_directive_ledger(user_id,document_request_id,document_request_revision,action_id)
  WHERE channel='document_review';
COMMIT;
