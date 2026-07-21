-- Migration 113: release-manifested Kai Plaid portfolio tables.
--
-- The original Plaid table DDL lived in 023/024, but those files were not part
-- of the canonical release manifest. This forward migration intentionally
-- subsumes that shape so UAT/production deploys can create and verify the
-- provider-cache tables through the governed release lane.

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

ALTER TABLE kai_plaid_items ADD COLUMN IF NOT EXISTS access_token_ciphertext TEXT;
ALTER TABLE kai_plaid_items ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE kai_plaid_items ADD COLUMN IF NOT EXISTS access_token_iv TEXT;
ALTER TABLE kai_plaid_items ADD COLUMN IF NOT EXISTS access_token_tag TEXT;
ALTER TABLE kai_plaid_items ADD COLUMN IF NOT EXISTS access_token_algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm';
ALTER TABLE kai_plaid_items ADD COLUMN IF NOT EXISTS institution_id TEXT;
ALTER TABLE kai_plaid_items ADD COLUMN IF NOT EXISTS institution_name TEXT;
ALTER TABLE kai_plaid_items ADD COLUMN IF NOT EXISTS plaid_env TEXT NOT NULL DEFAULT 'sandbox';
ALTER TABLE kai_plaid_items ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE kai_plaid_items ADD COLUMN IF NOT EXISTS sync_status TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE kai_plaid_items ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMPTZ;
ALTER TABLE kai_plaid_items ADD COLUMN IF NOT EXISTS last_refresh_requested_at TIMESTAMPTZ;
ALTER TABLE kai_plaid_items ADD COLUMN IF NOT EXISTS last_webhook_type TEXT;
ALTER TABLE kai_plaid_items ADD COLUMN IF NOT EXISTS last_webhook_code TEXT;
ALTER TABLE kai_plaid_items ADD COLUMN IF NOT EXISTS last_error_code TEXT;
ALTER TABLE kai_plaid_items ADD COLUMN IF NOT EXISTS last_error_message TEXT;
ALTER TABLE kai_plaid_items ADD COLUMN IF NOT EXISTS latest_accounts_json JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE kai_plaid_items ADD COLUMN IF NOT EXISTS latest_holdings_json JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE kai_plaid_items ADD COLUMN IF NOT EXISTS latest_securities_json JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE kai_plaid_items ADD COLUMN IF NOT EXISTS latest_transactions_json JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE kai_plaid_items ADD COLUMN IF NOT EXISTS latest_summary_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE kai_plaid_items ADD COLUMN IF NOT EXISTS latest_portfolio_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE kai_plaid_items ADD COLUMN IF NOT EXISTS latest_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE kai_plaid_items ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE kai_plaid_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE kai_plaid_items
    DROP CONSTRAINT IF EXISTS kai_plaid_items_status_check;
ALTER TABLE kai_plaid_items
    ADD CONSTRAINT kai_plaid_items_status_check
    CHECK (status IN ('active', 'relink_required', 'permission_revoked', 'error', 'removed'));
ALTER TABLE kai_plaid_items
    DROP CONSTRAINT IF EXISTS kai_plaid_items_sync_status_check;
ALTER TABLE kai_plaid_items
    ADD CONSTRAINT kai_plaid_items_sync_status_check
    CHECK (sync_status IN ('idle', 'running', 'completed', 'failed', 'action_required', 'stale'));

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
    status TEXT NOT NULL DEFAULT 'queued',
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

ALTER TABLE kai_plaid_refresh_runs ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE kai_plaid_refresh_runs ADD COLUMN IF NOT EXISTS item_id TEXT;
ALTER TABLE kai_plaid_refresh_runs ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE kai_plaid_refresh_runs ADD COLUMN IF NOT EXISTS trigger_source TEXT;
ALTER TABLE kai_plaid_refresh_runs ADD COLUMN IF NOT EXISTS refresh_method TEXT;
ALTER TABLE kai_plaid_refresh_runs ADD COLUMN IF NOT EXISTS fallback_reason TEXT;
ALTER TABLE kai_plaid_refresh_runs ADD COLUMN IF NOT EXISTS webhook_type TEXT;
ALTER TABLE kai_plaid_refresh_runs ADD COLUMN IF NOT EXISTS webhook_code TEXT;
ALTER TABLE kai_plaid_refresh_runs ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE kai_plaid_refresh_runs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE kai_plaid_refresh_runs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE kai_plaid_refresh_runs ADD COLUMN IF NOT EXISTS error_code TEXT;
ALTER TABLE kai_plaid_refresh_runs ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE kai_plaid_refresh_runs ADD COLUMN IF NOT EXISTS result_summary_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE kai_plaid_refresh_runs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE kai_plaid_refresh_runs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE kai_plaid_refresh_runs
    DROP CONSTRAINT IF EXISTS kai_plaid_refresh_runs_status_check;
ALTER TABLE kai_plaid_refresh_runs
    ADD CONSTRAINT kai_plaid_refresh_runs_status_check
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'canceled'));

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

ALTER TABLE kai_plaid_link_sessions ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE kai_plaid_link_sessions ADD COLUMN IF NOT EXISTS item_id TEXT;
ALTER TABLE kai_plaid_link_sessions ADD COLUMN IF NOT EXISTS mode TEXT;
ALTER TABLE kai_plaid_link_sessions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE kai_plaid_link_sessions ADD COLUMN IF NOT EXISTS redirect_uri TEXT;
ALTER TABLE kai_plaid_link_sessions ADD COLUMN IF NOT EXISTS link_token TEXT;
ALTER TABLE kai_plaid_link_sessions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE kai_plaid_link_sessions ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE kai_plaid_link_sessions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE kai_plaid_link_sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE kai_plaid_link_sessions
    DROP CONSTRAINT IF EXISTS kai_plaid_link_sessions_mode_check;
ALTER TABLE kai_plaid_link_sessions
    ADD CONSTRAINT kai_plaid_link_sessions_mode_check
    CHECK (mode IN ('create', 'update'));
ALTER TABLE kai_plaid_link_sessions
    DROP CONSTRAINT IF EXISTS kai_plaid_link_sessions_status_check;
ALTER TABLE kai_plaid_link_sessions
    ADD CONSTRAINT kai_plaid_link_sessions_status_check
    CHECK (status IN ('active', 'completed', 'expired', 'canceled'));

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

ALTER TABLE kai_portfolio_source_preferences ADD COLUMN IF NOT EXISTS active_source TEXT NOT NULL DEFAULT 'statement';
ALTER TABLE kai_portfolio_source_preferences ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE kai_portfolio_source_preferences ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE kai_portfolio_source_preferences
    DROP CONSTRAINT IF EXISTS kai_portfolio_source_preferences_active_source_check;
ALTER TABLE kai_portfolio_source_preferences
    ADD CONSTRAINT kai_portfolio_source_preferences_active_source_check
    CHECK (active_source IN ('statement', 'plaid', 'combined'));
