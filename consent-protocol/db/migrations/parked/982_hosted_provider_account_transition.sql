-- Dev only. Retain provider-account transition evidence in the existing
-- provisionAttempt journal; no provider operation is dispatched by this migration.
BEGIN;

CREATE OR REPLACE FUNCTION public.valid_hosted_provider_account_transition_intent(
 p_row jsonb, p_intent jsonb
) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE metadata jsonb:=p_row->'backend_metadata'; attempt jsonb:=metadata->'provisionAttempt';
        admission jsonb:=attempt->'hostedAdmission'; assignment jsonb:=admission->'assignment';
        prep_contract jsonb:=assignment->'preparationContract';
        prep jsonb:=attempt->'evidence'->'reserved'->'hostedPreparation';
        completed jsonb:=prep->'completed';
        creation jsonb; billing jsonb;
BEGIN
 IF jsonb_typeof(p_row) IS DISTINCT FROM 'object'
 OR jsonb_typeof(p_intent) IS DISTINCT FROM 'object'
 OR p_intent-ARRAY['version','ownerId','attemptId','placementEpoch','operationId','projectId',
      'projectNumber','oldBillingAccount','targetBillingAccount','actorPrincipal','actorVerification',
      'serviceUid','runtimePrincipal','minimumSourceRevision','imageDigest','intentAt']<>'{}'::jsonb
 OR p_intent->'version' IS DISTINCT FROM '1'::jsonb
 OR p_intent->>'ownerId' IS DISTINCT FROM p_row->>'user_id'
 OR p_intent->>'attemptId' IS DISTINCT FROM attempt->>'attemptId'
 OR attempt->>'ownerId' IS DISTINCT FROM p_row->>'user_id'
 OR attempt->'intent'->>'user_id' IS DISTINCT FROM p_row->>'user_id'
 OR attempt->'intent'->>'hushh_id' IS DISTINCT FROM p_row->>'hushh_id'
 OR admission->>'environment' IS DISTINCT FROM 'dev'
 OR (attempt->'providerAccountTransition' IS NULL
     AND public.hosted_pod_retained_admitted(p_row->>'user_id',p_row) IS NOT TRUE)
 OR p_intent->'placementEpoch' IS DISTINCT FROM p_row->'placement_epoch'
 OR coalesce(p_intent->>'operationId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 OR p_intent->>'projectId' IS DISTINCT FROM assignment->>'project'
 OR p_intent->>'projectId' IS DISTINCT FROM metadata->>'project'
 OR p_intent->>'projectNumber' IS DISTINCT FROM attempt->'evidence'->'reserved'->'projectObservation'->>'projectNumber'
 OR (assignment->>'projectNumber' IS NOT NULL
     AND p_intent->>'projectNumber' IS DISTINCT FROM assignment->>'projectNumber')
 OR p_intent->>'oldBillingAccount' IS DISTINCT FROM prep_contract->>'billingAccount'
 OR p_intent->>'targetBillingAccount' IS NOT DISTINCT FROM p_intent->>'oldBillingAccount'
 OR p_intent->>'targetBillingAccount' !~ '^billingAccounts/[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$'
 OR p_intent->>'actorPrincipal' IS DISTINCT FROM 'user:kushaltrivedi97@gmail.com'
 OR jsonb_typeof(p_intent->'actorVerification') IS DISTINCT FROM 'object'
 OR (p_intent->'actorVerification')-ARRAY['version','provider','issuer','subject','principal',
      'email','emailVerified','audience','verificationMethod','tokenSha256','verifiedAt']<>'{}'::jsonb
 OR p_intent->'actorVerification'->'version' IS DISTINCT FROM '1'::jsonb
 OR p_intent->'actorVerification'->>'provider' IS DISTINCT FROM 'google'
 OR p_intent->'actorVerification'->>'issuer' IS DISTINCT FROM 'https://accounts.google.com'
 OR p_intent->'actorVerification'->>'principal' IS DISTINCT FROM p_intent->>'actorPrincipal'
 OR p_intent->'actorVerification'->>'email' IS DISTINCT FROM 'kushaltrivedi97@gmail.com'
 OR p_intent->'actorVerification'->'emailVerified' IS DISTINCT FROM 'true'::jsonb
 OR p_intent->'actorVerification'->>'verificationMethod' IS DISTINCT FROM 'google_id_token_verified'
 OR coalesce(p_intent->'actorVerification'->>'subject','') !~ '^[A-Za-z0-9_-]{1,255}$'
 OR coalesce(p_intent->'actorVerification'->>'tokenSha256','') !~ '^[a-f0-9]{64}$'
 OR coalesce(p_intent->'actorVerification'->>'audience','')=''
 OR octet_length(p_intent->'actorVerification'->>'audience')>256
 OR jsonb_typeof(p_intent->'actorVerification'->'verifiedAt') IS DISTINCT FROM 'string'
 OR p_intent->>'serviceUid' IS DISTINCT FROM metadata->>'serviceUid'
 OR p_intent->>'runtimePrincipal' IS DISTINCT FROM metadata->>'runtime_service_account'
 OR coalesce(p_intent->>'minimumSourceRevision','') !~ '^[a-f0-9]{40}$'
 OR p_intent->>'imageDigest' IS DISTINCT FROM 'sha256:639958a5d5a9adf12c5a93839afaa3a8a1a86421896291b746b4e8c257ffc8a1'
 OR p_intent->>'projectId' NOT IN ('hussh-hp-7da5778b-261027a','hussh-hp-a3a6730e-261027b')
 OR assignment->>'ownerHash' IS DISTINCT FROM
      'sha256:'||encode(digest(p_row->>'user_id','sha256'),'hex')
 OR assignment->>'hushhId' IS DISTINCT FROM p_row->>'hushh_id'
 OR jsonb_typeof(p_intent->'intentAt') IS DISTINCT FROM 'string'
 OR jsonb_typeof(completed) IS DISTINCT FROM 'array'
 OR jsonb_array_length(completed)<>5
 OR (SELECT array_agg(x->>'step' ORDER BY n)
       FROM jsonb_array_elements(completed) WITH ORDINALITY AS item(x,n))
      IS DISTINCT FROM ARRAY['create_project','link_billing','authorize_project',
                             'inference_vertex','inference_quota']::text[]
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(completed) AS item(x)
      WHERE x->'ok' IS DISTINCT FROM 'true'::jsonb
         OR public.valid_hosted_preparation_result(attempt,x) IS NOT TRUE)
 OR prep->>'phase' IS DISTINCT FROM 'observed'
 OR prep->'version' IS DISTINCT FROM '1'::jsonb
 OR prep->>'ownerId' IS DISTINCT FROM p_row->>'user_id'
 OR prep->>'attemptId' IS DISTINCT FROM attempt->>'attemptId'
 OR prep->'generation' IS DISTINCT FROM '10'::jsonb
 OR prep->>'step' IS DISTINCT FROM 'inference_quota'
 OR prep->>'planDigest' IS DISTINCT FROM admission->>'preparationContractHash'
 OR prep->>'planDigest' IS DISTINCT FROM encode(digest(prep_contract::text,'sha256'),'hex')
 OR prep_contract IS NULL
 THEN RETURN false; END IF;
 IF (CASE p_intent->>'projectId'
  WHEN 'hussh-hp-7da5778b-261027a' THEN
   p_intent->>'projectNumber'='1010592650891'
   AND p_intent->>'attemptId'='95af9d1fdab94601a1e45554e4774fd3'
   AND p_intent->>'operationId'='777fe0a3-eaa2-42b3-97d2-3b6549a20290'
   AND p_row->>'hushh_id'='ha1_t6cqxavpt6sumlllpfcjrwkh4fztw5zq'
   AND p_intent->>'serviceUid'='fec811ba-2456-495d-ab66-a0d926077ae1'
   AND p_intent->>'runtimePrincipal'='one-pod-ha1-t6cqxavpt-rkntchve@hussh-hp-7da5778b-261027a.iam.gserviceaccount.com'
  WHEN 'hussh-hp-a3a6730e-261027b' THEN
   p_intent->>'projectNumber'='349132050484'
   AND p_intent->>'attemptId'='67ce0564b4b541a69abb31b336e51352'
   AND p_intent->>'operationId'='9df62f66-f271-491d-ab34-406823292f5d'
   AND p_row->>'hushh_id'='ha1_sdhll3ua5kg4o6cmo2imyijcmygnwzqh'
   AND p_intent->>'serviceUid'='e14040de-505a-4fc6-9a4a-e391ea1d6026'
   AND p_intent->>'runtimePrincipal'='one-pod-ha1-sdhll3ua5-rqghnwhy@hussh-hp-a3a6730e-261027b.iam.gserviceaccount.com'
  ELSE false END) IS NOT TRUE THEN RETURN false; END IF;
 IF p_intent->>'oldBillingAccount' IS DISTINCT FROM 'billingAccounts/014D7F-FD970D-D2459E'
 OR p_intent->>'targetBillingAccount' IS DISTINCT FROM 'billingAccounts/013848-8258FA-2D068F'
 THEN RETURN false; END IF;
 creation:=completed->0->'resourceObservation'->'identity';
 billing:=completed->1->'billingObservation';
 RETURN creation->>'projectId'=p_intent->>'projectId'
  AND creation->>'projectNumber'=p_intent->>'projectNumber'
  AND billing->>'projectId'=p_intent->>'projectId'
  AND billing->>'billingAccountName'=p_intent->>'oldBillingAccount'
  AND billing->'billingEnabled'='true'::jsonb
  AND metadata->>'serviceUid' IS NOT NULL
  AND metadata->>'runtime_service_account' IS NOT NULL
  AND p_row->>'status'='provisioned'
  AND p_row->>'deployment_target'='gcp'
  AND coalesce(metadata->>'tenancy','hussh-hosted')='hussh-hosted'
  AND (p_intent->'actorVerification'->>'verifiedAt')::timestamptz<=(p_intent->>'intentAt')::timestamptz+interval '5 seconds';
