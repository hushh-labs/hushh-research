-- Dev only. Bind hosted Files work to one PostgreSQL session and the existing
-- owner-approved upgrade lease. Hosted Files remains disabled until the full
-- custody adoption family and provider settlement predicates are qualified.
BEGIN;

DO $hosted_files_executor_predecessors$
BEGIN
 IF to_regprocedure('public.private_gcp_coordinates(jsonb)') IS NULL
 OR to_regprocedure('public.hosted_pod_upgrade_admitted(text,text,jsonb,boolean)') IS NULL
 OR to_regprocedure('public.valid_erasure_gcp_files_upgrade_observation(jsonb,jsonb)') IS NULL
 OR to_regprocedure('public.valid_erasure_substrate_inventory(jsonb,jsonb)') IS NULL
 OR to_regprocedure('public.personal_agent_erasure_complete(text)') IS NULL
 OR to_regprocedure('public.personal_agent_erasure_archive(jsonb,jsonb)') IS NULL
 OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
   AND tgname='zx_project_grant_registry' AND tgtype=23 AND tgenabled IN ('O','A')
   AND tgfoid='public.guard_project_grant_registry_admission()'::regprocedure AND tgnargs=0 AND tgqual IS NULL)
 OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
   AND tgname='zz_personal_agent_erasure_registry' AND tgtype=27 AND tgenabled IN ('O','A')
   AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure AND tgnargs=0 AND tgqual IS NULL)
 THEN RAISE EXCEPTION 'Hosted Files executor predecessors or registry triggers are unavailable'; END IF;
END;
$hosted_files_executor_predecessors$;

-- Preserve the exact predecessor functions while the Hosted Files executor is installed so rollback
-- can restore the existing trigger and erasure owners without reconstructing
-- their source from a later migration. The table contains SQL definitions only.
DO $hosted_files_executor_rollback_source$
DECLARE signature text;
BEGIN
 IF to_regclass('public.hosted_files_executor_976_rollback_source') IS NOT NULL THEN
  RAISE EXCEPTION 'Hosted Files executor rollback source already exists'; END IF;
 CREATE TABLE public.hosted_files_executor_976_rollback_source (
  signature text PRIMARY KEY,
  definition text NOT NULL
 );
 INSERT INTO public.hosted_files_executor_976_rollback_source(signature,definition)
 SELECT spec.signature,pg_get_functiondef(to_regprocedure('public.'||spec.signature))
 FROM (VALUES
  ('guard_project_grant_registry_admission()'),
  ('guard_personal_agent_erasure_registry()'),
  ('valid_erasure_substrate_inventory(jsonb,jsonb)'),
  ('personal_agent_erasure_complete(text)'),
  ('personal_agent_erasure_archive(jsonb,jsonb)')
 ) AS spec(signature);
 IF (SELECT count(*) FROM public.hosted_files_executor_976_rollback_source)<>5 THEN
  RAISE EXCEPTION 'Hosted Files executor rollback source is incomplete'; END IF;
 REVOKE ALL ON public.hosted_files_executor_976_rollback_source FROM PUBLIC;
 FOREACH signature IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=signature) THEN
   EXECUTE format('REVOKE ALL ON public.hosted_files_executor_976_rollback_source FROM %I',signature);
  END IF;
 END LOOP;
END;
$hosted_files_executor_rollback_source$;

