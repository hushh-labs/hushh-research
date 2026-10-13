-- Kai Plaid portfolio source persistence

CREATE TABLE IF NOT EXISTS kai_plaid_items (
    item_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    access_token_ciphertext TEXT NOT NULL,
    access_token_iv TEXT NOT NULL,
    access_token_tag TEXT NOT NULL,
    access_token_algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
    institution_id TEXT,
    institution_name TEXT,
    plaid_env TEXT NOT NULL DEFAULT 'sandbox',
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'relink_required', 'permission_revoked', 'error', 'removed')),
    sync_status TEXT NOT NULL DEFAULT 'idle'
        CHECK (sync_status IN ('idle', 'running', 'completed', 'failed', 'action_required', 'stale')),
    last_sync_at TIMESTAMPTZ,
    last_refresh_requested_at TIMESTAMPTZ,
    last_webhook_type TEXT,
    last_webhook_code TEXT,
    last_error_code TEXT,
    last_error_message TEXT,
    latest_accounts_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    latest_holdings_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    latest_securities_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    latest_transactions_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    latest_summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    latest_portfolio_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    latest_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kai_plaid_items_user_id
    ON kai_plaid_items(user_id);
CREATE INDEX IF NOT EXISTS idx_kai_plaid_items_user_status
    ON kai_plaid_items(user_id, status);
CREATE INDEX IF NOT EXISTS idx_kai_plaid_items_last_sync
    ON kai_plaid_items(last_sync_at DESC);

CREATE TABLE IF NOT EXISTS kai_plaid_refresh_runs (
    run_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES kai_plaid_items(item_id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    trigger_source TEXT NOT NULL,
    refresh_method TEXT,
    fallback_reason TEXT,
    webhook_type TEXT,
    webhook_code TEXT,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_code TEXT,
    error_message TEXT,
    result_summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kai_plaid_refresh_runs_user_id
    ON kai_plaid_refresh_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_kai_plaid_refresh_runs_item_requested
    ON kai_plaid_refresh_runs(item_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_kai_plaid_refresh_runs_status
    ON kai_plaid_refresh_runs(status, requested_at DESC);

CREATE TABLE IF NOT EXISTS kai_plaid_link_sessions (
    resume_session_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    item_id TEXT REFERENCES kai_plaid_items(item_id) ON DELETE SET NULL,
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

CREATE INDEX IF NOT EXISTS idx_kai_plaid_link_sessions_user_status
    ON kai_plaid_link_sessions(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kai_plaid_link_sessions_expires_at
    ON kai_plaid_link_sessions(expires_at DESC);

CREATE TABLE IF NOT EXISTS kai_portfolio_source_preferences (
    user_id TEXT PRIMARY KEY REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    active_source TEXT NOT NULL DEFAULT 'statement'
        CHECK (active_source IN ('statement', 'plaid', 'combined')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