EXCEPTION WHEN data_exception THEN RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_hosted_provider_account_transition_settlement(
 p_intent jsonb, p_settlement jsonb
) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE observed_at timestamptz; outcome text:=p_settlement->>'outcome';
BEGIN
 IF jsonb_typeof(p_settlement) IS DISTINCT FROM 'object'
 OR p_settlement->'version' IS DISTINCT FROM '1'::jsonb
 OR jsonb_typeof(p_settlement->'observedAt') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
 IF outcome='unknown' THEN
  IF p_settlement-ARRAY['version','outcome','observedAt']<>'{}'::jsonb THEN RETURN false; END IF;
 ELSIF outcome='settled' THEN
  IF p_settlement-ARRAY['version','outcome','observedAt','projectId','projectNumber',
       'billingAccountName','billingEnabled','actorPrincipal','operationId']<>'{}'::jsonb
  OR p_settlement->>'projectId' IS DISTINCT FROM p_intent->>'projectId'
  OR p_settlement->>'projectNumber' IS DISTINCT FROM p_intent->>'projectNumber'
  OR p_settlement->>'billingAccountName' IS DISTINCT FROM p_intent->>'targetBillingAccount'
  OR p_settlement->'billingEnabled' IS DISTINCT FROM 'true'::jsonb
  OR p_settlement->>'actorPrincipal' IS DISTINCT FROM p_intent->>'actorPrincipal'
  OR p_settlement->>'operationId' IS DISTINCT FROM p_intent->>'operationId' THEN RETURN false; END IF;
 ELSE RETURN false; END IF;
 BEGIN
  observed_at:=(p_settlement->>'observedAt')::timestamptz;
  RETURN observed_at >= (p_intent->>'intentAt')::timestamptz
   AND observed_at <= clock_timestamp()+interval '5 seconds';
 EXCEPTION WHEN data_exception THEN RETURN false; END;
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_hosted_provider_account_transition(
 p_row jsonb, p_transition jsonb
) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE generation bigint; settlements jsonb:=p_transition->'settlements'; first_receipt jsonb; last_receipt jsonb;
BEGIN
 IF jsonb_typeof(p_transition) IS DISTINCT FROM 'object'
 OR p_transition-ARRAY['version','generation','phase','intent','settlements']<>'{}'::jsonb
 OR p_transition->'version' IS DISTINCT FROM '1'::jsonb
 OR jsonb_typeof(p_transition->'generation') IS DISTINCT FROM 'number'
 OR coalesce(p_transition->>'generation','') !~ '^[1-9][0-9]*$'
 OR jsonb_typeof(settlements) IS DISTINCT FROM 'array'
 OR public.valid_hosted_provider_account_transition_intent(p_row,p_transition->'intent') IS NOT TRUE
 THEN RETURN false; END IF;
 generation:=(p_transition->>'generation')::bigint;
 IF p_transition->>'phase'='intent' THEN
  RETURN generation=1 AND settlements='[]'::jsonb;
 ELSIF p_transition->>'phase'='unknown' THEN
  RETURN generation=2 AND jsonb_array_length(settlements)=1
   AND public.valid_hosted_provider_account_transition_settlement(
     p_transition->'intent',settlements->0) IS TRUE
   AND settlements->0->>'outcome'='unknown';
 ELSIF p_transition->>'phase'='settled' THEN
  IF generation NOT IN (2,3) OR jsonb_array_length(settlements) NOT IN (1,2) THEN RETURN false; END IF;
  first_receipt:=settlements->0; last_receipt:=settlements->(jsonb_array_length(settlements)-1);
  RETURN (generation=2 AND jsonb_array_length(settlements)=1
       AND first_receipt->>'outcome'='settled'
       AND public.valid_hosted_provider_account_transition_settlement(p_transition->'intent',first_receipt) IS TRUE)
   OR (generation=3 AND jsonb_array_length(settlements)=2
       AND first_receipt->>'outcome'='unknown'
       AND public.valid_hosted_provider_account_transition_settlement(p_transition->'intent',first_receipt) IS TRUE
       AND last_receipt->>'outcome'='settled'
       AND public.valid_hosted_provider_account_transition_settlement(p_transition->'intent',last_receipt) IS TRUE);
 END IF;
 RETURN false;
