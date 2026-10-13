-- ============================================================================
-- Migration 005: Encrypt Chat Tables
-- Adds BYOK encryption to chat_conversations and chat_messages
-- ============================================================================

-- ============================================================================
-- STEP 1: Add encryption columns to chat_conversations
-- ============================================================================
ALTER TABLE chat_conversations 
ADD COLUMN IF NOT EXISTS title_ciphertext TEXT,
ADD COLUMN IF NOT EXISTS title_iv TEXT,
ADD COLUMN IF NOT EXISTS title_tag TEXT,
ADD COLUMN IF NOT EXISTS agent_context_ciphertext TEXT,
ADD COLUMN IF NOT EXISTS agent_context_iv TEXT,
ADD COLUMN IF NOT EXISTS agent_context_tag TEXT,
ADD COLUMN IF NOT EXISTS algorithm TEXT DEFAULT 'aes-256-gcm';

-- ============================================================================
-- STEP 2: Add encryption columns to chat_messages
-- ============================================================================
ALTER TABLE chat_messages 
ADD COLUMN IF NOT EXISTS content_ciphertext TEXT,
ADD COLUMN IF NOT EXISTS content_iv TEXT,
ADD COLUMN IF NOT EXISTS content_tag TEXT,
ADD COLUMN IF NOT EXISTS component_data_ciphertext TEXT,
ADD COLUMN IF NOT EXISTS component_data_iv TEXT,
ADD COLUMN IF NOT EXISTS component_data_tag TEXT,
ADD COLUMN IF NOT EXISTS algorithm TEXT DEFAULT 'aes-256-gcm';

-- ============================================================================
-- STEP 3: Migrate existing plaintext data (if any)
-- Note: This is a placeholder - actual encryption must be done at application layer
-- with user's BYOK key. For now, we mark existing data as needing migration.
-- ============================================================================

-- Add migration status column to track which rows need encryption
ALTER TABLE chat_conversations 
ADD COLUMN IF NOT EXISTS encryption_status TEXT DEFAULT 'pending' 
CHECK (encryption_status IN ('pending', 'encrypted', 'legacy_plaintext'));

ALTER TABLE chat_messages 
ADD COLUMN IF NOT EXISTS encryption_status TEXT DEFAULT 'pending'
CHECK (encryption_status IN ('pending', 'encrypted', 'legacy_plaintext'));

-- Mark existing rows as legacy plaintext (they have content but no ciphertext)
UPDATE chat_conversations 
SET encryption_status = 'legacy_plaintext' 
WHERE title IS NOT NULL AND title_ciphertext IS NULL;

UPDATE chat_messages 
SET encryption_status = 'legacy_plaintext' 
WHERE content IS NOT NULL AND content_ciphertext IS NULL;

-- ============================================================================
-- STEP 4: Create indexes for encrypted columns
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_chat_conv_encryption ON chat_conversations(encryption_status);
CREATE INDEX IF NOT EXISTS idx_chat_msg_encryption ON chat_messages(encryption_status);

-- ============================================================================
-- STEP 5: Add comment explaining the encryption model
-- ============================================================================
COMMENT ON COLUMN chat_conversations.title_ciphertext IS 'AES-256-GCM encrypted title using user BYOK key';
COMMENT ON COLUMN chat_conversations.title_iv IS 'Initialization vector for title encryption';
COMMENT ON COLUMN chat_conversations.title_tag IS 'Authentication tag for title encryption';

COMMENT ON COLUMN chat_messages.content_ciphertext IS 'AES-256-GCM encrypted message content using user BYOK key';
COMMENT ON COLUMN chat_messages.content_iv IS 'Initialization vector for content encryption';
COMMENT ON COLUMN chat_messages.content_tag IS 'Authentication tag for content encryption';

COMMENT ON COLUMN chat_messages.component_data_ciphertext IS 'AES-256-GCM encrypted component data using user BYOK key';
COMMENT ON COLUMN chat_messages.component_data_iv IS 'Initialization vector for component_data encryption';
COMMENT ON COLUMN chat_messages.component_data_tag IS 'Authentication tag for component_data encryption';

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
SELECT 'Chat tables encryption columns added. Run application-level migration to encrypt existing data.' as status;
