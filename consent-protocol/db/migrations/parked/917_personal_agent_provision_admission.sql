-- Dev-only durable ownership before substrate and host creation.
-- A retained attempt has no timeout takeover and is not an erasure receipt.
BEGIN;

CREATE OR REPLACE FUNCTION public.guard_personal_agent_provision_registry()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- The later erasure trigger owns all mutations after reservation.
  IF OLD.backend_metadata ? 'erasure' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF OLD.backend_metadata ? 'provisionAttempt'
     AND OLD.backend_metadata->'provisionAttempt'->>'phase' IS DISTINCT FROM 'provisioned' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'personal agent provision retained' USING ERRCODE='42501';
    END IF;
    -- Existing erasure admission may capture the attempt, never discard it.
    IF NOT (OLD.backend_metadata ? 'erasure')
       AND NEW.status = 'suspended'
       AND NEW.backend_metadata->'erasure'->'registrySnapshot' = to_jsonb(OLD)
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata
       AND to_jsonb(NEW) - ARRAY['status','updated_at','backend_metadata'] =
           to_jsonb(OLD) - ARRAY['status','updated_at','backend_metadata'] THEN
      RETURN NEW;
    END IF;
    -- The publication function sets this transaction-local coordination token.
    -- It is an accidental-writer guard, not authentication against database admins.
    IF current_setting('hussh.provision_attempt', true) =
       OLD.backend_metadata->'provisionAttempt'->>'attemptId'
       AND NEW.backend_metadata->'provisionAttempt'->>'attemptId' =
           OLD.backend_metadata->'provisionAttempt'->>'attemptId' THEN
      RETURN NEW;
    END IF;
    -- Pod heartbeat observations do not own lifecycle or resource coordinates.
    IF to_jsonb(NEW) - ARRAY['last_heartbeat_at','health_state','liveness_failures','backend_metadata'] =
       to_jsonb(OLD) - ARRAY['last_heartbeat_at','health_state','liveness_failures','backend_metadata']
       AND NEW.backend_metadata - 'observed' = OLD.backend_metadata - 'observed' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'personal agent provision retained' USING ERRCODE='42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS zy_personal_agent_provision_registry ON public.personal_agent_registry;
CREATE TRIGGER zy_personal_agent_provision_registry
BEFORE UPDATE OR DELETE ON public.personal_agent_registry
FOR EACH ROW EXECUTE FUNCTION public.guard_personal_agent_provision_registry();