EXCEPTION WHEN data_exception THEN RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_hosted_provider_account_transition_append(
 p_old jsonb, p_new jsonb
) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE old_attempt jsonb:=p_old->'backend_metadata'->'provisionAttempt';
        new_attempt jsonb:=p_new->'backend_metadata'->'provisionAttempt';
        prior jsonb:=old_attempt->'providerAccountTransition';
        next_state jsonb:=new_attempt->'providerAccountTransition';
BEGIN
 IF jsonb_typeof(p_old) IS DISTINCT FROM 'object' OR jsonb_typeof(p_new) IS DISTINCT FROM 'object'
 OR (p_new-ARRAY['backend_metadata','updated_at']) IS DISTINCT FROM
    (p_old-ARRAY['backend_metadata','updated_at'])
 OR ((p_new->'backend_metadata')-'provisionAttempt') IS DISTINCT FROM
    ((p_old->'backend_metadata')-'provisionAttempt')
 OR (new_attempt-'providerAccountTransition') IS DISTINCT FROM
    (old_attempt-'providerAccountTransition')
 OR public.valid_hosted_provider_account_transition(p_new,next_state) IS NOT TRUE THEN RETURN false; END IF;
 IF prior IS NULL THEN
  RETURN next_state->>'phase'='intent'
   AND next_state->'generation'='1'::jsonb AND next_state->'settlements'='[]'::jsonb;
 END IF;
 IF prior->'intent' IS DISTINCT FROM next_state->'intent'
 OR next_state->'generation' IS DISTINCT FROM to_jsonb((prior->>'generation')::bigint+1)
 OR jsonb_array_length(next_state->'settlements')<>jsonb_array_length(prior->'settlements')+1
 OR ((next_state->'settlements')-((jsonb_array_length(next_state->'settlements')-1)::integer))
      IS DISTINCT FROM prior->'settlements' THEN RETURN false; END IF;
 IF prior->>'phase'='intent' THEN
  RETURN next_state->>'phase' IN ('unknown','settled');
 ELSIF prior->>'phase'='unknown' THEN
  RETURN next_state->>'phase'='settled';
 END IF;
 RETURN false;
