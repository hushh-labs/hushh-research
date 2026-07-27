BEGIN;

-- ============================================================================
-- Migration 118: pwm_documents (Personal World Model store)
-- ============================================================================
-- The self-owned, uid-keyed Personal World Model document behind /api/pwm and
-- the cross-device "your private agent already knows you" loop of the PCHP
-- RFC-002 Preference Subscription Fabric.
--
-- One row per verified Firebase uid. `doc` is the person's OWN plaintext
-- preference document (for example { "connect": { "want", "zip", "updatedAt" } }),
-- returned only to them, merged section-level last-writer-wins by `updatedAt`,
-- and fully wipeable (DELETE or an empty PUT).
--
-- This is deliberately NOT a vault/ciphertext table: it never stores another
-- party's data and never vault-protected content. It is the owner's own
-- preference doc, written and read under their own consent, keyed by the uid
-- that only the verified token can assert.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pwm_documents (
  user_id TEXT PRIMARY KEY,
  doc JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pwm_documents_updated_at
  ON pwm_documents (updated_at DESC);

COMMENT ON TABLE pwm_documents IS
  'Owner-keyed Personal World Model doc for /api/pwm (PCHP RFC-002 subscription fabric). One row per verified Firebase uid; owner-only plaintext preference doc, section-level last-writer-wins by updatedAt, wipeable. Not a vault/ciphertext table.';

COMMIT;
