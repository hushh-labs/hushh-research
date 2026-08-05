-- Conformance-harness prelude: the MINIMUM neighbours the PKM chain touches,
-- with exactly the columns the stored procedures read. Proven empirically: the
-- full db/verify/pkm_v7_zero_loss_rehearsal.sql passes on prelude + MIGRATIONS.
--
-- vault_keys is the FK spine. consent_exports + consent_export_refresh_jobs are
-- the fan-out targets of commit/delete. pkm_data is the legacy single-blob table
-- 098's recovery functions read (%ROWTYPE), created empty here because the
-- rename migration (033) has nothing to rename on a fresh cluster.

CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS vault_keys (
    user_id TEXT PRIMARY KEY,
    vault_status TEXT,
    primary_method TEXT,
    created_at BIGINT,
    updated_at BIGINT
);

CREATE TABLE IF NOT EXISTS consent_exports (
    user_id TEXT,
    consent_token TEXT PRIMARY KEY,
    scope TEXT,
    export_revision BIGINT DEFAULT 1,
    envelope_version INT DEFAULT 2,
    refresh_policy TEXT DEFAULT 'continuous_until_expiry',
    refresh_status TEXT,
    expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS consent_export_refresh_jobs (
    user_id TEXT,
    consent_token TEXT PRIMARY KEY,
    granted_scope TEXT,
    status TEXT,
    trigger_domain TEXT,
    trigger_paths JSONB,
    requested_at TIMESTAMPTZ,
    last_error TEXT,
    attempt_count INT DEFAULT 0,
    claim_id TEXT,
    claimed_at TIMESTAMPTZ,
    claim_expires_at TIMESTAMPTZ,
    expected_export_revision BIGINT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS pkm_data (
    user_id TEXT PRIMARY KEY,
    encrypted_data_ciphertext TEXT,
    encrypted_data_iv TEXT,
    encrypted_data_tag TEXT,
    algorithm TEXT,
    data_version BIGINT DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
