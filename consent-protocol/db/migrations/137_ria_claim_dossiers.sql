BEGIN;

-- Migration 137: idempotency ledger for post-claim background dossiers.
--
-- A successful RIA claim dispatches a best-effort background dossier run
-- (scan -> persist -> mail). This table is that dispatch's idempotency
-- ledger: INSERT ... ON CONFLICT (ria_profile_id, crd_number) DO NOTHING
-- picks a single winner, so re-claims and provisional->verified email
-- upgrades never spawn a second scan or a second mail. Creating a row
-- grants no access and never gates the claim itself; every worker failure
-- lands in status, never in the claim response.
CREATE TABLE IF NOT EXISTS ria_claim_dossiers (
  id BIGSERIAL PRIMARY KEY,
  ria_profile_id UUID NOT NULL
    REFERENCES ria_profiles(id) ON DELETE CASCADE,
  crd_number TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued', 'scanning', 'generated', 'sent',
      'scan_failed', 'send_failed', 'blocked_no_email', 'send_blocked_test_unset'
    )),
  scan_id TEXT,
  result_markdown TEXT,
  result_summary TEXT,
  mail_message_id TEXT,
  mail_recipient TEXT,
  mail_intended_recipient TEXT,
  mail_delivery_mode TEXT,
  error TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (ria_profile_id, crd_number)
);

CREATE INDEX IF NOT EXISTS idx_ria_claim_dossiers_user
  ON ria_claim_dossiers (user_id, requested_at DESC);

COMMENT ON TABLE ria_claim_dossiers IS
  'Idempotency ledger for post-claim background dossiers: one row per (ria_profile_id, crd_number). Best-effort by contract — a dossier can never fail a claim.';

COMMIT;