EXCEPTION WHEN data_exception THEN RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_hosted_provider_account_transition_registry()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE old_state jsonb; new_state jsonb; owner_id text; attempt_id text; operation_id text;
        old_generation bigint; new_generation bigint; expected_authority text;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.backend_metadata->'provisionAttempt'->'providerAccountTransition' IS NOT NULL THEN
   RAISE EXCEPTION 'provider account transition must use its journal' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 old_state:=OLD.backend_metadata->'provisionAttempt'->'providerAccountTransition';
 IF TG_OP='DELETE' THEN
  IF old_state IS NULL THEN RETURN OLD; END IF;
  IF old_state->>'phase'='settled' AND OLD.backend_metadata->'erasure' IS NOT NULL
   AND public.personal_agent_erasure_archived(OLD.user_id,OLD.backend_metadata->'erasure') IS TRUE THEN
   RETURN OLD;
  END IF;
  RAISE EXCEPTION 'provider account transition evidence retained' USING ERRCODE='42501';
 END IF;
 new_state:=NEW.backend_metadata->'provisionAttempt'->'providerAccountTransition';
 IF old_state IS NULL AND new_state IS NULL THEN RETURN NEW; END IF;
 IF old_state IS NOT NULL AND (
    NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.hushh_id IS DISTINCT FROM OLD.hushh_id
    OR NEW.placement_epoch IS DISTINCT FROM OLD.placement_epoch
    OR NEW.deployment_target IS DISTINCT FROM OLD.deployment_target
    OR NEW.backend_metadata->>'project' IS DISTINCT FROM OLD.backend_metadata->>'project'
    OR NEW.backend_metadata->>'tenancy' IS DISTINCT FROM OLD.backend_metadata->>'tenancy'
    OR NEW.backend_metadata->>'serviceUid' IS DISTINCT FROM OLD.backend_metadata->>'serviceUid'
    OR NEW.backend_metadata->>'runtime_service_account' IS DISTINCT FROM OLD.backend_metadata->>'runtime_service_account'
    OR NEW.backend_metadata->'provisionAttempt'->>'attemptId' IS DISTINCT FROM
      OLD.backend_metadata->'provisionAttempt'->>'attemptId'
    OR NEW.backend_metadata->'provisionAttempt'->>'operationId' IS DISTINCT FROM
      OLD.backend_metadata->'provisionAttempt'->>'operationId'
    OR NEW.backend_metadata->'provisionAttempt'->'evidence'->'reserved'->'projectObservation'
      IS DISTINCT FROM OLD.backend_metadata->'provisionAttempt'->'evidence'->'reserved'->'projectObservation'
    OR NEW.backend_metadata->'provisionAttempt'->'hostedAdmission' IS DISTINCT FROM
      OLD.backend_metadata->'provisionAttempt'->'hostedAdmission'
    OR NEW.backend_metadata->'provisionAttempt'->'evidence'->'reserved'->'hostedPreparation'
      IS DISTINCT FROM OLD.backend_metadata->'provisionAttempt'->'evidence'->'reserved'->'hostedPreparation'
    OR NEW.backend_metadata->'provisionAttempt'->'hostedAdmission'->'assignment'->'preparationContract'
      IS DISTINCT FROM OLD.backend_metadata->'provisionAttempt'->'hostedAdmission'->'assignment'->'preparationContract'
 ) THEN
  RAISE EXCEPTION 'provider account transition preparation evidence retained' USING ERRCODE='42501';
 END IF;
 IF old_state IS NOT NULL AND old_state IS NOT DISTINCT FROM new_state THEN
  IF old_state->>'phase' NOT IN ('intent','unknown') THEN RETURN NEW; END IF;
  IF to_jsonb(NEW)-ARRAY['last_heartbeat_at','health_state','liveness_failures','backend_metadata'] =
       to_jsonb(OLD)-ARRAY['last_heartbeat_at','health_state','liveness_failures','backend_metadata']
     AND NEW.backend_metadata-ARRAY['observed','signingKeyPull'] =
       OLD.backend_metadata-ARRAY['observed','signingKeyPull']
     AND (NOT (NEW.backend_metadata ? 'signingKeyPull')
          OR jsonb_typeof(NEW.backend_metadata->'signingKeyPull')='number') THEN RETURN NEW; END IF;
 END IF;
 IF old_state IS NULL OR new_state IS NULL THEN
  IF new_state IS NULL THEN RAISE EXCEPTION 'provider account transition evidence retained' USING ERRCODE='42501'; END IF;
  old_generation:=0;
 ELSE old_generation:=(old_state->>'generation')::bigint; END IF;
 new_generation:=(new_state->>'generation')::bigint;
 owner_id:=NEW.user_id; attempt_id:=new_state->'intent'->>'attemptId'; operation_id:=new_state->'intent'->>'operationId';
 expected_authority:=format('%s|%s|%s|%s|%s',owner_id,attempt_id,operation_id,old_generation,new_generation);
 IF current_setting('hush.hosted_provider_account_transition',true)=expected_authority
  AND public.valid_hosted_provider_account_transition_append(to_jsonb(OLD),to_jsonb(NEW)) IS TRUE THEN
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'provider account transition requires reconciliation' USING ERRCODE='42501';
END;
$$;

