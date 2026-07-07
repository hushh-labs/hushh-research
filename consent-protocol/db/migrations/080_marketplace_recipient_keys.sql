BEGIN;

-- Buyer recipient keys for consent-based Information Marketplace delivery.
--
-- Until now a marketplace "Approve" only flipped a request status row; no data
-- ever reached the buyer. Real end-to-end delivery reuses the One Location
-- user-to-user envelope pattern: the buyer publishes an ECDH P-256 public "lock"
-- (private half stays on-device), the seller seals a slice envelope against it,
-- and the server relays ciphertext only. This table persists the buyer's public
-- key so the seller can fetch it at approve time. Mirrors
-- one_location_recipient_keys (migration 061), scoped to the marketplace.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS marketplace_recipient_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  public_key_jwk JSONB NOT NULL,
  public_key_fingerprint TEXT,
  algorithm TEXT NOT NULL DEFAULT 'ECDH-P256-AES256-GCM',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'rotated', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT marketplace_recipient_keys_unique_key
    UNIQUE (user_id, key_id)
);

-- Seller's fetch at approve time: the buyer's current active key, newest first.
CREATE INDEX IF NOT EXISTS idx_marketplace_recipient_keys_active
  ON marketplace_recipient_keys (user_id, status, created_at DESC);

COMMIT;
