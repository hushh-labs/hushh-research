-- Dev-only recovery for an erasure reservation that never started.
-- A reservation with receipts remains permanently fail-closed; this lane only
-- restores the exact provisioned snapshot when no erasure work was recorded.
BEGIN;

CREATE OR REPLACE FUNCTION public.guard_personal_agent_erasure_registry()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  reservation jsonb;
  snapshot jsonb;
BEGIN
  IF OLD.backend_metadata ? 'erasure' THEN
    reservation := OLD.backend_metadata->'erasure';
    snapshot := reservation->'registrySnapshot';

    -- The application recovery path sets this transaction-local value only after
    -- discovering the owner's live pod. The database still requires the immutable
    -- reservation shape and an exact restoration of the original row, so a normal
    -- writer cannot use this branch to erase or rebind an owner.
    IF TG_OP = 'UPDATE'
       AND current_setting('hussh.erasure_restore_attempt', true) = reservation->>'attemptId'
       AND reservation - ARRAY['version','ownerId','attemptId','hushhId','phase','registrySnapshot'] = '{}'::jsonb
       AND reservation->>'ownerId' = OLD.user_id
       AND reservation->>'phase' = 'reserved'
       AND snapshot->>'status' = 'provisioned'
       AND jsonb_typeof(snapshot->'backend_metadata') = 'object'
       AND NOT (snapshot->'backend_metadata' ? 'erasure')
       AND to_jsonb(NEW) - 'updated_at' = snapshot - 'updated_at'
    THEN
      RETURN NEW;
    END IF;

    -- Only a bound late acknowledgement may be appended. It is not a terminal
    -- cleanup result and cannot alter identity, custody, status or the reservation.
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND (NEW.backend_metadata->'erasure') - 'lateUpgradeAcknowledgement' =
           (OLD.backend_metadata->'erasure') - 'lateUpgradeAcknowledgement'
       AND NOT ((OLD.backend_metadata->'erasure') ? 'lateUpgradeAcknowledgement')
       AND public.valid_erasure_upgrade_ack(
           OLD.backend_metadata->'erasure', NEW.backend_metadata->'erasure'->'lateUpgradeAcknowledgement') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'personal agent erasure reserved' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.restore_personal_agent_erasure_reservation(
  owner_id text, attempt_id text, snapshot_sha256 text, evidence jsonb
)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path = public AS $$
DECLARE
  current_row public.personal_agent_registry%ROWTYPE;
  reservation jsonb;
  snapshot jsonb;
  restored public.personal_agent_registry%ROWTYPE;
BEGIN
  IF owner_id IS NULL OR btrim(owner_id) = ''
     OR attempt_id IS NULL OR attempt_id !~ '^[a-f0-9]{32}$'
     OR snapshot_sha256 IS NULL OR snapshot_sha256 !~ '^[a-f0-9]{64}$'
     OR jsonb_typeof(evidence) IS DISTINCT FROM 'object'
     OR evidence - ARRAY['project','service','url','observedAt'] <> '{}'::jsonb
     OR length(evidence->>'project') = 0 OR length(evidence->>'service') = 0 THEN
    RETURN false;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id, 171));
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id, 198));
  SELECT * INTO current_row
  FROM public.personal_agent_registry
  WHERE user_id = owner_id
  FOR UPDATE;
  IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;

  reservation := current_row.backend_metadata->'erasure';
  snapshot := reservation->'registrySnapshot';
  IF reservation IS NULL
     OR reservation - ARRAY['version','ownerId','attemptId','hushhId','phase','registrySnapshot'] <> '{}'::jsonb
     OR reservation->>'ownerId' IS DISTINCT FROM owner_id
     OR reservation->>'attemptId' IS DISTINCT FROM attempt_id
     OR reservation->>'phase' IS DISTINCT FROM 'reserved'
     OR snapshot->>'status' IS DISTINCT FROM 'provisioned'
     OR jsonb_typeof(snapshot->'backend_metadata') IS DISTINCT FROM 'object'
     OR snapshot->'backend_metadata' ? 'erasure'
     OR encode(sha256(convert_to(snapshot::text, 'UTF8')), 'hex') IS DISTINCT FROM snapshot_sha256
     OR evidence->>'project' IS DISTINCT FROM coalesce(snapshot->>'user_cloud_project', snapshot->'backend_metadata'->>'project')
     OR evidence->>'service' IS DISTINCT FROM coalesce(snapshot->>'external_agent_id', snapshot->'backend_metadata'->>'service')
     OR (snapshot->'backend_metadata'->>'url' IS NOT NULL
         AND evidence->>'url' IS DISTINCT FROM snapshot->'backend_metadata'->>'url') THEN
    RETURN false;
  END IF;
  -- A deletion tombstone or account-erasure tombstone always wins. This function
  -- cannot resurrect an identity that the erasure workflow has completed or begun.
  IF EXISTS (
    SELECT 1 FROM public.personal_agent_deletion_tombstones
    WHERE hushh_id = current_row.hushh_id
  ) OR EXISTS (
    SELECT 1 FROM public.account_deletion_tombstones
    WHERE user_id_hash = 'sha256:' || encode(sha256(convert_to(owner_id, 'UTF8')), 'hex')
  ) OR NOT EXISTS (
    SELECT 1 FROM public.byoc_setup_jobs
    WHERE user_id = owner_id AND status = 'recorded' AND authorization_attempts = '{}'::jsonb
  ) THEN
    RETURN false;
  END IF;

  restored := jsonb_populate_record(NULL::public.personal_agent_registry, snapshot);
  PERFORM set_config('hussh.erasure_restore_attempt', attempt_id, true);
  UPDATE public.personal_agent_registry SET
    hushh_id = restored.hushh_id,
    phone_e164_hash = restored.phone_e164_hash,
    space_id = restored.space_id,
    backend = restored.backend,
    external_agent_id = restored.external_agent_id,
    a2a_route = restored.a2a_route,
    backend_metadata = restored.backend_metadata,
    attestation_ref = restored.attestation_ref,
    pod_pubkey = restored.pod_pubkey,
    pod_key_id = restored.pod_key_id,
    pod_key_wrapping_alg = restored.pod_key_wrapping_alg,
    runtime_version = restored.runtime_version,
    prompt_version = restored.prompt_version,
    status = restored.status,
    region = restored.region,
    provisioned_at = restored.provisioned_at,
    created_at = restored.created_at,
    last_heartbeat_at = restored.last_heartbeat_at,
    health_state = restored.health_state,
    liveness_mode = restored.liveness_mode,
    last_probe_at = restored.last_probe_at,
    liveness_failures = restored.liveness_failures,
    last_healed_at = restored.last_healed_at,
    deployment_target = restored.deployment_target,
    model_credential_mode = restored.model_credential_mode,
    user_cloud_project = restored.user_cloud_project,
    user_cloud_region = restored.user_cloud_region,
    user_cloud_bootstrap_sa = restored.user_cloud_bootstrap_sa,
    user_cloud_authorized_at = restored.user_cloud_authorized_at,
    billing_space_id = restored.billing_space_id,
    updated_at = clock_timestamp()
  WHERE user_id = owner_id;
  RETURN FOUND;
END;
$$;
COMMIT;
