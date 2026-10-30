-- One Live Voice runtime state. Metadata only: no audio, no transcripts,
-- no tokens. Entity context holds canonical ids plus the display names the
-- server itself returned, so a spoken name can never become an id.

BEGIN;

CREATE TABLE IF NOT EXISTS one_voice_conversations (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'ended', 'expired')),
  entity_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  screen_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  live_resumption_handle TEXT,
  model_id TEXT NOT NULL,
  model_location TEXT NOT NULL,
  session_count INTEGER NOT NULL DEFAULT 0,
  audio_in_seconds INTEGER NOT NULL DEFAULT 0,
  audio_out_seconds INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  tool_results_ok INTEGER NOT NULL DEFAULT 0,
  tool_results_rejected INTEGER NOT NULL DEFAULT 0,
  narration_without_receipt INTEGER NOT NULL DEFAULT 0,
  unknown_tool_calls INTEGER NOT NULL DEFAULT 0,
  last_close_code INTEGER,
  last_close_reason_class TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '2 hours')
);

CREATE INDEX IF NOT EXISTS one_voice_conversations_user_idx
  ON one_voice_conversations (user_id, last_seen_at DESC);

COMMENT ON TABLE one_voice_conversations IS
  'One Live Voice conversation ledger: canonical entity context and session counters. No audio or transcripts.';
COMMENT ON COLUMN one_voice_conversations.live_resumption_handle IS
  'Provider session-resumption handle. Opaque and useless without the service identity (ADC).';

CREATE TABLE IF NOT EXISTS one_voice_pending_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES one_voice_conversations(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  gateway_action_id TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('voice', 'tap')),
  args JSONB NOT NULL,
  summary TEXT NOT NULL,
  receipt_token_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'executed', 'failed', 'cancelled', 'expired')),
  shown_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  confirmation_source TEXT
    CHECK (confirmation_source IS NULL OR confirmation_source IN ('voice', 'tap', 'http')),
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT one_voice_pending_actions_tap_receipt CHECK (
    tier <> 'tap' OR receipt_token_hash IS NOT NULL
  )
);

-- One open confirmation per conversation: a new mutation cancels the prior one.
CREATE UNIQUE INDEX IF NOT EXISTS one_voice_pending_actions_one_open
  ON one_voice_pending_actions (conversation_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS one_voice_pending_actions_user_idx
  ON one_voice_pending_actions (user_id, created_at DESC);

COMMENT ON TABLE one_voice_pending_actions IS
  'Confirmation-gated voice mutations. args hold canonical ids only; receipts are hashed; never transcripts.';

-- Refresh migration 201's tombstone write guards for the new account-keyed
-- tables. Guarded so partial test schemas without 201 still apply cleanly;
-- every release lane runs 201 before this migration (manifest order).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;

COMMIT;
