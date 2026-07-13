-- Consent export envelope v2 and explicit refresh lifecycle.
-- Existing grants become immutable snapshots unless continuous refresh was
-- explicitly disclosed and recorded by a new v2 approval.

BEGIN;

ALTER TABLE consent_exports
  ADD COLUMN IF NOT EXISTS export_id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS envelope_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS grant_id TEXT,
  ADD COLUMN IF NOT EXISTS app_id TEXT,
  ADD COLUMN IF NOT EXISTS scope_handle TEXT,
  ADD COLUMN IF NOT EXISTS recipient_key_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS payload_algorithm TEXT NOT NULL DEFAULT 'AES-256-GCM',
  ADD COLUMN IF NOT EXISTS envelope_aad JSONB,
  ADD COLUMN IF NOT EXISTS envelope_aad_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS ciphertext_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS ciphertext_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS refresh_policy TEXT NOT NULL DEFAULT 'snapshot';

ALTER TABLE consent_export_refresh_jobs
  ADD COLUMN IF NOT EXISTS claim_id UUID,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expected_export_revision INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_consent_export_refresh_jobs_claim_id
  ON consent_export_refresh_jobs(claim_id)
  WHERE claim_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_consent_exports_export_id
  ON consent_exports(export_id);
CREATE INDEX IF NOT EXISTS idx_consent_exports_app_resource
  ON consent_exports(app_id, export_id, expires_at DESC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'consent_exports_envelope_version_check'
  ) THEN
    ALTER TABLE consent_exports DROP CONSTRAINT consent_exports_envelope_version_check;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'consent_exports_refresh_policy_check'
  ) THEN
    ALTER TABLE consent_exports DROP CONSTRAINT consent_exports_refresh_policy_check;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'consent_exports_envelope_v2_fields_check'
  ) THEN
    ALTER TABLE consent_exports DROP CONSTRAINT consent_exports_envelope_v2_fields_check;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'consent_exports_refresh_status_check'
  ) THEN
    ALTER TABLE consent_exports DROP CONSTRAINT consent_exports_refresh_status_check;
  END IF;
END $$;

ALTER TABLE consent_exports
  ADD CONSTRAINT consent_exports_envelope_version_check
    CHECK (envelope_version IN (1, 2)),
  ADD CONSTRAINT consent_exports_refresh_policy_check
    CHECK (refresh_policy IN ('snapshot', 'continuous_until_expiry')),
  ADD CONSTRAINT consent_exports_envelope_v2_fields_check
    CHECK (
      envelope_version <> 2 OR (
        grant_id IS NOT NULL AND
        app_id IS NOT NULL AND
        scope_handle IS NOT NULL AND
        recipient_key_fingerprint ~ '^sha256:[0-9a-f]{64}$' AND
        payload_algorithm = 'AES-256-GCM' AND
        envelope_aad IS NOT NULL AND
        envelope_aad_sha256 ~ '^sha256:[0-9a-f]{64}$' AND
        ciphertext_sha256 ~ '^sha256:[0-9a-f]{64}$' AND
        ciphertext_bytes > 0
      )
    ),
  ADD CONSTRAINT consent_exports_refresh_status_check
    CHECK (refresh_status IN (
      'current',
      'refresh_pending',
      'refresh_failed',
      'stale',
      'scope_retired',
      'key_rebind_required'
    ));

-- No historical grant is silently upgraded to continuous sharing.
UPDATE consent_exports
SET refresh_policy = 'snapshot'
WHERE refresh_policy IS NULL
   OR refresh_policy NOT IN ('snapshot', 'continuous_until_expiry');

COMMENT ON COLUMN consent_exports.envelope_aad IS
  'Canonical AES-GCM associated-data contract; never contains plaintext PKM data.';
COMMENT ON COLUMN consent_exports.ciphertext_sha256 IS
  'Transfer-integrity digest. AES-GCM authenticates ciphertext against envelope_aad.';

