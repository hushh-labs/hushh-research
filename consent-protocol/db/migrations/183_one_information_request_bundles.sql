-- Person-to-person information request correlation only.
-- Consent lifecycle authority and encrypted exports remain in consent_audit.

BEGIN;

CREATE TABLE IF NOT EXISTS one_information_request_bundles (
  bundle_id UUID PRIMARY KEY,
  requester_user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  subject_user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  requester_principal TEXT NOT NULL,
  idempotency_hash TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  purpose TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  connector_key_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ,
  CONSTRAINT one_information_request_distinct_people
    CHECK (requester_user_id <> subject_user_id),
  CONSTRAINT one_information_request_duration
    CHECK (duration_seconds BETWEEN 300 AND 2592000),
  CONSTRAINT one_information_request_idempotency
    UNIQUE (requester_user_id, idempotency_hash),
  CONSTRAINT one_information_request_fingerprint_format
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_one_information_request_subject
  ON one_information_request_bundles(subject_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS one_information_request_items (
  bundle_id UUID NOT NULL REFERENCES one_information_request_bundles(bundle_id) ON DELETE CASCADE,
  request_id TEXT PRIMARY KEY,
  scope_ref TEXT NOT NULL,
  scope TEXT NOT NULL,
  label TEXT NOT NULL,
  sensitivity TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bundle_id, scope_ref)
);

COMMIT;
