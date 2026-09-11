-- Tamper-evident consent-audit receipt chain (PCHP / NIST 800-53 AU-9 + AU-10).
--
-- PARKED (unapplied, flag-off): numbered in the 900 band, deliberately OUT of the
-- active migration sequence. It is NOT in db/release_migration_manifest.json, so it
-- is never applied until CONSENT_AUDIT_CHAIN_ENABLED is greenlit; at that point it
-- is renumbered into sequence and added to the manifest. The high band keeps it
-- from colliding with main's fast-moving migration head on every branch sync.
--
-- Why: the primary consent ledger (`consent_audit`) is event-sourced and HMAC-signed
-- at the token layer, but the TABLE itself is mutable (rows carry an updatable
-- `revoked_at`) and unchained -- so a silent edit or delete of an audit row is not
-- detectable. This table adds the missing tamper-evidence WITHOUT changing the
-- operational `consent_audit` write path: on every consent event a receipt is ALSO
-- appended here, fail-safe, to a per-subject append-only hash chain --
--
--     hash      = sha256( prev_hash || '\n' || canonical_payload )
--     signature = HMAC-SHA256( APP_SIGNING_KEY, hash )
--
-- verify_chain(subject_id) replays the chain and reports the first dropped,
-- reordered, or tampered receipt (AU-9 protection of audit info, AU-10
-- non-repudiation). Mirrors the proven fabric_receipts primitive (migration 119)
-- but keyed on the consent subject rather than the PWM owner. Stores only consent-
-- event metadata + receipt hashes; never token secrets or PKM values.
-- Non-breaking + idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS consent_audit_receipts (
  id              BIGSERIAL PRIMARY KEY,
  subject_id      TEXT   NOT NULL,
  seq             BIGINT NOT NULL,
  event_type      TEXT   NOT NULL,
  agent_id        TEXT,
  scope           TEXT,
  request_id      TEXT,
  token_id        TEXT,
  audit_event_id  BIGINT,
  issued_at_ms    BIGINT NOT NULL,
  metadata        JSONB  NOT NULL DEFAULT '{}'::jsonb,
  prev_hash       TEXT   NOT NULL,
  hash            TEXT   NOT NULL,
  signature       TEXT   NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subject_id, seq),
  UNIQUE (subject_id, hash)
);

CREATE INDEX IF NOT EXISTS idx_consent_audit_receipts_subject
  ON consent_audit_receipts (subject_id, id);

CREATE INDEX IF NOT EXISTS idx_consent_audit_receipts_audit_event
  ON consent_audit_receipts (audit_event_id);

COMMENT ON TABLE consent_audit_receipts IS
  'Tamper-evident consent-audit receipt chain (NIST 800-53 AU-9/AU-10). Append-only, per-subject: hash = sha256(prev_hash || canonical payload), signature = HMAC-SHA256(APP_SIGNING_KEY, hash). One receipt mirrored per consent_audit event; stores metadata + hashes only, never secrets.';

COMMIT;
