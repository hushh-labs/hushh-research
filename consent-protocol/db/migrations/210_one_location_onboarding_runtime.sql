BEGIN;

-- A composite owner key lets every Location workflow record prove that it
-- belongs to the same authenticated owner as its durable capability run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'one_capability_runs_run_owner_unique'
      AND conrelid = 'one_capability_runs'::regclass
  ) THEN
    ALTER TABLE one_capability_runs
      ADD CONSTRAINT one_capability_runs_run_owner_unique UNIQUE (run_id, user_id);
  END IF;
END $$;

-- One-time interaction authority.  Only bounded enum-like outcomes and HMAC
-- digests are stored; there is no audio, transcript, coordinate, place label,
-- route query, provider payload, or arbitrary error text.
CREATE TABLE IF NOT EXISTS one_location_onboarding_interactions (
  lease_id TEXT PRIMARY KEY
    CHECK (lease_id ~ '^loclease_[a-z0-9]{16,96}$'),
  directive_id TEXT NOT NULL UNIQUE
    CHECK (directive_id ~ '^locdirective_[a-z0-9]{16,96}$'),
  schema_version TEXT NOT NULL DEFAULT 'one.location_interaction_lease.v1',
  user_id TEXT NOT NULL
    REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL DEFAULT 2 CHECK (workflow_version = 2),
  step_cursor TEXT NOT NULL CHECK (step_cursor IN (
    'location.onboarding.preflight',
    'location.onboarding.introduction',
    'location.onboarding.permission',
    'location.onboarding.position',
    'location.onboarding.place',
    'location.onboarding.circle',
    'location.onboarding.complete'
  )),
  run_revision BIGINT NOT NULL CHECK (run_revision > 0),
  context_revision TEXT NOT NULL DEFAULT '',
  surface_id TEXT NOT NULL
    CHECK (surface_id ~ '^one[.]location[.][a-z0-9_]+[.]v2$'),
  resume_surface_id TEXT
    CHECK (resume_surface_id ~ '^one[.]location[.][a-z0-9_]+[.]v2$'),
  allowed_actions_digest CHAR(64) NOT NULL
    CHECK (allowed_actions_digest ~ '^[0-9a-f]{64}$'),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  outcome_code TEXT,
  result_digest CHAR(64),
  CONSTRAINT one_location_onboarding_interactions_run_owner_fk
    FOREIGN KEY (run_id, user_id)
    REFERENCES one_capability_runs(run_id, user_id) ON DELETE CASCADE,
  CONSTRAINT one_location_onboarding_interactions_run_revision_unique
    UNIQUE (run_id, run_revision),
  CONSTRAINT one_location_onboarding_interactions_expiry_order
    CHECK (expires_at > issued_at),
  CONSTRAINT one_location_onboarding_interactions_pause_target CHECK (
    (surface_id = 'one.location.paused.v2'
      AND resume_surface_id IS NOT NULL
      AND resume_surface_id <> 'one.location.paused.v2')
    OR
    (surface_id <> 'one.location.paused.v2' AND resume_surface_id IS NULL)
  ),
  CONSTRAINT one_location_onboarding_interactions_result_complete CHECK (
    (consumed_at IS NULL AND outcome_code IS NULL AND result_digest IS NULL)
    OR
    (consumed_at IS NOT NULL AND outcome_code IS NOT NULL
      AND result_digest ~ '^[0-9a-f]{64}$')
  )
);

