-- Migration 022: RIA invite lifecycle support
-- ==========================================
-- Adds private invite persistence for RIA -> investor acquisition flows.

BEGIN;

CREATE TABLE IF NOT EXISTS ria_client_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_token TEXT NOT NULL UNIQUE,
  ria_profile_id UUID NOT NULL REFERENCES ria_profiles(id) ON DELETE CASCADE,
  firm_id UUID REFERENCES ria_firms(id) ON DELETE SET NULL,
  target_display_name TEXT,
  target_email TEXT,
  target_phone TEXT,
  target_investor_user_id TEXT REFERENCES actor_profiles(user_id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  delivery_channel TEXT NOT NULL DEFAULT 'share_link',
  status TEXT NOT NULL DEFAULT 'sent',
  scope_template_id TEXT NOT NULL REFERENCES consent_scope_templates(template_id) ON DELETE RESTRICT,
  duration_mode TEXT NOT NULL DEFAULT 'preset',
  duration_hours INTEGER,
  reason TEXT,
  accepted_by_user_id TEXT REFERENCES actor_profiles(user_id) ON DELETE SET NULL,
  accepted_request_id TEXT,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  accepted_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ria_client_invites_source_check
    CHECK (source IN ('manual', 'marketplace', 'csv')),
  CONSTRAINT ria_client_invites_channel_check
    CHECK (delivery_channel IN ('share_link', 'email', 'sms')),
  CONSTRAINT ria_client_invites_status_check
    CHECK (status IN ('sent', 'accepted', 'expired', 'cancelled')),
  CONSTRAINT ria_client_invites_duration_mode_check
    CHECK (duration_mode IN ('preset', 'custom'))
);

CREATE INDEX IF NOT EXISTS idx_ria_client_invites_ria_profile
  ON ria_client_invites(ria_profile_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ria_client_invites_target_user
  ON ria_client_invites(target_investor_user_id)
  WHERE target_investor_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ria_client_invites_expiry
  ON ria_client_invites(expires_at)
  WHERE status = 'sent';

COMMIT;
