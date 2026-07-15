-- Migration 021: Runtime persona fallback state
-- ============================================
-- Provides backend-persisted last-active persona continuity even when
-- full IAM schema is not yet active in all environments.

BEGIN;

CREATE TABLE IF NOT EXISTS runtime_persona_state (
  user_id TEXT PRIMARY KEY REFERENCES vault_keys(user_id) ON DELETE CASCADE,
  last_active_persona TEXT NOT NULL DEFAULT 'investor',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT runtime_persona_state_persona_check
    CHECK (last_active_persona IN ('investor', 'ria'))
);

CREATE INDEX IF NOT EXISTS idx_runtime_persona_state_updated_at
  ON runtime_persona_state(updated_at DESC);

INSERT INTO runtime_persona_state (user_id, last_active_persona, updated_at)
SELECT
  vk.user_id,
  COALESCE(ap.last_active_persona, 'investor'),
  NOW()
FROM vault_keys vk
LEFT JOIN actor_profiles ap ON ap.user_id = vk.user_id
ON CONFLICT (user_id) DO UPDATE
SET
  last_active_persona = EXCLUDED.last_active_persona,
  updated_at = NOW();

COMMIT;
