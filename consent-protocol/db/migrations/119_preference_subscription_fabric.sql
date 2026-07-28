BEGIN;

-- ============================================================================
-- Migration 119: Preference Subscription Fabric (PCHP RFC-002)
-- ============================================================================
-- The two tables that turn the Personal World Model (migration 118) from a
-- private store into a subscribable fabric: a person grants a subscriber
-- (a brand/agent developer principal) scoped, dated, priced, revocable read
-- access to specific PWM fields, and every grant/read/revoke writes a signed,
-- hash-chained receipt the owner can audit.
--
--  * fabric_subscription_grants -- one row per (owner uid -> subscriber) grant,
--    binding { subscriber, scopes[], purpose, ttl, price? } to the owner's uid.
--    The signed grant handle is a consent token; only its fingerprint is
--    stored here. Revocation is fail-closed via `status`.
--
--  * fabric_receipts -- append-only, per-owner hash-chained ledger. Each row
--    links to the previous by `prev_hash`; `hash` = sha256(prev_hash || payload)
--    and `signature` = HMAC-SHA256(APP_SIGNING_KEY, hash). This is the PCHP
--    receipt primitive built here (hushh-research's consent ledger is
--    event-sourced + HMAC-signed but not chained; the fabric adds the chain).
--
-- Neither table stores PWM values or ciphertext -- only grant metadata and
-- receipt hashes. Owner-only; the uid is asserted by the verified token alone.
-- ============================================================================

CREATE TABLE IF NOT EXISTS fabric_subscription_grants (
  grant_id           TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  subscriber_id      TEXT NOT NULL,
  subscriber_label   TEXT,
  scopes             JSONB NOT NULL DEFAULT '[]'::jsonb,
  fields             JSONB NOT NULL DEFAULT '[]'::jsonb,
  purpose            TEXT NOT NULL,
  price_cents        BIGINT,
  currency           TEXT,
  token_fingerprint  TEXT NOT NULL UNIQUE,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ,
  revoked_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_fabric_grants_user_created
  ON fabric_subscription_grants (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fabric_grants_subscriber
  ON fabric_subscription_grants (subscriber_id);

COMMENT ON TABLE fabric_subscription_grants IS
  'PCHP RFC-002 subscription grants: (owner uid -> subscriber) scoped, dated, priced, revocable read access to PWM fields. Stores grant metadata + the handle fingerprint, never PWM values.';

CREATE TABLE IF NOT EXISTS fabric_receipts (
  id             BIGSERIAL PRIMARY KEY,
  user_id        TEXT NOT NULL,
  seq            BIGINT NOT NULL,
  event_type     TEXT NOT NULL CHECK (event_type IN ('GRANT', 'READ', 'REVOKE')),
  subscriber_id  TEXT,
  grant_id       TEXT,
  scopes         JSONB NOT NULL DEFAULT '[]'::jsonb,
  fields         JSONB NOT NULL DEFAULT '[]'::jsonb,
  purpose        TEXT,
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL,
  signature      TEXT NOT NULL,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at_ms  BIGINT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, seq),
  UNIQUE (user_id, hash)
);

CREATE INDEX IF NOT EXISTS idx_fabric_receipts_user_id
  ON fabric_receipts (user_id, id);

CREATE INDEX IF NOT EXISTS idx_fabric_receipts_grant
  ON fabric_receipts (grant_id);

COMMENT ON TABLE fabric_receipts IS
  'PCHP RFC-002 hash-chained receipt ledger. Append-only, per-owner chain: hash = sha256(prev_hash || canonical payload), signature = HMAC-SHA256(APP_SIGNING_KEY, hash). One receipt per grant/read/revoke.';

COMMIT;
