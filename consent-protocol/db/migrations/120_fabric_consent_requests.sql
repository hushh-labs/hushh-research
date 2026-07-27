BEGIN;

-- ============================================================================
-- Migration 120: fabric_consent_requests (the brand-initiated handshake)
-- ============================================================================
-- The missing verb of the Permission Gateway (PCHP RFC-002): a verified
-- subscriber (brand / professional) REQUESTS scoped access, and the person
-- approves it into a fabric grant from their own agent.
--
-- Modeled as a device-authorization-style pairing flow so the brand never
-- learns who the person is before consent:
--   1. subscriber creates a request -> gets request_id + short pairing code
--   2. the person's agent looks up the code, shows who/what/why/how-long/price
--   3. approve binds the verified uid, mints the grant (+ GRANT receipt), and
--      parks the signed handle for a SINGLE subscriber claim
--   4. the subscriber polls and claims the handle exactly once
--
-- `handle_once` holds the signed grant handle only between approval and the
-- single claim; it is cleared on claim, and requests expire in minutes. This
-- table stores workflow state and grant metadata only — never PWM values.
-- ============================================================================

CREATE TABLE IF NOT EXISTS fabric_consent_requests (
  request_id       TEXT PRIMARY KEY,
  pairing_code     TEXT NOT NULL UNIQUE,
  subscriber_id    TEXT NOT NULL,
  subscriber_label TEXT,
  scopes           JSONB NOT NULL DEFAULT '[]'::jsonb,
  purpose          TEXT NOT NULL,
  ttl_ms           BIGINT,
  price_cents      BIGINT,
  currency         TEXT,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'claimed')),
  user_id          TEXT,
  grant_id         TEXT,
  handle_once      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  responded_at     TIMESTAMPTZ,
  claimed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_fabric_requests_subscriber_created
  ON fabric_consent_requests (subscriber_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fabric_requests_status_expires
  ON fabric_consent_requests (status, expires_at);

COMMENT ON TABLE fabric_consent_requests IS
  'Brand-initiated PCHP RFC-002 consent requests (device-authorization-style pairing). Workflow state + grant metadata only; handle_once holds the signed grant handle solely between approval and its single claim. Never stores PWM values.';

COMMIT;
