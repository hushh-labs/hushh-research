BEGIN;

-- Extend the existing atomic v5 writer; preserve its signature and manual flow.
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
  v_workflow JSONB;
  v_workflow_mode TEXT;
  v_command_created_at TIMESTAMPTZ;
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

  -- Requested setup is a narrow authority lane. The locator is supplied only
  -- by the authenticated writer after typed validation, and included in the
  -- mutation fingerprint. It never grants a general automatic memory write.
  SELECT event->'metadata'->'provenance'->'workflow_authority',
         event->'metadata'->'provenance'->>'authorization_mode'
  INTO v_workflow, v_workflow_mode
  FROM jsonb_array_elements(p_event_rows) AS event
  WHERE event->>'operation_type' = 'content_write';
  IF v_workflow IS NOT NULL OR v_workflow_mode = 'owner_requested_workflow' THEN
    IF v_workflow_mode IS DISTINCT FROM 'owner_requested_workflow'
       OR jsonb_typeof(v_workflow) IS DISTINCT FROM 'object'
       OR (SELECT COUNT(*) FROM jsonb_object_keys(v_workflow)) <> 5
       OR NOT v_workflow ?& ARRAY['command_id','command_step','operation_id','workflow_id','run_id']
       OR v_workflow->>'workflow_id' IS DISTINCT FROM 'workflow.setup.location'
       OR v_workflow->>'run_id' IS DISTINCT FROM p_location_finalize_authorization->>'run_id'
       OR COALESCE(v_workflow->>'command_step','') !~ '^(0|[1-9]|1[01])$'
       OR COALESCE(v_workflow->>'operation_id','') !~ '^[0-9a-f]{64}$'
       OR (SELECT COUNT(*) FROM jsonb_array_elements(p_event_rows) AS event
           WHERE event->>'operation_type' = 'content_write') <> 1 THEN
      RAISE EXCEPTION 'location_command_finalize_binding_invalid';
    END IF;

    -- Same lock order as command admission/claim. Postgres is the shared
    -- execution plane; any future lease adapter must preserve this atomic fence.
    SELECT command.created_at INTO v_command_created_at
    FROM one_adk_sessions command
    WHERE command.app_name = 'one.location.commands.v1'
      AND command.user_id = p_user_id
      AND command.session_id = v_workflow->>'command_id'
      AND command.command_status = 'admitted'
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'location_command_finalize_inactive';
    END IF;
    PERFORM 1 FROM one_action_directive_ledger directive
    WHERE directive.user_id = p_user_id
      AND directive.channel = 'command'
      AND directive.session_id = v_workflow->>'command_id'
      AND directive.command_step = (v_workflow->>'command_step')::INTEGER
      AND directive.operation_id = v_workflow->>'operation_id'
      AND directive.action_id = 'workflow.setup.location'
      AND directive.command_effect = 'workflow'
      AND directive.state = 'consumed'
      AND directive.workflow_run_id = v_workflow->>'run_id'
    FOR UPDATE;
    IF NOT FOUND OR v_command_created_at <= clock_timestamp() - INTERVAL '24 hours' THEN
      RAISE EXCEPTION 'location_command_finalize_inactive';
    END IF;
  END IF;

  -- Match v4's domain-lock order before touching workflow rows to avoid a
  -- PKM/finalization deadlock with another writer for this owner and domain.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id || ':' || p_domain, 0));

  -- Lease issuance and draft cancellation lock the workflow before finalizer
  -- authority. Take the same run lock first to prevent a run/auth deadlock.
  PERFORM 1 FROM one_capability_runs run
  WHERE run.run_id = p_location_finalize_authorization->>'run_id'
    AND run.user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'location_pkm_finalize_authorization_not_owned';
  END IF;

  -- A command-bound run cannot downgrade to a client-claimed clicked review.
  -- Check after the run lock, which also serializes command reservation/binding.
  IF v_workflow IS NULL AND EXISTS (
    SELECT 1 FROM one_action_directive_ledger directive
    WHERE directive.user_id = p_user_id AND directive.channel = 'command'
      AND directive.command_effect = 'workflow'
      AND directive.workflow_run_id = p_location_finalize_authorization->>'run_id'
  ) THEN
    RAISE EXCEPTION 'location_command_finalize_authority_required';
  END IF;

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

  IF v_authority.expires_at <= clock_timestamp() THEN
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
    AND run.expires_at > clock_timestamp()
    AND interaction.lease_id = v_authority.lease_id
    AND interaction.directive_id = v_authority.directive_id
    AND interaction.workflow_version = 2
    AND interaction.step_cursor = run.step_cursor
    AND interaction.run_revision = run.revision
    AND interaction.context_revision = v_authority.context_revision
    AND interaction.surface_id = 'one.location.awaiting_vault_finalize.v2'
    AND interaction.consumed_at IS NULL
    AND interaction.expires_at > clock_timestamp()
    AND draft.draft_id = v_authority.draft_id
    AND draft.workflow_version = 2
    AND draft.graph_revision = run.graph_revision
    AND draft.content_digest = v_authority.draft_digest
    AND draft.status = 'staged'
    AND draft.expires_at > clock_timestamp()
    AND NOT EXISTS (
      SELECT 1 FROM one_location_onboarding_receipts prior
      WHERE prior.run_id = run.run_id AND prior.receipt_kind = 'place'
    )
  FOR UPDATE OF run, interaction, draft;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'location_pkm_finalize_authorization_inactive';
  END IF;

  IF v_workflow IS NOT NULL AND v_command_created_at <= clock_timestamp() - INTERVAL '24 hours' THEN
    RAISE EXCEPTION 'location_command_finalize_inactive';
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
COMMIT;