CREATE OR REPLACE FUNCTION public.hosted_files_upgrade_host_binding(p_row jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT jsonb_build_object(
  'registry',jsonb_build_object(
   'user_id',p_row->'user_id','hushh_id',p_row->'hushh_id','backend',p_row->'backend',
   'external_agent_id',p_row->'external_agent_id','a2a_route',p_row->'a2a_route',
   'billing_space_id',p_row->'billing_space_id','phone_e164_hash',p_row->'phone_e164_hash',
   'deployment_target',p_row->'deployment_target','user_cloud_project',p_row->'user_cloud_project',
   'user_cloud_tenant_id',p_row->'user_cloud_tenant_id','user_cloud_subscription_id',p_row->'user_cloud_subscription_id',
   'user_cloud_resource_group',p_row->'user_cloud_resource_group','user_cloud_region',p_row->'user_cloud_region',
   'user_cloud_bootstrap_sa',p_row->'user_cloud_bootstrap_sa','placement_epoch',p_row->'placement_epoch',
   'pod_pubkey',p_row->'pod_pubkey','pod_key_id',p_row->'pod_key_id',
   'pod_signing_key_id',p_row->'pod_signing_key_id','pod_signing_pubkey',p_row->'pod_signing_pubkey'),
  'hostMetadata',jsonb_build_object(
   'project',p_row->'backend_metadata'->'project','region',p_row->'backend_metadata'->'region',
   'service',p_row->'backend_metadata'->'service','serviceUid',p_row->'backend_metadata'->'serviceUid',
   'url',p_row->'backend_metadata'->'url','runtime_service_account',p_row->'backend_metadata'->'runtime_service_account',
   'tenancy',p_row->'backend_metadata'->'tenancy','ingress',p_row->'backend_metadata'->'ingress',
   'hostKind',p_row->'backend_metadata'->'hostKind','vmHost',p_row->'backend_metadata'->'vmHost',
   'vmConfigurationSha256',p_row->'backend_metadata'->'vmConfigurationSha256',
   'vmUpdateModuleSha256',p_row->'backend_metadata'->'vmUpdateModuleSha256',
   'runtime_principal_id',p_row->'backend_metadata'->'runtime_principal_id',
   'runtime_client_id',p_row->'backend_metadata'->'runtime_client_id'),
  'userCloudAuthorizedAt',CASE WHEN p_row->>'user_cloud_authorized_at' IS NULL THEN NULL
   ELSE to_char((p_row->>'user_cloud_authorized_at')::timestamptz AT TIME ZONE 'UTC',
     'YYYY-MM-DD"T"HH24:MI:SS.US')||'+00:00' END)
$$;

CREATE OR REPLACE FUNCTION public.hosted_files_executor_session_held(p_owner text, witness jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT coalesce(jsonb_typeof(witness)='object'
  AND witness->>'ownerId'=p_owner
  AND witness->'backendPid'=to_jsonb(pg_backend_pid())
  AND EXISTS (SELECT 1 FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
   WHERE a.pid=pg_backend_pid() AND a.backend_start= (witness->>'backendStart')::timestamptz
   AND l.locktype='advisory' AND l.mode='ExclusiveLock' AND l.granted
   AND l.objsubid=1
   AND l.classid=((hashtextextended(p_owner,206)>>32)&4294967295)::oid
   AND l.objid=(hashtextextended(p_owner,206)&4294967295)::oid),false)
$$;

CREATE OR REPLACE FUNCTION public.hosted_files_executor_owner_locks_held(p_owner text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT p_owner IS NOT NULL
 AND EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid=pg_backend_pid() AND l.locktype='advisory'
   AND l.mode='ExclusiveLock' AND l.granted AND l.objsubid=1
   AND l.classid=((hashtextextended(p_owner,171)>>32)&4294967295)::oid
   AND l.objid=(hashtextextended(p_owner,171)&4294967295)::oid)
 AND EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid=pg_backend_pid() AND l.locktype='advisory'
   AND l.mode='ExclusiveLock' AND l.granted AND l.objsubid=1
   AND l.classid=((hashtextextended(p_owner,198)>>32)&4294967295)::oid
   AND l.objid=(hashtextextended(p_owner,198)&4294967295)::oid)
$$;

CREATE OR REPLACE FUNCTION public.hosted_files_executor_session_active(p_owner text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT EXISTS (SELECT 1 FROM pg_locks l WHERE l.locktype='advisory'
   AND l.mode='ExclusiveLock' AND l.granted AND l.objsubid=1
   AND l.classid=((hashtextextended(p_owner,206)>>32)&4294967295)::oid
   AND l.objid=(hashtextextended(p_owner,206)&4294967295)::oid)
$$;

CREATE OR REPLACE FUNCTION public.valid_hosted_files_replacement_intent(
 reservation jsonb, witness jsonb, intent jsonb
) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE observed_at timestamptz;
BEGIN
 IF jsonb_typeof(intent) IS DISTINCT FROM 'object'
 OR intent-ARRAY['version','ownerId','executionId','lease','operationId','attemptId',
   'targetImage','sourceImage','sourceDigest','deployedImage','incarnation',
   'backendPid','backendStart','intentAt','predecessor']<>'{}'::jsonb
 OR intent->'version' IS DISTINCT FROM '1'::jsonb
 OR intent->>'ownerId' IS DISTINCT FROM reservation->>'ownerId'
 OR intent->>'executionId' IS DISTINCT FROM witness->>'executionId'
 OR intent->>'lease' IS DISTINCT FROM witness->>'lease'
 OR intent->>'operationId' IS DISTINCT FROM witness->>'operationId'
 OR intent->>'attemptId' IS DISTINCT FROM encode(sha256(convert_to(witness->>'lease','UTF8')),'hex')
 OR intent->>'targetImage' IS DISTINCT FROM witness->>'targetImage'
 OR intent->>'sourceImage' IS DISTINCT FROM witness->>'sourceImage'
 OR intent->>'sourceDigest' IS DISTINCT FROM witness->>'sourceDigest'
 OR intent->>'deployedImage' IS DISTINCT FROM witness->>'deployedImage'
 OR intent->>'incarnation' IS DISTINCT FROM witness->>'incarnation'
 OR intent->'backendPid' IS DISTINCT FROM witness->'backendPid'
 OR intent->'backendStart' IS DISTINCT FROM witness->'backendStart'
 OR jsonb_typeof(intent->'predecessor') IS DISTINCT FROM 'object'
 OR (intent->'predecessor')-ARRAY['version','service','serviceUid','generation','resourceVersion',
      'revision','image','nonce']<>'{}'::jsonb
 OR intent->'predecessor'->'version' IS DISTINCT FROM '1'::jsonb
 OR intent->'predecessor'->>'service' IS DISTINCT FROM witness->'plan'->>'service'
 OR intent->'predecessor'->>'serviceUid' IS DISTINCT FROM witness->>'incarnation'
 OR jsonb_typeof(intent->'predecessor'->'generation') IS DISTINCT FROM 'number'
 OR coalesce(intent->'predecessor'->>'generation','') !~ '^[1-9][0-9]*$'
 OR coalesce(intent->'predecessor'->>'resourceVersion','')=''
 OR coalesce(intent->'predecessor'->>'revision','') !~
      ('^'||(witness->'plan'->>'service')||'-')
 OR coalesce(intent->'predecessor'->>'image','')=''
 OR (intent->'predecessor'->'nonce' IS NOT NULL
     AND intent->'predecessor'->'nonce'<>'null'::jsonb
     AND (jsonb_typeof(intent->'predecessor'->'nonce') IS DISTINCT FROM 'string'
          OR intent->'predecessor'->>'nonce'=''))
 OR jsonb_typeof(intent->'intentAt') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
 BEGIN observed_at:=(intent->>'intentAt')::timestamptz;
 EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false; END;
 RETURN observed_at <= statement_timestamp()+interval '5 seconds'
  AND observed_at >= (witness->>'startedAt')::timestamptz;
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_hosted_files_executor_exit(
 reservation jsonb, witness jsonb, exit_evidence jsonb
) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE exited_at timestamptz;
BEGIN
 IF jsonb_typeof(exit_evidence) IS DISTINCT FROM 'object'
 OR exit_evidence->>'phase' IS DISTINCT FROM 'exited'
 OR jsonb_typeof(exit_evidence->'exitedAt') IS DISTINCT FROM 'string'
 OR exit_evidence-ARRAY['phase','exitedAt'] IS DISTINCT FROM witness-'phase'
 OR witness->>'phase' NOT IN ('running','exited')
 OR witness->>'ownerId' IS DISTINCT FROM reservation->>'ownerId'
 OR witness->>'hushhId' IS DISTINCT FROM reservation->>'hushhId'
 OR witness->'backendPid' IS NULL OR witness->'backendStart' IS NULL THEN RETURN false; END IF;
 BEGIN exited_at:=(exit_evidence->>'exitedAt')::timestamptz;
 EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false; END;
 RETURN exited_at >= (witness->>'startedAt')::timestamptz
  AND exited_at <= statement_timestamp()+interval '5 seconds';
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_hosted_files_provider_settlement(
 p_owner text,p_hushh text,witness jsonb,receipt jsonb,intent jsonb
) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE generation bigint; observed_generation bigint; predecessor_generation bigint;
        revision_generation bigint; service_resource text; expected_predecessor text;
        terminal jsonb; revision_condition jsonb; traffic jsonb; condition_reason text;
BEGIN
 IF jsonb_typeof(receipt) IS DISTINCT FROM 'object'
 OR receipt-ARRAY['version','ownerId','hushhId','executionId','lease','operationId','releaseId',
   'planDigest','attemptId','targetImage','targetDigest','sourceImage','sourceDigest','deployedImage',
   'incarnation','service','serviceUid','generation',
   'observedGeneration','revision','image','nonce','ready','outcome','predecessor','revisionUid',
   'revisionGeneration','latestReadyRevision','terminalCondition','revisionCondition','reconciling',
   'revisionReconciling','trafficStatuses']<>'{}'::jsonb
 OR receipt->'version' IS DISTINCT FROM '1'::jsonb
 OR receipt->>'ownerId' IS DISTINCT FROM p_owner
 OR receipt->>'hushhId' IS DISTINCT FROM p_hushh
 OR receipt->>'executionId' IS DISTINCT FROM witness->>'executionId'
 OR receipt->>'lease' IS DISTINCT FROM witness->>'lease'
 OR receipt->>'operationId' IS DISTINCT FROM witness->>'operationId'
 OR receipt->>'releaseId' IS DISTINCT FROM witness->>'releaseId'
 OR receipt->>'planDigest' IS DISTINCT FROM witness->>'planDigest'
 OR receipt->>'attemptId' IS DISTINCT FROM encode(sha256(convert_to(witness->>'lease','UTF8')),'hex')
 OR receipt->>'targetImage' IS DISTINCT FROM witness->>'targetImage'
 OR receipt->>'targetDigest' IS DISTINCT FROM split_part(witness->>'targetImage','@',2)
 OR receipt->>'sourceImage' IS DISTINCT FROM witness->>'sourceImage'
 OR receipt->>'sourceDigest' IS DISTINCT FROM witness->>'sourceDigest'
 OR receipt->>'deployedImage' IS DISTINCT FROM witness->>'deployedImage'
 OR receipt->>'incarnation' IS DISTINCT FROM witness->>'incarnation'
 OR receipt->>'serviceUid' IS DISTINCT FROM witness->>'incarnation'
 OR receipt->>'service' IS DISTINCT FROM witness->'plan'->>'service'
 OR public.valid_hosted_files_replacement_intent(
      jsonb_build_object('ownerId',p_owner,'hushhId',p_hushh),witness,intent) IS NOT TRUE
 OR receipt->'predecessor' IS DISTINCT FROM intent->'predecessor'
 OR receipt->>'nonce' IS DISTINCT FROM receipt->>'attemptId'
 OR receipt->>'image' IS DISTINCT FROM receipt->>'deployedImage'
 OR split_part(receipt->>'image','@',2) IS DISTINCT FROM receipt->>'sourceDigest'
 OR receipt->>'targetDigest' IS DISTINCT FROM split_part(witness->>'targetImage','@',2)
 OR jsonb_typeof(receipt->'generation') IS DISTINCT FROM 'number'
 OR jsonb_typeof(receipt->'observedGeneration') IS DISTINCT FROM 'number'
 OR coalesce(receipt->>'revision','')='' THEN RETURN false; END IF;
 BEGIN
  generation:=(receipt->>'generation')::bigint;
  observed_generation:=(receipt->>'observedGeneration')::bigint;
  predecessor_generation:=(intent->'predecessor'->>'generation')::bigint;
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false; END;
 IF generation<=predecessor_generation THEN RETURN false; END IF;
 IF receipt->>'outcome'='ready' THEN
  RETURN NOT (receipt ?| ARRAY['revisionUid','revisionGeneration','latestReadyRevision',
      'terminalCondition','revisionCondition','reconciling','revisionReconciling','trafficStatuses'])
    AND receipt->'ready' IS NOT DISTINCT FROM 'true'::jsonb
    AND observed_generation=generation
    AND starts_with(receipt->>'revision',(receipt->>'service')||'-')
    AND receipt->>'revision' IS DISTINCT FROM intent->'predecessor'->>'revision';
 END IF;
 IF receipt->>'outcome' IS DISTINCT FROM 'failed'
 OR receipt->'ready' IS DISTINCT FROM 'false'::jsonb
 OR observed_generation IS DISTINCT FROM predecessor_generation
 OR receipt->'reconciling' IS DISTINCT FROM 'false'::jsonb
 OR receipt->'revisionReconciling' IS DISTINCT FROM 'false'::jsonb
 OR jsonb_typeof(receipt->'terminalCondition') IS DISTINCT FROM 'object'
 OR receipt->'terminalCondition'->>'type' IS DISTINCT FROM 'Ready'
 OR receipt->'terminalCondition'->>'state' IS DISTINCT FROM 'CONDITION_FAILED'
 OR jsonb_typeof(receipt->'revisionCondition') IS DISTINCT FROM 'object'
 OR receipt->'revisionCondition'->>'type' IS DISTINCT FROM 'Ready'
 OR receipt->'revisionCondition'->>'state' IS DISTINCT FROM 'CONDITION_FAILED'
 OR jsonb_typeof(receipt->'revisionUid') IS DISTINCT FROM 'string'
 OR coalesce(receipt->>'revisionUid','')=''
 OR jsonb_typeof(receipt->'revisionGeneration') IS DISTINCT FROM 'number'
 OR jsonb_typeof(receipt->'latestReadyRevision') IS DISTINCT FROM 'string'
 OR jsonb_typeof(receipt->'trafficStatuses') IS DISTINCT FROM 'array'
 THEN RETURN false; END IF;
 BEGIN revision_generation:=(receipt->>'revisionGeneration')::bigint;
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false; END;
 service_resource:='projects/'||(witness->'plan'->>'project')||'/locations/'||
   (witness->'plan'->>'region')||'/services/'||(witness->'plan'->>'service');
 expected_predecessor:=service_resource||'/revisions/'||(intent->'predecessor'->>'revision');
 traffic:=receipt->'trafficStatuses';
 IF jsonb_array_length(traffic)<>1 THEN RETURN false; END IF;
 terminal:=receipt->'terminalCondition'; revision_condition:=receipt->'revisionCondition';
 IF receipt->>'revision' NOT LIKE (service_resource||'/revisions/%')
 OR receipt->>'revision'=expected_predecessor
 OR receipt->>'latestReadyRevision' IS DISTINCT FROM expected_predecessor
 OR traffic->0->>'revision' IS DISTINCT FROM expected_predecessor
 OR traffic->0->'percent' IS DISTINCT FROM '100'::jsonb
 OR revision_generation<1
 OR EXISTS (SELECT 1 FROM (VALUES
    (terminal->>'reason'),(terminal->>'revisionReason'),(terminal->>'executionReason'),
    (terminal->>'instanceReason'),(revision_condition->>'reason'),
    (revision_condition->>'revisionReason'),(revision_condition->>'executionReason'),
    (revision_condition->>'instanceReason')) AS reasons(reason)
    WHERE reason IN ('IMMEDIATE_RETRY','POSTPONED_RETRY','WAITING_FOR_OPERATION'))
 THEN RETURN false; END IF;
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_hosted_files_previous_success(p_row jsonb,witness jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE metadata jsonb:=p_row->'backend_metadata'; ack jsonb:=metadata->'upgradeAcknowledgement';
        settlement jsonb:=witness->'providerSettlement';
BEGIN
 IF witness->>'phase' IS DISTINCT FROM 'exited'
 OR nullif(metadata->>'upgradeLease','') IS NOT NULL
 OR metadata ? 'upgradeLeaseHost'
 OR metadata ? 'erasure'
 OR witness->>'ownerId' IS DISTINCT FROM p_row->>'user_id'
 OR witness->>'hushhId' IS DISTINCT FROM p_row->>'hushh_id'
 OR public.valid_hosted_files_replacement_intent(
      jsonb_build_object('ownerId',p_row->>'user_id','hushhId',p_row->>'hushh_id'),
      witness,witness->'replacementIntent') IS NOT TRUE
 OR witness->'providerSettlement' IS NULL
 OR public.valid_hosted_files_provider_settlement(
      p_row->>'user_id',p_row->>'hushh_id',witness,witness->'providerSettlement',
      witness->'replacementIntent') IS NOT TRUE
 OR jsonb_typeof(ack) IS DISTINCT FROM 'object'
 OR ack->>'outcome' IS DISTINCT FROM 'ready'
 OR ack->>'attemptId' IS DISTINCT FROM encode(sha256(convert_to(witness->>'lease','UTF8')),'hex')
 OR ack->>'operationId' IS DISTINCT FROM witness->>'operationId'
 OR ack->>'releaseId' IS DISTINCT FROM witness->'providerSettlement'->>'releaseId'
 OR ack->>'releaseId' IS DISTINCT FROM witness->>'releaseId'
 OR ack->>'podIncarnation' IS DISTINCT FROM witness->>'incarnation'
 OR ack->>'targetImage' IS DISTINCT FROM witness->>'targetImage'
 OR ack->>'targetDigest' IS DISTINCT FROM split_part(witness->>'targetImage','@',2)
 OR ack->>'sourceImage' IS DISTINCT FROM witness->>'sourceImage'
 OR ack->>'sourceDigest' IS DISTINCT FROM witness->>'sourceDigest'
 OR ack->>'deployedImage' IS DISTINCT FROM witness->>'deployedImage'
 OR ack->>'serviceUid' IS DISTINCT FROM witness->>'incarnation'
 OR ack->>'service' IS DISTINCT FROM witness->'plan'->>'service'
 OR ack->>'image' IS DISTINCT FROM witness->>'deployedImage'
 OR ack->>'image' IS DISTINCT FROM settlement->>'deployedImage'
 OR ack->>'sourceImage' IS DISTINCT FROM settlement->>'sourceImage'
 OR ack->>'sourceDigest' IS DISTINCT FROM settlement->>'sourceDigest'
 OR ack->>'deployedImage' IS DISTINCT FROM settlement->>'deployedImage'
 OR ack->'predecessor' IS DISTINCT FROM witness->'replacementIntent'->'predecessor'
 OR ack->>'generation' IS DISTINCT FROM witness->'providerSettlement'->>'generation' THEN
  RETURN false;
 END IF;
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_hosted_files_previous_failure(p_row jsonb,witness jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE metadata jsonb:=p_row->'backend_metadata'; ack jsonb:=metadata->'upgradeAcknowledgement';
        settlement jsonb:=witness->'providerSettlement'; intent jsonb:=witness->'replacementIntent';
BEGIN
 IF witness->>'phase' IS DISTINCT FROM 'exited'
 OR nullif(metadata->>'upgradeLease','') IS NOT NULL
 OR metadata ? 'upgradeLeaseHost'
 OR metadata ? 'erasure'
 OR witness->>'ownerId' IS DISTINCT FROM p_row->>'user_id'
 OR witness->>'hushhId' IS DISTINCT FROM p_row->>'hushh_id'
 OR public.valid_hosted_files_replacement_intent(
      jsonb_build_object('ownerId',p_row->>'user_id','hushhId',p_row->>'hushh_id'),
      witness,intent) IS NOT TRUE
 OR public.valid_hosted_files_provider_settlement(
      p_row->>'user_id',p_row->>'hushh_id',witness,settlement,intent) IS NOT TRUE
 OR jsonb_typeof(ack) IS DISTINCT FROM 'object'
 OR ack->>'outcome' IS DISTINCT FROM 'failed'
 OR ack->>'attemptId' IS DISTINCT FROM encode(sha256(convert_to(witness->>'lease','UTF8')),'hex')
 OR ack->>'operationId' IS DISTINCT FROM witness->>'operationId'
 OR ack->>'releaseId' IS DISTINCT FROM witness->>'releaseId'
 OR ack->>'podIncarnation' IS DISTINCT FROM witness->>'incarnation'
 OR ack->>'targetImage' IS DISTINCT FROM witness->>'targetImage'
 OR ack->>'targetDigest' IS DISTINCT FROM split_part(witness->>'targetImage','@',2)
 OR ack->>'sourceImage' IS DISTINCT FROM witness->>'sourceImage'
 OR ack->>'sourceDigest' IS DISTINCT FROM witness->>'sourceDigest'
 OR ack->>'deployedImage' IS DISTINCT FROM witness->>'deployedImage'
 OR ack->>'serviceUid' IS DISTINCT FROM witness->>'incarnation'
 OR ack->>'service' IS DISTINCT FROM witness->'plan'->>'service'
 OR ack->>'image' IS DISTINCT FROM witness->>'deployedImage'
 OR ack->'predecessor' IS DISTINCT FROM intent->'predecessor'
 OR ack->>'generation' IS DISTINCT FROM settlement->>'generation'
 OR ack->>'observedGeneration' IS DISTINCT FROM settlement->>'observedGeneration'
 OR ack->>'revision' IS DISTINCT FROM settlement->>'revision'
 OR ack->>'ready' IS DISTINCT FROM 'false'
 OR ack->'terminalFailure' IS DISTINCT FROM settlement THEN RETURN false; END IF;
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_hosted_files_no_dispatch(p_row jsonb,witness jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE metadata jsonb:=p_row->'backend_metadata'; ack jsonb:=metadata->'upgradeAcknowledgement';
BEGIN
 IF jsonb_typeof(witness) IS DISTINCT FROM 'object'
 OR witness->>'phase' IS DISTINCT FROM 'exited'
 OR witness->>'dispatchState' IS DISTINCT FROM 'not_submitted'
 OR witness ? 'replacementIntent' OR witness ? 'providerSettlement'
 OR nullif(metadata->>'upgradeLease','') IS NOT NULL
 OR metadata ? 'upgradeLeaseHost' OR metadata ? 'erasure'
 OR witness->>'ownerId' IS DISTINCT FROM p_row->>'user_id'
 OR witness->>'hushhId' IS DISTINCT FROM p_row->>'hushh_id'
 OR (jsonb_typeof(ack)='object'
     AND ack->>'attemptId'=encode(sha256(convert_to(witness->>'lease','UTF8')),'hex'))
 OR witness->>'lease' IS NULL OR witness->>'operationId' IS NULL
 OR witness->>'releaseId' IS NULL OR witness->>'planDigest' IS NULL
 OR witness->>'targetImage' IS NULL OR witness->>'incarnation' IS NULL THEN RETURN false; END IF;
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_hosted_files_previous_terminal(p_row jsonb,witness jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT public.valid_hosted_files_previous_success(p_row,witness) IS TRUE
     OR public.valid_hosted_files_previous_failure(p_row,witness) IS TRUE
     OR public.valid_hosted_files_no_dispatch(p_row,witness) IS TRUE
$$;

CREATE OR REPLACE FUNCTION public.valid_hosted_files_queue_retry(
 prior jsonb, retry jsonb, plan jsonb, lease text, plan_digest text, operation_id text
) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE results jsonb; last_result jsonb; prefix jsonb; recovery jsonb; absence jsonb;
 observed_at timestamptz; expected_steps text[]:=ARRAY[
  'enable_services','generate_files_task_identity','iam_files_task_identity',
  'iam_files_queue_admin','files_worker_account','files_queue','iam_files_enqueuer',
  'iam_files_worker_actas','iam_files_bucket_metadata','iam_files_invoker'];
BEGIN
 results:=prior->'completed'; recovery:=retry->'recovery'; absence:=recovery->'absence';
 IF jsonb_typeof(prior) IS DISTINCT FROM 'object'
 OR prior-ARRAY['version','planDigest','operationId','attemptId','phase','step','completed']<>'{}'::jsonb
 OR jsonb_typeof(retry) IS DISTINCT FROM 'object'
 OR retry-ARRAY['version','planDigest','operationId','attemptId','phase','step','completed','recovery']<>'{}'::jsonb
 OR prior->'version' IS DISTINCT FROM '1'::jsonb OR retry->'version' IS DISTINCT FROM '1'::jsonb
 OR prior->>'phase' IS DISTINCT FROM 'observed' OR prior->>'step' IS DISTINCT FROM 'files_queue'
 OR retry->>'phase' IS DISTINCT FROM 'retry_authorized' OR retry->>'step' IS DISTINCT FROM prior->>'step'
 OR retry->>'planDigest' IS DISTINCT FROM plan_digest
 OR retry->>'operationId' IS DISTINCT FROM operation_id
 OR retry->>'attemptId' IS DISTINCT FROM encode(sha256(convert_to(lease,'UTF8')),'hex')
 OR prior->>'planDigest' IS DISTINCT FROM plan_digest OR prior->>'operationId' IS DISTINCT FROM operation_id
 OR jsonb_typeof(results) IS DISTINCT FROM 'array' OR jsonb_array_length(results)<>6
 OR jsonb_typeof(retry->'completed') IS DISTINCT FROM 'array'
 OR jsonb_typeof(recovery) IS DISTINCT FROM 'object'
 OR recovery-ARRAY['reason','failedObservation','absence']<>'{}'::jsonb
 OR recovery->>'reason' IS DISTINCT FROM 'queue_create_denied'
 OR recovery->'failedObservation' IS DISTINCT FROM results->5
 OR jsonb_typeof(absence) IS DISTINCT FROM 'object'
 OR absence-ARRAY['queue','status','observedAt']<>'{}'::jsonb
 OR absence->>'queue' IS DISTINCT FROM plan->'environment'->>'POD_FILES_TASK_QUEUE'
 OR absence->>'status' IS DISTINCT FROM '404'
 OR jsonb_typeof(absence->'observedAt') IS DISTINCT FROM 'string'
 OR plan->>'version' IS DISTINCT FROM '1' OR plan->>'capability' IS DISTINCT FROM 'files'
 THEN RETURN false; END IF;
 last_result:=results->5; prefix:=results-5;
 IF last_result IS DISTINCT FROM jsonb_build_object('step','files_queue','status',403,'ok',false)
 OR retry->'completed' IS DISTINCT FROM prefix
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(results) WITH ORDINALITY x(value,ord)
    WHERE value->>'step' IS DISTINCT FROM expected_steps[ord::integer]
      OR (ord<6 AND value->'ok' IS DISTINCT FROM 'true'::jsonb)) THEN RETURN false; END IF;
 BEGIN observed_at:=(absence->>'observedAt')::timestamptz;
 EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false; END;
 RETURN observed_at>=clock_timestamp()-interval '5 minutes'
  AND observed_at<=clock_timestamp()+interval '5 seconds';
END;
$$;

CREATE OR REPLACE FUNCTION public.hosted_files_executor_registry_guard(
 p_old jsonb, p_new jsonb, p_operation text
) RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE old_meta jsonb:=coalesce(p_old->'backend_metadata','{}'::jsonb);
 new_meta jsonb:=coalesce(p_new->'backend_metadata','{}'::jsonb);
 old_exec jsonb:=old_meta->'hostedFilesExecutor'; new_exec jsonb:=new_meta->'hostedFilesExecutor';
 old_erasure jsonb:=old_meta->'erasure'; new_erasure jsonb:=new_meta->'erasure';
 intent jsonb; exit_evidence jsonb; policy_current boolean;
BEGIN
 IF p_operation='INSERT' THEN
  RETURN new_exec IS NULL AND nullif(new_meta->>'upgradeLease','') IS NULL;
 END IF;
 IF p_operation='DELETE' THEN
  IF old_exec IS NULL THEN RETURN true; END IF;
  -- A retained executor witness is evidence even after its session exits. Keep
  -- it until the exact provider settlement has been archived by the existing
  -- erasure authority; direct registry deletion must not erase recovery state.
  RETURN old_erasure IS NOT NULL
   AND public.hosted_files_queue_erasure_settled(old_erasure) IS TRUE
   AND public.personal_agent_erasure_archived(p_old->>'user_id',old_erasure) IS TRUE;
 END IF;
 IF p_operation<>'UPDATE' OR jsonb_typeof(p_old) IS DISTINCT FROM 'object'
 OR jsonb_typeof(p_new) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF old_exec IS NULL AND new_exec IS NULL THEN
  IF p_operation='UPDATE' AND p_new->>'deployment_target'='gcp'
   AND coalesce(new_meta->>'tenancy','')='hussh-hosted'
   AND jsonb_typeof(new_meta->'upgradeApproval'->'capabilityPlan')='object'
   AND nullif(new_meta->>'upgradeLease','') IS NOT NULL THEN RETURN false; END IF;
  RETURN true;
 END IF;
 IF p_operation='UPDATE' AND p_new->>'deployment_target'='gcp'
  AND coalesce(new_meta->>'tenancy','')='hussh-hosted'
  AND jsonb_typeof(new_meta->'upgradeApproval'->'capabilityPlan')='object'
  AND nullif(new_meta->>'upgradeLease','') IS NOT NULL
  AND (new_exec IS NULL OR new_exec->>'phase' IS DISTINCT FROM 'running'
       OR new_exec->>'lease' IS DISTINCT FROM new_meta->>'upgradeLease')
  AND NOT (old_exec->>'phase'='running' AND new_exec->>'phase'='exited'
       AND old_exec->>'lease'=new_meta->>'upgradeLease')
  AND NOT (old_exec->>'phase'='exited' AND new_exec IS NOT DISTINCT FROM old_exec
       AND old_erasure IS NULL AND new_erasure IS NOT NULL
       AND new_meta-'erasure' IS NOT DISTINCT FROM old_meta
       AND new_erasure->'registrySnapshot' IS NOT DISTINCT FROM p_old
       AND new_erasure->>'ownerId' IS NOT DISTINCT FROM p_old->>'user_id'
       AND new_erasure->>'hushhId' IS NOT DISTINCT FROM p_old->>'hushh_id'
       AND new_erasure->>'phase' IS NOT DISTINCT FROM 'reserved'
       AND new_erasure->'version' IS NOT DISTINCT FROM '1'::jsonb
       AND coalesce(new_erasure->>'attemptId','')<>''
       AND p_new-ARRAY['backend_metadata','updated_at','status']
           IS NOT DISTINCT FROM p_old-ARRAY['backend_metadata','updated_at','status']
       AND p_new->>'status' IS NOT DISTINCT FROM 'suspended')
 THEN RETURN false; END IF;
 IF p_old->>'user_id' IS DISTINCT FROM p_new->>'user_id'
 OR p_old->>'hushh_id' IS DISTINCT FROM p_new->>'hushh_id'
 OR p_old->'model_credential_mode' IS DISTINCT FROM p_new->'model_credential_mode'
 OR p_old->'liveness_mode' IS DISTINCT FROM p_new->'liveness_mode'
 OR public.hosted_files_upgrade_host_binding(p_old) IS DISTINCT FROM
    public.hosted_files_upgrade_host_binding(p_new) THEN RETURN false; END IF;

 -- Clearing a hosted Files lease requires both independent terminal facts:
 -- the original session has joined and persisted its exit, and the existing
 -- provider settlement plus acknowledgement prove the exact replacement.
 IF nullif(old_meta->>'upgradeLease','') IS NOT NULL
    AND nullif(new_meta->>'upgradeLease','') IS NULL THEN
  IF old_exec IS NULL OR new_exec IS DISTINCT FROM old_exec
  OR old_exec->>'phase' IS DISTINCT FROM 'exited'
  OR old_exec->>'lease' IS DISTINCT FROM old_meta->>'upgradeLease'
  OR old_meta->'upgradeLeaseHost' IS DISTINCT FROM public.hosted_files_upgrade_host_binding(p_old)
  OR public.valid_hosted_files_previous_terminal(p_new,new_exec) IS NOT TRUE THEN
   RETURN false;
  END IF;
 END IF;

 -- An executor can append one replacement intent after erasure has frozen its
 -- start witness. The original session remains the only writer for this append.
 IF old_exec IS NOT DISTINCT FROM new_exec AND old_erasure IS NOT NULL AND new_erasure IS NOT NULL THEN
  IF (new_erasure-'lateFilesReplacementIntent') IS NOT DISTINCT FROM old_erasure
   AND NOT old_erasure ? 'lateFilesReplacementIntent'
   AND public.hosted_files_executor_owner_locks_held(p_old->>'user_id')
   AND public.hosted_files_executor_session_held(p_old->>'user_id',old_exec)
   AND public.valid_hosted_files_replacement_intent(
      old_erasure,old_erasure->'registrySnapshot'->'backend_metadata'->'hostedFilesExecutor',
      new_erasure->'lateFilesReplacementIntent') IS TRUE THEN RETURN true; END IF;
  IF (new_erasure-'lateFilesProviderSettlement') IS NOT DISTINCT FROM old_erasure
   AND NOT old_erasure ? 'lateFilesProviderSettlement'
   AND public.hosted_files_executor_owner_locks_held(p_old->>'user_id')
   AND public.hosted_files_executor_session_held(p_old->>'user_id',old_exec)
   AND public.valid_hosted_files_provider_settlement(
      p_old->>'user_id',p_old->>'hushh_id',
      old_erasure->'registrySnapshot'->'backend_metadata'->'hostedFilesExecutor',
      new_erasure->'lateFilesProviderSettlement',
      coalesce(old_erasure->'lateFilesReplacementIntent',
        old_erasure->'registrySnapshot'->'backend_metadata'->'hostedFilesExecutor'->'replacementIntent'))
      IS TRUE THEN RETURN true; END IF;
  IF (new_erasure-'lateFilesExecutorExit') IS NOT DISTINCT FROM old_erasure
   AND NOT old_erasure ? 'lateFilesExecutorExit'
   AND public.hosted_files_executor_owner_locks_held(p_old->>'user_id')
   AND public.hosted_files_executor_session_held(p_old->>'user_id',old_exec)
   AND public.valid_hosted_files_executor_exit(
      old_erasure,old_erasure->'registrySnapshot'->'backend_metadata'->'hostedFilesExecutor',
      new_erasure->'lateFilesExecutorExit') IS TRUE
   AND (old_erasure->'registrySnapshot'->'backend_metadata'->'hostedFilesExecutor'->>'executionId')
       =old_exec->>'executionId' THEN RETURN true; END IF;
 END IF;

 IF old_exec IS NOT DISTINCT FROM new_exec THEN
  IF new_exec IS NOT NULL AND old_exec->>'phase'='running'
   AND nullif(old_meta->>'upgradeLease','') IS NOT NULL
   AND new_meta->>'upgradeLease' IS NULL THEN RETURN false; END IF;
  RETURN true;
 END IF;

 IF new_exec IS NOT NULL AND new_exec->>'phase'='running'
 AND (old_exec IS NULL OR old_exec->>'phase'='exited') THEN
  IF old_meta ? 'erasure' OR new_meta ? 'erasure'
  OR (old_exec IS NULL AND nullif(old_meta->>'upgradeLease','') IS NOT NULL)
  OR (old_exec IS NOT NULL AND NOT (
       (old_exec->>'phase'='exited'
        AND old_meta->>'upgradeLease'=old_exec->>'lease'
        AND old_exec->>'lease'=new_exec->>'lease'
        AND old_exec->>'operationId'=new_exec->>'operationId'
        AND old_exec->>'planDigest'=new_exec->>'planDigest'
        AND old_exec->'plan'=new_exec->'plan'
        AND old_exec->>'targetImage'=new_exec->>'targetImage'
        AND old_exec->>'sourceImage'=new_exec->>'sourceImage'
        AND old_exec->>'sourceDigest'=new_exec->>'sourceDigest'
        AND old_exec->>'deployedImage'=new_exec->>'deployedImage'
        AND old_exec->>'incarnation'=new_exec->>'incarnation'
        AND new_exec->>'executionId' IS DISTINCT FROM old_exec->>'executionId'
        AND public.valid_hosted_files_queue_retry(
          old_meta->'filesUpgradeCheckpoint',new_meta->'filesUpgradeCheckpoint',
          new_exec->'plan',old_meta->>'upgradeLease',new_exec->>'planDigest',new_exec->>'operationId') IS TRUE)
       OR (old_exec->>'phase'='exited'
        AND old_meta->>'upgradeLease' IS NULL
        AND old_meta->>'upgradeLeaseHost' IS NULL
        AND new_exec->>'lease' IS DISTINCT FROM old_exec->>'lease'
        AND public.valid_hosted_files_previous_terminal(p_old,old_exec) IS TRUE
        AND (public.valid_hosted_files_no_dispatch(p_old,old_exec) IS NOT TRUE
             OR new_exec->>'operationId' IS DISTINCT FROM old_exec->>'operationId'))))
  OR new_meta->>'upgradeLease' IS DISTINCT FROM new_exec->>'lease'
  OR new_meta->'upgradeLeaseHost' IS DISTINCT FROM public.hosted_files_upgrade_host_binding(p_new)
  OR new_exec-ARRAY['version','executionId','ownerId','hushhId','lease','operationId','releaseId','planDigest',
      'plan','incarnation','targetImage','sourceImage','sourceDigest','deployedImage',
      'backendPid','backendStart','startedAt','phase','dispatchState']<>'{}'::jsonb
  OR new_exec->'version' IS DISTINCT FROM '1'::jsonb
  OR new_exec->>'ownerId' IS DISTINCT FROM p_new->>'user_id'
  OR new_exec->>'hushhId' IS DISTINCT FROM p_new->>'hushh_id'
  OR new_exec->>'lease' IS NULL OR new_exec->>'operationId' IS NULL
  OR new_exec->>'releaseId' IS NULL
  OR coalesce(new_exec->>'executionId','') !~ '^[a-f0-9]{32}$'
  OR coalesce(new_exec->>'planDigest','') !~ '^[a-f0-9]{64}$'
  OR coalesce(new_exec->>'targetImage','') !~ '^.+@sha256:[a-f0-9]{64}$'
  OR new_exec->>'sourceImage' IS DISTINCT FROM new_exec->>'targetImage'
  OR new_exec->>'sourceDigest' IS DISTINCT FROM split_part(new_exec->>'targetImage','@',2)
  OR new_exec->>'deployedImage' IS DISTINCT FROM format('%s-docker.pkg.dev/%s/one-pod/consent-protocol-pod@%s',
       new_exec->'plan'->>'region',new_exec->'plan'->>'project',split_part(new_exec->>'targetImage','@',2))
  OR new_exec->'plan'->>'project' IS DISTINCT FROM public.private_gcp_coordinates(p_new)->>'project'
  OR new_exec->'plan'->>'region' IS DISTINCT FROM public.private_gcp_coordinates(p_new)->>'region'
  OR new_exec->>'incarnation' IS DISTINCT FROM p_new->'backend_metadata'->>'serviceUid'
  OR new_exec->'backendPid' IS DISTINCT FROM to_jsonb(pg_backend_pid())
  OR new_exec->'backendStart' IS DISTINCT FROM (SELECT to_jsonb(a.backend_start)
       FROM pg_stat_activity a WHERE a.pid=pg_backend_pid())
  OR new_exec->>'phase' IS DISTINCT FROM 'running'
  OR new_exec->>'dispatchState' IS DISTINCT FROM 'not_submitted'
  OR p_new->>'deployment_target' IS DISTINCT FROM 'gcp'
  OR p_new->>'status' IS DISTINCT FROM 'provisioned'
  OR p_new->'backend_metadata'->>'tenancy' IS DISTINCT FROM 'hussh-hosted'
  OR public.hosted_files_executor_owner_locks_held(p_new->>'user_id') IS NOT TRUE
  OR public.hosted_files_executor_session_held(p_new->>'user_id',new_exec) IS NOT TRUE
  OR public.private_gcp_coordinates(p_new) IS NULL
  OR new_exec->'plan' IS DISTINCT FROM new_meta->'upgradeApproval'->'capabilityPlan'
  OR new_exec->>'planDigest' IS DISTINCT FROM new_meta->'upgradeApproval'->>'capabilityPlanDigest'
  OR new_exec->>'operationId' IS DISTINCT FROM new_meta->'upgradeApproval'->>'operationId'
  OR new_exec->>'releaseId' IS DISTINCT FROM new_meta->'upgradeApproval'->>'releaseId'
  OR new_exec->>'targetImage' IS DISTINCT FROM new_meta->'upgradeApproval'->>'targetImage'
  OR new_exec->>'incarnation' IS DISTINCT FROM new_meta->'upgradeApproval'->>'podIncarnation'
  OR new_exec->'plan'->>'ownerId' IS DISTINCT FROM p_new->>'user_id'
  OR new_exec->'plan'->>'hushhId' IS DISTINCT FROM p_new->>'hushh_id'
  OR new_exec->'plan'->>'serviceUid' IS DISTINCT FROM new_exec->>'incarnation'
  OR new_exec->'plan'->>'targetImage' IS DISTINCT FROM new_exec->>'targetImage'
  OR new_exec->'plan'->>'version' IS DISTINCT FROM '1'
  OR (coalesce(new_meta->'upgradeApproval'->>'status','') NOT IN ('approved','scheduled')
      AND NOT (old_exec->>'phase'='exited'
       AND old_meta->'upgradeApproval'->>'status'='blocked'
       AND old_meta->'upgradeApproval'->>'operationState'='blocked'
       AND new_meta->'upgradeApproval'->>'status'='updating'
       AND new_meta->'upgradeApproval'->>'operationState'='installing'
       AND (new_meta->'upgradeApproval')-ARRAY['status','operationState'] IS NOT DISTINCT FROM
           (old_meta->'upgradeApproval')-ARRAY['status','operationState']))
  OR EXISTS (SELECT 1 FROM public.account_deletion_tombstones t
      WHERE t.user_id_hash='sha256:'||encode(sha256(convert_to(p_new->>'user_id','UTF8')),'hex'))
  OR NOT EXISTS (SELECT 1 FROM public.hosted_pod_pilot_policy p,
      jsonb_array_elements(p.assignments) WITH ORDINALITY x(assignment,n)
    WHERE p.singleton AND p.environment='dev' AND p.expires_at>clock_timestamp()
      AND p.policy_id::text=new_meta->'provisionAttempt'->'hostedAdmission'->>'policyId'
      AND p.source_revision=new_meta->'provisionAttempt'->'hostedAdmission'->>'sourceRevision'
      AND p.image_digest=new_meta->'provisionAttempt'->'hostedAdmission'->>'imageDigest'
      AND p.model_binding=new_meta->'provisionAttempt'->'hostedAdmission'->'modelBinding'
      AND x.assignment=new_meta->'provisionAttempt'->'hostedAdmission'->'assignment'
      AND CASE WHEN x.n=1 THEN p.attempt_a ELSE p.attempt_b END=new_meta->'provisionAttempt'->>'attemptId')
  THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(new_exec) x WHERE x.key='replacementIntent') THEN RETURN false; END IF;
  IF (old_exec IS NULL AND
      new_meta-ARRAY['upgradeLease','upgradeLeaseHost','hostedFilesExecutor'] IS DISTINCT FROM
      old_meta-ARRAY['upgradeLease','upgradeLeaseHost','hostedFilesExecutor'])
  OR (old_exec IS NOT NULL AND
      new_meta-ARRAY['upgradeLease','upgradeLeaseHost','hostedFilesExecutor',
        'filesUpgradeCheckpoint','upgradeApproval'] IS DISTINCT FROM
      old_meta-ARRAY['upgradeLease','upgradeLeaseHost','hostedFilesExecutor',
        'filesUpgradeCheckpoint','upgradeApproval'])
  OR p_new-ARRAY['backend_metadata','updated_at'] IS DISTINCT FROM p_old-ARRAY['backend_metadata','updated_at']
  THEN RETURN false; END IF;
  RETURN true;
 END IF;

 -- Only the original session may add its replacement intent or joined exit.
 IF old_exec IS NOT NULL AND new_exec IS NOT NULL
 AND old_exec->>'phase'='running' AND new_exec->>'phase'='running'
 AND new_exec-ARRAY['replacementIntent','dispatchState'] IS NOT DISTINCT FROM old_exec-'dispatchState'
 AND NOT old_exec ? 'replacementIntent'
 AND old_exec->>'dispatchState'='not_submitted'
 AND new_exec->>'dispatchState'='request_admitted'
 AND public.hosted_files_executor_owner_locks_held(p_old->>'user_id')
 AND public.hosted_files_executor_session_held(p_old->>'user_id',old_exec)
 AND public.valid_hosted_files_replacement_intent(
    jsonb_build_object('ownerId',p_old->>'user_id','hushhId',p_old->>'hushh_id'),
    old_exec,new_exec->'replacementIntent') IS TRUE
 AND new_meta-'hostedFilesExecutor'=old_meta-'hostedFilesExecutor'
 AND p_new-ARRAY['backend_metadata','updated_at'] IS NOT DISTINCT FROM p_old-ARRAY['backend_metadata','updated_at']
 THEN RETURN true; END IF;

 IF old_exec IS NOT NULL AND new_exec IS NOT NULL
 AND old_exec->>'phase'='running' AND new_exec->>'phase'='running'
 AND new_exec-'providerSettlement'=old_exec
 AND NOT old_exec ? 'providerSettlement'
 AND old_exec ? 'replacementIntent'
 AND old_exec->>'dispatchState'='request_admitted'
 AND public.hosted_files_executor_owner_locks_held(p_old->>'user_id')
 AND public.hosted_files_executor_session_held(p_old->>'user_id',old_exec)
 AND public.valid_hosted_files_provider_settlement(
    p_old->>'user_id',p_old->>'hushh_id',old_exec,new_exec->'providerSettlement',
    old_exec->'replacementIntent') IS TRUE
 AND new_meta-'hostedFilesExecutor'=old_meta-'hostedFilesExecutor'
 AND p_new-ARRAY['backend_metadata','updated_at'] IS NOT DISTINCT FROM p_old-ARRAY['backend_metadata','updated_at']
 THEN RETURN true; END IF;

 IF old_exec IS NOT NULL AND new_exec IS NOT NULL
 AND old_exec->>'phase'='running' AND new_exec->>'phase'='exited'
 AND new_exec-ARRAY['phase','exitedAt'] IS NOT DISTINCT FROM old_exec-'phase'
 AND public.hosted_files_executor_owner_locks_held(p_old->>'user_id')
 AND public.hosted_files_executor_session_held(p_old->>'user_id',old_exec)
 AND public.valid_hosted_files_executor_exit(
    jsonb_build_object('ownerId',p_old->>'user_id','hushhId',p_old->>'hushh_id'),
    old_exec,new_exec) IS TRUE
 AND new_meta-'hostedFilesExecutor'=old_meta-'hostedFilesExecutor'
 AND p_new-ARRAY['backend_metadata','updated_at'] IS NOT DISTINCT FROM p_old-ARRAY['backend_metadata','updated_at']
 THEN RETURN true; END IF;

 RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_hosted_files_executor(
 p_owner text, p_observed_registry jsonb, p_observed_host_metadata jsonb,
 p_observed_updated_at timestamptz, p_observed_user_cloud_authorized_at timestamptz,
 p_observed_backend_metadata jsonb, p_target_image text, p_expected_deployed_image text,
 p_operation_id text,
 p_plan jsonb, p_incarnation text, p_execution_id text
) RETURNS text LANGUAGE plpgsql SET search_path=public AS $$
DECLARE r public.personal_agent_registry%ROWTYPE; metadata jsonb; approval jsonb;
 attempt jsonb; lease text; witness jsonb; candidate jsonb; was_locked boolean:=false;
 prior jsonb; prior_lease text;
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed'
 OR coalesce(p_owner,'')='' OR coalesce(p_execution_id,'') !~ '^[a-f0-9]{32}$'
 OR coalesce(p_target_image,'') !~ '^.+@sha256:[a-f0-9]{64}$'
 OR coalesce(p_expected_deployed_image,'') !~ '^.+@sha256:[a-f0-9]{64}$'
 OR coalesce(p_operation_id,'')='' OR jsonb_typeof(p_plan) IS DISTINCT FROM 'object'
 THEN RETURN NULL; END IF;
 -- A retry with the same live session and execution UUID observes the existing
 -- lease before attempting a session lock, so PostgreSQL does not accumulate
 -- reentrant session-lock counts.
 SELECT backend_metadata->'hostedFilesExecutor' INTO prior
  FROM public.personal_agent_registry WHERE user_id=p_owner;
 IF prior->>'executionId'=p_execution_id
 AND public.hosted_files_executor_session_held(p_owner,prior) IS TRUE THEN
  IF prior->>'deployedImage' IS DISTINCT FROM p_expected_deployed_image THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,171));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,198));
  SELECT * INTO r FROM public.personal_agent_registry WHERE user_id=p_owner FOR UPDATE;
  IF NOT FOUND OR r.backend_metadata->'hostedFilesExecutor' IS DISTINCT FROM prior
   OR r.backend_metadata->>'upgradeLease' IS DISTINCT FROM prior->>'lease' THEN RETURN NULL; END IF;
  RETURN prior->>'lease';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,198));
 IF NOT pg_try_advisory_lock(hashtextextended(p_owner,206)) THEN RETURN NULL; END IF;
 was_locked:=true;
 SELECT * INTO r FROM public.personal_agent_registry WHERE user_id=p_owner FOR UPDATE;
 IF NOT FOUND OR to_jsonb(r) IS NULL OR r.user_id IS DISTINCT FROM p_owner
 OR (SELECT count(*) FROM jsonb_each(p_observed_registry) x
      WHERE to_jsonb(r)->x.key IS DISTINCT FROM x.value)>0
 OR r.updated_at IS DISTINCT FROM p_observed_updated_at
 OR r.user_cloud_authorized_at IS DISTINCT FROM p_observed_user_cloud_authorized_at
 OR r.backend_metadata IS DISTINCT FROM p_observed_backend_metadata
 OR (p_observed_host_metadata-ARRAY['substrateReceipt','filesUpgradeCheckpoint','image','image_digest','vmPower'])
      IS DISTINCT FROM public.hosted_files_upgrade_host_binding(to_jsonb(r))->'hostMetadata'
 OR r.status IS DISTINCT FROM 'provisioned' OR r.deployment_target IS DISTINCT FROM 'gcp'
 OR coalesce(r.backend_metadata->>'tenancy','') IS DISTINCT FROM 'hussh-hosted'
 OR r.backend_metadata ? 'erasure'
 OR nullif(r.backend_metadata->>'upgradeLease','') IS NOT NULL
 OR (r.backend_metadata->'hostedFilesExecutor' IS NOT NULL
     AND r.backend_metadata->'hostedFilesExecutor'->>'phase' IS DISTINCT FROM 'exited')
 OR public.private_gcp_coordinates(to_jsonb(r)) IS NULL
 OR p_plan->>'project' IS DISTINCT FROM public.private_gcp_coordinates(to_jsonb(r))->>'project'
 OR p_plan->>'region' IS DISTINCT FROM public.private_gcp_coordinates(to_jsonb(r))->>'region'
 OR p_expected_deployed_image IS DISTINCT FROM format('%s-docker.pkg.dev/%s/one-pod/consent-protocol-pod@%s',
      public.private_gcp_coordinates(to_jsonb(r))->>'region',
      public.private_gcp_coordinates(to_jsonb(r))->>'project',split_part(p_target_image,'@',2)) THEN
  PERFORM pg_advisory_unlock(hashtextextended(p_owner,206)); was_locked:=false; RETURN NULL;
 END IF;
 PERFORM public.assert_project_grant_admission(r.user_cloud_project);
 metadata:=coalesce(r.backend_metadata,'{}'::jsonb); approval:=metadata->'upgradeApproval';
 attempt:=metadata->'provisionAttempt';
 IF approval->>'operationId' IS DISTINCT FROM p_operation_id
 OR approval->>'targetImage' IS DISTINCT FROM p_target_image
 OR coalesce(approval->>'releaseId','')=''
 OR approval->'capabilityPlan' IS DISTINCT FROM p_plan
 OR coalesce(approval->>'capabilityPlanDigest','') !~ '^[a-f0-9]{64}$'
 OR approval->>'podIncarnation' IS DISTINCT FROM p_incarnation
 OR approval->>'status' NOT IN ('approved','scheduled')
 OR p_plan->>'version' IS DISTINCT FROM '1'
 OR p_plan->>'ownerId' IS DISTINCT FROM p_owner
 OR p_plan->>'hushhId' IS DISTINCT FROM r.hushh_id
 OR p_plan->>'serviceUid' IS DISTINCT FROM p_incarnation
 OR p_plan->>'targetImage' IS DISTINCT FROM p_target_image
 OR p_incarnation IS DISTINCT FROM metadata->>'serviceUid'
 OR EXISTS (SELECT 1 FROM public.account_deletion_tombstones t
   WHERE t.user_id_hash='sha256:'||encode(sha256(convert_to(p_owner,'UTF8')),'hex'))
 OR NOT EXISTS (SELECT 1 FROM public.hosted_pod_pilot_policy p,
     jsonb_array_elements(p.assignments) WITH ORDINALITY x(assignment,n)
   WHERE p.singleton AND p.environment='dev' AND p.expires_at>clock_timestamp()
    AND p.policy_id::text=attempt->'hostedAdmission'->>'policyId'
    AND p.source_revision=attempt->'hostedAdmission'->>'sourceRevision'
    AND p.image_digest=attempt->'hostedAdmission'->>'imageDigest'
    AND p.model_binding=attempt->'hostedAdmission'->'modelBinding'
    AND x.assignment=attempt->'hostedAdmission'->'assignment'
    AND CASE WHEN x.n=1 THEN p.attempt_a ELSE p.attempt_b END=attempt->>'attemptId') THEN
  PERFORM pg_advisory_unlock(hashtextextended(p_owner,206)); was_locked:=false; RETURN NULL;
 END IF;
 lease:=clock_timestamp()::text||'|'||replace(gen_random_uuid()::text,'-','')||'|'||p_target_image;
 witness:=jsonb_build_object(
  'version',1,'executionId',p_execution_id,'ownerId',p_owner,'hushhId',r.hushh_id,
  'lease',lease,'operationId',p_operation_id,'releaseId',approval->>'releaseId',
  'planDigest',approval->>'capabilityPlanDigest',
  'plan',p_plan,'incarnation',p_incarnation,'targetImage',p_target_image,
  'sourceImage',p_target_image,'sourceDigest',split_part(p_target_image,'@',2),
  'deployedImage',p_expected_deployed_image,
  'backendPid',pg_backend_pid(),'backendStart',(SELECT backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()),
  'startedAt',clock_timestamp(),'phase','running','dispatchState','not_submitted');
 metadata:=jsonb_set(jsonb_set(jsonb_set(metadata,'{upgradeLease}',to_jsonb(lease),true),
   '{upgradeLeaseHost}',public.hosted_files_upgrade_host_binding(to_jsonb(r)),true),
   '{hostedFilesExecutor}',witness,true);
 PERFORM set_config(
   'hushh.upgrade_lease_host_binding',
   format('%s|%s',lease,public.hosted_files_upgrade_host_binding(to_jsonb(r))::text),
   true);
 UPDATE public.personal_agent_registry AS registry SET backend_metadata=metadata,updated_at=clock_timestamp()
  WHERE user_id=p_owner RETURNING to_jsonb(registry) INTO candidate;
 IF NOT FOUND OR public.hosted_pod_upgrade_admitted(p_owner,lease,candidate,true) IS NOT TRUE THEN
  RAISE EXCEPTION 'hosted Files executor admission changed during claim' USING ERRCODE='42501';
 END IF;
 RETURN lease;
