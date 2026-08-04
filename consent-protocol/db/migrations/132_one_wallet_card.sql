BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- One row per owner: the Wallet Profile card behind a Hussh One pass.
--
-- This is a dedicated, additive plane. It deliberately does not reuse
-- pkm_default_available_projections: that table is read by the Information
-- Marketplace catalogue and mints a fresh handle on every edit, so publishing
-- a card there would both list the owner for sale and invalidate an already
-- printed QR code.
--
-- Privacy boundary:
-- - the plaintext share token is never stored; only its SHA-256 hex digest
--   lives here, and it is returned to the owner exactly once at create and at
--   rotate;
-- - card_payload holds only the closed, server-validated allowlist of fields
--   the owner explicitly chose to show. It carries no PKM material, no vault
--   reference, no credential, and no coordinates - location_label is a coarse
--   city/region string only;
-- - scans are aggregate-only. No per-scan row, IP address, user agent,
--   geolocation, or referrer is ever recorded, matching the location-agent
--   rule that consent metadata must never carry coordinates or traces;
-- - pause is indistinguishable from non-existence at the public endpoint, so
--   status is never leaked to a visitor holding a stale link.
CREATE TABLE IF NOT EXISTS one_wallet_cards (
  user_id TEXT PRIMARY KEY,
  pass_serial UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  share_token_hash TEXT NOT NULL UNIQUE,
  share_token_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'revoked')),
  card_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  display_name TEXT,
  headline TEXT,
  avatar_url TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  last_scanned_at TIMESTAMPTZ,
  scan_count BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT chk_one_wallet_cards_token_version
    CHECK (share_token_version > 0),
  CONSTRAINT chk_one_wallet_cards_scan_count
    CHECK (scan_count >= 0),
  CONSTRAINT chk_one_wallet_cards_payload_object
    CHECK (jsonb_typeof(card_payload) = 'object'),
  CONSTRAINT chk_one_wallet_cards_revocation
    CHECK (
      (status = 'revoked' AND revoked_at IS NOT NULL)
      OR (status <> 'revoked')
    )
);

CREATE INDEX IF NOT EXISTS idx_one_wallet_cards_status
  ON one_wallet_cards (status);

COMMENT ON TABLE one_wallet_cards IS
  'Owner-controlled Wallet Profile card resolved by an anonymous share token. Aggregate scan counters only; no per-scan telemetry row, IP address, user agent, geolocation, or referrer is ever stored.';

COMMENT ON COLUMN one_wallet_cards.pass_serial IS
  'Stable serial of the installed Apple Wallet pass. Minted once and never rotated; never returned to a public visitor.';

COMMENT ON COLUMN one_wallet_cards.share_token_hash IS
  'SHA-256 hex digest of the share token. The plaintext token is NEVER stored, logged, or recoverable; it is returned to the owner only in the create and rotate responses.';

COMMENT ON COLUMN one_wallet_cards.share_token_version IS
  'Increments on every rotate. A rotate invalidates the previous token immediately because only the current digest is retained.';

COMMENT ON COLUMN one_wallet_cards.card_payload IS
  'Server-validated allowlisted profile fields the owner explicitly chose to share. Never PKM material, credentials, vault references, or coordinates; stored as plain text and escaped at render time.';

COMMENT ON COLUMN one_wallet_cards.status IS
  'Owner-controlled sharing posture. A paused card is served exactly like an unknown token so pausing cannot be detected by a visitor.';

COMMENT ON COLUMN one_wallet_cards.expires_at IS
  'Optional owner-set expiry. NULL means the card does not expire; an elapsed value is served as gone, never as missing.';

COMMENT ON COLUMN one_wallet_cards.last_scanned_at IS
  'Coarse best-effort timestamp of the most recent public resolve. No per-scan telemetry row is ever kept, and no scanner identity, address, or location is recorded.';

COMMENT ON COLUMN one_wallet_cards.scan_count IS
  'Aggregate resolve counter only. It is incremented best-effort and never expands into per-scan telemetry rows; a counter failure must never fail the read.';

COMMIT;
