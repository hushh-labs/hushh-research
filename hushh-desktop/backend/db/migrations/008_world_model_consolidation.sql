-- Migration: World Model Architecture Consolidation
-- Date: 2026-01-31
-- Purpose: Consolidate world model storage into single encrypted blob per user
-- Implements BYOK (Bring Your Own Key) architecture

-- ============================================================================
-- NEW TABLE: world_model_data
-- ============================================================================
-- Stores ONE encrypted JSONB blob per user containing ALL domain data
-- Backend cannot read this data - only client with vault key can decrypt

CREATE TABLE IF NOT EXISTS world_model_data (
    user_id TEXT PRIMARY KEY REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    
    -- Single encrypted JSONB blob containing ALL user data across domains
    -- Structure when decrypted: { "financial": {...}, "food": {...}, "health": {...} }
    encrypted_data_ciphertext TEXT NOT NULL,
    encrypted_data_iv TEXT NOT NULL,
    encrypted_data_tag TEXT NOT NULL,
    
    -- Encryption metadata
    algorithm TEXT DEFAULT 'aes-256-gcm' NOT NULL,
    data_version INTEGER DEFAULT 1 NOT NULL,
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_world_model_data_user_id ON world_model_data(user_id);
CREATE INDEX IF NOT EXISTS idx_world_model_data_updated_at ON world_model_data(updated_at);

-- Trigger to automatically update updated_at
CREATE OR REPLACE FUNCTION update_world_model_data_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_world_model_data_timestamp
    BEFORE UPDATE ON world_model_data
    FOR EACH ROW
    EXECUTE FUNCTION update_world_model_data_timestamp();

-- ============================================================================
-- KEEP EXISTING: world_model_index_v2
-- ============================================================================
-- This table is CORRECT - it stores queryable metadata (non-encrypted)
-- Used for MCP scope generation, UI display, and domain discovery
-- ONE row per user

-- Ensure it has proper indexes
CREATE INDEX IF NOT EXISTS idx_world_model_index_user_id ON world_model_index_v2(user_id);
CREATE INDEX IF NOT EXISTS idx_world_model_index_domains ON world_model_index_v2 USING GIN(available_domains);
CREATE INDEX IF NOT EXISTS idx_world_model_index_tags ON world_model_index_v2 USING GIN(computed_tags);
CREATE INDEX IF NOT EXISTS idx_world_model_index_summaries ON world_model_index_v2 USING GIN(domain_summaries);

-- ============================================================================
-- DEPRECATION NOTICES
-- ============================================================================
-- The following tables are DEPRECATED and replaced by world_model_data:
-- - world_model_attributes (field-based storage - WRONG pattern)
-- - vault_portfolios (redundant - merged into world_model_data.financial)
-- - vault_food (redundant - merged into world_model_data.food)
-- - vault_professional (redundant - merged into world_model_data.professional)
--
-- These tables are NOT dropped in this migration to avoid data loss.
-- They will be marked for removal after migration is complete.
-- New code should NOT write to these tables.

COMMENT ON TABLE world_model_data IS 'Consolidated encrypted storage for all user domain data. ONE row per user. Backend cannot decrypt - BYOK architecture.';
COMMENT ON COLUMN world_model_data.encrypted_data_ciphertext IS 'AES-256-GCM encrypted JSONB blob containing all domains: {financial, food, health, etc.}';
COMMENT ON COLUMN world_model_data.encrypted_data_iv IS 'Initialization vector for AES-GCM encryption';
COMMENT ON COLUMN world_model_data.encrypted_data_tag IS 'Authentication tag for AES-GCM encryption';
COMMENT ON COLUMN world_model_data.algorithm IS 'Encryption algorithm used (default: aes-256-gcm)';
COMMENT ON COLUMN world_model_data.data_version IS 'Schema version of decrypted data structure';

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================
-- To verify migration success, run:
-- SELECT COUNT(*) FROM world_model_data;
-- SELECT user_id, data_version, created_at FROM world_model_data LIMIT 5;
