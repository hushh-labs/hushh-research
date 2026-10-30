-- Migration 050: One KYC client-held connector registry
-- =====================================================
-- Strict client-side ZK KYC keeps connector private keys and review drafts on
-- the client. The backend stores only public connector metadata and
-- send/writeback status.

BEGIN;

CREATE TABLE IF NOT EXISTS one_kyc_client_connectors (
  connector_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  connector_key_id TEXT NOT NULL,
  connector_public_key TEXT NOT NULL,
  connector_wrapping_alg TEXT NOT NULL DEFAULT 'X25519-AES256-GCM',
  public_key_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT one_kyc_client_connectors_unique_user_key
    UNIQUE (user_id, connector_key_id),
  CONSTRAINT one_kyc_client_connectors_wrapping_check
    CHECK (connector_wrapping_alg IN ('X25519-AES256-GCM')),
  CONSTRAINT one_kyc_client_connectors_status_check
    CHECK (status IN ('active', 'rotated', 'revoked'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_kyc_client_connectors_one_active
  ON one_kyc_client_connectors(user_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_one_kyc_client_connectors_fingerprint
  ON one_kyc_client_connectors(public_key_fingerprint);

ALTER TABLE one_kyc_workflows
  DROP CONSTRAINT IF EXISTS one_kyc_workflows_status_check;

ALTER TABLE one_kyc_workflows
  ADD CONSTRAINT one_kyc_workflows_status_check
    CHECK (status IN (
      'needs_client_connector',
      'needs_scope',
      'needs_documents',
      'drafting',
      'waiting_on_user',
      'waiting_on_counterparty',
      'completed',
      'blocked'
    ));

ALTER TABLE one_kyc_workflows
  ADD COLUMN IF NOT EXISTS send_attempt_id TEXT,
  ADD COLUMN IF NOT EXISTS send_status TEXT NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS sent_message_id TEXT,
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS client_draft_hash TEXT,
  ADD COLUMN IF NOT EXISTS approved_send_hash TEXT,
  ADD COLUMN IF NOT EXISTS pkm_writeback_status TEXT NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS pkm_writeback_artifact_hash TEXT,
  ADD COLUMN IF NOT EXISTS pkm_writeback_attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pkm_writeback_last_error TEXT,
  ADD COLUMN IF NOT EXISTS pkm_writeback_completed_at TIMESTAMPTZ;

ALTER TABLE one_kyc_workflows
  DROP CONSTRAINT IF EXISTS one_kyc_workflows_send_status_check;

ALTER TABLE one_kyc_workflows
  ADD CONSTRAINT one_kyc_workflows_send_status_check
    CHECK (send_status IN ('not_started', 'sending', 'sent', 'failed'));

ALTER TABLE one_kyc_workflows
  DROP CONSTRAINT IF EXISTS one_kyc_workflows_pkm_writeback_status_check;

ALTER TABLE one_kyc_workflows
  ADD CONSTRAINT one_kyc_workflows_pkm_writeback_status_check
    CHECK (pkm_writeback_status IN ('not_started', 'pending', 'succeeded', 'failed'));

CREATE INDEX IF NOT EXISTS idx_one_kyc_workflows_send_status
  ON one_kyc_workflows(user_id, send_status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_one_kyc_workflows_writeback_status
  ON one_kyc_workflows(user_id, pkm_writeback_status, updated_at DESC);

UPDATE one_kyc_workflows
SET
  draft_body = NULL,
  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'legacy_draft_body_redacted_at', NOW(),
    'strict_client_zk_migration', '050_one_kyc_client_connector_registry'
  ),
  updated_at = NOW()
WHERE draft_body IS NOT NULL;

ALTER TABLE one_kyc_workflows
  DROP CONSTRAINT IF EXISTS one_kyc_workflows_draft_body_null_check;

ALTER TABLE one_kyc_workflows
  ADD CONSTRAINT one_kyc_workflows_draft_body_null_check
    CHECK (draft_body IS NULL);

COMMIT;