CREATE OR REPLACE FUNCTION public.claim_personal_agent_provision(
  owner_id text, attempt_id text, observed jsonb, desired jsonb
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  current_row public.personal_agent_registry%ROWTYPE;
  expected_row public.personal_agent_registry%ROWTYPE;
  target public.personal_agent_registry%ROWTYPE;
  reservation jsonb;
  row_exists boolean;
BEGIN
  IF owner_id IS NULL OR btrim(owner_id) = '' OR attempt_id IS NULL
     OR attempt_id !~ '^[a-f0-9]{32}$' OR jsonb_typeof(desired) IS DISTINCT FROM 'object'
     OR desired->>'user_id' IS DISTINCT FROM owner_id
     OR coalesce(desired->>'hushh_id','') = ''
     OR coalesce(desired->>'phone_e164_hash','') = ''
     OR desired - ARRAY['user_id','hushh_id','phone_e164_hash','billing_space_id',
          'deployment_target','model_credential_mode','user_cloud_project',
          'user_cloud_region','user_cloud_bootstrap_sa','pod_pubkey','pod_key_id',
          'pod_key_wrapping_alg'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'invalid personal agent provision admission' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
  IF EXISTS (SELECT 1 FROM public.account_deletion_tombstones
      WHERE user_id_hash='sha256:' || encode(digest(owner_id,'sha256'),'hex')) THEN
    RAISE EXCEPTION 'personal agent owner deleted' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
      AND tgname='zy_personal_agent_provision_registry' AND tgenabled IN ('O','A')
      AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
      AND tgfoid='public.guard_personal_agent_provision_registry()'::regprocedure
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
      AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
      AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
      AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
      AND tgname='trg_reject_deleted_account_insert' AND tgenabled IN ('O','A')
      AND tgtype=7 AND tgnargs=1 AND tgqual IS NULL
      AND tgargs=decode('757365725f696400','hex') -- user_id, NUL-terminated trigger argument
      AND tgfoid='public.reject_deleted_account_identity_write()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'personal agent provision guards unavailable' USING ERRCODE='42501';
  END IF;
  SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
  row_exists := FOUND;
  IF row_exists THEN
    IF jsonb_typeof(observed) IS DISTINCT FROM 'object'
       OR observed->>'user_id' IS DISTINCT FROM owner_id
       OR NOT (observed ?& ARRAY['user_id','hushh_id','status','backend_metadata',
           'external_agent_id','a2a_route','pod_pubkey','deployment_target',
           'user_cloud_project','user_cloud_region','user_cloud_bootstrap_sa',
           'user_cloud_authorized_at']) THEN
      RAISE EXCEPTION 'personal agent provision observation changed' USING ERRCODE='42501';
    END IF;
    expected_row := jsonb_populate_record(NULL::public.personal_agent_registry, observed);
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(observed) AS k(key)
               WHERE to_jsonb(current_row)->k.key IS DISTINCT FROM to_jsonb(expected_row)->k.key) THEN
      RAISE EXCEPTION 'personal agent provision observation changed' USING ERRCODE='42501';
    END IF;
    IF current_row.status NOT IN ('unprovisioned','pending','reaped','provisioning_failed')
       OR current_row.hushh_id IS DISTINCT FROM desired->>'hushh_id'
       OR current_row.external_agent_id IS NOT NULL OR current_row.a2a_route IS NOT NULL
       OR current_row.pod_pubkey IS NOT NULL
       OR coalesce(current_row.backend_metadata,'{}'::jsonb) - 'observed' <> '{}'::jsonb THEN
      RAISE EXCEPTION 'personal agent provision requires reconciliation' USING ERRCODE='42501';
    END IF;
  ELSIF observed IS NOT NULL AND observed <> 'null'::jsonb THEN
    RAISE EXCEPTION 'personal agent provision observation changed' USING ERRCODE='42501';
  END IF;
  target := jsonb_populate_record(current_row, desired);
  reservation := jsonb_build_object('version',1,'ownerId',owner_id,'attemptId',attempt_id,
      'phase','reserved','intent',desired,'createdAt',clock_timestamp());
  INSERT INTO public.personal_agent_registry AS r (
    user_id,hushh_id,phone_e164_hash,billing_space_id,deployment_target,model_credential_mode,
    user_cloud_project,user_cloud_region,user_cloud_bootstrap_sa,pod_pubkey,pod_key_id,
    pod_key_wrapping_alg,status,backend_metadata
  ) VALUES (
    owner_id,target.hushh_id,target.phone_e164_hash,target.billing_space_id,
    target.deployment_target,target.model_credential_mode,target.user_cloud_project,
    target.user_cloud_region,target.user_cloud_bootstrap_sa,target.pod_pubkey,
    target.pod_key_id,target.pod_key_wrapping_alg,'provisioning',
    coalesce(current_row.backend_metadata,'{}'::jsonb) || jsonb_build_object('provisionAttempt',reservation)
  ) ON CONFLICT (user_id) DO UPDATE SET
    hushh_id=EXCLUDED.hushh_id,phone_e164_hash=EXCLUDED.phone_e164_hash,
    billing_space_id=EXCLUDED.billing_space_id,deployment_target=EXCLUDED.deployment_target,
    model_credential_mode=EXCLUDED.model_credential_mode,user_cloud_project=EXCLUDED.user_cloud_project,
    user_cloud_region=EXCLUDED.user_cloud_region,user_cloud_bootstrap_sa=EXCLUDED.user_cloud_bootstrap_sa,
    pod_pubkey=EXCLUDED.pod_pubkey,pod_key_id=EXCLUDED.pod_key_id,
    pod_key_wrapping_alg=EXCLUDED.pod_key_wrapping_alg,status='provisioning',
    backend_metadata=EXCLUDED.backend_metadata,updated_at=clock_timestamp()
    WHERE row_exists AND to_jsonb(r)=to_jsonb(current_row);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'personal agent provision observation changed' USING ERRCODE='42501';
  END IF;
  RETURN reservation;
END;
$$;

CREATE OR REPLACE FUNCTION public.publish_personal_agent_provision(
  owner_id text, attempt_id text, expected_phase text, next_phase text, evidence jsonb
) RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  current_row public.personal_agent_registry%ROWTYPE;
  attempt jsonb;
  prior_setting text;
  fields jsonb;
  target public.personal_agent_registry%ROWTYPE;
BEGIN
  IF owner_id IS NULL OR btrim(owner_id)='' OR attempt_id IS NULL
     OR attempt_id !~ '^[a-f0-9]{32}$' OR expected_phase IS NULL OR next_phase IS NULL
     OR jsonb_typeof(evidence) IS DISTINCT FROM 'object' OR octet_length(evidence::text)>65536
     OR evidence ?| ARRAY['provisionAttempt','erasure','upgradeLease','observed']
     OR NOT ((expected_phase='reserved' AND next_phase IN ('substrate','failed'))
          OR (expected_phase='substrate' AND next_phase IN ('host_requested','failed'))
          OR (expected_phase='host_requested' AND next_phase IN ('host_requested','host_acknowledged','failed'))
          OR (expected_phase='host_acknowledged' AND next_phase IN ('connecting','failed'))
          OR (expected_phase='connecting' AND next_phase IN ('connecting','provisioned','failed'))) THEN
    RETURN false;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
  SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  attempt := current_row.backend_metadata->'provisionAttempt';
  IF attempt->>'ownerId' IS DISTINCT FROM owner_id OR attempt->>'attemptId' IS DISTINCT FROM attempt_id
     OR attempt->>'phase' IS DISTINCT FROM expected_phase OR current_row.backend_metadata ? 'erasure' THEN
    RETURN false;
  END IF;
  fields := coalesce(evidence->'registry','{}'::jsonb);
  IF expected_phase='host_requested' AND next_phase='host_requested' THEN
    IF evidence - 'creationAcknowledgement' <> '{}'::jsonb
       OR jsonb_typeof(evidence->'creationAcknowledgement') IS DISTINCT FROM 'object'
       OR coalesce(evidence->'creationAcknowledgement'->>'service','')=''
       OR coalesce(evidence->'creationAcknowledgement'->>'serviceUid','')='' THEN RETURN false; END IF;
    IF attempt->'evidence'->'host_requested' ? 'creationAcknowledgement' THEN
      RETURN attempt->'evidence'->'host_requested'->'creationAcknowledgement' = evidence->'creationAcknowledgement';
    END IF;
  END IF;
  IF jsonb_typeof(fields) IS DISTINCT FROM 'object'
     OR fields - ARRAY['pod_pubkey','pod_key_id','pod_key_wrapping_alg','external_agent_id',
        'a2a_route','backend','backend_metadata','attestation_ref','liveness_mode'] <> '{}'::jsonb
     OR (fields ? 'backend_metadata' AND (
         jsonb_typeof(fields->'backend_metadata') IS DISTINCT FROM 'object'
         OR fields->'backend_metadata' ?| ARRAY['provisionAttempt','erasure','upgradeLease','observed']))
     OR (evidence ? 'expectedPodKey' AND evidence->>'expectedPodKey' IS DISTINCT FROM current_row.pod_pubkey)
  THEN RETURN false; END IF;
  target := jsonb_populate_record(current_row,fields);
  prior_setting := current_setting('hussh.provision_attempt',true);
  PERFORM set_config('hussh.provision_attempt',attempt_id,true);
  UPDATE public.personal_agent_registry SET backend_metadata = jsonb_set(
      backend_metadata || coalesce(fields->'backend_metadata','{}'::jsonb),
      '{provisionAttempt}',attempt || CASE WHEN next_phase='failed' THEN jsonb_build_object('failedFrom',expected_phase) ELSE '{}'::jsonb END || jsonb_build_object(
        'phase',next_phase,'evidence',coalesce(attempt->'evidence','{}'::jsonb) ||
        jsonb_build_object(next_phase,coalesce(attempt->'evidence'->next_phase,'{}'::jsonb) || evidence))),
      status=CASE WHEN next_phase='failed' THEN 'suspended'
                  WHEN next_phase IN ('connecting','provisioned') THEN next_phase ELSE status END,
      pod_pubkey=target.pod_pubkey,pod_key_id=target.pod_key_id,
      pod_key_wrapping_alg=target.pod_key_wrapping_alg,external_agent_id=target.external_agent_id,
      a2a_route=target.a2a_route,backend=target.backend,attestation_ref=target.attestation_ref,
      liveness_mode=target.liveness_mode,
      provisioned_at=CASE WHEN next_phase='provisioned' THEN coalesce(provisioned_at,clock_timestamp())
                          ELSE provisioned_at END,
      updated_at=clock_timestamp()
    WHERE user_id=owner_id;
  PERFORM set_config('hussh.provision_attempt',coalesce(prior_setting,''),true);
  RETURN true;
END;
$$;
CREATE OR REPLACE FUNCTION public.valid_erasure_provision_ack(reservation jsonb, receipt jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
 SELECT coalesce(
   jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=65536
   AND receipt->>'version'='1' AND jsonb_typeof(receipt->'evidence')='object'
   AND receipt->>'ownerId'=reservation->>'ownerId'
   AND receipt->>'attemptId'=reservation->'registrySnapshot'->'backend_metadata'->'provisionAttempt'->>'attemptId'
   AND receipt->>'expectedPhase'=CASE
     WHEN reservation->'registrySnapshot'->'backend_metadata'->'provisionAttempt'->>'phase'='failed'
     THEN reservation->'registrySnapshot'->'backend_metadata'->'provisionAttempt'->>'failedFrom'
     ELSE reservation->'registrySnapshot'->'backend_metadata'->'provisionAttempt'->>'phase' END
   AND ((receipt->>'expectedPhase'='reserved' AND receipt->>'nextPhase'='substrate')
     OR (receipt->>'expectedPhase'='host_requested' AND receipt->>'nextPhase' IN ('host_requested','host_acknowledged'))),
   false);
$$;
CREATE OR REPLACE FUNCTION public.guard_personal_agent_erasure_registry()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.backend_metadata ? 'erasure' THEN
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
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND (NEW.backend_metadata->'erasure') - 'lateProvisionAcknowledgement' =
           (OLD.backend_metadata->'erasure') - 'lateProvisionAcknowledgement'
       AND NOT ((OLD.backend_metadata->'erasure') ? 'lateProvisionAcknowledgement')
       AND public.valid_erasure_provision_ack(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'lateProvisionAcknowledgement') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'personal agent erasure reserved' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.retain_personal_agent_provision_ack(owner_id text, receipt jsonb)
RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
DECLARE reservation jsonb; current_row public.personal_agent_registry%ROWTYPE; prior_setting text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 reservation := current_row.backend_metadata->'erasure';
 IF reservation IS NULL THEN
   IF current_row.backend_metadata->'provisionAttempt'->>'phase' IS DISTINCT FROM 'failed' THEN RETURN false; END IF;
   reservation := jsonb_build_object('ownerId',owner_id,'registrySnapshot',to_jsonb(current_row));
   IF NOT public.valid_erasure_provision_ack(reservation,receipt) THEN RETURN false; END IF;
   IF current_row.backend_metadata->'provisionAttempt' ? 'lateAcknowledgement' THEN
     RETURN current_row.backend_metadata->'provisionAttempt'->'lateAcknowledgement'=receipt;
   END IF;
   prior_setting := current_setting('hussh.provision_attempt',true);
   PERFORM set_config('hussh.provision_attempt',receipt->>'attemptId',true);
   UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(
     backend_metadata,'{provisionAttempt,lateAcknowledgement}',receipt,true) WHERE user_id=owner_id;
   PERFORM set_config('hussh.provision_attempt',coalesce(prior_setting,''),true);
   RETURN true;
 END IF;
 IF NOT public.valid_erasure_provision_ack(reservation,receipt) THEN RETURN false; END IF;
 IF reservation ? 'lateProvisionAcknowledgement' THEN
   RETURN reservation->'lateProvisionAcknowledgement'=receipt;
 END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(
   backend_metadata,'{erasure,lateProvisionAcknowledgement}',receipt,true) WHERE user_id=owner_id;
 RETURN true;
END;
$$;

COMMIT;
