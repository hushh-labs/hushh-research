BEGIN;

-- Metadata-only authority ledger for one-time private-agent actions. Raw slots,
-- prompts, credentials, exports, and protected information are never stored.
CREATE TABLE IF NOT EXISTS one_action_directive_ledger (
  directive_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL DEFAULT 'action.directive.v1',
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('typed_chat', 'voice')),
  conversation_id UUID REFERENCES agent_chat_conversations(id) ON DELETE CASCADE,
  session_id TEXT,
  action_id TEXT NOT NULL,
  context_revision TEXT NOT NULL,
  action_contract_digest TEXT NOT NULL,
  slots_hmac TEXT NOT NULL,
  resource_binding_hmac TEXT,
  requires_confirmation BOOLEAN NOT NULL DEFAULT TRUE,
  trusted_activation_required BOOLEAN NOT NULL DEFAULT FALSE,
  state TEXT NOT NULL DEFAULT 'issued'
    CHECK (state IN ('issued', 'confirmed', 'consumed', 'settled', 'cancelled', 'expired')),
  receipt_hash TEXT UNIQUE,
  settlement_status TEXT,
  settlement_reason_code TEXT,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  CHECK (
    (channel = 'typed_chat' AND conversation_id IS NOT NULL AND session_id IS NULL)
    OR (channel = 'voice' AND session_id IS NOT NULL AND conversation_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_one_action_directive_user_conversation
  ON one_action_directive_ledger (user_id, conversation_id, issued_at DESC)
  WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_one_action_directive_user_session
  ON one_action_directive_ledger (user_id, session_id, issued_at DESC)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_one_action_directive_expiry
  ON one_action_directive_ledger (expires_at)
  WHERE state IN ('issued', 'confirmed');

COMMIT;
