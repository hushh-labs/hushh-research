-- Persistent RIA marketplace deck actions.
--
-- Public SEC profiles are discovery leads, not consent subjects. This table
-- records the RIA-side deck state for pass, shortlist, view-more, and
-- connection-request intents without pretending public SEC profiles are Hushh
-- users.

CREATE TABLE IF NOT EXISTS marketplace_investor_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  ria_profile_id UUID REFERENCES ria_profiles(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL,
  target_key TEXT NOT NULL,
  target_user_id TEXT REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  public_profile_id BIGINT REFERENCES investor_profiles(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  target_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT marketplace_investor_actions_source_type_check
    CHECK (source_type IN ('hushh_user', 'public_sec')),
  CONSTRAINT marketplace_investor_actions_action_check
    CHECK (action IN ('view_more', 'pass', 'shortlist', 'connect_request')),
  CONSTRAINT marketplace_investor_actions_status_check
    CHECK (status IN ('viewed', 'passed', 'shortlisted', 'connect_requested')),
  CONSTRAINT marketplace_investor_actions_target_check
    CHECK (
      (source_type = 'public_sec' AND public_profile_id IS NOT NULL AND target_user_id IS NULL)
      OR
      (source_type = 'hushh_user' AND target_user_id IS NOT NULL AND public_profile_id IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_marketplace_investor_actions_actor_target
  ON marketplace_investor_actions(actor_user_id, target_key);

CREATE INDEX IF NOT EXISTS idx_marketplace_investor_actions_ria_status
  ON marketplace_investor_actions(ria_profile_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketplace_investor_actions_public_profile
  ON marketplace_investor_actions(public_profile_id, status, updated_at DESC)
  WHERE public_profile_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_marketplace_investor_actions_target_user
  ON marketplace_investor_actions(target_user_id, status, updated_at DESC)
  WHERE target_user_id IS NOT NULL;
