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
