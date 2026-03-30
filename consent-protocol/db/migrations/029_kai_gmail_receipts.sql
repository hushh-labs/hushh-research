-- Kai Gmail receipts connector persistence

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
    auto_sync_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    last_sync_at TIMESTAMPTZ,
    last_sync_status TEXT NOT NULL DEFAULT 'idle'
        CHECK (last_sync_status IN ('idle', 'running', 'completed', 'failed')),
    last_sync_error TEXT,
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

CREATE TABLE IF NOT EXISTS kai_gmail_sync_runs (
    run_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    trigger_source TEXT NOT NULL,
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
