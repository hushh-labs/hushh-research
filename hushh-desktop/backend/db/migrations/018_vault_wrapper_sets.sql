-- Migration 018: Vault Wrapper Sets (additive, zero re-encryption)
-- ==============================================================
-- Adds multi-wrapper identity + passkey metadata for dual-domain/native passkey support.
-- Non-destructive: no ciphertext rewrite, no data loss.

BEGIN;

-- 1) Add wrapper-set identity + metadata columns.
ALTER TABLE vault_key_wrappers
  ADD COLUMN IF NOT EXISTS wrapper_id TEXT NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS passkey_rp_id TEXT,
  ADD COLUMN IF NOT EXISTS passkey_provider TEXT,
  ADD COLUMN IF NOT EXISTS passkey_device_label TEXT,
  ADD COLUMN IF NOT EXISTS passkey_last_used_at BIGINT;

ALTER TABLE vault_keys
  ADD COLUMN IF NOT EXISTS primary_wrapper_id TEXT NOT NULL DEFAULT 'default';

-- 2) Backfill existing rows (safe idempotent).
UPDATE vault_key_wrappers
SET wrapper_id = 'default'
WHERE wrapper_id IS NULL OR btrim(wrapper_id) = '';

UPDATE vault_keys
SET primary_wrapper_id = 'default'
WHERE primary_wrapper_id IS NULL OR btrim(primary_wrapper_id) = '';

-- 3) Replace legacy uniqueness (user_id, method) with wrapper-set uniqueness.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE t.relname = 'vault_key_wrappers'
      AND c.contype = 'u'
      AND c.conname = 'vault_key_wrappers_user_id_method_key'
  ) THEN
    ALTER TABLE vault_key_wrappers DROP CONSTRAINT vault_key_wrappers_user_id_method_key;
  END IF;
EXCEPTION
  WHEN undefined_object THEN
    NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE t.relname = 'vault_key_wrappers'
      AND c.contype = 'u'
      AND c.conname = 'vault_key_wrappers_user_id_method_wrapper_id_key'
  ) THEN
    ALTER TABLE vault_key_wrappers
      ADD CONSTRAINT vault_key_wrappers_user_id_method_wrapper_id_key
      UNIQUE (user_id, method, wrapper_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_vkw_user_method_wrapper
  ON vault_key_wrappers(user_id, method, wrapper_id);

CREATE INDEX IF NOT EXISTS idx_vkw_passkey_rp_id
  ON vault_key_wrappers(passkey_rp_id)
  WHERE passkey_rp_id IS NOT NULL;

COMMIT;
