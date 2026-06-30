-- ============================================================================
-- Migration 009: Consent Exports Table
-- Persists encrypted MCP export data for cross-instance consistency
-- ============================================================================

-- ============================================================================
-- CONSENT EXPORTS TABLE
-- Stores encrypted export data for MCP zero-knowledge flow
-- ============================================================================
CREATE TABLE IF NOT EXISTS consent_exports (
    id SERIAL PRIMARY KEY,
    
    -- Token reference (the consent token this export is for)
    consent_token TEXT NOT NULL UNIQUE,
    
    -- User reference
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    
    -- Encrypted export data (BYOK - server never sees plaintext)
    encrypted_data TEXT NOT NULL,
    iv TEXT NOT NULL,
    tag TEXT NOT NULL,
    
    -- Export key (hex-encoded AES-256 key for MCP decryption)
    export_key TEXT NOT NULL,
    
    -- Scope this export is for
    scope TEXT NOT NULL,
    
    -- TTL management
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    
    -- Index for efficient lookups
    CONSTRAINT consent_exports_token_idx UNIQUE (consent_token)
);

-- Index for cleanup queries (expired exports)
CREATE INDEX IF NOT EXISTS consent_exports_expires_at_idx 
    ON consent_exports(expires_at);

-- Index for user lookups
CREATE INDEX IF NOT EXISTS consent_exports_user_id_idx 
    ON consent_exports(user_id);

-- ============================================================================
-- CLEANUP FUNCTION
-- Automatically removes expired exports
-- ============================================================================
CREATE OR REPLACE FUNCTION cleanup_expired_consent_exports()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM consent_exports 
    WHERE expires_at < NOW();
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- COMMENTS
-- ============================================================================
COMMENT ON TABLE consent_exports IS 
    'Stores encrypted export data for MCP zero-knowledge flow. Data is encrypted client-side and server never sees plaintext.';

COMMENT ON COLUMN consent_exports.consent_token IS 
    'The consent token this export is associated with';

COMMENT ON COLUMN consent_exports.encrypted_data IS 
    'Base64-encoded AES-256-GCM ciphertext of user data';

COMMENT ON COLUMN consent_exports.export_key IS 
    'Hex-encoded AES-256 key for MCP to decrypt the data';

COMMENT ON COLUMN consent_exports.expires_at IS 
    'When this export expires and should be cleaned up';
