-- Migration 019: Vault Placeholder User State (DB-first pre-vault onboarding/tour)
-- ===============================================================================
-- Adds placeholder/active vault status to support authenticated no-vault users
-- while preserving existing active vault behavior.

BEGIN;

-- 1) Add status discriminator and user-state fields.
ALTER TABLE vault_keys
  ADD COLUMN IF NOT EXISTS vault_status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS first_login_at BIGINT,
  ADD COLUMN IF NOT EXISTS last_login_at BIGINT,
  ADD COLUMN IF NOT EXISTS login_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pre_onboarding_completed BOOLEAN,
  ADD COLUMN IF NOT EXISTS pre_onboarding_skipped BOOLEAN,
  ADD COLUMN IF NOT EXISTS pre_onboarding_completed_at BIGINT,
  ADD COLUMN IF NOT EXISTS pre_nav_tour_completed_at BIGINT,
  ADD COLUMN IF NOT EXISTS pre_nav_tour_skipped_at BIGINT,
  ADD COLUMN IF NOT EXISTS pre_state_updated_at BIGINT;

-- 2) Allow placeholder rows without crypto payload.
ALTER TABLE vault_keys
  ALTER COLUMN vault_key_hash DROP NOT NULL,
  ALTER COLUMN recovery_encrypted_vault_key DROP NOT NULL,
  ALTER COLUMN recovery_salt DROP NOT NULL,
  ALTER COLUMN recovery_iv DROP NOT NULL;

-- 3) Keep status constrained to known values.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE t.relname = 'vault_keys'
      AND c.contype = 'c'
      AND c.conname = 'vault_keys_status_check'
  ) THEN
    ALTER TABLE vault_keys
      ADD CONSTRAINT vault_keys_status_check
      CHECK (vault_status IN ('placeholder', 'active'));
  END IF;
END $$;

-- 4) Backfill existing rows as active + initialize login markers.
UPDATE vault_keys
SET
  vault_status = 'active'
WHERE vault_status IS NULL OR vault_status NOT IN ('placeholder', 'active');

UPDATE vault_keys
SET
  first_login_at = COALESCE(first_login_at, created_at),
  last_login_at = COALESCE(last_login_at, updated_at),
  login_count = CASE WHEN login_count < 1 THEN 1 ELSE login_count END;

-- 5) Integrity gate for placeholder vs active rows.
ALTER TABLE vault_keys DROP CONSTRAINT IF EXISTS vault_keys_placeholder_integrity_check;
ALTER TABLE vault_keys
  ADD CONSTRAINT vault_keys_placeholder_integrity_check
  CHECK (
    (vault_status = 'placeholder'
      AND vault_key_hash IS NULL
      AND recovery_encrypted_vault_key IS NULL
      AND recovery_salt IS NULL
      AND recovery_iv IS NULL)
    OR
    (vault_status = 'active'
      AND vault_key_hash IS NOT NULL
      AND recovery_encrypted_vault_key IS NOT NULL
      AND recovery_salt IS NOT NULL
      AND recovery_iv IS NOT NULL)
  );

COMMIT;