EXCEPTION WHEN OTHERS THEN
 IF was_locked THEN PERFORM pg_advisory_unlock(hashtextextended(p_owner,206)); END IF;
 RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION public.resume_hosted_files_executor(
 p_owner text, p_observed_registry jsonb, p_observed_host_metadata jsonb,
 p_observed_updated_at timestamptz, p_observed_user_cloud_authorized_at timestamptz,
 p_observed_backend_metadata jsonb, p_lease text, p_retry_checkpoint jsonb,
 p_plan jsonb, p_incarnation text, p_expected_deployed_image text, p_execution_id text
) RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE r public.personal_agent_registry%ROWTYPE; metadata jsonb; approval jsonb;
 attempt jsonb; prior_executor jsonb; witness jsonb; candidate jsonb; was_locked boolean:=false;
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed'
 OR coalesce(p_owner,'')='' OR coalesce(p_execution_id,'') !~ '^[a-f0-9]{32}$'
 OR coalesce(p_lease,'')='' OR coalesce(p_incarnation,'')=''
 OR coalesce(p_expected_deployed_image,'') !~ '^.+@sha256:[a-f0-9]{64}$'
 OR jsonb_typeof(p_plan) IS DISTINCT FROM 'object'
 OR jsonb_typeof(p_retry_checkpoint) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,198));
 IF NOT pg_try_advisory_lock(hashtextextended(p_owner,206)) THEN RETURN NULL; END IF;
 was_locked:=true;
 SELECT * INTO r FROM public.personal_agent_registry WHERE user_id=p_owner FOR UPDATE;
 IF NOT FOUND OR r.user_id IS DISTINCT FROM p_owner
 OR (SELECT count(*) FROM jsonb_each(p_observed_registry) x
      WHERE to_jsonb(r)->x.key IS DISTINCT FROM x.value)>0
 OR r.updated_at IS DISTINCT FROM p_observed_updated_at
 OR r.user_cloud_authorized_at IS DISTINCT FROM p_observed_user_cloud_authorized_at
 OR r.backend_metadata IS DISTINCT FROM p_observed_backend_metadata
 OR (p_observed_host_metadata-ARRAY['substrateReceipt','filesUpgradeCheckpoint','image','image_digest','vmPower'])
      IS DISTINCT FROM public.hosted_files_upgrade_host_binding(to_jsonb(r))->'hostMetadata'
 OR r.status IS DISTINCT FROM 'provisioned' OR r.deployment_target IS DISTINCT FROM 'gcp'
 OR coalesce(r.backend_metadata->>'tenancy','') IS DISTINCT FROM 'hussh-hosted'
 OR r.backend_metadata ? 'erasure'
 OR r.backend_metadata->>'upgradeLease' IS DISTINCT FROM p_lease
 OR r.backend_metadata->'upgradeLeaseHost' IS DISTINCT FROM public.hosted_files_upgrade_host_binding(to_jsonb(r))
 OR r.backend_metadata->>'serviceUid' IS DISTINCT FROM p_incarnation
 OR public.private_gcp_coordinates(to_jsonb(r)) IS NULL
 OR p_plan->>'project' IS DISTINCT FROM public.private_gcp_coordinates(to_jsonb(r))->>'project'
 OR p_plan->>'region' IS DISTINCT FROM public.private_gcp_coordinates(to_jsonb(r))->>'region'
 OR p_expected_deployed_image IS DISTINCT FROM format('%s-docker.pkg.dev/%s/one-pod/consent-protocol-pod@%s',
      public.private_gcp_coordinates(to_jsonb(r))->>'region',
      public.private_gcp_coordinates(to_jsonb(r))->>'project',
      split_part(approval->>'targetImage','@',2)) THEN
  PERFORM pg_advisory_unlock(hashtextextended(p_owner,206)); was_locked:=false; RETURN NULL;
 END IF;
 PERFORM public.assert_project_grant_admission(r.user_cloud_project);
 metadata:=r.backend_metadata; approval:=metadata->'upgradeApproval';
 attempt:=metadata->'provisionAttempt'; prior_executor:=metadata->'hostedFilesExecutor';
 IF approval->>'status' IS DISTINCT FROM 'blocked'
 OR approval->>'operationState' IS DISTINCT FROM 'blocked'
 OR coalesce(approval->>'releaseId','')=''
 OR approval->'capabilityPlan' IS DISTINCT FROM p_plan
 OR approval->>'podIncarnation' IS DISTINCT FROM p_incarnation
 OR approval->>'targetImage' IS DISTINCT FROM p_plan->>'targetImage'
 OR approval->>'capabilityPlanDigest' IS DISTINCT FROM p_retry_checkpoint->>'planDigest'
 OR approval->>'operationId' IS DISTINCT FROM p_retry_checkpoint->>'operationId'
 OR p_plan->>'ownerId' IS DISTINCT FROM p_owner
 OR p_plan->>'hushhId' IS DISTINCT FROM r.hushh_id
 OR p_plan->>'serviceUid' IS DISTINCT FROM p_incarnation
 OR p_plan->>'targetImage' IS DISTINCT FROM approval->>'targetImage'
 OR prior_executor->>'phase' IS DISTINCT FROM 'exited'
 OR prior_executor->>'lease' IS DISTINCT FROM p_lease
 OR prior_executor->>'deployedImage' IS DISTINCT FROM p_expected_deployed_image
 OR public.valid_hosted_files_queue_retry(metadata->'filesUpgradeCheckpoint',p_retry_checkpoint,
     p_plan,p_lease,approval->>'capabilityPlanDigest',approval->>'operationId') IS NOT TRUE
 OR EXISTS (SELECT 1 FROM public.account_deletion_tombstones t
   WHERE t.user_id_hash='sha256:'||encode(sha256(convert_to(p_owner,'UTF8')),'hex'))
 OR NOT EXISTS (SELECT 1 FROM public.hosted_pod_pilot_policy p,
     jsonb_array_elements(p.assignments) WITH ORDINALITY x(assignment,n)
   WHERE p.singleton AND p.environment='dev' AND p.expires_at>clock_timestamp()
    AND p.policy_id::text=attempt->'hostedAdmission'->>'policyId'
    AND p.source_revision=attempt->'hostedAdmission'->>'sourceRevision'
    AND p.image_digest=attempt->'hostedAdmission'->>'imageDigest'
    AND p.model_binding=attempt->'hostedAdmission'->'modelBinding'
    AND x.assignment=attempt->'hostedAdmission'->'assignment'
    AND CASE WHEN x.n=1 THEN p.attempt_a ELSE p.attempt_b END=attempt->>'attemptId') THEN
  PERFORM pg_advisory_unlock(hashtextextended(p_owner,206)); was_locked:=false; RETURN NULL;
 END IF;
 witness:=jsonb_build_object(
  'version',1,'executionId',p_execution_id,'ownerId',p_owner,'hushhId',r.hushh_id,
  'lease',p_lease,'operationId',approval->>'operationId','releaseId',approval->>'releaseId',
  'planDigest',approval->>'capabilityPlanDigest',
  'plan',p_plan,'incarnation',p_incarnation,'targetImage',approval->>'targetImage',
  'sourceImage',approval->>'targetImage',
  'sourceDigest',split_part(approval->>'targetImage','@',2),
  'deployedImage',p_expected_deployed_image,
  'backendPid',pg_backend_pid(),'backendStart',(SELECT backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()),
  'startedAt',clock_timestamp(),'phase','running','dispatchState','not_submitted');
 metadata:=jsonb_set(jsonb_set(jsonb_set(metadata,'{filesUpgradeCheckpoint}',p_retry_checkpoint,true),
  '{upgradeApproval}',approval||jsonb_build_object('status','updating','operationState','installing'),true),
  '{hostedFilesExecutor}',witness,true);
 PERFORM set_config(
   'hushh.upgrade_lease_host_binding',
   format('%s|%s',p_lease,public.hosted_files_upgrade_host_binding(to_jsonb(r))::text),
   true);
 UPDATE public.personal_agent_registry AS registry SET backend_metadata=metadata,updated_at=clock_timestamp()
  WHERE user_id=p_owner RETURNING to_jsonb(registry) INTO candidate;
 IF NOT FOUND OR public.hosted_pod_upgrade_admitted(p_owner,p_lease,candidate,true) IS NOT TRUE THEN
  RAISE EXCEPTION 'hosted Files retry admission changed during claim' USING ERRCODE='42501';
 END IF;
 RETURN candidate;
