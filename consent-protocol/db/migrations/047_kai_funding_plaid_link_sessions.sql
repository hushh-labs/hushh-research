-- Plaid funding OAuth resume sessions for bank institutions that redirect out of Link.

CREATE TABLE IF NOT EXISTS kai_funding_plaid_link_sessions (
    resume_session_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    item_id TEXT REFERENCES kai_funding_plaid_items(item_id) ON DELETE SET NULL,
    mode TEXT NOT NULL CHECK (mode IN ('create', 'update')),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'completed', 'expired', 'canceled')),
    redirect_uri TEXT NOT NULL,
    link_token TEXT NOT NULL,
    expires_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kai_funding_plaid_link_sessions_user_status
    ON kai_funding_plaid_link_sessions(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_kai_funding_plaid_link_sessions_expires_at
    ON kai_funding_plaid_link_sessions(expires_at DESC);
