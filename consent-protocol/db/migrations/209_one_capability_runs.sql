BEGIN;

-- One durable task authority. This row is shared by voice, typed input, Siri,
-- web, and iOS. It intentionally stores no transcript, route, entity value,
-- provider payload, or generated prose: bounded task slots are encrypted and
-- every settlement reference is a one-way HMAC.
CREATE TABLE IF NOT EXISTS one_capability_runs (
  run_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL DEFAULT 'one.capability_run.v1',
  user_id TEXT NOT NULL
    REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  capability_id TEXT NOT NULL,
  capability_version INTEGER NOT NULL CHECK (capability_version > 0),
  graph_revision TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'proposed', 'needs_input', 'entity_choice', 'interaction_required',
    'confirmation_required', 'authorized', 'executing', 'settlement_received',
    'verified_succeeded', 'verified_failed', 'paused', 'cancelled', 'expired'
  )),
  step_cursor TEXT NOT NULL DEFAULT 'start',
  context_revision TEXT NOT NULL DEFAULT '',
  expected_context_revision TEXT NOT NULL DEFAULT '',
  pending_interaction TEXT,
  pending_directive_id TEXT,
  idempotency_key CHAR(64) NOT NULL,
  slots_hmac CHAR(64) NOT NULL,
  slots_ciphertext TEXT,
  slots_iv TEXT,
  slots_tag TEXT,
  slots_algorithm TEXT,
  settlement_reference_hmac CHAR(64),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT one_capability_runs_slot_envelope_complete CHECK (
    (slots_ciphertext IS NULL AND slots_iv IS NULL AND slots_tag IS NULL AND slots_algorithm IS NULL)
    OR
    (slots_ciphertext IS NOT NULL AND slots_iv IS NOT NULL AND slots_tag IS NOT NULL AND slots_algorithm IS NOT NULL)
  ),
  CONSTRAINT one_capability_runs_owner_idempotency_unique
    UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_one_capability_runs_owner_active
  ON one_capability_runs (user_id, updated_at DESC)
  WHERE status NOT IN ('verified_succeeded', 'verified_failed', 'cancelled', 'expired');

CREATE INDEX IF NOT EXISTS idx_one_capability_runs_expiry
  ON one_capability_runs (expires_at)
  WHERE status NOT IN ('verified_succeeded', 'verified_failed', 'cancelled', 'expired');

COMMENT ON TABLE one_capability_runs IS
  'Server-owned Agent One task state. Encrypted bounded slots only; no audio, transcript, route, entity value, credential, or provider payload.';
COMMENT ON COLUMN one_capability_runs.settlement_reference_hmac IS
  'One-way proof binding for a verified domain settlement; never a domain identifier or result payload.';

-- The migration-201 DDL event trigger discovers this user_id column, and this
-- explicit idempotent installer call makes that identity-write guard a
-- deploy-time postcondition of the durable-run migration as well.
SELECT public.install_account_deletion_write_guards();

COMMIT;
