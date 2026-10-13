-- Alpaca OAuth connect sessions for one-time state validation + replay protection.

CREATE TABLE IF NOT EXISTS kai_funding_alpaca_connect_sessions (
    session_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    state TEXT NOT NULL UNIQUE,
    redirect_uri TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'completed', 'failed', 'expired', 'replayed')),
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_code TEXT,
    error_message TEXT,
    consumed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kai_funding_alpaca_connect_sessions_user
    ON kai_funding_alpaca_connect_sessions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_kai_funding_alpaca_connect_sessions_status
    ON kai_funding_alpaca_connect_sessions(status, created_at DESC);

