BEGIN;

-- A person's rating of one assistant turn, so response quality is queryable
-- instead of a local useState that dies with the tab. The row references the
-- ADK session and event by id and stores no message content, no prompt and no
-- model output, so it needs no vault key and no decrypt path. Clearing a
-- rating deletes the row; an absent row means "not rated".
CREATE TABLE IF NOT EXISTS one_agent_message_feedback (
  user_id TEXT NOT NULL,
  app_name TEXT NOT NULL DEFAULT 'hussh_one',
  conversation_ref TEXT NOT NULL,
  message_ref TEXT NOT NULL,
  rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, app_name, conversation_ref, message_ref),
  FOREIGN KEY (app_name, user_id, conversation_ref)
    REFERENCES one_adk_sessions (app_name, user_id, session_id) ON DELETE CASCADE
);

-- The reporting access path: recent negatives first, which is what anyone
-- asking "what is the agent getting wrong" actually reads.
CREATE INDEX IF NOT EXISTS idx_one_agent_message_feedback_rating_recent
  ON one_agent_message_feedback (rating, created_at DESC);

COMMENT ON TABLE one_agent_message_feedback IS
  'Per-person rating of one Agent One assistant turn. Ids and a bounded rating enum only; never message content. Cascades with the conversation and with the account.';

COMMIT;
