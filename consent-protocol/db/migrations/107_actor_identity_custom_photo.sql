-- Migration 107: extend actor identity cache with app-owned custom photo
-- ============================================================
-- Adds an app-owned avatar override that survives Firebase identity syncs.
-- Firebase Auth's photo_url remains the source of truth for the Firebase
-- avatar; custom_photo_url takes precedence for presentation when set.

BEGIN;

ALTER TABLE actor_identity_cache
  ADD COLUMN IF NOT EXISTS custom_photo_url TEXT;

COMMIT;
