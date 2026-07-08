BEGIN;

-- Consent-based E2E delivery for the Information Marketplace.
--
-- Until now approving a marketplace request only flipped a status row; no data
-- ever reached the buyer. Real delivery reuses the One Location user-to-user
-- envelope pattern (migration 061): the buyer publishes an ECDH P-256 public
-- "lock" (migration 078), the seller pulls the slice plaintext on-device with
-- their vault key, seals it against the buyer's public key, and posts ONLY
-- ciphertext. The server is a blind relay. This table persists that ciphertext
-- envelope, keyed to the approved request (the request row is the "grant"), so
-- the buyer can fetch and decrypt it on their device.
--
-- Coordinate-free by construction for location, and plaintext-free here: the
-- slice contents live only inside `ciphertext`; no cleartext slice value is ever
-- stored. Mirrors one_location_envelopes, scoped to the marketplace.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS marketplace_delivery_envelopes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL
    REFERENCES marketplace_access_requests(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL,
  buyer_user_id TEXT NOT NULL,
  recipient_key_id TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'ECDH-P256-AES256-GCM',
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  sender_ephemeral_public_key_jwk JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- The buyer's fetch after approval: the latest envelope for their request.
CREATE INDEX IF NOT EXISTS idx_marketplace_delivery_envelopes_request
  ON marketplace_delivery_envelopes (request_id, created_at DESC);

-- Point the request at its latest delivered envelope (mirrors
-- one_location_share_grants.latest_envelope_id).
ALTER TABLE marketplace_access_requests
  ADD COLUMN IF NOT EXISTS latest_envelope_id UUID
  REFERENCES marketplace_delivery_envelopes(id) ON DELETE SET NULL;

COMMENT ON TABLE marketplace_delivery_envelopes IS
  'Ciphertext-only marketplace slice deliveries. Slice values must exist only inside ciphertext; the server is a blind relay.';

COMMIT;