-- Opaque, server-issued evidence.  The evidence digest is an HMAC over an
-- adapter settlement and is not a domain value or provider identifier.
CREATE TABLE IF NOT EXISTS one_location_onboarding_receipts (
  receipt_id TEXT PRIMARY KEY
    CHECK (receipt_id ~ '^loc(perm|place|circle|complete)_[a-z0-9]{16,96}$'),
  schema_version TEXT NOT NULL DEFAULT 'one.location_receipt.v1',
  user_id TEXT NOT NULL
    REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL DEFAULT 2 CHECK (workflow_version = 2),
  step_cursor TEXT NOT NULL CHECK (step_cursor IN (
    'location.onboarding.preflight',
    'location.onboarding.introduction',
    'location.onboarding.permission',
    'location.onboarding.position',
    'location.onboarding.place',
    'location.onboarding.circle',
    'location.onboarding.complete'
  )),
  context_revision TEXT NOT NULL DEFAULT '',
  receipt_kind TEXT NOT NULL
    CHECK (receipt_kind IN ('permission', 'place', 'circle', 'completion')),
  outcome_code TEXT NOT NULL
    CHECK (outcome_code IN ('observed', 'saved', 'skipped', 'provisioned', 'verified')),
  issuer TEXT NOT NULL CHECK (issuer ~ '^[a-z][a-z0-9_]{0,63}$'),
  evidence_digest CHAR(64) NOT NULL
    CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  lease_id TEXT REFERENCES one_location_onboarding_interactions(lease_id)
    ON DELETE SET NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CONSTRAINT one_location_onboarding_receipts_run_owner_fk
    FOREIGN KEY (run_id, user_id)
    REFERENCES one_capability_runs(run_id, user_id) ON DELETE CASCADE,
  CONSTRAINT one_location_onboarding_receipts_kind_unique
    UNIQUE (run_id, receipt_kind),
  CONSTRAINT one_location_onboarding_receipts_expiry_order
    CHECK (expires_at > issued_at)
);

-- Server-side metadata for a device-encrypted pre-vault draft.  The actual
-- Location payload stays encrypted on the device; only its SHA-256 digest,
-- lifecycle status, owner/run/graph/revision binding, and expiry exist here.
CREATE TABLE IF NOT EXISTS one_location_onboarding_drafts (
  draft_id TEXT PRIMARY KEY
    CHECK (draft_id ~ '^locdraft_[a-z0-9]{16,96}$'),
  schema_version TEXT NOT NULL DEFAULT 'one.pre_vault_location_draft_envelope.v1',
  user_id TEXT NOT NULL
    REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL UNIQUE,
  workflow_version INTEGER NOT NULL DEFAULT 2 CHECK (workflow_version = 2),
  graph_revision TEXT NOT NULL,
  run_revision BIGINT NOT NULL CHECK (run_revision > 0),
  content_digest CHAR(64) NOT NULL
    CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status = 'staged'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT one_location_onboarding_drafts_run_owner_fk
    FOREIGN KEY (run_id, user_id)
    REFERENCES one_capability_runs(run_id, user_id) ON DELETE CASCADE,
  CONSTRAINT one_location_onboarding_drafts_expiry_order
    CHECK (expires_at > created_at)
);

