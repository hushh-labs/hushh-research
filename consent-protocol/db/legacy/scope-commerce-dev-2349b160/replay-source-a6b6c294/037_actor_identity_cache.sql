-- Migration 037: Actor identity cache for internal app presentation
-- ================================================================
-- Stores a backend-owned identity shadow so app surfaces can render
-- human-readable names and emails without relying on live Firebase lookups.

BEGIN;

CREATE TABLE IF NOT EXISTS actor_identity_cache (
  user_id TEXT PRIMARY KEY REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  display_name TEXT,
  email TEXT,
  photo_url TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  source TEXT NOT NULL DEFAULT 'unknown',
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_actor_identity_cache_email
  ON actor_identity_cache(email)
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_actor_identity_cache_last_synced_at
  ON actor_identity_cache(last_synced_at DESC);

INSERT INTO actor_identity_cache (
  user_id,
  display_name,
  email,
  photo_url,
  email_verified,
  source,
  last_synced_at,
  created_at,
  updated_at
)
SELECT
  ap.user_id,
  COALESCE(mpp.display_name, rp.display_name, ap.user_id),
  NULL,
  NULL,
  FALSE,
  'migration_seed',
  NOW(),
  NOW(),
  NOW()
FROM actor_profiles ap
LEFT JOIN marketplace_public_profiles mpp
  ON mpp.user_id = ap.user_id
LEFT JOIN ria_profiles rp
  ON rp.user_id = ap.user_id
ON CONFLICT (user_id) DO UPDATE SET
  display_name = COALESCE(actor_identity_cache.display_name, EXCLUDED.display_name),
  updated_at = NOW();

COMMIT;
