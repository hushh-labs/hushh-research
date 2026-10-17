-- Two ledgers in the consent-audit receipt chain, as an ALTER rather than an edit.
--
-- PARKED (dev-only), 900 band, same contract as 904 which it extends.
--
-- WHY THIS IS A NEW FILE INSTEAD OF AN EDIT TO 904
-- 904 has already been applied to hushh-pda-dev. The dev-extra lane records a
-- checksum per applied migration and refuses a file whose contents have changed
-- (`db/migrate.py:1395` -> MigrationAuthorityError "Applied dev migration
-- checksum changed"). Editing 904 in place therefore does not add a column; it
-- breaks every subsequent dev deploy at the migration gate, before anything
-- ships. That is exactly what happened: 904 was amended in place on 2026-08-29,
-- and the next dev deploy of this branch would have failed on it.
--
-- The rule this encodes: an applied migration is immutable, whatever band it
-- sits in. "Parked" means unreleased, not un-applied.
--
-- WHAT IT DOES
-- Adds the `ledger` discriminator so the chain can carry two independent
-- per-subject sequences:
--   'consent'  -- the person-visible permission record.
--   'internal' -- the agent's OWN operations, which reached no chain at all
--                 before this: the largest class of actions the system takes,
--                 with no receipt. Kept as a separate sequence because merging
--                 would advance the head an owner pins for truncation detection
--                 on every turn, and a pin that moves constantly cannot detect
--                 the truncation it exists for.
--
-- Every statement survives a second application: the lane runs REPLAY, and
-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, so each ADD is preceded by a
-- DROP ... IF EXISTS naming the same constraint. Matches the house pattern in
-- 019, 024, 027, 039 and 141.

BEGIN;

ALTER TABLE consent_audit_receipts
  ADD COLUMN IF NOT EXISTS ledger TEXT NOT NULL DEFAULT 'consent';

-- The uniqueness that makes the two sequences independent. Postgres derives
-- these names from the table and column list, so the pre-913 names are the ones
-- dropped here and the new ones carry `ledger`.
ALTER TABLE consent_audit_receipts
  DROP CONSTRAINT IF EXISTS consent_audit_receipts_subject_id_seq_key;
ALTER TABLE consent_audit_receipts
  DROP CONSTRAINT IF EXISTS consent_audit_receipts_subject_id_ledger_seq_key;
ALTER TABLE consent_audit_receipts
  ADD CONSTRAINT consent_audit_receipts_subject_id_ledger_seq_key
  UNIQUE (subject_id, ledger, seq);

ALTER TABLE consent_audit_receipts
  DROP CONSTRAINT IF EXISTS consent_audit_receipts_subject_id_hash_key;
ALTER TABLE consent_audit_receipts
  DROP CONSTRAINT IF EXISTS consent_audit_receipts_subject_id_ledger_hash_key;
ALTER TABLE consent_audit_receipts
  ADD CONSTRAINT consent_audit_receipts_subject_id_ledger_hash_key
  UNIQUE (subject_id, ledger, hash);

DROP INDEX IF EXISTS idx_consent_audit_receipts_subject;
CREATE INDEX IF NOT EXISTS idx_consent_audit_receipts_subject
  ON consent_audit_receipts (subject_id, ledger, id);

COMMENT ON TABLE consent_audit_receipts IS
  'Tamper-evident consent-audit receipt chain (NIST 800-53 AU-9/AU-10). Append-only, per (subject_id, ledger): hash = sha256(prev_hash || canonical payload), signature = Ed25519 under CONSENT_AUDIT_ED25519_PRIVATE_KEY -- deliberately NOT the token-minting APP_SIGNING_KEY, so an auditor can verify with the public key while holding nothing that could write. ledger is consent (person-visible permissions) or internal (the agent own operations). Stores metadata + hashes only, never secrets.';

COMMIT;
