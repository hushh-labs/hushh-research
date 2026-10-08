-- Additive dev-only multi-device registry. Keep user_push_tokens and its
-- owner/platform uniqueness unchanged for old backend/client compatibility.
BEGIN;
CREATE TABLE IF NOT EXISTS user_push_devices (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    platform TEXT NOT NULL CHECK (platform IN ('web', 'ios', 'android')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_push_devices_owner ON user_push_devices(user_id);
ALTER TABLE user_push_devices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON user_push_devices FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
            EXECUTE format('REVOKE ALL ON user_push_devices FROM %I', role_name);
        END IF;
    END LOOP;
END $$;
COMMIT;
