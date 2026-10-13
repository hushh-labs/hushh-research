-- Migration 015: Vault Multi-Wrapper Refactor (breaking, no backward compatibility)
-- ===============================================================================
-- This migration resets vault key storage to a production-grade multi-wrapper model:
-- - vault_keys stores vault hash + primary method + mandatory recovery wrapper
-- - vault_key_wrappers stores per-method wrappers (passphrase required, optional biometric/passkey)
--
-- NOTE: This migration is intentionally destructive for development environments.

BEGIN;

-- Drop dependent tables first (FK dependency on vault_keys).
DROP TABLE IF EXISTS vault_key_wrappers CASCADE;
DROP TABLE IF EXISTS consent_exports CASCADE;
DROP TABLE IF EXISTS world_model_index_v2 CASCADE;
DROP TABLE IF EXISTS world_model_data CASCADE;
DROP TABLE IF EXISTS vault_keys CASCADE;

CREATE TABLE vault_keys (
    user_id TEXT PRIMARY KEY,
    vault_key_hash TEXT NOT NULL,
    primary_method TEXT NOT NULL,
    recovery_encrypted_vault_key TEXT NOT NULL,
    recovery_salt TEXT NOT NULL,
    recovery_iv TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE TABLE vault_key_wrappers (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    method TEXT NOT NULL,
    encrypted_vault_key TEXT NOT NULL,
    salt TEXT NOT NULL,
    iv TEXT NOT NULL,
    passkey_credential_id TEXT,
    passkey_prf_salt TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE(user_id, method)
);

CREATE INDEX idx_vkw_user_id ON vault_key_wrappers(user_id);
CREATE INDEX idx_vkw_method ON vault_key_wrappers(method);

-- Recreate encrypted world-model storage tables.
CREATE TABLE world_model_data (
    user_id TEXT PRIMARY KEY REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    encrypted_data_ciphertext TEXT NOT NULL,
    encrypted_data_iv TEXT NOT NULL,
    encrypted_data_tag TEXT NOT NULL,
    algorithm TEXT DEFAULT 'aes-256-gcm',
    data_version INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE world_model_index_v2 (
    user_id TEXT PRIMARY KEY REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    domain_summaries JSONB DEFAULT '{}',
    available_domains TEXT[] DEFAULT '{}',
    computed_tags TEXT[] DEFAULT '{}',
    activity_score DECIMAL(3,2),
    last_active_at TIMESTAMPTZ,
    total_attributes INTEGER DEFAULT 0,
    model_version INTEGER DEFAULT 2,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_wmi2_domains ON world_model_index_v2 USING GIN(domain_summaries);
CREATE INDEX idx_wmi2_available ON world_model_index_v2 USING GIN(available_domains);
CREATE INDEX idx_wmi2_tags ON world_model_index_v2 USING GIN(computed_tags);

-- Recreate zero-knowledge exports table.
CREATE TABLE consent_exports (
    consent_token TEXT PRIMARY KEY,
    user_id TEXT REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    encrypted_data TEXT NOT NULL,
    iv TEXT NOT NULL,
    tag TEXT NOT NULL,
    export_key TEXT NOT NULL,
    scope TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_consent_exports_user ON consent_exports(user_id);
CREATE INDEX idx_consent_exports_expires ON consent_exports(expires_at);

COMMIT;
