-- Migration 047: extend actor identity cache with phone shadow
-- ============================================================
-- Mirrors verified phone state from Firebase Auth into the backend-owned
-- identity cache for app/server presentation. Firebase Auth remains the
-- source of truth.

BEGIN;

ALTER TABLE actor_identity_cache
  ADD COLUMN IF NOT EXISTS phone_number TEXT,
  ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_actor_identity_cache_phone_number
  ON actor_identity_cache(phone_number)
  WHERE phone_number IS NOT NULL;

COMMIT;
