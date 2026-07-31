-- ============================================================================
-- Migration 012: User push tokens for FCM/APNs (consent notifications)
-- ============================================================================
-- Stores FCM or APNs device tokens per user for push notifications when
-- consent requests are created (WhatsApp-style delivery when app is closed).
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_push_tokens (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    token TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('web', 'ios', 'android')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_user_push_tokens_user_id ON user_push_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_user_push_tokens_platform ON user_push_tokens(platform);

COMMENT ON TABLE user_push_tokens IS 'FCM/APNs tokens for push notifications (consent requests, etc.)';
