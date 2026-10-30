-- Migration 051: Redact One KYC workflow token metadata
-- =====================================================
-- Strict client-side ZK workflow APIs must not become consent-token
-- distribution paths. Keep consent status and export metadata only.

BEGIN;

UPDATE one_kyc_workflows
SET
  metadata = metadata - 'access_token' - 'consent_token' - 'token' - 'token_id',
  updated_at = NOW()
WHERE metadata ?| ARRAY['access_token', 'consent_token', 'token', 'token_id'];

COMMIT;
