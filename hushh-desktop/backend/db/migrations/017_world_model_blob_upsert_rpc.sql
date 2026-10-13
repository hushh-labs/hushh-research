-- Migration 017: Atomic world_model_data blob upsert RPC
-- =======================================================
-- Stores encrypted world-model blob and increments data_version atomically
-- without pre-reading the existing row from application code.

CREATE OR REPLACE FUNCTION upsert_world_model_data_blob(
  p_user_id TEXT,
  p_ciphertext TEXT,
  p_iv TEXT,
  p_tag TEXT,
  p_algorithm TEXT DEFAULT 'aes-256-gcm'
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  next_version INTEGER;
BEGIN
  INSERT INTO world_model_data (
    user_id,
    encrypted_data_ciphertext,
    encrypted_data_iv,
    encrypted_data_tag,
    algorithm,
    data_version,
    created_at,
    updated_at
  )
  VALUES (
    p_user_id,
    p_ciphertext,
    p_iv,
    p_tag,
    COALESCE(NULLIF(TRIM(p_algorithm), ''), 'aes-256-gcm'),
    1,
    NOW(),
    NOW()
  )
  ON CONFLICT (user_id)
  DO UPDATE SET
    encrypted_data_ciphertext = EXCLUDED.encrypted_data_ciphertext,
    encrypted_data_iv = EXCLUDED.encrypted_data_iv,
    encrypted_data_tag = EXCLUDED.encrypted_data_tag,
    algorithm = COALESCE(NULLIF(TRIM(EXCLUDED.algorithm), ''), 'aes-256-gcm'),
    data_version = world_model_data.data_version + 1,
    updated_at = NOW()
  RETURNING data_version INTO next_version;

  RETURN next_version;
END;
$$;