-- Single-use authority for moving one device-encrypted Location draft into
-- the owner's encrypted PKM.  The bearer token itself is never stored: the
-- backend can deterministically re-issue it while Postgres compares only its
-- SHA-256 digest.  Every other field is an opaque identifier, revision,
-- timestamp, or keyed digest; no Location value or ciphertext is present.
CREATE TABLE IF NOT EXISTS one_location_pkm_finalize_authorizations (
  authorization_id TEXT PRIMARY KEY
    CHECK (authorization_id ~ '^locpkmauth_[a-z0-9]{16,96}$'),
  schema_version TEXT NOT NULL DEFAULT 'one.location_pkm_finalize_authorization.v1',
  token_sha256 CHAR(64) NOT NULL
    CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  user_id TEXT NOT NULL
    REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL DEFAULT 2 CHECK (workflow_version = 2),
  run_revision BIGINT NOT NULL CHECK (run_revision > 0),
  context_revision TEXT NOT NULL DEFAULT '',
  lease_id TEXT NOT NULL
    REFERENCES one_location_onboarding_interactions(lease_id) ON DELETE CASCADE,
  directive_id TEXT NOT NULL
    REFERENCES one_location_onboarding_interactions(directive_id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL
    CHECK (draft_id ~ '^locdraft_[a-z0-9]{16,96}$'),
  draft_digest CHAR(64) NOT NULL
    CHECK (draft_digest ~ '^[0-9a-f]{64}$'),
  expected_commit_id UUID NOT NULL,
  place_receipt_evidence_digest CHAR(64) NOT NULL
    CHECK (place_receipt_evidence_digest ~ '^[0-9a-f]{64}$'),
  interaction_result_digest CHAR(64) NOT NULL
    CHECK (interaction_result_digest ~ '^[0-9a-f]{64}$'),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  committed_request_fingerprint CHAR(64),
  result_content_revision INTEGER,
  result_manifest_revision INTEGER,
  result_archived_revision_id UUID,
  CONSTRAINT one_location_pkm_finalize_authorizations_run_owner_fk
    FOREIGN KEY (run_id, user_id)
    REFERENCES one_capability_runs(run_id, user_id) ON DELETE CASCADE,
  CONSTRAINT one_location_pkm_finalize_authorizations_run_revision_unique
    UNIQUE (run_id, run_revision),
  CONSTRAINT one_location_pkm_finalize_authorizations_expiry_order
    CHECK (expires_at > issued_at),
  CONSTRAINT one_location_pkm_finalize_authorizations_result_complete CHECK (
    (consumed_at IS NULL
      AND committed_request_fingerprint IS NULL
      AND result_content_revision IS NULL
      AND result_manifest_revision IS NULL
      AND result_archived_revision_id IS NULL)
    OR
    (consumed_at IS NOT NULL
      AND committed_request_fingerprint ~ '^[0-9a-f]{64}$'
      AND result_content_revision IS NOT NULL
      AND result_content_revision > 0
      AND result_manifest_revision IS NOT NULL
      AND result_manifest_revision > 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_one_location_onboarding_interactions_expiry
  ON one_location_onboarding_interactions (expires_at)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_one_location_onboarding_receipts_owner_run
  ON one_location_onboarding_receipts (user_id, run_id, issued_at);

CREATE INDEX IF NOT EXISTS idx_one_location_onboarding_drafts_expiry
  ON one_location_onboarding_drafts (expires_at);

CREATE INDEX IF NOT EXISTS idx_one_location_pkm_finalize_authorizations_expiry
  ON one_location_pkm_finalize_authorizations (expires_at)
  WHERE consumed_at IS NULL;

-- These tables are reached only through the authenticated backend workflow
-- API.  No browser/mobile database role receives a direct policy.
ALTER TABLE one_location_onboarding_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE one_location_onboarding_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE one_location_onboarding_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE one_location_pkm_finalize_authorizations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON one_location_onboarding_interactions FROM anon;
    REVOKE ALL ON one_location_onboarding_receipts FROM anon;
    REVOKE ALL ON one_location_onboarding_drafts FROM anon;
    REVOKE ALL ON one_location_pkm_finalize_authorizations FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON one_location_onboarding_interactions FROM authenticated;
    REVOKE ALL ON one_location_onboarding_receipts FROM authenticated;
    REVOKE ALL ON one_location_onboarding_drafts FROM authenticated;
    REVOKE ALL ON one_location_pkm_finalize_authorizations FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON one_location_onboarding_interactions TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON one_location_onboarding_receipts TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON one_location_onboarding_drafts TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON one_location_pkm_finalize_authorizations TO service_role;
  END IF;
END $$;

-- Location finalization is a stricter wrapper around the existing general PKM
-- mutation.  It locks the PKM domain first (the same order used by v4), then
-- the workflow authority rows.  Consequently a concurrent Skip/Cancel either
-- commits first and prevents the PKM write, or waits and observes the already
-- consumed lease after the PKM write plus Location receipt commit together.
CREATE OR REPLACE FUNCTION public.commit_pkm_domain_mutation_v5(
  p_user_id TEXT,
  p_domain TEXT,
  p_expected_content_revision INTEGER,
  p_next_content_revision INTEGER,
  p_segment_rows JSONB,
  p_manifest_row JSONB,
  p_path_rows JSONB,
  p_scope_rows JSONB,
  p_summary_patch JSONB,
  p_event_rows JSONB,
  p_legacy_blob_present BOOLEAN,
  p_refresh_tokens TEXT[] DEFAULT ARRAY[]::TEXT[],
  p_trigger_paths JSONB DEFAULT '[]'::JSONB,
  p_commit_id UUID DEFAULT gen_random_uuid(),
  p_commit_kind TEXT DEFAULT 'mutation',
  p_upgrade_claim JSONB DEFAULT NULL,
  p_preservation_receipt JSONB DEFAULT '{}'::JSONB,
  p_request_fingerprint TEXT DEFAULT NULL,
  p_location_finalize_authorization JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_authority one_location_pkm_finalize_authorizations%ROWTYPE;
  v_result JSONB;
  v_advanced_revision BIGINT;
  v_receipt_id TEXT;
  v_authorization_token TEXT;
BEGIN
  IF p_domain <> 'location'
     OR p_commit_kind <> 'mutation'
     OR p_upgrade_claim IS NOT NULL THEN
    RAISE EXCEPTION 'location_pkm_finalize_target_invalid';
  END IF;
  IF p_location_finalize_authorization IS NULL
     OR jsonb_typeof(p_location_finalize_authorization) <> 'object'
     OR (SELECT COUNT(*) FROM jsonb_object_keys(p_location_finalize_authorization)) <> 11
     OR NOT p_location_finalize_authorization ?& ARRAY[
       'schema_version', 'authorization_id', 'token', 'run_id',
       'run_revision', 'lease_id', 'directive_id', 'draft_ref',
       'draft_digest', 'expected_commit_id', 'expires_at'
     ] THEN
    RAISE EXCEPTION 'location_pkm_finalize_authorization_invalid';
  END IF;
  IF p_location_finalize_authorization->>'schema_version'
       <> 'one.location_pkm_finalize_authorization.v1'
     OR COALESCE(p_location_finalize_authorization->>'authorization_id', '')
       !~ '^locpkmauth_[a-z0-9]{16,96}$'
     OR COALESCE(p_location_finalize_authorization->>'token', '')
       !~ '^locpkmtoken_[a-z0-9]{16,96}_[0-9a-f]{64}$'
     OR COALESCE(p_location_finalize_authorization->>'draft_digest', '')
       !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_location_finalize_authorization->>'expected_commit_id', '')
       !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_request_fingerprint IS NULL
     OR p_request_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'location_pkm_finalize_authorization_invalid';
  END IF;

  -- Match v4's domain-lock order before touching workflow rows to avoid a
  -- PKM/finalization deadlock with another writer for this owner and domain.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id || ':' || p_domain, 0));

  SELECT * INTO v_authority
  FROM one_location_pkm_finalize_authorizations authority
  WHERE authority.authorization_id =
          p_location_finalize_authorization->>'authorization_id'
    AND authority.user_id = p_user_id
    AND authority.run_id = p_location_finalize_authorization->>'run_id'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'location_pkm_finalize_authorization_not_owned';
  END IF;

  v_authorization_token := p_location_finalize_authorization->>'token';
  IF v_authority.schema_version <>
       p_location_finalize_authorization->>'schema_version'
     OR v_authority.run_revision <>
       (p_location_finalize_authorization->>'run_revision')::BIGINT
     OR v_authority.lease_id <>
       p_location_finalize_authorization->>'lease_id'
     OR v_authority.directive_id <>
       p_location_finalize_authorization->>'directive_id'
     OR v_authority.draft_id <>
       p_location_finalize_authorization->>'draft_ref'
     OR v_authority.draft_digest <>
       p_location_finalize_authorization->>'draft_digest'
     OR v_authority.expected_commit_id::TEXT <>
       p_location_finalize_authorization->>'expected_commit_id'
     OR v_authority.expected_commit_id <> p_commit_id
     OR v_authority.expires_at <>
       (p_location_finalize_authorization->>'expires_at')::TIMESTAMPTZ
     OR v_authority.token_sha256 <>
       encode(digest(v_authorization_token, 'sha256'), 'hex') THEN
    RAISE EXCEPTION 'location_pkm_finalize_authorization_binding_mismatch';
  END IF;

  -- The workflow bearer is strictly single-use. Response-loss recovery reads
  -- the durable Location receipt through the run API; it never resubmits this
  -- capability or dispatches another PKM mutation.
  IF v_authority.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'location_pkm_finalize_authorization_replayed';
  END IF;

  IF v_authority.expires_at <= NOW() THEN
    RAISE EXCEPTION 'location_pkm_finalize_authorization_expired';
  END IF;

  -- Lock and re-check every live authority predicate before v4 can mutate PKM.
  -- No client-reported success flag participates in this decision.
  PERFORM 1
  FROM one_capability_runs run
  JOIN one_location_onboarding_interactions interaction
    ON interaction.run_id = run.run_id
   AND interaction.user_id = run.user_id
  JOIN one_location_onboarding_drafts draft
    ON draft.run_id = run.run_id
   AND draft.user_id = run.user_id
  WHERE run.run_id = v_authority.run_id
    AND run.user_id = v_authority.user_id
    AND run.capability_id = 'workflow.setup.location'
    AND run.capability_version = 2
    AND run.status = 'interaction_required'
    AND run.step_cursor = 'location.onboarding.complete'
    AND run.revision = v_authority.run_revision
    AND run.pending_interaction = 'one.location.awaiting_vault_finalize.v2'
    AND run.pending_directive_id = v_authority.directive_id
    AND run.expires_at > NOW()
    AND interaction.lease_id = v_authority.lease_id
    AND interaction.directive_id = v_authority.directive_id
    AND interaction.workflow_version = 2
    AND interaction.step_cursor = run.step_cursor
    AND interaction.run_revision = run.revision
    AND interaction.context_revision = v_authority.context_revision
    AND interaction.surface_id = 'one.location.awaiting_vault_finalize.v2'
    AND interaction.consumed_at IS NULL
    AND interaction.expires_at > NOW()
    AND draft.draft_id = v_authority.draft_id
    AND draft.workflow_version = 2
    AND draft.graph_revision = run.graph_revision
    AND draft.content_digest = v_authority.draft_digest
    AND draft.status = 'staged'
    AND draft.expires_at > NOW()
    AND NOT EXISTS (
      SELECT 1 FROM one_location_onboarding_receipts prior
      WHERE prior.run_id = run.run_id AND prior.receipt_kind = 'place'
    )
  FOR UPDATE OF run, interaction, draft;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'location_pkm_finalize_authorization_inactive';
  END IF;

  v_result := public.commit_pkm_domain_mutation_v4(
    p_user_id,
    p_domain,
    p_expected_content_revision,
    p_next_content_revision,
    p_segment_rows,
    p_manifest_row,
    p_path_rows,
    p_scope_rows,
    p_summary_patch,
    p_event_rows,
    p_legacy_blob_present,
    p_refresh_tokens,
    p_trigger_paths,
    p_commit_id,
    p_commit_kind,
    p_upgrade_claim,
    p_preservation_receipt,
    p_request_fingerprint
  );
  IF NOT COALESCE((v_result->>'success')::BOOLEAN, FALSE) THEN
    RETURN v_result;
  END IF;

  UPDATE one_location_onboarding_interactions interaction
  SET consumed_at = NOW(),
      outcome_code = 'place_saved',
      result_digest = v_authority.interaction_result_digest
  WHERE interaction.lease_id = v_authority.lease_id
    AND interaction.directive_id = v_authority.directive_id
    AND interaction.run_id = v_authority.run_id
    AND interaction.user_id = v_authority.user_id
    AND interaction.run_revision = v_authority.run_revision
    AND interaction.consumed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'location_pkm_finalize_lease_consumption_failed';
  END IF;

  v_receipt_id := 'locplace_' || replace(gen_random_uuid()::TEXT, '-', '');
  INSERT INTO one_location_onboarding_receipts (
    receipt_id, user_id, run_id, workflow_version, step_cursor,
    context_revision, receipt_kind, outcome_code, issuer,
    evidence_digest, lease_id, expires_at
  ) VALUES (
    v_receipt_id, v_authority.user_id, v_authority.run_id, 2,
    'location.onboarding.complete', v_authority.context_revision,
    'place', 'saved', 'pkm_atomic_finalize',
    v_authority.place_receipt_evidence_digest, v_authority.lease_id,
    LEAST(
      (SELECT expires_at FROM one_capability_runs
       WHERE run_id = v_authority.run_id AND user_id = v_authority.user_id),
      NOW() + INTERVAL '24 hours'
    )
  );

  DELETE FROM one_location_onboarding_drafts draft
  WHERE draft.draft_id = v_authority.draft_id
    AND draft.run_id = v_authority.run_id
    AND draft.user_id = v_authority.user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'location_pkm_finalize_draft_purge_failed';
  END IF;

  UPDATE one_capability_runs run
  SET status = 'interaction_required',
      pending_interaction = NULL,
      pending_directive_id = NULL,
      revision = revision + 1,
      updated_at = NOW()
  WHERE run.run_id = v_authority.run_id
    AND run.user_id = v_authority.user_id
    AND run.revision = v_authority.run_revision
    AND run.pending_directive_id = v_authority.directive_id
  RETURNING run.revision INTO v_advanced_revision;
  IF v_advanced_revision IS NULL THEN
    RAISE EXCEPTION 'location_pkm_finalize_run_advance_failed';
  END IF;

  UPDATE one_location_pkm_finalize_authorizations authority
  SET consumed_at = NOW(),
      committed_request_fingerprint = p_request_fingerprint,
      result_content_revision = (v_result->>'data_version')::INTEGER,
      result_manifest_revision = (v_result->>'manifest_revision')::INTEGER,
      result_archived_revision_id = NULLIF(
        v_result->>'archived_revision_id', ''
      )::UUID
  WHERE authority.authorization_id = v_authority.authorization_id
    AND authority.consumed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'location_pkm_finalize_authorization_consumption_failed';
  END IF;

  RETURN v_result || jsonb_build_object(
    'location_run_revision', v_advanced_revision,
    'location_place_receipt_id', v_receipt_id
  );
END;
$$;

-- The wrapper is a backend data-plane capability, not a browser/mobile RPC.
-- RLS already denies its table reads to those roles, and explicit EXECUTE
-- revocation keeps that boundary auditable instead of relying on RLS alone.
DO $$
BEGIN
  REVOKE EXECUTE ON FUNCTION public.commit_pkm_domain_mutation_v5(
    TEXT, TEXT, INTEGER, INTEGER, JSONB, JSONB, JSONB, JSONB, JSONB, JSONB,
    BOOLEAN, TEXT[], JSONB, UUID, TEXT, JSONB, JSONB, TEXT, JSONB
  ) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION public.commit_pkm_domain_mutation_v5(
      TEXT, TEXT, INTEGER, INTEGER, JSONB, JSONB, JSONB, JSONB, JSONB, JSONB,
      BOOLEAN, TEXT[], JSONB, UUID, TEXT, JSONB, JSONB, TEXT, JSONB
    ) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE EXECUTE ON FUNCTION public.commit_pkm_domain_mutation_v5(
      TEXT, TEXT, INTEGER, INTEGER, JSONB, JSONB, JSONB, JSONB, JSONB, JSONB,
      BOOLEAN, TEXT[], JSONB, UUID, TEXT, JSONB, JSONB, TEXT, JSONB
    ) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.commit_pkm_domain_mutation_v5(
      TEXT, TEXT, INTEGER, INTEGER, JSONB, JSONB, JSONB, JSONB, JSONB, JSONB,
      BOOLEAN, TEXT[], JSONB, UUID, TEXT, JSONB, JSONB, TEXT, JSONB
    ) TO service_role;
  END IF;
END $$;

COMMENT ON TABLE one_location_onboarding_interactions IS
  'One-time owner/run/revision-bound Location interaction leases; metadata and digests only.';
COMMENT ON TABLE one_location_onboarding_receipts IS
  'Opaque Location workflow settlement receipts; no private entity or provider values.';
COMMENT ON TABLE one_location_onboarding_drafts IS
  'Metadata for an encrypted device-only pre-vault Location draft; never stores coordinates, labels, addresses, ciphertext, or keys.';
COMMENT ON TABLE one_location_pkm_finalize_authorizations IS
  'Single-use Location-to-PKM finalize authority; opaque ids, revisions, timestamps, and digests only. The bearer token and Location values are never stored.';

SELECT public.install_account_deletion_write_guards();

COMMIT;
