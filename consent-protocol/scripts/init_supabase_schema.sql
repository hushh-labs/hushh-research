-- Supabase Schema Initialization Script
-- Mirror of db/migrate.py table definitions; for Supabase Dashboard / one-off init.
-- Prefer: python db/migrate.py --init (programmatic setup, same DB_* as runtime).
-- Run this in Supabase Dashboard SQL Editor or via psql.

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1. vault_keys (user authentication keys)
CREATE TABLE IF NOT EXISTS vault_keys (
    user_id TEXT PRIMARY KEY,
    vault_status TEXT NOT NULL DEFAULT 'active' CHECK (vault_status IN ('placeholder', 'active')),
    vault_key_hash TEXT,
    primary_method TEXT NOT NULL DEFAULT 'passphrase',
    primary_wrapper_id TEXT NOT NULL DEFAULT 'default',
    recovery_encrypted_vault_key TEXT,
    recovery_salt TEXT,
    recovery_iv TEXT,
    first_login_at BIGINT,
    last_login_at BIGINT,
    login_count INTEGER NOT NULL DEFAULT 0,
    pre_onboarding_completed BOOLEAN,
    pre_onboarding_skipped BOOLEAN,
    pre_onboarding_completed_at BIGINT,
    pre_nav_tour_completed_at BIGINT,
    pre_nav_tour_skipped_at BIGINT,
    pre_state_updated_at BIGINT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    CONSTRAINT vault_keys_placeholder_integrity_check CHECK (
        (vault_status = 'placeholder'
            AND vault_key_hash IS NULL
            AND recovery_encrypted_vault_key IS NULL
            AND recovery_salt IS NULL
            AND recovery_iv IS NULL)
        OR
        (vault_status = 'active'
            AND vault_key_hash IS NOT NULL
            AND recovery_encrypted_vault_key IS NOT NULL
            AND recovery_salt IS NOT NULL
            AND recovery_iv IS NOT NULL)
    )
);

-- 1b. vault_key_wrappers (one wrapper per method per user)
CREATE TABLE IF NOT EXISTS vault_key_wrappers (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    method TEXT NOT NULL,
    wrapper_id TEXT NOT NULL DEFAULT 'default',
    encrypted_vault_key TEXT NOT NULL,
    salt TEXT NOT NULL,
    iv TEXT NOT NULL,
    passkey_credential_id TEXT,
    passkey_prf_salt TEXT,
    passkey_rp_id TEXT,
    passkey_provider TEXT,
    passkey_device_label TEXT,
    passkey_last_used_at BIGINT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE (user_id, method, wrapper_id)
);
CREATE INDEX IF NOT EXISTS idx_vkw_user_id ON vault_key_wrappers(user_id);
CREATE INDEX IF NOT EXISTS idx_vkw_method ON vault_key_wrappers(method);
CREATE INDEX IF NOT EXISTS idx_vkw_user_method_wrapper ON vault_key_wrappers(user_id, method, wrapper_id);
CREATE INDEX IF NOT EXISTS idx_vkw_passkey_rp_id ON vault_key_wrappers(passkey_rp_id);