CREATE OR REPLACE FUNCTION claim_consent_export_refresh_jobs_v2(
  p_user_id TEXT,
  p_limit INTEGER DEFAULT 50,
  p_lease_seconds INTEGER DEFAULT 300
)
RETURNS SETOF consent_export_refresh_jobs
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH claimable AS (
    SELECT jobs.id
    FROM consent_export_refresh_jobs AS jobs
    JOIN consent_exports AS exports
      ON exports.consent_token = jobs.consent_token
    WHERE jobs.user_id = p_user_id
      AND exports.user_id = p_user_id
      AND exports.refresh_policy = 'continuous_until_expiry'
      AND exports.expires_at > NOW()
      AND (
        jobs.status IN ('pending', 'failed')
        OR (
          jobs.status = 'processing'
          AND jobs.claim_expires_at IS NOT NULL
          AND jobs.claim_expires_at <= NOW()
        )
      )
    ORDER BY jobs.requested_at
    FOR UPDATE OF jobs SKIP LOCKED
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 100))
  )
  UPDATE consent_export_refresh_jobs AS jobs
  SET status = 'processing',
      claim_id = gen_random_uuid(),
      claimed_at = NOW(),
      claim_expires_at = NOW() + make_interval(secs => GREATEST(30, p_lease_seconds)),
      expected_export_revision = exports.export_revision,
      last_error = NULL,
      updated_at = NOW()
  FROM claimable, consent_exports AS exports
  WHERE jobs.id = claimable.id
    AND exports.consent_token = jobs.consent_token
  RETURNING jobs.*;
END;
$$;

CREATE OR REPLACE FUNCTION complete_consent_export_refresh_v2(
  p_user_id TEXT,
  p_claim_id UUID,
  p_expected_export_revision INTEGER,
  p_encrypted_data TEXT,
  p_iv TEXT,
  p_tag TEXT,
  p_wrapped_key_bundle JSONB,
  p_connector_key_id TEXT,
  p_connector_wrapping_alg TEXT,
  p_envelope_aad JSONB,
  p_envelope_aad_sha256 TEXT,
  p_ciphertext_sha256 TEXT,
  p_ciphertext_bytes BIGINT,
  p_source_content_revision INTEGER,
  p_source_manifest_revision INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_token TEXT;
  v_updated INTEGER;
BEGIN
  SELECT jobs.consent_token
  INTO v_token
  FROM consent_export_refresh_jobs AS jobs
  WHERE jobs.user_id = p_user_id
    AND jobs.claim_id = p_claim_id
    AND jobs.status = 'processing'
    AND jobs.claim_expires_at > NOW()
    AND jobs.expected_export_revision = p_expected_export_revision
  FOR UPDATE;

  IF v_token IS NULL THEN
    RETURN FALSE;
  END IF;

  UPDATE consent_exports
  SET encrypted_data = p_encrypted_data,
      iv = p_iv,
      tag = p_tag,
      wrapped_key_bundle = p_wrapped_key_bundle,
      connector_key_id = p_connector_key_id,
      connector_wrapping_alg = p_connector_wrapping_alg,
      export_revision = p_expected_export_revision + 1,
      export_generated_at = NOW(),
      source_content_revision = p_source_content_revision,
      source_manifest_revision = p_source_manifest_revision,
      refresh_status = 'current',
      envelope_version = 2,
      envelope_aad = p_envelope_aad,
      envelope_aad_sha256 = p_envelope_aad_sha256,
      ciphertext_sha256 = p_ciphertext_sha256,
      ciphertext_bytes = p_ciphertext_bytes
  WHERE consent_token = v_token
    AND user_id = p_user_id
    AND refresh_policy = 'continuous_until_expiry'
    AND refresh_status = 'refresh_pending'
    AND export_revision = p_expected_export_revision;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated <> 1 THEN
    RETURN FALSE;
  END IF;

  UPDATE consent_export_refresh_jobs
  SET status = 'completed',
      last_error = NULL,
      claim_expires_at = NULL,
      updated_at = NOW()
  WHERE user_id = p_user_id
    AND claim_id = p_claim_id;

  RETURN TRUE;
END;
$$;

COMMIT;