EXCEPTION WHEN OTHERS THEN
 IF was_locked THEN PERFORM pg_advisory_unlock(hashtextextended(p_owner,206)); END IF;
 RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_hosted_files_replacement_intent(
 p_owner text,p_execution_id text,p_lease text,p_operation_id text,p_predecessor jsonb
) RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE r public.personal_agent_registry%ROWTYPE; witness jsonb; reservation jsonb; intent jsonb;
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,198));
 IF public.hosted_files_executor_session_held(p_owner,
    (SELECT backend_metadata->'hostedFilesExecutor' FROM public.personal_agent_registry WHERE user_id=p_owner)) IS NOT TRUE
 THEN RETURN false; END IF;
 SELECT * INTO r FROM public.personal_agent_registry WHERE user_id=p_owner FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 witness:=r.backend_metadata->'hostedFilesExecutor'; reservation:=r.backend_metadata->'erasure';
 IF witness->>'executionId' IS DISTINCT FROM p_execution_id
 OR witness->>'lease' IS DISTINCT FROM p_lease OR witness->>'operationId' IS DISTINCT FROM p_operation_id
 OR witness->>'phase' IS DISTINCT FROM 'running'
 OR public.hosted_files_executor_session_held(p_owner,witness) IS NOT TRUE THEN RETURN false; END IF;
 IF reservation IS NOT NULL AND reservation ? 'lateFilesReplacementIntent' THEN
  RETURN reservation->'lateFilesReplacementIntent'->'predecessor' IS NOT DISTINCT FROM p_predecessor
   AND public.valid_hosted_files_replacement_intent(reservation,
    jsonb_set(reservation->'registrySnapshot'->'backend_metadata'->'hostedFilesExecutor',
      '{dispatchState}','"request_admitted"'::jsonb),
    reservation->'lateFilesReplacementIntent');
 END IF;
 IF reservation IS NULL AND witness ? 'replacementIntent' THEN
  RETURN witness->'replacementIntent'->'predecessor' IS NOT DISTINCT FROM p_predecessor
   AND public.valid_hosted_files_replacement_intent(
    jsonb_build_object('ownerId',p_owner,'hushhId',r.hushh_id),
    jsonb_set(witness,'{dispatchState}','"request_admitted"'::jsonb),witness->'replacementIntent');
 END IF;
 IF witness->>'dispatchState' IS DISTINCT FROM 'not_submitted' THEN RETURN false; END IF;
 intent:=jsonb_build_object('version',1,'ownerId',p_owner,'executionId',p_execution_id,
  'lease',p_lease,'operationId',p_operation_id,
  'attemptId',encode(sha256(convert_to(p_lease,'UTF8')),'hex'),
  'targetImage',witness->>'targetImage','incarnation',witness->>'incarnation',
  'sourceImage',witness->>'sourceImage',
  'sourceDigest',witness->>'sourceDigest',
  'deployedImage',witness->>'deployedImage',
  'predecessor',p_predecessor,
  'backendPid',witness->'backendPid','backendStart',witness->'backendStart','intentAt',clock_timestamp());
 IF reservation IS NOT NULL THEN
  UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,
    ARRAY['erasure','lateFilesReplacementIntent'],intent,true),updated_at=clock_timestamp()
   WHERE user_id=p_owner;
 ELSE
  UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(jsonb_set(backend_metadata,
    '{hostedFilesExecutor,replacementIntent}',intent,true),
    '{hostedFilesExecutor,dispatchState}','"request_admitted"'::jsonb,true),updated_at=clock_timestamp()
   WHERE user_id=p_owner;
 END IF;
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_hosted_files_provider_settlement(
 p_owner text,p_execution_id text,p_lease text,p_receipt jsonb
) RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE r public.personal_agent_registry%ROWTYPE; witness jsonb; reservation jsonb;
        intent jsonb; intent_witness jsonb;
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed'
 OR coalesce(p_owner,'')='' OR jsonb_typeof(p_receipt) IS DISTINCT FROM 'object' THEN
  RETURN false;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,198));
 IF public.hosted_files_executor_session_held(p_owner,
    (SELECT backend_metadata->'hostedFilesExecutor' FROM public.personal_agent_registry WHERE user_id=p_owner)) IS NOT TRUE
 THEN RETURN false; END IF;
 SELECT * INTO r FROM public.personal_agent_registry WHERE user_id=p_owner FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 witness:=r.backend_metadata->'hostedFilesExecutor'; reservation:=r.backend_metadata->'erasure';
 intent:=CASE WHEN reservation IS NULL THEN witness->'replacementIntent'
   ELSE coalesce(reservation->'lateFilesReplacementIntent',witness->'replacementIntent') END;
 intent_witness:=CASE WHEN reservation IS NOT NULL AND reservation ? 'lateFilesReplacementIntent'
   THEN jsonb_set(witness,'{dispatchState}','"request_admitted"'::jsonb) ELSE witness END;
 IF witness->>'executionId' IS DISTINCT FROM p_execution_id
 OR witness->>'lease' IS DISTINCT FROM p_lease
 OR witness->>'phase' IS DISTINCT FROM 'running'
 OR intent IS NULL
 OR (witness->>'dispatchState' IS DISTINCT FROM 'request_admitted'
     AND NOT (reservation IS NOT NULL AND reservation ? 'lateFilesReplacementIntent'
       AND witness->>'dispatchState'='not_submitted'))
 OR public.hosted_files_executor_session_held(p_owner,witness) IS NOT TRUE
 OR public.valid_hosted_files_replacement_intent(
      jsonb_build_object('ownerId',p_owner,'hushhId',r.hushh_id),intent_witness,intent) IS NOT TRUE
 OR public.valid_hosted_files_provider_settlement(
      p_owner,r.hushh_id,witness,p_receipt,intent) IS NOT TRUE THEN RETURN false; END IF;
 IF reservation IS NOT NULL THEN
  IF reservation ? 'lateFilesProviderSettlement' THEN
   RETURN reservation->'lateFilesProviderSettlement' IS NOT DISTINCT FROM p_receipt;
  END IF;
  UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(
    backend_metadata,ARRAY['erasure','lateFilesProviderSettlement'],p_receipt,true),
    updated_at=clock_timestamp() WHERE user_id=p_owner;
 ELSE
  IF witness ? 'providerSettlement' THEN
   RETURN witness->'providerSettlement' IS NOT DISTINCT FROM p_receipt;
  END IF;
  UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(
    backend_metadata,'{hostedFilesExecutor,providerSettlement}',p_receipt,true),
    updated_at=clock_timestamp() WHERE user_id=p_owner;
 END IF;
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_hosted_files_executor(
 p_owner text,p_execution_id text,p_lease text
) RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE r public.personal_agent_registry%ROWTYPE; witness jsonb; reservation jsonb; exit_evidence jsonb;
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,198));
 IF public.hosted_files_executor_session_held(p_owner,
    (SELECT backend_metadata->'hostedFilesExecutor' FROM public.personal_agent_registry WHERE user_id=p_owner)) IS NOT TRUE
 THEN RETURN false; END IF;
 SELECT * INTO r FROM public.personal_agent_registry WHERE user_id=p_owner FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 witness:=r.backend_metadata->'hostedFilesExecutor'; reservation:=r.backend_metadata->'erasure';
 IF witness->>'executionId' IS DISTINCT FROM p_execution_id
 OR witness->>'lease' IS DISTINCT FROM p_lease
 OR public.hosted_files_executor_session_held(p_owner,witness) IS NOT TRUE THEN RETURN false; END IF;
 IF reservation IS NOT NULL AND reservation ? 'lateFilesExecutorExit' THEN
  IF public.valid_hosted_files_executor_exit(reservation,
      reservation->'registrySnapshot'->'backend_metadata'->'hostedFilesExecutor',
      reservation->'lateFilesExecutorExit') IS NOT TRUE THEN RETURN false; END IF;
  PERFORM pg_advisory_unlock(hashtextextended(p_owner,206));
  RETURN true;
 END IF;
 IF reservation IS NULL AND witness->>'phase'='exited' THEN
  PERFORM pg_advisory_unlock(hashtextextended(p_owner,206));
  RETURN true;
 END IF;
 IF witness->>'phase' IS DISTINCT FROM 'running' THEN RETURN false; END IF;
 exit_evidence:=witness||jsonb_build_object('phase','exited','exitedAt',clock_timestamp());
 IF reservation IS NOT NULL THEN
  UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,
   ARRAY['erasure','lateFilesExecutorExit'],exit_evidence,true),updated_at=clock_timestamp()
   WHERE user_id=p_owner;
 ELSE
  UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,
   '{hostedFilesExecutor}',exit_evidence,true),updated_at=clock_timestamp()
   WHERE user_id=p_owner;
 END IF;
 PERFORM pg_advisory_unlock(hashtextextended(p_owner,206));
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.hosted_files_queue_erasure_settled(reservation jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE snapshot jsonb:=reservation->'registrySnapshot'; metadata jsonb:=snapshot->'backend_metadata';
 witness jsonb:=metadata->'hostedFilesExecutor'; exit_evidence jsonb; intent jsonb; ack jsonb;
 checkpoint jsonb; settlement jsonb;
BEGIN
 IF jsonb_typeof(reservation) IS DISTINCT FROM 'object' OR jsonb_typeof(snapshot) IS DISTINCT FROM 'object'
 OR snapshot->>'deployment_target' IS DISTINCT FROM 'gcp'
 OR coalesce(metadata->>'tenancy','hussh-hosted') IS DISTINCT FROM 'hussh-hosted' THEN RETURN true; END IF;
 IF witness IS NULL THEN
  RETURN nullif(metadata->>'upgradeLease','') IS NULL
   AND coalesce(metadata->'provisionAttempt'->>'phase','')='provisioned'
   AND metadata->'filesUpgradeCheckpoint' IS NULL
   AND metadata->'upgradeApproval'->'capabilityPlan' IS NULL
   AND NOT (reservation ?| ARRAY['lateFilesExecutorExit','lateFilesReplacementIntent',
     'lateFilesUpgradeObservation']);
 END IF;
 IF jsonb_typeof(witness) IS DISTINCT FROM 'object'
 OR witness-ARRAY['version','executionId','ownerId','hushhId','lease','operationId','planDigest','plan',
   'releaseId','incarnation','targetImage','sourceImage','sourceDigest','deployedImage',
   'backendPid','backendStart','startedAt','phase','exitedAt','dispatchState',
   'replacementIntent','providerSettlement']<>'{}'::jsonb
 OR witness->'version' IS DISTINCT FROM '1'::jsonb
 OR witness->>'ownerId' IS DISTINCT FROM reservation->>'ownerId'
 OR witness->>'hushhId' IS DISTINCT FROM reservation->>'hushhId'
 OR coalesce(witness->>'lease','')=''
 OR coalesce(witness->>'operationId','')=''
 OR coalesce(witness->>'releaseId','')=''
 OR coalesce(witness->>'planDigest','') !~ '^[a-f0-9]{64}$'
 OR witness->>'incarnation' IS DISTINCT FROM metadata->>'serviceUid'
 OR witness->>'sourceImage' IS DISTINCT FROM witness->>'targetImage'
 OR witness->>'sourceDigest' IS DISTINCT FROM split_part(witness->>'targetImage','@',2)
 OR witness->>'deployedImage' IS DISTINCT FROM format('%s-docker.pkg.dev/%s/one-pod/consent-protocol-pod@%s',
      witness->'plan'->>'region',witness->'plan'->>'project',split_part(witness->>'targetImage','@',2))
 OR witness->'plan'->>'project' IS DISTINCT FROM public.private_gcp_coordinates(snapshot)->>'project'
 OR witness->'plan'->>'region' IS DISTINCT FROM public.private_gcp_coordinates(snapshot)->>'region'
 OR witness->>'phase' NOT IN ('running','exited')
 OR witness->>'dispatchState' NOT IN ('not_submitted','request_admitted')
 OR coalesce(metadata->'provisionAttempt'->>'phase','') IS DISTINCT FROM 'provisioned'
 OR public.private_gcp_coordinates(snapshot) IS NULL THEN RETURN false; END IF;
 IF nullif(metadata->>'upgradeLease','') IS NOT NULL
 AND (witness->>'lease' IS DISTINCT FROM metadata->>'upgradeLease'
   OR witness->>'operationId' IS DISTINCT FROM metadata->'upgradeApproval'->>'operationId'
   OR witness->>'releaseId' IS DISTINCT FROM metadata->'upgradeApproval'->>'releaseId'
   OR witness->>'planDigest' IS DISTINCT FROM metadata->'upgradeApproval'->>'capabilityPlanDigest'
   OR witness->'plan' IS DISTINCT FROM metadata->'upgradeApproval'->'capabilityPlan'
   OR witness->>'targetImage' IS DISTINCT FROM metadata->'upgradeApproval'->>'targetImage') THEN
  RETURN false;
 END IF;
 IF witness->>'phase'='exited' THEN
  exit_evidence:=witness;
 ELSE
  exit_evidence:=reservation->'lateFilesExecutorExit';
  IF public.valid_hosted_files_executor_exit(reservation,witness,exit_evidence) IS NOT TRUE THEN RETURN false; END IF;
 END IF;
 IF public.hosted_files_executor_session_active(reservation->>'ownerId') THEN RETURN false; END IF;
 checkpoint:=metadata->'filesUpgradeCheckpoint';
 IF checkpoint IS NOT NULL THEN
  IF checkpoint->>'phase'='intent' THEN
   IF reservation ? 'lateFilesUpgradeObservation' IS DISTINCT FROM true
    OR public.valid_erasure_gcp_files_upgrade_observation(
      reservation,reservation->'lateFilesUpgradeObservation') IS NOT TRUE THEN RETURN false; END IF;
  ELSIF checkpoint->>'phase' IS DISTINCT FROM 'observed'
   OR reservation ? 'lateFilesUpgradeObservation' THEN RETURN false;
  END IF;
 ELSIF reservation ? 'lateFilesUpgradeObservation' THEN RETURN false;
 END IF;
 intent:=coalesce(reservation->'lateFilesReplacementIntent',witness->'replacementIntent');
 IF reservation ? 'lateFilesReplacementIntent' AND witness ? 'replacementIntent'
 AND reservation->'lateFilesReplacementIntent' IS DISTINCT FROM witness->'replacementIntent' THEN RETURN false; END IF;
 IF intent IS NOT NULL THEN
  IF witness->>'dispatchState' IS DISTINCT FROM 'request_admitted'
   AND NOT (reservation ? 'lateFilesReplacementIntent'
      AND witness->>'dispatchState'='not_submitted') THEN RETURN false; END IF;
  IF public.valid_hosted_files_replacement_intent(reservation,witness,intent) IS NOT TRUE THEN RETURN false; END IF;
  settlement:=coalesce(reservation->'lateFilesProviderSettlement',witness->'providerSettlement');
  IF public.valid_hosted_files_provider_settlement(
       reservation->>'ownerId',reservation->>'hushhId',witness,settlement,intent) IS NOT TRUE THEN RETURN false; END IF;
  ack:=coalesce(reservation->'lateUpgradeAcknowledgement',metadata->'upgradeAcknowledgement');
  IF (nullif(metadata->>'upgradeLease','') IS NOT NULL
      AND public.valid_erasure_upgrade_ack(reservation,ack) IS NOT TRUE)
   OR (nullif(metadata->>'upgradeLease','') IS NULL
      AND public.valid_hosted_files_previous_terminal(snapshot,witness) IS NOT TRUE)
   OR ack->>'operationId' IS DISTINCT FROM witness->>'operationId'
   OR ack->>'releaseId' IS DISTINCT FROM witness->>'releaseId'
   OR ack->>'podIncarnation' IS DISTINCT FROM witness->>'incarnation'
   OR ack->>'serviceUid' IS DISTINCT FROM witness->>'incarnation'
   OR ack->>'service' IS DISTINCT FROM witness->'plan'->>'service'
   OR ack->>'targetImage' IS DISTINCT FROM witness->>'targetImage'
   OR ack->>'targetDigest' IS DISTINCT FROM split_part(witness->>'targetImage','@',2)
   OR ack->>'sourceImage' IS DISTINCT FROM witness->>'sourceImage'
   OR ack->>'sourceDigest' IS DISTINCT FROM witness->>'sourceDigest'
   OR ack->>'deployedImage' IS DISTINCT FROM witness->>'deployedImage'
   OR ack->>'image' IS DISTINCT FROM witness->>'deployedImage'
   OR ack->>'attemptId' IS DISTINCT FROM encode(sha256(convert_to(witness->>'lease','UTF8')),'hex')
   OR jsonb_typeof(ack->'generation') IS DISTINCT FROM 'number'
   OR ack->>'generation' IS DISTINCT FROM settlement->>'generation'
   THEN RETURN false; END IF;
 ELSIF reservation ?| ARRAY['lateUpgradeAcknowledgement','lateFilesProviderSettlement']
    OR witness ? 'providerSettlement'
    OR witness->>'dispatchState' IS DISTINCT FROM 'not_submitted' THEN RETURN false;
 END IF;
 IF witness->>'phase'='exited' AND reservation ? 'lateFilesExecutorExit' THEN RETURN false; END IF;
 RETURN true;
END;
$$;

-- Extend the existing guards in place. Trigger names and event sets remain
-- unchanged: project admission stays INSERT/UPDATE and erasure stays UPDATE/DELETE.
DO $hosted_files_executor_trigger_injection$
DECLARE signature text; definition text; marker text:=E'\nBEGIN\n'; at_position integer; injection text;
BEGIN
 injection:=$inject$
  IF TG_OP='INSERT' THEN
   IF public.hosted_files_executor_registry_guard(NULL,to_jsonb(NEW),'INSERT') IS NOT TRUE THEN
    RAISE EXCEPTION 'hosted Files executor evidence invalid' USING ERRCODE='42501'; END IF;
  ELSIF TG_OP='DELETE' THEN
   IF public.hosted_files_executor_registry_guard(to_jsonb(OLD),NULL,'DELETE') IS NOT TRUE THEN
    RAISE EXCEPTION 'hosted Files executor evidence invalid' USING ERRCODE='42501'; END IF;
  ELSE
   IF public.hosted_files_executor_registry_guard(to_jsonb(OLD),to_jsonb(NEW),'UPDATE') IS NOT TRUE THEN
    RAISE EXCEPTION 'hosted Files executor evidence invalid' USING ERRCODE='42501'; END IF;
  END IF;
  IF TG_OP='UPDATE' AND OLD.backend_metadata ? 'erasure'
   AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
   AND (((NEW.backend_metadata->'erasure')-'lateFilesProviderSettlement'=OLD.backend_metadata->'erasure'
         AND NOT (OLD.backend_metadata->'erasure' ? 'lateFilesProviderSettlement'))
     OR ((NEW.backend_metadata->'erasure')-'lateFilesExecutorExit'=OLD.backend_metadata->'erasure'
         AND NOT (OLD.backend_metadata->'erasure' ? 'lateFilesExecutorExit'))
     OR ((NEW.backend_metadata->'erasure')-'lateFilesReplacementIntent'=OLD.backend_metadata->'erasure'
         AND NOT (OLD.backend_metadata->'erasure' ? 'lateFilesReplacementIntent')))
  THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.backend_metadata->'hostedFilesExecutor' IS NULL
   AND NEW.backend_metadata->'hostedFilesExecutor' IS NOT NULL
   AND public.hosted_files_executor_owner_locks_held(NEW.user_id)
   AND public.hosted_files_executor_session_held(NEW.user_id,NEW.backend_metadata->'hostedFilesExecutor')
  THEN RETURN NEW; END IF;
$inject$;
 FOREACH signature IN ARRAY ARRAY[
  'public.guard_project_grant_registry_admission()','public.guard_personal_agent_erasure_registry()'
 ] LOOP
  SELECT pg_get_functiondef(to_regprocedure(signature)) INTO definition;
  IF definition IS NULL OR position(marker IN definition)=0 THEN
   RAISE EXCEPTION 'Hosted Files registry guard source shape changed: %',signature; END IF;
  at_position:=position(marker IN definition);
  IF position(injection IN definition)>0 THEN
   RAISE EXCEPTION 'Hosted Files registry guard was already extended: %',signature; END IF;
  definition:=substring(definition FROM 1 FOR at_position+length(marker)-1)||injection||substring(definition FROM at_position+length(marker));
  EXECUTE definition;
 END LOOP;
END;
$hosted_files_executor_trigger_injection$;

-- The installed inventory predicate remains the owner of notification and
-- compute-deletion checks; hosted settlement is an additional necessary term.
DO $hosted_files_inventory_settlement$
DECLARE definition text; anchor text:= ' RETURN coalesce(public.valid_erasure_compute_receipt';
 replacement text;
BEGIN
 SELECT pg_get_functiondef('public.valid_erasure_substrate_inventory(jsonb,jsonb)'::regprocedure) INTO definition;
 IF definition IS NULL OR position(anchor IN definition)=0 THEN
  RAISE EXCEPTION 'Hosted Files substrate inventory source shape changed'; END IF;
 replacement:=E' IF reservation->''registrySnapshot''->>''deployment_target''=''gcp''\n'
  ||E'  AND coalesce(reservation->''registrySnapshot''->''backend_metadata''->>''tenancy'',''hussh-hosted'')=''hussh-hosted''\n'
  ||E'  AND public.hosted_files_queue_erasure_settled(reservation) IS NOT TRUE THEN RETURN false; END IF;\n'
  ||anchor;
 definition:=replace(definition,anchor,replacement);
 definition:=replace(definition,'LANGUAGE plpgsql IMMUTABLE','LANGUAGE plpgsql STABLE');
 EXECUTE definition;
END;
$hosted_files_inventory_settlement$;

-- An in-flight lease remains blocking for other surfaces. Hosted Files can
-- settle only through the exact executor witness above and its provider receipt.
DO $hosted_files_erasure_completion$
DECLARE definition text; old_ack text; new_ack text; old_lease text; new_lease text;
BEGIN
 SELECT pg_get_functiondef('public.personal_agent_erasure_complete(text)'::regprocedure) INTO definition;
 old_ack:='OR r ?| ARRAY[''lateUpgradeAcknowledgement'',''lateProvisionAcknowledgement'']';
 new_ack:=$replace$
 OR r ? 'lateProvisionAcknowledgement'
 OR (r ? 'lateUpgradeAcknowledgement' AND NOT (
   r->'registrySnapshot'->>'deployment_target'='gcp'
   AND coalesce(r->'registrySnapshot'->'backend_metadata'->>'tenancy','hussh-hosted')='hussh-hosted'
   AND public.hosted_files_queue_erasure_settled(r) IS TRUE))
$replace$;
 old_lease:='OR nullif(r->''registrySnapshot''->''backend_metadata''->>''upgradeLease'','''') IS NOT NULL';
 new_lease:=$replace$
 OR (nullif(r->'registrySnapshot'->'backend_metadata'->>'upgradeLease','') IS NOT NULL
  AND NOT (r->'registrySnapshot'->>'deployment_target'='gcp'
    AND coalesce(r->'registrySnapshot'->'backend_metadata'->>'tenancy','hussh-hosted')='hussh-hosted'
    AND public.hosted_files_queue_erasure_settled(r) IS TRUE))
$replace$;
 IF definition IS NULL OR position(old_ack IN definition)=0 OR position(old_lease IN definition)=0 THEN
  RAISE EXCEPTION 'Hosted Files erasure completion source shape changed'; END IF;
 definition:=replace(definition,old_ack,new_ack);
 definition:=replace(definition,old_lease,new_lease);
 EXECUTE definition;
END;
$hosted_files_erasure_completion$;

-- Preserve the bounded executor receipt with the existing erasure archive.
DO $hosted_files_executor_archive$
DECLARE definition text; anchor text; replacement text;
BEGIN
 SELECT pg_get_functiondef('public.personal_agent_erasure_archive(jsonb,jsonb)'::regprocedure) INTO definition;
 anchor:='''writerDisabled'',r->''writerDisabled'',''bucketDeletion'',r->''bucketDeletion''';
 replacement:=$replace$
  'writerDisabled',r->'writerDisabled',
  'hostedFilesExecutor',CASE WHEN r->'registrySnapshot'->'backend_metadata'->'hostedFilesExecutor' IS NOT NULL
    THEN jsonb_build_object(
     'start',r->'registrySnapshot'->'backend_metadata'->'hostedFilesExecutor',
     'exit',coalesce(r->'lateFilesExecutorExit',
       CASE WHEN r->'registrySnapshot'->'backend_metadata'->'hostedFilesExecutor'->>'phase'='exited'
         THEN r->'registrySnapshot'->'backend_metadata'->'hostedFilesExecutor' END),
     'replacementIntent',coalesce(r->'lateFilesReplacementIntent',
       r->'registrySnapshot'->'backend_metadata'->'hostedFilesExecutor'->'replacementIntent'),
     'providerAcknowledgement',coalesce(r->'lateUpgradeAcknowledgement',
       r->'registrySnapshot'->'backend_metadata'->'upgradeAcknowledgement'),
     'providerSettlement',coalesce(r->'lateFilesProviderSettlement',
       r->'registrySnapshot'->'backend_metadata'->'hostedFilesExecutor'->'providerSettlement')) ELSE NULL END,
  'bucketDeletion',r->'bucketDeletion'
$replace$;
 IF definition IS NULL OR position(anchor IN definition)=0 THEN
  RAISE EXCEPTION 'Hosted Files erasure archive source shape changed'; END IF;
 definition:=replace(definition,anchor,replacement);
 EXECUTE definition;
END;
$hosted_files_executor_archive$;

DO $hosted_files_executor_acl$
DECLARE signature text; client_role text;
BEGIN
 FOREACH signature IN ARRAY ARRAY[
  'hosted_files_upgrade_host_binding(jsonb)',
  'hosted_files_executor_session_held(text,jsonb)',
  'hosted_files_executor_owner_locks_held(text)',
  'hosted_files_executor_session_active(text)',
  'valid_hosted_files_replacement_intent(jsonb,jsonb,jsonb)',
  'valid_hosted_files_executor_exit(jsonb,jsonb,jsonb)',
  'valid_hosted_files_queue_retry(jsonb,jsonb,jsonb,text,text,text)',
  'valid_hosted_files_provider_settlement(text,text,jsonb,jsonb,jsonb)',
  'valid_hosted_files_previous_success(jsonb,jsonb)',
  'valid_hosted_files_previous_failure(jsonb,jsonb)',
  'valid_hosted_files_no_dispatch(jsonb,jsonb)',
  'valid_hosted_files_previous_terminal(jsonb,jsonb)',
  'hosted_files_executor_registry_guard(jsonb,jsonb,text)',
  'begin_hosted_files_executor(text,jsonb,jsonb,timestamptz,timestamptz,jsonb,text,text,text,jsonb,text,text)',
  'resume_hosted_files_executor(text,jsonb,jsonb,timestamptz,timestamptz,jsonb,text,jsonb,jsonb,text,text,text)',
  'record_hosted_files_replacement_intent(text,text,text,text,jsonb)',
  'record_hosted_files_provider_settlement(text,text,text,jsonb)',
  'finish_hosted_files_executor(text,text,text)',
  'hosted_files_queue_erasure_settled(jsonb)'
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
$hosted_files_executor_acl$;

COMMIT;
