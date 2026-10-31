-- Rollback for migration 239: recreate the server-held Plaid custody and
-- funding tables EMPTY, with the DDL of migrations 113, 038, 044, 045 and the
-- funding Feed projection from 179, copied verbatim. Rows deleted by
-- scripts/ops/plaid_server_custody_retire.py and Items removed at Plaid are not
-- restored; people re-link through the vault flow either way.
--
-- kai_plaid_user_profile_cache is not recreated: no governed migration ever
-- created it.

BEGIN;

-- ---- from 113_kai_plaid_portfolio_tables.sql ----
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

-- ---- from 038_kai_alpaca_funding_orchestration.sql ----
-- Kai embedded funding orchestration (Plaid Auth + Alpaca Broker ACH/Transfers)

CREATE TABLE IF NOT EXISTS kai_funding_brokerage_accounts (
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'alpaca',
    alpaca_account_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive', 'restricted', 'closed', 'error')),
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    account_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, alpaca_account_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_kai_funding_default_brokerage_account
    ON kai_funding_brokerage_accounts(user_id)
    WHERE is_default = TRUE;

CREATE TABLE IF NOT EXISTS kai_funding_plaid_items (
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
    latest_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_error_code TEXT,
    last_error_message TEXT,
    last_webhook_type TEXT,
    last_webhook_code TEXT,
    last_synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kai_funding_plaid_items_user
    ON kai_funding_plaid_items(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_kai_funding_plaid_items_status
    ON kai_funding_plaid_items(user_id, status, updated_at DESC);

-- From the retired 047_kai_funding_plaid_link_sessions migration.
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

CREATE TABLE IF NOT EXISTS kai_funding_plaid_accounts (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES kai_funding_plaid_items(item_id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    account_name TEXT,
    official_name TEXT,
    mask TEXT,
    account_type TEXT,
    account_subtype TEXT,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    account_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, item_id, account_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_kai_funding_default_plaid_account
    ON kai_funding_plaid_accounts(user_id)
    WHERE is_default = TRUE;

CREATE INDEX IF NOT EXISTS idx_kai_funding_plaid_accounts_item
    ON kai_funding_plaid_accounts(item_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS kai_funding_consent_records (
    consent_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    item_id TEXT REFERENCES kai_funding_plaid_items(item_id) ON DELETE SET NULL,
    account_id TEXT,
    terms_version TEXT NOT NULL,
    consented_at TIMESTAMPTZ NOT NULL,
    disclosure_version TEXT,
    consent_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kai_funding_consents_user
    ON kai_funding_consent_records(user_id, consented_at DESC);

CREATE TABLE IF NOT EXISTS kai_funding_ach_relationships (
    relationship_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    alpaca_account_id TEXT NOT NULL,
    item_id TEXT NOT NULL REFERENCES kai_funding_plaid_items(item_id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    processor_token_ciphertext TEXT NOT NULL,
    processor_token_iv TEXT NOT NULL,
    processor_token_tag TEXT NOT NULL,
    processor_token_algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'pending', 'submitted', 'approved', 'rejected', 'canceled', 'disabled', 'error')),
    status_reason_code TEXT,
    status_reason_message TEXT,
    relationship_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (user_id, alpaca_account_id)
        REFERENCES kai_funding_brokerage_accounts(user_id, alpaca_account_id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_kai_funding_ach_relationships_user
    ON kai_funding_ach_relationships(user_id, alpaca_account_id, status, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_kai_funding_active_relationship_per_account
    ON kai_funding_ach_relationships(user_id, alpaca_account_id, item_id, account_id)
    WHERE status IN ('queued', 'pending', 'submitted', 'approved');

CREATE TABLE IF NOT EXISTS kai_funding_transfers (
    transfer_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    alpaca_account_id TEXT NOT NULL,
    relationship_id TEXT NOT NULL REFERENCES kai_funding_ach_relationships(relationship_id) ON DELETE RESTRICT,
    item_id TEXT NOT NULL REFERENCES kai_funding_plaid_items(item_id) ON DELETE RESTRICT,
    account_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('INCOMING', 'OUTGOING')),
    amount NUMERIC(18, 2) NOT NULL CHECK (amount > 0),
    currency TEXT NOT NULL DEFAULT 'USD',
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('queued', 'pending', 'submitted', 'completed', 'settled', 'canceled', 'failed', 'rejected', 'returned', 'reversed', 'error')),
    user_facing_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (user_facing_status IN ('pending', 'completed', 'canceled', 'failed', 'returned')),
    failure_reason_code TEXT,
    failure_reason_message TEXT,
    idempotency_key TEXT NOT NULL,
    request_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    response_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    submitted_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_kai_funding_transfers_user
    ON kai_funding_transfers(user_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_kai_funding_transfers_relationship
    ON kai_funding_transfers(relationship_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_kai_funding_transfers_status
    ON kai_funding_transfers(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS kai_funding_transfer_events (
    event_id TEXT PRIMARY KEY,
    transfer_id TEXT NOT NULL REFERENCES kai_funding_transfers(transfer_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    event_source TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_status TEXT,
    reason_code TEXT,
    reason_message TEXT,
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kai_funding_transfer_events_transfer
    ON kai_funding_transfer_events(transfer_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_kai_funding_transfer_events_user
    ON kai_funding_transfer_events(user_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS kai_funding_webhook_events (
    id BIGSERIAL PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('plaid', 'alpaca')),
    event_uid TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    signature_valid BOOLEAN NOT NULL DEFAULT FALSE,
    replay_detected BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL CHECK (status IN ('accepted', 'ignored', 'rejected', 'error')),
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    headers_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    processed_at TIMESTAMPTZ,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, event_uid)
);

CREATE INDEX IF NOT EXISTS idx_kai_funding_webhook_events_provider
    ON kai_funding_webhook_events(provider, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_kai_funding_webhook_events_payload_hash
    ON kai_funding_webhook_events(provider, payload_hash);

CREATE TABLE IF NOT EXISTS kai_funding_reconciliation_runs (
    run_id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES vault_keys(user_id) ON DELETE SET NULL,
    trigger_source TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    mismatches_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    error_message TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kai_funding_recon_runs_user
    ON kai_funding_reconciliation_runs(user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS kai_funding_support_escalations (
    escalation_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    transfer_id TEXT REFERENCES kai_funding_transfers(transfer_id) ON DELETE SET NULL,
    relationship_id TEXT REFERENCES kai_funding_ach_relationships(relationship_id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'investigating', 'resolved', 'closed')),
    severity TEXT NOT NULL DEFAULT 'normal'
        CHECK (severity IN ('low', 'normal', 'high', 'urgent')),
    notes TEXT,
    created_by TEXT,
    resolved_by TEXT,
    resolution_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kai_funding_escalations_user
    ON kai_funding_support_escalations(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_kai_funding_escalations_transfer
    ON kai_funding_support_escalations(transfer_id, created_at DESC);

-- ---- from 044_kai_alpaca_connect_sessions.sql ----
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

-- ---- from 045_kai_funding_trade_intents.sql ----
-- One-click funding + trading orchestration state.

CREATE TABLE IF NOT EXISTS kai_funding_trade_intents (
    intent_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    transfer_id TEXT REFERENCES kai_funding_transfers(transfer_id) ON DELETE SET NULL,
    alpaca_account_id TEXT NOT NULL,
    funding_item_id TEXT NOT NULL REFERENCES kai_funding_plaid_items(item_id) ON DELETE RESTRICT,
    funding_account_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL DEFAULT 'buy'
        CHECK (side IN ('buy', 'sell')),
    order_type TEXT NOT NULL DEFAULT 'market'
        CHECK (order_type IN ('market', 'limit')),
    time_in_force TEXT NOT NULL DEFAULT 'day'
        CHECK (time_in_force IN ('day', 'gtc', 'opg', 'cls', 'ioc', 'fok')),
    notional_usd NUMERIC(18, 2),
    quantity NUMERIC(20, 8),
    limit_price NUMERIC(18, 6),
    status TEXT NOT NULL DEFAULT 'funding_pending'
        CHECK (
            status IN (
                'queued',
                'funding_pending',
                'ready_to_trade',
                'order_submitted',
                'order_partially_filled',
                'order_filled',
                'order_canceled',
                'failed'
            )
        ),
    order_id TEXT,
    idempotency_key TEXT NOT NULL,
    request_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    transfer_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    order_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    failure_code TEXT,
    failure_message TEXT,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    executed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, idempotency_key),
    CHECK ((notional_usd IS NOT NULL) OR (quantity IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_kai_funding_trade_intents_user
    ON kai_funding_trade_intents(user_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_kai_funding_trade_intents_transfer
    ON kai_funding_trade_intents(transfer_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_kai_funding_trade_intents_status
    ON kai_funding_trade_intents(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS kai_funding_trade_events (
    event_id TEXT PRIMARY KEY,
    intent_id TEXT NOT NULL REFERENCES kai_funding_trade_intents(intent_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    event_source TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_status TEXT,
    reason_code TEXT,
    reason_message TEXT,
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kai_funding_trade_events_intent
    ON kai_funding_trade_events(intent_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_kai_funding_trade_events_user
    ON kai_funding_trade_events(user_id, occurred_at DESC);

-- ---- from 179_feed_notification_projection_coverage.sql ----
-- Funding already owns a durable event ledger. Project terminal user-facing
-- transitions from that ledger, not from best-effort FCM delivery, and keep
-- financial amount/account/provider/failure details out of plaintext Feed.
CREATE OR REPLACE FUNCTION feed_events_from_kai_funding_transfer_events()
RETURNS TRIGGER AS $$
DECLARE
  normalized_status TEXT;
  transfer_direction TEXT;
BEGIN
  IF NEW.event_type NOT IN ('transfer_created', 'transfer_status_updated') THEN
    RETURN NEW;
  END IF;

  normalized_status := CASE LOWER(COALESCE(NEW.event_status, ''))
    WHEN 'completed' THEN 'completed'
    WHEN 'settled' THEN 'completed'
    WHEN 'canceled' THEN 'canceled'
    WHEN 'failed' THEN 'failed'
    WHEN 'rejected' THEN 'failed'
    WHEN 'error' THEN 'failed'
    WHEN 'returned' THEN 'returned'
    WHEN 'reversed' THEN 'returned'
    ELSE NULL
  END;
  IF normalized_status IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT direction
    INTO transfer_direction
    FROM kai_funding_transfers
   WHERE transfer_id = NEW.transfer_id;

  INSERT INTO feed_events (
    user_id, source_domain, event_type, metadata, source_row_id
  )
  VALUES (
    NEW.user_id,
    'kai',
    'funding_transfer_status',
    jsonb_build_object(
      'user_facing_status', normalized_status,
      'direction', COALESCE(transfer_direction, '')
    ),
    NEW.transfer_id || ':' || normalized_status
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS kai_funding_transfer_events_feed_fanout
  ON kai_funding_transfer_events;
CREATE TRIGGER kai_funding_transfer_events_feed_fanout
  AFTER INSERT ON kai_funding_transfer_events
  FOR EACH ROW
  EXECUTE FUNCTION feed_events_from_kai_funding_transfer_events();

COMMENT ON FUNCTION feed_events_from_kai_funding_transfer_events() IS
  'Projects one privacy-bounded Feed row per terminal funding transfer status and user.';

COMMIT;
