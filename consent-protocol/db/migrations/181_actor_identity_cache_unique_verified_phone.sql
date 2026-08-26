-- Migration 181: enforce one verified phone number per account
-- ===============================================================
-- A verified phone number must belong to exactly one actor. The app-level
-- ownership check in claim_verified_phone() is not race-safe on its own (two
-- concurrent claims for the same number could both pass it before either
-- commits), so the database must be the final guard.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_actor_identity_cache_verified_phone
  ON actor_identity_cache(phone_number)
  WHERE phone_verified = TRUE AND phone_number IS NOT NULL;

COMMIT;