CREATE OR REPLACE FUNCTION public.record_hosted_provider_account_transition_intent(
 p_owner text,p_attempt text,p_intent jsonb
) RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE r public.personal_agent_registry%ROWTYPE; current_state jsonb; next_state jsonb;
        prior_authority text; project_id text; updated boolean;
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed'
  OR p_owner IS NULL OR p_attempt IS NULL THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,198));
 SELECT * INTO r FROM public.personal_agent_registry WHERE user_id=p_owner FOR UPDATE;
 IF NOT FOUND OR r.backend_metadata ? 'erasure' THEN RETURN false; END IF;
 project_id:=r.backend_metadata->'provisionAttempt'->'hostedAdmission'->'assignment'->>'project';
 IF public.valid_hosted_provider_account_transition_intent(to_jsonb(r),p_intent) IS NOT TRUE
  OR (p_intent->>'intentAt')::timestamptz>clock_timestamp()+interval '5 seconds'
  OR (p_intent->>'intentAt')::timestamptz<clock_timestamp()-interval '10 minutes'
  OR (p_intent->'actorVerification'->>'verifiedAt')::timestamptz>clock_timestamp()+interval '5 seconds'
  OR (p_intent->'actorVerification'->>'verifiedAt')::timestamptz<clock_timestamp()-interval '10 minutes'
  OR r.backend_metadata->'provisionAttempt'->>'attemptId' IS DISTINCT FROM p_attempt
  OR r.backend_metadata->'provisionAttempt'->>'phase' IS DISTINCT FROM 'provisioned'
  OR r.backend_metadata->'provisionAttempt'->'providerAccountTransition' IS NOT NULL
  OR nullif(r.backend_metadata->>'upgradeLease','') IS NOT NULL
  OR r.backend_metadata->'hostedFilesExecutor' IS NOT NULL
  OR EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals c
     WHERE c.user_id=p_owner AND c.completed_at IS NULL)
  OR EXISTS(SELECT 1 FROM public.personal_agent_deletion_tombstones t WHERE t.hushh_id=r.hushh_id)
  OR EXISTS(SELECT 1 FROM public.account_deletion_tombstones t
     WHERE t.user_id_hash='sha256:'||encode(digest(p_owner,'sha256'),'hex')) THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(project_id,205));
 current_state:=r.backend_metadata->'provisionAttempt'->'providerAccountTransition';
 IF current_state IS NOT NULL THEN RETURN false; END IF;
 next_state:=jsonb_build_object('version',1,'generation',1,'phase','intent',
   'intent',p_intent,'settlements','[]'::jsonb);
 IF public.valid_hosted_provider_account_transition(to_jsonb(r),next_state) IS NOT TRUE THEN RETURN false; END IF;
 prior_authority:=current_setting('hush.hosted_provider_account_transition',true);
 PERFORM set_config('hush.hosted_provider_account_transition',
   format('%s|%s|%s|0|1',p_owner,p_attempt,p_intent->>'operationId'),true);
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,
   '{provisionAttempt,providerAccountTransition}',next_state,true),updated_at=clock_timestamp()
  WHERE user_id=p_owner AND backend_metadata->'provisionAttempt'->>'attemptId'=p_attempt
   AND backend_metadata->'provisionAttempt'->'providerAccountTransition' IS NULL;
 updated:=FOUND;
 PERFORM set_config('hush.hosted_provider_account_transition',coalesce(prior_authority,''),true);
 RETURN updated;
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_hosted_provider_account_transition(
 p_owner text,p_attempt text,p_expected_generation bigint,p_expected_phase text,p_settlement jsonb
) RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE r public.personal_agent_registry%ROWTYPE; current_state jsonb; next_state jsonb;
        intent jsonb; prior_authority text; project_id text; next_phase text; next_generation bigint;
        updated boolean;
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed'
  OR p_owner IS NULL OR p_attempt IS NULL OR p_expected_generation IS NULL
  OR p_expected_phase NOT IN ('intent','unknown') THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,198));
 SELECT * INTO r FROM public.personal_agent_registry WHERE user_id=p_owner FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 current_state:=r.backend_metadata->'provisionAttempt'->'providerAccountTransition';
 intent:=current_state->'intent';
 IF r.backend_metadata ? 'erasure'
  OR current_state->>'phase' IS DISTINCT FROM p_expected_phase
  OR current_state->>'generation' IS DISTINCT FROM p_expected_generation::text
  OR public.valid_hosted_provider_account_transition(to_jsonb(r),current_state) IS NOT TRUE
  OR public.valid_hosted_provider_account_transition_settlement(intent,p_settlement) IS NOT TRUE
  OR (p_expected_phase='intent' AND p_settlement->>'outcome' NOT IN ('unknown','settled'))
  OR (p_expected_phase='unknown' AND p_settlement->>'outcome' IS DISTINCT FROM 'settled') THEN RETURN false; END IF;
 project_id:=intent->>'projectId';
 PERFORM pg_advisory_xact_lock(hashtextextended(project_id,205));
 next_generation:=p_expected_generation+1;
 next_phase:=p_settlement->>'outcome';
 IF next_phase='settled' THEN next_phase:='settled'; END IF;
 next_state:=jsonb_set(jsonb_set(current_state,'{generation}',to_jsonb(next_generation)),
   '{phase}',to_jsonb(next_phase));
 next_state:=jsonb_set(next_state,'{settlements}',current_state->'settlements'||jsonb_build_array(p_settlement));
 IF public.valid_hosted_provider_account_transition(to_jsonb(r),next_state) IS NOT TRUE THEN RETURN false; END IF;
 prior_authority:=current_setting('hush.hosted_provider_account_transition',true);
 PERFORM set_config('hush.hosted_provider_account_transition',format('%s|%s|%s|%s|%s',
   p_owner,p_attempt,intent->>'operationId',p_expected_generation,next_generation),true);
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,
   '{provisionAttempt,providerAccountTransition}',next_state,true),updated_at=clock_timestamp()
  WHERE user_id=p_owner AND backend_metadata->'provisionAttempt'->>'attemptId'=p_attempt
   AND backend_metadata->'provisionAttempt'->'providerAccountTransition'=current_state;
 updated:=FOUND;
 PERFORM set_config('hush.hosted_provider_account_transition',coalesce(prior_authority,''),true);
 RETURN updated;
