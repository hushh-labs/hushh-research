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
--     signature = Ed25519( CONSENT_AUDIT_ED25519_PRIVATE_KEY, hash )
--
-- The signature is NOT keyed with APP_SIGNING_KEY, and the difference is the whole
-- point. That key MINTS consent tokens, so signing the ledger with it meant the
-- party with the most reason to rewrite the record of a permission held the key
-- that could -- and because verification recomputed the MAC, no verifier existed
-- anywhere that could check the chain without also being able to forge it. That is
-- not AU-10 non-repudiation, it is self-attestation. The chain now signs under its
-- own Ed25519 namespace and verifies with the PUBLIC key.
--
-- TWO LEDGERS, one table. `ledger` discriminates, and each ledger is its own
-- per-subject sequence:
--   'consent'  -- the person-visible permission record.
--   'internal' -- the agent's OWN operations (consent_db.insert_internal_event),
--                 which reached no chain at all before this: the largest class of
--                 actions the system takes, with no receipt. Kept as a separate
--                 sequence because merging would advance the head an owner pins on
--                 every Kai turn, and a pin that moves constantly cannot detect the
--                 truncation it exists to detect.
--
-- APPLYING THIS OVER AN EARLIER DEV COPY: rows written before the key separation
-- carry an HMAC signature that verification now REFUSES (accepting it would restore
-- the downgrade), and their hashes predate `ledger` entering the canonical payload.
-- Truncate the table on dev as part of applying this. That is free only while the
-- chain is dev-only; it stops being free the moment the flag reaches UAT.
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
  ledger          TEXT   NOT NULL DEFAULT 'consent',
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
  UNIQUE (subject_id, ledger, seq),
  UNIQUE (subject_id, ledger, hash)
);

CREATE INDEX IF NOT EXISTS idx_consent_audit_receipts_subject
  ON consent_audit_receipts (subject_id, ledger, id);

CREATE INDEX IF NOT EXISTS idx_consent_audit_receipts_audit_event
  ON consent_audit_receipts (audit_event_id);

COMMENT ON TABLE consent_audit_receipts IS
  'Tamper-evident consent-audit receipt chain (NIST 800-53 AU-9/AU-10). Append-only, per (subject_id, ledger): hash = sha256(prev_hash || canonical payload), signature = Ed25519 under CONSENT_AUDIT_ED25519_PRIVATE_KEY -- deliberately NOT the token-minting APP_SIGNING_KEY, so an auditor can verify with the public key while holding nothing that could write. ledger is consent (person-visible permissions) or internal (the agent own operations). Stores metadata + hashes only, never secrets.';

COMMIT;
