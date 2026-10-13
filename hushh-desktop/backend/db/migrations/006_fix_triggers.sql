-- ============================================================================
-- FIX TRIGGER ISSUE
-- Run this in Supabase SQL Editor to fix the trigger issue
-- ============================================================================

-- First, check if updated_at column exists
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'world_model_attributes';

-- Drop the problematic trigger
DROP TRIGGER IF EXISTS update_world_model_attributes_updated_at ON world_model_attributes;

-- Add updated_at column if it doesn't exist
ALTER TABLE world_model_attributes 
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Recreate the trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_world_model_attributes_updated_at
    BEFORE UPDATE ON world_model_attributes
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Also fix domain_registry trigger
DROP TRIGGER IF EXISTS update_domain_registry_updated_at ON domain_registry;

ALTER TABLE domain_registry 
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Verify the fix
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'world_model_attributes'
ORDER BY ordinal_position;

-- Test insert
INSERT INTO world_model_attributes (user_id, domain, attribute_key, ciphertext, iv, tag, algorithm, source)
VALUES ('test_user', 'test', 'test_key', 'test_cipher', 'test_iv', 'test_tag', 'aes-256-gcm', 'test')
ON CONFLICT (user_id, domain, attribute_key) DO NOTHING;

-- Clean up test
DELETE FROM world_model_attributes WHERE user_id = 'test_user';

SELECT 'Trigger fix complete!' as status;