END;
$$;

DROP TRIGGER IF EXISTS zx_hosted_provider_account_transition_registry ON public.personal_agent_registry;
CREATE TRIGGER zx_hosted_provider_account_transition_registry
BEFORE INSERT OR UPDATE OR DELETE ON public.personal_agent_registry
FOR EACH ROW EXECUTE FUNCTION public.guard_hosted_provider_account_transition_registry();

-- The frozen registry snapshot already contains the journal. Make its exact
-- transition visible in the existing erasure archive receipt as well.
DO $provider_account_transition_archive$
DECLARE definition text; anchor text; replacement text;
BEGIN
 SELECT pg_get_functiondef('public.personal_agent_erasure_archive(jsonb,jsonb)'::regprocedure)
  INTO definition;
 anchor:='''managedPrefixAbort'',r->''managedPrefixAbort'') ELSE ''{}''::jsonb END ||';
 replacement:=$replace$'managedPrefixAbort',r->'managedPrefixAbort') ||
 jsonb_strip_nulls(jsonb_build_object(
  'providerAccountTransition',r->'registrySnapshot'->'backend_metadata'->'provisionAttempt'->'providerAccountTransition')) ELSE '{}'::jsonb END ||$replace$;
 IF definition IS NULL OR position(anchor IN definition)=0 OR
    position(anchor IN definition)<>strpos(definition,anchor) OR
    length(definition)-length(replace(definition,anchor,''))<>length(anchor) THEN
  RAISE EXCEPTION 'Provider account transition archive source shape changed'; END IF;
 EXECUTE replace(definition,anchor,replacement);
END;
$provider_account_transition_archive$;

DO $provider_account_transition_acl$
DECLARE signature text; client_role text;
BEGIN
 FOREACH signature IN ARRAY ARRAY[
  'valid_hosted_provider_account_transition_intent(jsonb,jsonb)',
  'valid_hosted_provider_account_transition_settlement(jsonb,jsonb)',
  'valid_hosted_provider_account_transition(jsonb,jsonb)',
  'valid_hosted_provider_account_transition_append(jsonb,jsonb)',
  'guard_hosted_provider_account_transition_registry()',
  'record_hosted_provider_account_transition_intent(text,text,jsonb)',
  'settle_hosted_provider_account_transition(text,text,bigint,text,jsonb)'
 ] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC',signature);
  FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=client_role) THEN
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM %I',signature,client_role);
   END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role',signature);
  END IF;
 END LOOP;
END;
$provider_account_transition_acl$;

COMMIT;
