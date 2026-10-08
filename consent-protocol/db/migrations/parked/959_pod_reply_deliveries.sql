-- Dev-only hub routing metadata. No chat text, title, key or provider credential.
-- Owner: OneReplyDelivery; pending selection by owner/event; six-hour expiry.
-- Delete retired receipts after one day; owner deletion cascades. POD log
-- retains sealed signal receipts until owner erasure, with a bounded checkpoint.
BEGIN;
CREATE TABLE IF NOT EXISTS one_reply_deliveries (
    user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
    hushh_id TEXT NOT NULL,
    event_id TEXT NOT NULL CHECK (event_id ~ '^[0-9a-f]{64}$'),
    conversation_id TEXT NOT NULL CHECK (conversation_id ~ '^[A-Za-z0-9_-]{8,128}$'),
    run_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'read', 'no_device')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
    accepted_devices JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(accepted_devices) = 'array'),
    leased_until TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, event_id),
    CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS idx_one_reply_deliveries_expiry ON one_reply_deliveries(expires_at);
ALTER TABLE one_reply_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON one_reply_deliveries FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
            EXECUTE format('REVOKE ALL ON one_reply_deliveries FROM %I', role_name);
        END IF;
    END LOOP;
END $$;
COMMIT;
