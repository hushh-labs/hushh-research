BEGIN;

CREATE TABLE IF NOT EXISTS agent_chat_conversations (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  title_ciphertext TEXT,
  title_iv TEXT,
  title_tag TEXT,
  title_algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
  status TEXT NOT NULL DEFAULT 'active',
  model TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS agent_chat_messages (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES agent_chat_conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  status TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete', 'interrupted', 'error')),
  content_ciphertext TEXT NOT NULL,
  content_iv TEXT NOT NULL,
  content_tag TEXT NOT NULL,
  content_algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
  model TEXT,
  tokens_used INTEGER,
  error_code TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_chat_conversations_user_updated
  ON agent_chat_conversations (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_chat_messages_conversation_created
  ON agent_chat_messages (conversation_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_agent_chat_messages_user_created
  ON agent_chat_messages (user_id, created_at DESC);

COMMIT;