-- 2. investor_profiles (public discovery layer)
CREATE TABLE IF NOT EXISTS investor_profiles (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    name_normalized TEXT,
    cik TEXT UNIQUE,
    firm TEXT,
    title TEXT,
    investor_type TEXT,
    photo_url TEXT,
    aum_billions NUMERIC,
    top_holdings JSONB,
    sector_exposure JSONB,
    investment_style TEXT[],
    risk_tolerance TEXT,
    time_horizon TEXT,
    portfolio_turnover TEXT,
    recent_buys TEXT[],
    recent_sells TEXT[],
    public_quotes JSONB,
    biography TEXT,
    education TEXT[],
    board_memberships TEXT[],
    peer_investors TEXT[],
    is_insider BOOLEAN DEFAULT FALSE,
    insider_company_ticker TEXT,
    data_sources TEXT[],
    last_13f_date DATE,
    last_form4_date DATE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_investor_name ON investor_profiles(name);
CREATE INDEX IF NOT EXISTS idx_investor_name_trgm ON investor_profiles USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_investor_firm ON investor_profiles(firm);
CREATE INDEX IF NOT EXISTS idx_investor_type ON investor_profiles(investor_type);
CREATE INDEX IF NOT EXISTS idx_investor_style ON investor_profiles USING GIN (investment_style);
CREATE INDEX IF NOT EXISTS idx_investor_cik ON investor_profiles(cik) WHERE cik IS NOT NULL;

-- 3. consent_audit (consent token audit trail; app uses this only)
CREATE TABLE IF NOT EXISTS consent_audit (
    id SERIAL PRIMARY KEY,
    token_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    action TEXT NOT NULL,
    issued_at BIGINT NOT NULL,
    expires_at BIGINT,
    revoked_at BIGINT,
    metadata JSONB,
    token_type VARCHAR(20) DEFAULT 'consent',
    ip_address VARCHAR(45),
    user_agent TEXT,
    request_id VARCHAR(32),
    scope_description TEXT,
    poll_timeout_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_consent_user ON consent_audit(user_id);
CREATE INDEX IF NOT EXISTS idx_consent_token ON consent_audit(token_id);
CREATE INDEX IF NOT EXISTS idx_consent_audit_created ON consent_audit(issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_consent_audit_user_action ON consent_audit(user_id, action);
CREATE INDEX IF NOT EXISTS idx_consent_audit_request_id ON consent_audit(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_consent_audit_pending ON consent_audit(user_id) WHERE action = 'REQUESTED';

-- NOTIFY on consent_audit INSERT (for event-driven SSE/push; see db/migrations/011_consent_audit_notify_trigger.sql)
CREATE OR REPLACE FUNCTION consent_audit_notify()
RETURNS TRIGGER AS $$
DECLARE payload TEXT;
BEGIN
  payload := json_build_object(
    'user_id', NEW.user_id,
    'request_id', COALESCE(NEW.request_id, ''),
    'action', NEW.action,
    'scope', COALESCE(NEW.scope, ''),
    'agent_id', COALESCE(NEW.agent_id, ''),
    'scope_description', COALESCE(NEW.scope_description, ''),
    'issued_at', NEW.issued_at,
    'bundle_id', COALESCE(NEW.metadata->>'bundle_id', ''),
    'bundle_label', COALESCE(NEW.metadata->>'bundle_label', ''),
    'bundle_scope_count', COALESCE(NEW.metadata->>'bundle_scope_count', '1')
  )::TEXT;
  PERFORM pg_notify('consent_audit_new', payload);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS consent_audit_after_insert ON consent_audit;
CREATE TRIGGER consent_audit_after_insert AFTER INSERT ON consent_audit FOR EACH ROW EXECUTE FUNCTION consent_audit_notify();

-- 4b. user_push_tokens (FCM/APNs for consent push notifications)
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

-- 4c. internal_access_events (self/internal app activity; not user-facing consent history)
CREATE TABLE IF NOT EXISTS internal_access_events (
    id SERIAL PRIMARY KEY,
    token_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    action TEXT NOT NULL,
    issued_at BIGINT NOT NULL,
    expires_at BIGINT,
    revoked_at BIGINT,
    metadata JSONB,
    token_type VARCHAR(20) DEFAULT 'internal',
    request_id VARCHAR(32),
    scope_description TEXT
);
CREATE INDEX IF NOT EXISTS idx_internal_access_events_user_id ON internal_access_events(user_id);
CREATE INDEX IF NOT EXISTS idx_internal_access_events_user_action ON internal_access_events(user_id, action);
CREATE INDEX IF NOT EXISTS idx_internal_access_events_issued_at ON internal_access_events(issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_internal_access_events_user_scope_agent
    ON internal_access_events(user_id, agent_id, scope, issued_at DESC);

-- 4d. kai_gmail_* (Gmail receipts connector persistence)
CREATE TABLE IF NOT EXISTS kai_gmail_connections (
    user_id TEXT PRIMARY KEY REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    google_email TEXT,
    google_sub TEXT,
    scope_csv TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'disconnected'
        CHECK (status IN ('connected', 'disconnected', 'error')),
    refresh_token_ciphertext TEXT,
    refresh_token_iv TEXT,
    refresh_token_tag TEXT,
    access_token_ciphertext TEXT,
    access_token_iv TEXT,
    access_token_tag TEXT,
    token_algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
    access_token_expires_at TIMESTAMPTZ,
    history_id TEXT,
    watch_status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (watch_status IN ('unknown', 'active', 'expiring', 'expired', 'failed', 'not_configured')),
    watch_expiration_at TIMESTAMPTZ,
    last_watch_renewed_at TIMESTAMPTZ,
    last_notification_at TIMESTAMPTZ,
    auto_sync_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    bootstrap_state TEXT NOT NULL DEFAULT 'idle'
        CHECK (bootstrap_state IN ('idle', 'queued', 'running', 'completed', 'failed')),
    bootstrap_completed_at TIMESTAMPTZ,
    last_sync_at TIMESTAMPTZ,
    last_sync_status TEXT NOT NULL DEFAULT 'idle'
        CHECK (last_sync_status IN ('idle', 'running', 'completed', 'failed')),
    last_sync_error TEXT,
    status_refreshed_at TIMESTAMPTZ,
    connected_at TIMESTAMPTZ,
    disconnected_at TIMESTAMPTZ,
    token_updated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kai_gmail_connections_status
    ON kai_gmail_connections(status, auto_sync_enabled);

CREATE INDEX IF NOT EXISTS idx_kai_gmail_connections_last_sync
    ON kai_gmail_connections(last_sync_at DESC);

CREATE INDEX IF NOT EXISTS idx_kai_gmail_connections_watch_expiration
    ON kai_gmail_connections(watch_expiration_at DESC);

CREATE TABLE IF NOT EXISTS kai_gmail_sync_runs (
    run_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    trigger_source TEXT NOT NULL,
    sync_mode TEXT NOT NULL DEFAULT 'manual'
        CHECK (sync_mode IN ('bootstrap', 'incremental', 'manual', 'recovery', 'backfill')),
    start_history_id TEXT,
    end_history_id TEXT,
    window_start_at TIMESTAMPTZ,
    window_end_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'completed', 'failed', 'canceled')),
    query_since TIMESTAMPTZ,
    query_text TEXT,
    listed_count INTEGER NOT NULL DEFAULT 0,
    filtered_count INTEGER NOT NULL DEFAULT 0,
    synced_count INTEGER NOT NULL DEFAULT 0,
    extracted_count INTEGER NOT NULL DEFAULT 0,
    duplicates_dropped INTEGER NOT NULL DEFAULT 0,
    extraction_success_rate NUMERIC(6,5),
    metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_message TEXT,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kai_gmail_sync_runs_user_requested
    ON kai_gmail_sync_runs(user_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_kai_gmail_sync_runs_status
    ON kai_gmail_sync_runs(status, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_kai_gmail_sync_runs_user_status
    ON kai_gmail_sync_runs(user_id, status, requested_at DESC);

CREATE TABLE IF NOT EXISTS kai_gmail_receipts (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    gmail_message_id TEXT NOT NULL,
    gmail_thread_id TEXT,
    gmail_internal_date TIMESTAMPTZ,
    gmail_history_id TEXT,
    subject TEXT,
    snippet TEXT,
    from_name TEXT,
    from_email TEXT,
    merchant_name TEXT,
    order_id TEXT,
    currency TEXT,
    amount NUMERIC(18,4),
    receipt_date TIMESTAMPTZ,
    classification_confidence NUMERIC(6,5),
    classification_source TEXT NOT NULL DEFAULT 'deterministic'
        CHECK (classification_source IN ('deterministic', 'llm')),
    receipt_checksum TEXT,
    raw_reference_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, gmail_message_id)
);

CREATE INDEX IF NOT EXISTS idx_kai_gmail_receipts_user_receipt_date
    ON kai_gmail_receipts(user_id, receipt_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_kai_gmail_receipts_user_internal_date
    ON kai_gmail_receipts(user_id, gmail_internal_date DESC);

DROP INDEX IF EXISTS uq_kai_gmail_receipts_user_checksum;

CREATE INDEX IF NOT EXISTS idx_kai_gmail_receipts_user_checksum
    ON kai_gmail_receipts(user_id, receipt_checksum)
    WHERE receipt_checksum IS NOT NULL;

CREATE TABLE IF NOT EXISTS kai_receipt_memory_artifacts (
    artifact_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL DEFAULT 'gmail_receipts',
    artifact_version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'ready',
    deterministic_schema_version INTEGER NOT NULL DEFAULT 1,
    enrichment_schema_version INTEGER,
    enrichment_cache_key TEXT NOT NULL,
    inference_window_days INTEGER NOT NULL DEFAULT 365,
    highlights_window_days INTEGER NOT NULL DEFAULT 90,
    source_watermark_hash TEXT NOT NULL,
    source_watermark_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    deterministic_projection_hash TEXT NOT NULL,
    enrichment_hash TEXT,
    candidate_pkm_payload_hash TEXT NOT NULL,
    deterministic_projection_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    enrichment_json JSONB,
    candidate_pkm_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    debug_stats_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    persisted_pkm_data_version INTEGER,
    persisted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kai_receipt_memory_artifacts_user_created
    ON kai_receipt_memory_artifacts(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_kai_receipt_memory_artifacts_cache_lookup
    ON kai_receipt_memory_artifacts(
        user_id,
        source_watermark_hash,
        deterministic_schema_version,
        enrichment_cache_key,
        created_at DESC
    );
-- Verification: Show all created tables
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_type = 'BASE TABLE'
ORDER BY table_name;
