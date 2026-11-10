-- Dev: retire an account without confusing provider retention with account access.
-- The original cloud-removal journal remains the sole authority for its resources.
BEGIN;

ALTER TABLE public.personal_agent_cloud_removals
 ADD COLUMN retirement_handoff jsonb,
 ADD CONSTRAINT cloud_removal_retirement_handoff_bounded CHECK
 (retirement_handoff IS NULL OR (jsonb_typeof(retirement_handoff)='object'
  AND octet_length(retirement_handoff::text)<=2097152));

CREATE FUNCTION public.account_cloud_retirement_contract_version()
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=public AS $$ SELECT 1 $$;

CREATE FUNCTION public.account_cloud_retirement_reservation(owner_id text,attempt text)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE op public.personal_agent_cloud_removals%ROWTYPE; r jsonb;
BEGIN
 SELECT * INTO op FROM public.personal_agent_cloud_removals
  WHERE user_id=owner_id AND attempt_id=attempt;
 IF NOT FOUND OR op.cancelled_at IS NOT NULL THEN RETURN NULL; END IF;
 IF op.retirement_handoff IS NOT NULL THEN RETURN op.retirement_handoff->'reservation'; END IF;
 SELECT backend_metadata->'erasure' INTO r FROM public.personal_agent_registry
  WHERE user_id=owner_id AND status='suspended';
 RETURN r;
END;
$$;

CREATE FUNCTION public.account_cloud_retirement_quiescent(owner_id text,attempt text)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE op public.personal_agent_cloud_removals%ROWTYPE; r jsonb; latest jsonb; kind text; key text;
BEGIN
 SELECT * INTO op FROM public.personal_agent_cloud_removals WHERE user_id=owner_id AND attempt_id=attempt;
 r:=public.account_cloud_retirement_reservation(owner_id,attempt);
 IF NOT FOUND OR op.completed_at IS NOT NULL OR op.cancelled_at IS NOT NULL
 OR op.recovery IS NULL OR r->>'ownerId' IS DISTINCT FROM owner_id
 OR r->>'attemptId' IS DISTINCT FROM attempt OR op.execution_started_at IS NULL
 OR public.legacy_cloud_removal_plan_valid(r,op.recovery->'plan') IS NOT TRUE
 OR EXISTS(SELECT 1 FROM public.personal_agent_standby_placements WHERE user_id=owner_id)
 OR EXISTS(SELECT 1 FROM public.pod_migration_jobs WHERE user_id=owner_id)
 OR EXISTS(SELECT 1 FROM public.byoc_setup_jobs j,
  LATERAL jsonb_each(j.authorization_attempts) a WHERE j.user_id=owner_id
   AND jsonb_typeof(a.value->'receipt') IS DISTINCT FROM 'object')
 THEN RETURN false; END IF;
 -- Every actual process must have a supervisor-verified exit, not just a stale lease.
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(op.recovery->'events') e WHERE e->>'stage'='executor_exit')
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(op.recovery->'events') started
  WHERE started->>'stage'='executor_started' AND NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(op.recovery->'events') exited
    WHERE exited->>'stage'='executor_exit'
     AND exited->'receipt'->>'executionId'=started->'receipt'->>'executionId'
     AND exited->'receipt'->'supervisorVerified'='true'::jsonb))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(op.recovery->'events') dispatched
  WHERE dispatched->>'stage'='provider_dispatch' AND NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(op.recovery->'events') ack
    WHERE ack->>'stage'='provider_ack' AND ack->>'resource'=dispatched->>'resource'
     AND ack->'receipt'->>'requestId'=dispatched->'receipt'->>'requestId'
     AND ack->'receipt'->>'targetSha256'=dispatched->'receipt'->>'targetSha256'
     AND (ack->'receipt'->>'httpStatus' ~ '^2[0-9]{2}$'
      OR ack->'receipt'->>'httpStatus' IN ('401','403','404','412','429'))
     AND (coalesce(ack->'receipt'->>'operationName','')='' OR EXISTS(
      SELECT 1 FROM jsonb_array_elements(op.recovery->'events') observation
       WHERE observation->>'resource'=dispatched->>'resource' AND observation->>'stage'='observation'
        AND observation->'receipt'->>'operationName'=ack->'receipt'->>'operationName'
        AND observation->'receipt'->'operationDone'='true'::jsonb))))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(op.recovery->'events') grant_event
  WHERE grant_event->>'stage'='checkpoint' AND grant_event->'receipt'->>'stage'='temporaryGrant'
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(op.recovery->'events') removed
    WHERE removed->>'resource'=grant_event->>'resource' AND removed->>'stage'='checkpoint'
     AND removed->'receipt'->>'stage'='temporaryGrantRemoved'
     AND (removed->>'sequence')::int>(grant_event->>'sequence')::int))
 THEN RETURN false; END IF;
 SELECT e INTO latest FROM jsonb_array_elements(op.recovery->'events') WITH ORDINALITY x(e,n)
  WHERE e->>'stage' IN ('executor_started','executor_exit') ORDER BY n DESC LIMIT 1;
 IF latest->>'stage' IS DISTINCT FROM 'executor_exit'
 OR latest->'receipt'->>'outcome' NOT IN ('returned','failed','cancelled') THEN RETURN false; END IF;
 key:='service_account:'||(op.recovery->'plan'->'runtime'->'principal'->>'email');
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(op.recovery->'events') e
  WHERE e->>'resource'=key AND e->>'stage' IN ('writer_disabled','native_writer_disabled_after_compute'))
 THEN RETURN false; END IF;
 FOREACH kind IN ARRAY ARRAY['cloud_run_service','reasoning_engine'] LOOP
  key:=CASE kind WHEN 'cloud_run_service' THEN 'cloud_run_service:'||regexp_replace(op.recovery->'plan'->'runtime'->>'serviceName','^.*/','')
   ELSE 'reasoning_engine:'||(op.recovery->'plan'->'memory'->>'engineName') END;
  SELECT e INTO latest FROM jsonb_array_elements(op.recovery->'events') WITH ORDINALITY x(e,n)
   WHERE e->>'resource'=key AND e->>'stage'='observation' ORDER BY n DESC LIMIT 1;
  IF latest IS NULL OR latest->'receipt'->>'status' NOT IN ('deleted','observed_absent') THEN RETURN false; END IF;
 END LOOP;
 -- Only positively evidenced provider retention may outlive account retirement.
 FOR key IN SELECT (item->>'type')||':'||(item->>'id') FROM jsonb_array_elements(op.recovery->'plan'->'resources') item LOOP
  SELECT e INTO latest FROM jsonb_array_elements(op.recovery->'events') WITH ORDINALITY x(e,n)
   WHERE e->>'resource'=key AND e->>'stage'='observation' ORDER BY n DESC LIMIT 1;
  IF latest->'receipt'->>'status'='waiting_for_provider' AND
   (latest->'receipt'->'coverage'->'providerRetention' IS DISTINCT FROM 'true'::jsonb
    OR latest->'receipt'->'coverage'->'inventoryComplete' IS DISTINCT FROM 'true'::jsonb
    OR coalesce(latest->'receipt'->'coverage'->>'nextEligibleAt','')='') THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END;
$$;

CREATE FUNCTION public.account_cloud_retirement_ready(owner_id text,attempt text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT public.account_cloud_retirement_quiescent(owner_id,attempt) IS TRUE AND
  (SELECT e->'receipt'->>'outcome'='returned' FROM public.personal_agent_cloud_removals c,
    LATERAL jsonb_array_elements(c.recovery->'events') WITH ORDINALITY x(e,n)
   WHERE c.user_id=owner_id AND c.attempt_id=attempt AND e->>'stage'='executor_exit'
   ORDER BY n DESC LIMIT 1) IS TRUE;
$$;

CREATE FUNCTION public.account_cloud_retirement_handoff_valid(owner_id text,h jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE t public.account_deletion_tombstones%ROWTYPE; op public.personal_agent_cloud_removals%ROWTYPE;
BEGIN
 IF jsonb_typeof(h) IS DISTINCT FROM 'object'
 OR h-ARRAY['version','ownerId','accountGeneration','cleanupOperation','attemptId','planSha256','snapshotSha256','reservation','authorizationHistory','approvedAt']<>'{}'::jsonb
 OR h->'version' IS DISTINCT FROM '1'::jsonb OR h->>'ownerId' IS DISTINCT FROM owner_id
 OR coalesce(h->>'accountGeneration','') !~ '^(0|[1-9][0-9]{0,8})$'
 OR jsonb_typeof(h->'authorizationHistory') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 SELECT * INTO op FROM public.personal_agent_cloud_removals WHERE user_id=owner_id AND attempt_id=h->>'attemptId';
 SELECT * INTO t FROM public.account_deletion_tombstones
  WHERE user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex')
   AND cleanup_intent_kind='full_account' AND provider_cleanup_id::text=h->>'cleanupOperation';
 RETURN (FOUND AND t.firebase_cleanup_project='hushh-pda-dev'
  AND t.firebase_erasure_authority->>'accountGeneration'=h->>'accountGeneration'
  AND t.firebase_erasure_authority->>'ownerHash'=t.user_id_hash
  AND t.firebase_erasure_authority->>'cleanupId'=h->>'cleanupOperation'
  AND h->>'planSha256'=op.recovery->>'planSha256' AND h->>'snapshotSha256'=op.snapshot_sha256
  AND h->'reservation'->>'ownerId'=owner_id
  AND h->'reservation'->>'attemptId'=op.attempt_id
  AND public.legacy_cloud_removal_plan_valid(h->'reservation',op.recovery->'plan') IS TRUE
  AND (h->>'approvedAt')::timestamptz>=t.deleted_at) IS TRUE;
END;
$$;

CREATE FUNCTION public.retain_account_cloud_retirement(owner_id text,cleanup uuid,expected_plan text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
DECLARE op public.personal_agent_cloud_removals%ROWTYPE; t public.account_deletion_tombstones%ROWTYPE; h jsonb; r jsonb; history jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO t FROM public.account_deletion_tombstones
  WHERE user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex') FOR UPDATE;
 IF NOT FOUND OR t.provider_cleanup_id IS DISTINCT FROM cleanup OR t.erasure_phase<>'provider_cleanup'
 OR t.firebase_cleanup_project IS DISTINCT FROM 'hushh-pda-dev' THEN RETURN false; END IF;
 SELECT * INTO op FROM public.personal_agent_cloud_removals WHERE user_id=owner_id AND completed_at IS NULL AND cancelled_at IS NULL FOR UPDATE;
 IF NOT FOUND OR expected_plan IS DISTINCT FROM op.recovery->>'planSha256'
 OR public.account_cloud_retirement_ready(owner_id,op.attempt_id) IS NOT TRUE THEN RETURN false; END IF;
 IF op.retirement_handoff IS NOT NULL THEN
  RETURN op.retirement_handoff->>'cleanupOperation'=cleanup::text
   AND public.account_cloud_retirement_handoff_valid(owner_id,op.retirement_handoff) IS TRUE;
 END IF;
 r:=public.account_cloud_retirement_reservation(owner_id,op.attempt_id);
 SELECT authorization_attempts INTO history FROM public.byoc_setup_jobs WHERE user_id=owner_id FOR UPDATE;
 -- Authorization acknowledgement can arrive under the job lock alone. Recheck
 -- after acquiring it; a job status or expired heartbeat never supplies proof.
 IF public.account_cloud_retirement_ready(owner_id,op.attempt_id) IS NOT TRUE THEN RETURN false; END IF;
 h:=jsonb_build_object('version',1,'ownerId',owner_id,
  'accountGeneration',t.firebase_erasure_authority->'accountGeneration','cleanupOperation',cleanup::text,
  'attemptId',op.attempt_id,'planSha256',expected_plan,'snapshotSha256',op.snapshot_sha256,
  'reservation',r,'authorizationHistory',coalesce(history,'{}'::jsonb),'approvedAt',clock_timestamp());
 UPDATE public.personal_agent_cloud_removals SET retirement_handoff=h WHERE user_id=owner_id AND attempt_id=op.attempt_id;
 -- Reuse the existing generation allocator's permanent marker. Fresh signup
 -- must not rederive the old global bucket/key namespace from the same phone.
 INSERT INTO public.personal_agent_deletion_tombstones(hushh_id,external_agent_id,status,metadata)
  SELECT r->'registrySnapshot'->>'hushh_id',r->'registrySnapshot'->>'external_agent_id',
   'deprovision_requested',jsonb_build_object('accountDeletionOperation',cleanup,
    'cloudRemovalAttempt',op.attempt_id,'planSha256',expected_plan)
  WHERE NOT EXISTS(SELECT 1 FROM public.personal_agent_deletion_tombstones
   WHERE hushh_id=r->'registrySnapshot'->>'hushh_id');
 RETURN true;
END;
$$;

CREATE FUNCTION public.account_cloud_retirement_retained(owner_id text)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
BEGIN
 RETURN EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals op WHERE op.user_id=owner_id
  AND op.cancelled_at IS NULL
  AND public.account_cloud_retirement_handoff_valid(owner_id,op.retirement_handoff) IS TRUE
  AND ((op.completed_at IS NULL AND public.account_cloud_retirement_ready(owner_id,op.attempt_id) IS TRUE)
   OR (op.completed_at IS NOT NULL AND op.released_identity IS NULL
    AND op.archive=((public.legacy_cloud_removal_archive(op.retirement_handoff->'reservation',
     op.retirement_handoff->'authorizationHistory',op.recovery)-'legacyRecovery')||jsonb_build_object('legacyRecoverySha256',encode(sha256(convert_to((op.recovery)::text,'UTF8')),'hex'))))));
END;
$$;

-- Closed predecessor guards and their qualified successors are installed below.
CREATE FUNCTION public.account_cloud_retirement_transition_valid(old_value jsonb,new_value jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE h jsonb:=old_value->'retirement_handoff'; owner_id text:=old_value->>'user_id';
BEGIN
 IF public.account_cloud_retirement_handoff_valid(owner_id,h) IS NOT TRUE
 OR old_value->>'completed_at' IS NOT NULL
 OR new_value-ARRAY['recovery','completed_at','archive','released_identity']
    IS DISTINCT FROM old_value-ARRAY['recovery','completed_at','archive','released_identity'] THEN RETURN false; END IF;
 IF new_value->>'completed_at' IS NULL THEN
  RETURN new_value-ARRAY['recovery'] IS NOT DISTINCT FROM old_value-ARRAY['recovery']
   AND public.legacy_cloud_removal_append_valid(h->'reservation',old_value->'recovery',new_value->'recovery') IS TRUE;
 END IF;
 RETURN new_value->'recovery' IS NOT DISTINCT FROM old_value->'recovery'
  AND new_value->'released_identity'='null'::jsonb
  AND public.legacy_cloud_removal_complete(owner_id,old_value->>'attempt_id') IS TRUE
  AND new_value->'archive'=((public.legacy_cloud_removal_archive(
   h->'reservation',h->'authorizationHistory',old_value->'recovery')-'legacyRecovery')||jsonb_build_object('legacyRecoverySha256',encode(sha256(convert_to((old_value->'recovery')::text,'UTF8')),'hex')));
END;
$$;

CREATE FUNCTION public.account_cloud_retirement_local_erasure_ready(owner_id text)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE t public.account_deletion_tombstones%ROWTYPE;
BEGIN
 SELECT * INTO t FROM public.account_deletion_tombstones
  WHERE user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex');
 RETURN (FOUND AND t.erasure_phase IN ('local_erasure','erased')
  AND public.account_firebase_erasure_qualified(t) IS TRUE
  AND public.account_provider_cleanup_qualified(t.provider_cleanup_receipt,
   t.provider_cleanup_inventory,t.user_id_hash,t.provider_cleanup_id) IS TRUE
  AND public.account_cloud_retirement_retained(owner_id) IS TRUE) IS TRUE;
END;
$$;
-- Installed qualified successors; measured predecessor bodies are immutable.

DO $preimages$ BEGIN
 IF encode(sha256(convert_to(pg_get_functiondef('public.guard_personal_agent_erasure_registry()'::regprocedure),'UTF8')),'hex') IS DISTINCT FROM 'c7f509dc6824e9a0ab66ae6e30b98e2afdd48483d72754a00c36cb15d0d3f521' AND encode(sha256(convert_to(pg_get_functiondef('public.guard_personal_agent_erasure_registry()'::regprocedure),'UTF8')),'hex') IS DISTINCT FROM '8ac0d73779ceeb59ee17c4d8424aa897bcb8baf48ce050321982753f50dda719' THEN RAISE EXCEPTION 'Account cloud retirement predecessor changed: guard_personal_agent_erasure_registry()'; END IF;
 IF encode(sha256(convert_to(pg_get_functiondef('public.guard_byoc_authorization_attempts()'::regprocedure),'UTF8')),'hex') IS DISTINCT FROM '21da621eb6d93ffed6c2df4d3ca287ccac2ec1cead0d0f94659fbb0b4fe41346' THEN RAISE EXCEPTION 'Account cloud retirement predecessor changed: guard_byoc_authorization_attempts()'; END IF;
 IF encode(sha256(convert_to(pg_get_functiondef('public.reject_retired_account_update()'::regprocedure),'UTF8')),'hex') IS DISTINCT FROM '260e109f69718263eed5116c07107f23d38d082edfd6b811230a813d20137fd9' THEN RAISE EXCEPTION 'Account cloud retirement predecessor changed: reject_retired_account_update()'; END IF;
 IF encode(sha256(convert_to(pg_get_functiondef('public.guard_personal_agent_cloud_removal()'::regprocedure),'UTF8')),'hex') IS DISTINCT FROM 'b4ce03f6eca358014dd92ec8aa563451ad46661546bf8627d9bb611780359516' THEN RAISE EXCEPTION 'Account cloud retirement predecessor changed: guard_personal_agent_cloud_removal()'; END IF;
 IF encode(sha256(convert_to(pg_get_functiondef('public.retain_legacy_cloud_removal(text,text,text,jsonb,jsonb)'::regprocedure),'UTF8')),'hex') IS DISTINCT FROM 'f9b107acd715896cad1ae56acadee2732ca2385915d78c6c9bda1626c7aec07d' THEN RAISE EXCEPTION 'Account cloud retirement predecessor changed: retain_legacy_cloud_removal(text,text,text,jsonb,jsonb)'; END IF;
 IF encode(sha256(convert_to(pg_get_functiondef('public.legacy_cloud_removal_complete(text,text)'::regprocedure),'UTF8')),'hex') IS DISTINCT FROM 'e3742d02c03e82dd34bf414fd08875dbdae2deba500b5e444e01756af80d4c70' THEN RAISE EXCEPTION 'Account cloud retirement predecessor changed: legacy_cloud_removal_complete(text,text)'; END IF;
 IF encode(sha256(convert_to(pg_get_functiondef('public.finalize_personal_agent_cloud_removal(text,text,text)'::regprocedure),'UTF8')),'hex') IS DISTINCT FROM '4b903616500da196c1bc2dc6972104a44a5618500ce4e2cd5d61f6a844e99dad' THEN RAISE EXCEPTION 'Account cloud retirement predecessor changed: finalize_personal_agent_cloud_removal(text,text,text)'; END IF;
 IF encode(sha256(convert_to(pg_get_functiondef('public.legacy_cloud_removal_event_valid(jsonb,jsonb)'::regprocedure),'UTF8')),'hex') IS DISTINCT FROM '494ff6364b1ab6bf3abbca3bde15731a3340a311f1ad0540b8e59e49c5dcb3a4' THEN RAISE EXCEPTION 'Account cloud retirement predecessor changed: legacy_cloud_removal_event_valid(jsonb,jsonb)'; END IF;
 IF encode(sha256(convert_to(pg_get_functiondef('public.assert_project_grant_admission(text)'::regprocedure),'UTF8')),'hex') IS DISTINCT FROM '2d702143880933dad5bfa7e2e24edd02691f964e45b0f6b64ded12bfb3862a36' THEN RAISE EXCEPTION 'Account cloud retirement predecessor changed: assert_project_grant_admission(text)'; END IF;
END $preimages$;


DO $completion_constraint$ DECLARE c record; n integer:=0; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='public.personal_agent_cloud_removals'::regclass
  AND contype='c' AND regexp_replace(pg_get_constraintdef(oid,true),'[ ()]','','g')=
   'CHECKcompleted_atISNULL=released_identityISNULL' LOOP
  EXECUTE format('ALTER TABLE public.personal_agent_cloud_removals DROP CONSTRAINT %I',c.conname);
  n:=n+1;
 END LOOP;
 IF n<>1 THEN RAISE EXCEPTION 'Unqualified cloud-removal completion constraint'; END IF;
END $completion_constraint$;
ALTER TABLE public.personal_agent_cloud_removals ADD CONSTRAINT cloud_removal_retired_completion CHECK
 ((completed_at IS NULL AND released_identity IS NULL) OR
  (completed_at IS NOT NULL AND ((retirement_handoff IS NULL AND released_identity IS NOT NULL)
   OR (retirement_handoff IS NOT NULL AND released_identity IS NULL))));

DO $retirement_registry_profile$ BEGIN
 IF encode(sha256(convert_to(pg_get_functiondef('public.guard_personal_agent_erasure_registry()'::regprocedure),'UTF8')),'hex')='8ac0d73779ceeb59ee17c4d8424aa897bcb8baf48ce050321982753f50dda719' THEN
 EXECUTE $native_retirement_registry$CREATE OR REPLACE FUNCTION public.guard_personal_agent_erasure_registry()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE reservation jsonb; snapshot jsonb; cancel_allowed boolean;
BEGIN
 IF TG_OP='DELETE' AND public.account_cloud_retirement_local_erasure_ready(OLD.user_id) IS TRUE
  AND EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals c WHERE c.user_id=OLD.user_id
   AND c.retirement_handoff->'reservation' IS NOT DISTINCT FROM OLD.backend_metadata->'erasure'
   AND public.account_cloud_retirement_handoff_valid(OLD.user_id,c.retirement_handoff) IS TRUE)
 THEN RETURN OLD; END IF;

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
  -- Preserve421's reviewed cloud-removal cancellation and restore barriers.
  IF TG_OP='UPDATE' AND to_regprocedure('public.cloud_removal_cancel_restore_allowed(jsonb,jsonb)') IS NOT NULL THEN
    EXECUTE 'SELECT public.cloud_removal_cancel_restore_allowed($1,$2)' INTO cancel_allowed USING to_jsonb(OLD),to_jsonb(NEW);
    IF cancel_allowed IS TRUE THEN RETURN NEW; END IF;
  END IF;
  IF TG_OP='DELETE' AND public.personal_agent_erasure_archived(OLD.user_id,OLD.backend_metadata->'erasure') IS TRUE THEN RETURN OLD; END IF;
  IF OLD.backend_metadata ? 'erasure' THEN
    reservation := OLD.backend_metadata->'erasure';
    snapshot := reservation->'registrySnapshot';

    -- 962: one validated append to the existing owner resource-cleanup receipt.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_azure_erasure_append(OLD.user_id,OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure') IS TRUE THEN RETURN NEW; END IF;

    -- 956: one qualified receipt for the exact notification mutation frozen by erasure.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND (NEW.backend_metadata->'erasure')-'lateNotificationObservation'=OLD.backend_metadata->'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'lateNotificationObservation')
       AND NOT (OLD.backend_metadata->'erasure' ? 'substrateInventory')
       AND public.valid_erasure_notification_observation(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'lateNotificationObservation') IS TRUE THEN RETURN NEW; END IF;

    IF TG_OP='UPDATE'
       AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND (NEW.backend_metadata->'erasure')-'lateFilesUpgradeObservation'=OLD.backend_metadata->'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'lateFilesUpgradeObservation')
       AND NOT (OLD.backend_metadata->'erasure' ? 'substrateInventory')
       AND public.valid_erasure_files_upgrade_observation(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'lateFilesUpgradeObservation') IS TRUE THEN RETURN NEW;
    END IF;

    IF TG_OP='UPDATE' AND public.hosted_preparation_cleanup_admitted(OLD.user_id,reservation->>'attemptId',reservation) IS TRUE
       AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_managed_preparation_cleanup_append(reservation,NEW.backend_metadata->'erasure') IS TRUE
       THEN RETURN NEW; END IF;

    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.hosted_prefix_abort_admitted(OLD.user_id,reservation->>'attemptId',reservation) IS TRUE
       AND public.valid_managed_prefix_abort_append(reservation,NEW.backend_metadata->'erasure') IS TRUE
       THEN RETURN NEW; END IF;

    -- Managed cleanup uses its retained policy slot, without a new-work expiry test.
    IF snapshot->>'deployment_target'='gcp' AND
       public.hosted_pod_cleanup_admitted(OLD.user_id,reservation->>'attemptId',reservation) IS NOT TRUE
       AND public.hosted_preparation_cleanup_admitted(OLD.user_id,reservation->>'attemptId',reservation) IS NOT TRUE THEN
      RAISE EXCEPTION 'managed erasure authority requires reconciliation' USING ERRCODE='42501';
    END IF;
    IF TG_OP='UPDATE' AND snapshot->>'deployment_target'='gcp'
       AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_erasure_managed_model_grant_append(reservation,NEW.backend_metadata->'erasure') IS TRUE
       THEN RETURN NEW; END IF;

    IF TG_OP='UPDATE' AND snapshot->>'deployment_target'='gcp'
       AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_erasure_managed_retirement_append(reservation,NEW.backend_metadata->'erasure') IS TRUE
       THEN RETURN NEW; END IF;

    -- The transaction-local marker coordinates the restore, but is caller-settable.
    -- Independently enforce the identity, tombstone and setup barriers here.
    IF TG_OP = 'UPDATE'
       AND NOT EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals c
        WHERE c.user_id=OLD.user_id AND c.attempt_id=reservation->>'attemptId')
       AND current_setting('hussh.erasure_restore_attempt', true) = reservation->>'attemptId'
       AND reservation - ARRAY['version','ownerId','attemptId','hushhId','phase','registrySnapshot'] = '{}'::jsonb
       AND reservation->>'ownerId' = OLD.user_id
       AND OLD.status = 'suspended'
       AND snapshot->>'user_id' = OLD.user_id
       AND snapshot->>'hushh_id' = OLD.hushh_id
       AND reservation->>'phase' = 'reserved'
       AND snapshot->>'status' = 'provisioned'
       AND jsonb_typeof(snapshot->'backend_metadata') = 'object'
       AND NOT (snapshot->'backend_metadata' ? 'erasure')
       AND to_jsonb(NEW) - 'updated_at' = snapshot - 'updated_at'
    THEN
      IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
        RAISE EXCEPTION 'erasure restore requires a current snapshot' USING ERRCODE='42501';
      END IF;
      -- Match account erasure's owner-lock order. A direct writer holding the row
      -- must refuse a lock conflict rather than invert that order and deadlock.
      IF NOT pg_try_advisory_xact_lock(hashtextextended(OLD.user_id,171))
         OR NOT pg_try_advisory_xact_lock(hashtextextended(OLD.user_id,198)) THEN
        RAISE EXCEPTION 'erasure restore owner busy' USING ERRCODE='42501';
      END IF;
      IF EXISTS (SELECT 1 FROM public.personal_agent_deletion_tombstones WHERE hushh_id=OLD.hushh_id)
         OR EXISTS (SELECT 1 FROM public.account_deletion_tombstones
            WHERE user_id_hash='sha256:'||encode(sha256(convert_to(OLD.user_id,'UTF8')),'hex'))
         OR NOT EXISTS (SELECT 1 FROM public.byoc_setup_jobs
            WHERE user_id=OLD.user_id AND status='recorded' AND authorization_attempts='{}'::jsonb) THEN
        RAISE EXCEPTION 'erasure restore authority unavailable' USING ERRCODE='42501';
      END IF;
      RETURN NEW;
    END IF;

    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_erasure_files_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') IS TRUE THEN RETURN NEW; END IF;
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
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND (NEW.backend_metadata->'erasure') - 'memoryBinding' =
           (OLD.backend_metadata->'erasure') - 'memoryBinding'
       AND NOT ((OLD.backend_metadata->'erasure') ? 'memoryBinding')
       AND public.valid_erasure_memory_binding(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'memoryBinding') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND (NEW.backend_metadata->'erasure') - 'memoryDeletion' = (OLD.backend_metadata->'erasure') - 'memoryDeletion'
       AND NOT ((OLD.backend_metadata->'erasure') ? 'memoryDeletion')
       AND public.valid_erasure_memory_deletion(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'memoryDeletion') THEN RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_compute_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'substrateInventory')
       AND (NEW.backend_metadata->'erasure') - 'substrateInventory' = OLD.backend_metadata->'erasure'
       AND public.valid_erasure_substrate_inventory(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'substrateInventory') THEN RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_writer_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_bucket_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_mail_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_kms_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_secret_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_account_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'grantRelease')
       AND (NEW.backend_metadata->'erasure') - 'grantRelease'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_grant_release(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure'->'grantRelease') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,NEW.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW;
    END IF;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_erasure_runtime_grant_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_repository_grant_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'repositoryInventory')
       AND (NEW.backend_metadata->'erasure')-'repositoryInventory'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_repository_inventory(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure'->'repositoryInventory') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'repositoryRetention')
       AND (NEW.backend_metadata->'erasure')-'repositoryRetention'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_repository_retention(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure'->'repositoryRetention') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'bootstrapGrantRelease')
       AND (NEW.backend_metadata->'erasure')-'bootstrapGrantRelease'=OLD.backend_metadata->'erasure'
       AND NEW.backend_metadata->'erasure'->'bootstrapGrantRelease'=public.expected_erasure_bootstrap_release(OLD.user_id,OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure'->'bootstrapGrantRelease'->>'recoveryMember')
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_erasure_bootstrap_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    -- Owner-access erasure (949): the pod's confirmation, once, before any revocation.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'agentCryptoErase')
       AND NOT (OLD.backend_metadata->'erasure' ? 'ownerAccessErasure')
       AND (NEW.backend_metadata->'erasure')-'agentCryptoErase'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_owner_access_checkpoint(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'agentCryptoErase') IS TRUE THEN RETURN NEW; END IF;
    -- Owner-access erasure (949): one receipt, once, validated against the snapshot.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'ownerAccessErasure')
       AND (NEW.backend_metadata->'erasure')-'ownerAccessErasure'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_owner_access(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'ownerAccessErasure') IS TRUE THEN RETURN NEW; END IF;
    -- Never-hosted erasure (954): the derived receipt and the project fence, once.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_erasure_never_hosted_append(OLD.user_id,OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,
           NEW.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'personal agent erasure reserved' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$
$native_retirement_registry$;
 ELSE
 EXECUTE $base_retirement_registry$CREATE OR REPLACE FUNCTION public.guard_personal_agent_erasure_registry()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE reservation jsonb; snapshot jsonb;
BEGIN
 IF TG_OP='DELETE' AND public.account_cloud_retirement_local_erasure_ready(OLD.user_id) IS TRUE
  AND EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals c WHERE c.user_id=OLD.user_id
   AND c.retirement_handoff->'reservation' IS NOT DISTINCT FROM OLD.backend_metadata->'erasure'
   AND public.account_cloud_retirement_handoff_valid(OLD.user_id,c.retirement_handoff) IS TRUE)
 THEN RETURN OLD; END IF;
  IF TG_OP='UPDATE' AND public.cloud_removal_cancel_restore_allowed(to_jsonb(OLD),to_jsonb(NEW)) IS TRUE THEN RETURN NEW; END IF;
  IF TG_OP='DELETE' AND public.personal_agent_erasure_archived(OLD.user_id,OLD.backend_metadata->'erasure') IS TRUE THEN RETURN OLD; END IF;
  IF OLD.backend_metadata ? 'erasure' THEN
    reservation := OLD.backend_metadata->'erasure';
    snapshot := reservation->'registrySnapshot';

    -- 962: one validated append to the existing owner resource-cleanup receipt.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_azure_erasure_append(OLD.user_id,OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure') IS TRUE THEN RETURN NEW; END IF;

    -- 956: one qualified receipt for the exact notification mutation frozen by erasure.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND (NEW.backend_metadata->'erasure')-'lateNotificationObservation'=OLD.backend_metadata->'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'lateNotificationObservation')
       AND NOT (OLD.backend_metadata->'erasure' ? 'substrateInventory')
       AND public.valid_erasure_notification_observation(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'lateNotificationObservation') IS TRUE THEN RETURN NEW; END IF;

    IF TG_OP='UPDATE'
       AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND (NEW.backend_metadata->'erasure')-'lateFilesUpgradeObservation'=OLD.backend_metadata->'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'lateFilesUpgradeObservation')
       AND NOT (OLD.backend_metadata->'erasure' ? 'substrateInventory')
       AND public.valid_erasure_files_upgrade_observation(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'lateFilesUpgradeObservation') IS TRUE THEN RETURN NEW;
    END IF;

    -- The transaction-local marker coordinates the restore, but is caller-settable.
    -- Independently enforce the identity, tombstone and setup barriers here.
    IF TG_OP = 'UPDATE'
       AND NOT EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals c
        WHERE c.user_id=OLD.user_id AND c.attempt_id=reservation->>'attemptId')
       AND current_setting('hussh.erasure_restore_attempt', true) = reservation->>'attemptId'
       AND reservation - ARRAY['version','ownerId','attemptId','hushhId','phase','registrySnapshot'] = '{}'::jsonb
       AND reservation->>'ownerId' = OLD.user_id
       AND OLD.status = 'suspended'
       AND snapshot->>'user_id' = OLD.user_id
       AND snapshot->>'hushh_id' = OLD.hushh_id
       AND reservation->>'phase' = 'reserved'
       AND snapshot->>'status' = 'provisioned'
       AND jsonb_typeof(snapshot->'backend_metadata') = 'object'
       AND NOT (snapshot->'backend_metadata' ? 'erasure')
       AND to_jsonb(NEW) - 'updated_at' = snapshot - 'updated_at'
    THEN
      IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
        RAISE EXCEPTION 'erasure restore requires a current snapshot' USING ERRCODE='42501';
      END IF;
      -- Match account erasure's owner-lock order. A direct writer holding the row
      -- must refuse a lock conflict rather than invert that order and deadlock.
      IF NOT pg_try_advisory_xact_lock(hashtextextended(OLD.user_id,171))
         OR NOT pg_try_advisory_xact_lock(hashtextextended(OLD.user_id,198)) THEN
        RAISE EXCEPTION 'erasure restore owner busy' USING ERRCODE='42501';
      END IF;
      IF EXISTS (SELECT 1 FROM public.personal_agent_deletion_tombstones WHERE hushh_id=OLD.hushh_id)
         OR EXISTS (SELECT 1 FROM public.account_deletion_tombstones
            WHERE user_id_hash='sha256:'||encode(sha256(convert_to(OLD.user_id,'UTF8')),'hex'))
         OR NOT EXISTS (SELECT 1 FROM public.byoc_setup_jobs
            WHERE user_id=OLD.user_id AND status='recorded' AND authorization_attempts='{}'::jsonb) THEN
        RAISE EXCEPTION 'erasure restore authority unavailable' USING ERRCODE='42501';
      END IF;
      RETURN NEW;
    END IF;

    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_erasure_files_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') IS TRUE THEN RETURN NEW; END IF;
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
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND (NEW.backend_metadata->'erasure') - 'memoryBinding' =
           (OLD.backend_metadata->'erasure') - 'memoryBinding'
       AND NOT ((OLD.backend_metadata->'erasure') ? 'memoryBinding')
       AND public.valid_erasure_memory_binding(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'memoryBinding') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND (NEW.backend_metadata->'erasure') - 'memoryDeletion' = (OLD.backend_metadata->'erasure') - 'memoryDeletion'
       AND NOT ((OLD.backend_metadata->'erasure') ? 'memoryDeletion')
       AND public.valid_erasure_memory_deletion(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'memoryDeletion') THEN RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_compute_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'substrateInventory')
       AND (NEW.backend_metadata->'erasure') - 'substrateInventory' = OLD.backend_metadata->'erasure'
       AND public.valid_erasure_substrate_inventory(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'substrateInventory') THEN RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_writer_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_bucket_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_mail_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_kms_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_secret_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_account_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'grantRelease')
       AND (NEW.backend_metadata->'erasure') - 'grantRelease'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_grant_release(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure'->'grantRelease') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,NEW.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW;
    END IF;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_erasure_runtime_grant_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_repository_grant_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'repositoryInventory')
       AND (NEW.backend_metadata->'erasure')-'repositoryInventory'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_repository_inventory(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure'->'repositoryInventory') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'repositoryRetention')
       AND (NEW.backend_metadata->'erasure')-'repositoryRetention'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_repository_retention(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure'->'repositoryRetention') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'bootstrapGrantRelease')
       AND (NEW.backend_metadata->'erasure')-'bootstrapGrantRelease'=OLD.backend_metadata->'erasure'
       AND NEW.backend_metadata->'erasure'->'bootstrapGrantRelease'=public.expected_erasure_bootstrap_release(OLD.user_id,OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure'->'bootstrapGrantRelease'->>'recoveryMember')
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_erasure_bootstrap_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    -- Owner-access erasure (949): the pod's confirmation, once, before any revocation.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'agentCryptoErase')
       AND NOT (OLD.backend_metadata->'erasure' ? 'ownerAccessErasure')
       AND (NEW.backend_metadata->'erasure')-'agentCryptoErase'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_owner_access_checkpoint(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'agentCryptoErase') IS TRUE THEN RETURN NEW; END IF;
    -- Owner-access erasure (949): one receipt, once, validated against the snapshot.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'ownerAccessErasure')
       AND (NEW.backend_metadata->'erasure')-'ownerAccessErasure'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_owner_access(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'ownerAccessErasure') IS TRUE THEN RETURN NEW; END IF;
    -- Never-hosted erasure (954): the derived receipt and the project fence, once.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_erasure_never_hosted_append(OLD.user_id,OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,
           NEW.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'personal agent erasure reserved' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$
$base_retirement_registry$;
 END IF;
END $retirement_registry_profile$;

CREATE OR REPLACE FUNCTION public.guard_byoc_authorization_attempts()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE k text; v jsonb; old_v jsonb; intent jsonb; receipt jsonb; binding jsonb; identity jsonb;
BEGIN
 IF TG_OP='DELETE' AND public.account_cloud_retirement_local_erasure_ready(OLD.user_id) IS TRUE
  AND EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals c WHERE c.user_id=OLD.user_id
   AND c.retirement_handoff->'authorizationHistory' IS NOT DISTINCT FROM OLD.authorization_attempts
   AND public.account_cloud_retirement_handoff_valid(OLD.user_id,c.retirement_handoff) IS TRUE)
 THEN RETURN OLD; END IF;
 IF TG_OP='DELETE' THEN
  IF public.personal_agent_erasure_archived(OLD.user_id,
    (SELECT backend_metadata->'erasure' FROM public.personal_agent_registry WHERE user_id=OLD.user_id),
    OLD.authorization_attempts) IS TRUE THEN RETURN OLD; END IF;
  IF OLD.authorization_attempts<>'{}'::jsonb THEN RAISE EXCEPTION 'authorization recovery retained' USING ERRCODE='42501'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.authorization_attempts<>'{}'::jsonb THEN RAISE EXCEPTION 'authorization admission required' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.user_id IS DISTINCT FROM OLD.user_id AND OLD.authorization_attempts<>'{}'::jsonb THEN RAISE EXCEPTION 'authorization owner immutable' USING ERRCODE='42501'; END IF;
 IF NEW.authorization_attempts=OLD.authorization_attempts THEN RETURN NEW; END IF;
 IF NEW.user_id IS DISTINCT FROM OLD.user_id OR jsonb_typeof(NEW.authorization_attempts) IS DISTINCT FROM 'object'
 OR NOT NEW.authorization_attempts ?& ARRAY(SELECT jsonb_object_keys(OLD.authorization_attempts)) THEN
  RAISE EXCEPTION 'authorization recovery immutable' USING ERRCODE='42501'; END IF;
 FOR k,v IN SELECT * FROM jsonb_each(NEW.authorization_attempts) LOOP
  old_v:=OLD.authorization_attempts->k;
  IF v=old_v THEN CONTINUE; END IF;
  intent:=v->'intent';
  IF old_v IS NULL THEN
   IF k IS DISTINCT FROM OLD.job_id OR OLD.status IS DISTINCT FROM 'running'
   OR v - 'intent'<>'{}'::jsonb OR jsonb_typeof(intent) IS DISTINCT FROM 'object'
   OR intent - ARRAY['ownerId','jobId','project','bootstrapEmail','callerEmail']<>'{}'::jsonb
   OR intent->>'ownerId' IS DISTINCT FROM OLD.user_id OR intent->>'jobId' IS DISTINCT FROM k
   OR intent->>'project' IS DISTINCT FROM OLD.project_id
   OR (intent->>'bootstrapEmail' ~ ('^[a-z][a-z0-9-]{4,28}[a-z0-9]@'||OLD.project_id||'\.iam\.gserviceaccount\.com$')) IS DISTINCT FROM true
   OR (intent->>'callerEmail' ~ '^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.gserviceaccount\.com$') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'authorization intent invalid' USING ERRCODE='42501'; END IF;
   PERFORM public.assert_project_grant_admission(OLD.project_id);
  ELSE
   receipt:=v->'receipt'; binding:=receipt->'bindingObservation'; identity:=receipt->'bootstrapIdentity';
   IF old_v ? 'receipt' OR v - 'receipt' IS DISTINCT FROM old_v
   OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' OR receipt - ARRAY['bindingObservation','bootstrapIdentity']<>'{}'::jsonb
   OR jsonb_typeof(binding) IS DISTINCT FROM 'object' OR jsonb_typeof(identity) IS DISTINCT FROM 'object'
   OR identity->>'email' IS DISTINCT FROM intent->>'bootstrapEmail'
   OR identity->>'projectId' IS DISTINCT FROM intent->>'project'
   OR identity->>'name' IS DISTINCT FROM 'projects/'||(intent->>'project')||'/serviceAccounts/'||(intent->>'bootstrapEmail')
   OR (identity->>'uniqueId' ~ '^[0-9]{10,30}$') IS DISTINCT FROM true
   OR identity - ARRAY['name','projectId','email','uniqueId']<>'{}'::jsonb
   OR binding->>'step' IS DISTINCT FROM 'authorize_bootstrap_impersonation'
   OR binding->>'role' IS DISTINCT FROM 'roles/iam.serviceAccountTokenCreator'
   OR binding->>'member' IS DISTINCT FROM 'serviceAccount:'||(intent->>'callerEmail')
   OR binding->>'policyResource' IS DISTINCT FROM 'https://iam.googleapis.com/v1/projects/'||(intent->>'project')||'/serviceAccounts/'||(intent->>'bootstrapEmail')||':getIamPolicy'
   OR (binding->>'disposition' IN ('added','already_present')) IS DISTINCT FROM true
   OR coalesce(length(binding->>'beforeEtag'),0) NOT BETWEEN 1 AND 512
   OR coalesce(length(binding->>'afterEtag'),0) NOT BETWEEN 1 AND 512
   OR binding - ARRAY['step','policyResource','role','member','disposition','beforeEtag','afterEtag']<>'{}'::jsonb THEN
    RAISE EXCEPTION 'authorization receipt invalid' USING ERRCODE='42501'; END IF;
  END IF;
 END LOOP;
 RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.reject_retired_account_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE identity_column text; previous_owner text;
BEGIN
 IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
  RAISE EXCEPTION 'account generation guard requires read committed isolation' USING ERRCODE='25001';
 END IF;
 -- Exact validated journal transitions remain possible after retirement.
 IF TG_TABLE_SCHEMA='public' AND TG_TABLE_NAME='personal_agent_cloud_removals'
  AND public.account_cloud_retirement_transition_valid(to_jsonb(OLD),to_jsonb(NEW)) IS TRUE
 THEN RETURN NEW; END IF;
 FOREACH identity_column IN ARRAY TG_ARGV LOOP

  EXECUTE format('SELECT ($1).%I::text',identity_column) INTO previous_owner USING OLD;
  IF previous_owner IS NOT NULL AND EXISTS(SELECT 1 FROM public.account_deletion_tombstones
   WHERE user_id_hash='sha256:'||encode(sha256(convert_to(previous_owner,'UTF8')),'hex')
    AND cleanup_intent_kind='full_account' AND erasure_phase='erased') THEN
   RAISE EXCEPTION 'account generation is retired' USING ERRCODE='23514',
    CONSTRAINT='account_retired_generation_update_guard';
  END IF;
 END LOOP;
 RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_personal_agent_cloud_removal()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE owner_id text; agent public.personal_agent_registry%ROWTYPE; r jsonb; review jsonb; history jsonb;
BEGIN
 -- A handoff transfers custody, never fabricates physical absence.
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'cloud retirement requires read committed isolation' USING ERRCODE='25001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(CASE WHEN TG_OP='DELETE' THEN OLD.user_id ELSE NEW.user_id END,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(CASE WHEN TG_OP='DELETE' THEN OLD.user_id ELSE NEW.user_id END,198));
 IF TG_OP='UPDATE' AND NEW.retirement_handoff IS DISTINCT FROM OLD.retirement_handoff THEN
  IF OLD.retirement_handoff IS NOT NULL OR OLD.completed_at IS NOT NULL
   OR to_jsonb(NEW)-'retirement_handoff' IS DISTINCT FROM to_jsonb(OLD)-'retirement_handoff'
   OR public.account_cloud_retirement_handoff_valid(OLD.user_id,NEW.retirement_handoff) IS NOT TRUE
   OR public.account_cloud_retirement_ready(OLD.user_id,OLD.attempt_id) IS NOT TRUE
   OR NEW.retirement_handoff->'reservation' IS DISTINCT FROM
    (SELECT backend_metadata->'erasure' FROM public.personal_agent_registry WHERE user_id=OLD.user_id)
   OR NEW.retirement_handoff->'authorizationHistory' IS DISTINCT FROM coalesce(
    (SELECT authorization_attempts FROM public.byoc_setup_jobs WHERE user_id=OLD.user_id),'{}'::jsonb)
   OR (NEW.retirement_handoff->>'approvedAt')::timestamptz<clock_timestamp()-interval '10 minutes'
   OR (NEW.retirement_handoff->>'approvedAt')::timestamptz>clock_timestamp()
  THEN RAISE EXCEPTION 'Cloud retirement handoff is unqualified' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' AND OLD.retirement_handoff IS NOT NULL THEN
  IF public.account_cloud_retirement_transition_valid(to_jsonb(OLD),to_jsonb(NEW)) IS NOT TRUE THEN
   RAISE EXCEPTION 'Retired cloud continuation is unqualified' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' AND OLD.retirement_handoff IS NOT NULL THEN
  RAISE EXCEPTION 'Deferred cloud cleanup evidence retained' USING ERRCODE='42501';
 END IF;
 owner_id:=CASE WHEN TG_OP='DELETE' THEN OLD.user_id ELSE NEW.user_id END;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 -- Full account erasure explicitly removes these records in its own transaction.
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM public.account_deletion_tombstones WHERE cleanup_intent_kind='full_account'
   AND user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex')) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'cloud removal evidence retained' USING ERRCODE='42501';
 END IF;
 IF EXISTS(SELECT 1 FROM public.account_deletion_tombstones
  WHERE user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex')) THEN
  RAISE EXCEPTION 'cloud removal owner deleted' USING ERRCODE='42501'; END IF;
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 r:=agent.backend_metadata->'erasure';
 IF NOT FOUND OR agent.status IS DISTINCT FROM 'suspended' OR jsonb_typeof(r) IS DISTINCT FROM 'object'
 OR NEW.attempt_id IS DISTINCT FROM r->>'attemptId' OR r->>'ownerId' IS DISTINCT FROM owner_id
 OR NEW.placement_epoch IS DISTINCT FROM agent.placement_epoch
 OR NEW.snapshot_sha256 IS DISTINCT FROM encode(sha256(convert_to((r->'registrySnapshot')::text,'UTF8')),'hex') THEN
  RAISE EXCEPTION 'cloud removal placement changed' USING ERRCODE='42501'; END IF;
 IF TG_OP='INSERT' AND NEW.recovery IS NOT NULL THEN
  RAISE EXCEPTION 'legacy recovery requires an existing removal' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND NEW.recovery IS DISTINCT FROM OLD.recovery THEN
  IF OLD.completed_at IS NOT NULL OR OLD.cancelled_at IS NOT NULL
  OR to_jsonb(NEW)-'recovery' IS DISTINCT FROM to_jsonb(OLD)-'recovery'
  OR public.legacy_cloud_removal_append_valid(r,OLD.recovery,NEW.recovery) IS NOT TRUE THEN
   RAISE EXCEPTION 'legacy recovery append refused' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' AND OLD.cancelled_at IS NOT NULL THEN
  RAISE EXCEPTION 'cancelled cloud removal immutable' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND NEW.cancelled_at IS NOT NULL THEN
  IF to_jsonb(NEW)-'cancelled_at' IS DISTINCT FROM to_jsonb(OLD)-'cancelled_at'
  OR public.cloud_removal_cancel_ready(owner_id,NEW.attempt_id) IS NOT TRUE THEN
   RAISE EXCEPTION 'cloud removal cannot cancel' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.approved_digest IS NOT NULL OR NEW.archive IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.execution_started_at IS NOT NULL OR NEW.execution_digest IS NOT NULL THEN
   RAISE EXCEPTION 'cloud removal approval required' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.completed_at IS NOT NULL OR to_jsonb(NEW)-ARRAY['approved_digest','approved_at','completed_at','archive','released_identity','execution_started_at','execution_digest']
  IS DISTINCT FROM to_jsonb(OLD)-ARRAY['approved_digest','approved_at','completed_at','archive','released_identity','execution_started_at','execution_digest'] THEN
  RAISE EXCEPTION 'cloud removal evidence immutable' USING ERRCODE='42501'; END IF;
 IF OLD.execution_started_at IS NOT NULL AND (NEW.execution_started_at IS DISTINCT FROM OLD.execution_started_at
  OR NEW.execution_digest IS DISTINCT FROM OLD.execution_digest) THEN
  RAISE EXCEPTION 'cloud removal dispatch immutable' USING ERRCODE='42501'; END IF;
 IF NEW.execution_started_at IS NOT NULL AND (NEW.execution_digest IS DISTINCT FROM NEW.approved_digest
  OR (OLD.execution_started_at IS NULL AND public.personal_agent_cloud_removal_execute_ready(owner_id,NEW.attempt_id) IS NOT TRUE)) THEN
  RAISE EXCEPTION 'cloud removal dispatch not admitted' USING ERRCODE='42501'; END IF;
 review:=public.personal_agent_cloud_removal_review(r);
 IF NEW.approved_digest IS NULL OR NEW.approved_digest IS DISTINCT FROM encode(sha256(convert_to(review::text,'UTF8')),'hex')
 OR (NEW.archive IS NOT NULL AND (NEW.approved_digest IS DISTINCT FROM OLD.approved_digest
  OR NEW.approved_at IS DISTINCT FROM OLD.approved_at)) THEN
  RAISE EXCEPTION 'cloud removal approval changed' USING ERRCODE='42501'; END IF;
 IF NEW.archive IS NOT NULL THEN
  SELECT authorization_attempts INTO history FROM public.byoc_setup_jobs WHERE user_id=owner_id;
  IF public.legacy_cloud_removal_complete(owner_id,NEW.attempt_id) IS TRUE THEN
   IF NEW.archive IS DISTINCT FROM public.legacy_cloud_removal_archive(r,history,OLD.recovery)
    OR NEW.released_identity IS DISTINCT FROM public.personal_agent_cloud_removal_identity(to_jsonb(agent),NEW.completed_at,NEW.attempt_id) THEN
    RAISE EXCEPTION 'legacy recovery completion unconfirmed' USING ERRCODE='42501'; END IF;
   RETURN NEW;
  END IF;
  IF public.personal_agent_erasure_complete(owner_id) IS NOT TRUE
  OR NEW.archive IS DISTINCT FROM public.personal_agent_erasure_archive(r,history)
  OR NEW.released_identity IS DISTINCT FROM public.personal_agent_cloud_removal_identity(to_jsonb(agent),NEW.completed_at,NEW.attempt_id) THEN
   RAISE EXCEPTION 'cloud removal completion unconfirmed' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.retain_legacy_cloud_removal(owner_id text, attempt text, expected_digest text, plan jsonb, event jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE op public.personal_agent_cloud_removals%ROWTYPE; agent public.personal_agent_registry%ROWTYPE; candidate jsonb; digest text; r jsonb; deferred boolean;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 SELECT * INTO op FROM public.personal_agent_cloud_removals WHERE user_id=owner_id AND attempt_id=attempt FOR UPDATE;
 deferred:=public.account_cloud_retirement_handoff_valid(owner_id,op.retirement_handoff) IS TRUE;
 r:=public.account_cloud_retirement_reservation(owner_id,attempt);
 IF op IS NULL OR op.completed_at IS NOT NULL OR op.cancelled_at IS NOT NULL OR (NOT deferred AND agent.status IS DISTINCT FROM 'suspended')
 OR op.approved_digest IS NULL OR op.execution_started_at IS NULL
 OR r->>'attemptId' IS DISTINCT FROM attempt
 OR (NOT deferred AND EXISTS(SELECT 1 FROM public.account_deletion_tombstones WHERE user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex'))) THEN RETURN NULL; END IF;
 IF op.recovery IS NULL THEN
  IF event IS NOT NULL OR expected_digest IS DISTINCT FROM op.snapshot_sha256 THEN RETURN NULL; END IF;
  candidate:=jsonb_build_object('version',1,'plan',plan,'planSha256',encode(sha256(convert_to(plan::text,'UTF8')),'hex'),'events','[]'::jsonb);
 ELSE
  digest:=encode(sha256(convert_to(op.recovery::text,'UTF8')),'hex');
  IF expected_digest IS DISTINCT FROM digest OR plan IS DISTINCT FROM op.recovery->'plan' OR event IS NULL THEN RETURN NULL; END IF;
  event:=event||jsonb_build_object('sequence',jsonb_array_length(op.recovery->'events'),'recordedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  candidate:=jsonb_set(op.recovery,'{events}',op.recovery->'events'||jsonb_build_array(event));
 END IF;
 IF public.legacy_cloud_removal_append_valid(r,op.recovery,candidate) IS NOT TRUE THEN RETURN NULL; END IF;
 IF NOT deferred AND event IS NOT NULL AND event->>'stage' IN ('intent','writer_intent','provider_dispatch') AND NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(op.recovery->'events') e WHERE e->>'stage'='approval'
   AND (e->>'recordedAt')::timestamptz>clock_timestamp()-interval '10 minutes') THEN RETURN NULL; END IF;
 UPDATE public.personal_agent_cloud_removals SET recovery=candidate WHERE user_id=owner_id AND attempt_id=attempt;
 RETURN candidate;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.legacy_cloud_removal_complete(owner_id text, attempt text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE op public.personal_agent_cloud_removals%ROWTYPE; agent public.personal_agent_registry%ROWTYPE; item jsonb; latest jsonb; r jsonb; deferred boolean;
BEGIN
 SELECT * INTO op FROM public.personal_agent_cloud_removals WHERE user_id=owner_id AND attempt_id=attempt;
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id;
 deferred:=public.account_cloud_retirement_handoff_valid(owner_id,op.retirement_handoff) IS TRUE;
 r:=public.account_cloud_retirement_reservation(owner_id,attempt);
 IF op.recovery IS NULL OR op.completed_at IS NOT NULL OR op.cancelled_at IS NOT NULL OR (NOT deferred AND agent.status IS DISTINCT FROM 'suspended')
 OR r->>'attemptId' IS DISTINCT FROM attempt
 OR public.legacy_cloud_removal_plan_valid(r,op.recovery->'plan') IS NOT TRUE
 OR EXISTS(SELECT 1 FROM public.personal_agent_standby_placements WHERE user_id=owner_id)
 OR EXISTS(SELECT 1 FROM public.pod_migration_jobs WHERE user_id=owner_id)
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(op.recovery->'events') e WHERE e->>'stage'='approval') THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(op.recovery->'events') dispatched WHERE dispatched->>'stage'='provider_dispatch'
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(op.recovery->'events') ack WHERE ack->>'stage'='provider_ack'
   AND ack->'receipt'->>'requestId'=dispatched->'receipt'->>'requestId')) THEN RETURN false; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(op.recovery->'plan'->'resources') LOOP
  SELECT value INTO latest FROM jsonb_array_elements(op.recovery->'events') WITH ORDINALITY e(value,ord)
   WHERE value->>'resource'=(item->>'type')||':'||(item->>'id') AND value->>'stage'='observation' ORDER BY ord DESC LIMIT 1;
  IF latest IS NULL OR latest->'receipt'->>'status' NOT IN ('observed_absent','deleted','retained_shared') THEN RETURN false; END IF;
 END LOOP;
 SELECT value INTO latest FROM jsonb_array_elements(op.recovery->'events') WITH ORDINALITY e(value,ord)
  WHERE value->>'stage' IN ('executor_started','executor_exit') ORDER BY ord DESC LIMIT 1;
 RETURN coalesce(latest->>'stage'='executor_exit' AND latest->'receipt'->>'outcome'='returned'
  AND latest->'receipt'->'supervisorVerified'='true'::jsonb,false);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.finalize_personal_agent_cloud_removal(owner_id text, attempt text, expected_digest text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE agent public.personal_agent_registry%ROWTYPE; op public.personal_agent_cloud_removals%ROWTYPE;
 r jsonb; history jsonb; removed_at timestamptz; replacement public.personal_agent_registry%ROWTYPE;
BEGIN
 -- Retirement finalization closes only the frozen cleanup; never recreates identity.
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO op FROM public.personal_agent_cloud_removals WHERE user_id=owner_id AND attempt_id=attempt FOR UPDATE;
 IF op.retirement_handoff IS NOT NULL THEN
  IF public.account_cloud_retirement_handoff_valid(owner_id,op.retirement_handoff) IS NOT TRUE
   OR expected_digest IS DISTINCT FROM op.recovery->>'planSha256' THEN RETURN false; END IF;
  IF op.completed_at IS NOT NULL THEN RETURN true; END IF;
  IF public.legacy_cloud_removal_complete(owner_id,attempt) IS NOT TRUE THEN RETURN false; END IF;
  UPDATE public.personal_agent_cloud_removals SET completed_at=clock_timestamp(),
   archive=((public.legacy_cloud_removal_archive(op.retirement_handoff->'reservation',
    op.retirement_handoff->'authorizationHistory',op.recovery)-'legacyRecovery')||jsonb_build_object('legacyRecoverySha256',encode(sha256(convert_to((op.recovery)::text,'UTF8')),'hex'))),released_identity=NULL
   WHERE user_id=owner_id AND attempt_id=attempt;
  RETURN true;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 IF public.personal_agent_cloud_removal_ready() IS NOT TRUE THEN RETURN false; END IF;
 SELECT * INTO op FROM public.personal_agent_cloud_removals WHERE user_id=owner_id AND attempt_id=attempt FOR UPDATE;
 IF NOT FOUND OR expected_digest IS NULL THEN RETURN false; END IF;
 -- A lost response is recoverable only while its exact released identity is
 -- still current. A replacement never becomes "unplaced" through an old replay.
 IF op.completed_at IS NOT NULL THEN
  RETURN (expected_digest=op.approved_digest OR expected_digest=op.recovery->>'planSha256')
   AND public.personal_agent_cloud_removal_replay_current(owner_id,attempt);
 END IF;
 IF expected_digest IS DISTINCT FROM coalesce(op.recovery->>'planSha256',op.approved_digest) THEN RETURN false; END IF;
 IF (public.legacy_cloud_removal_complete(owner_id,attempt) IS NOT TRUE
 AND public.personal_agent_erasure_complete(owner_id) IS NOT TRUE)
 OR EXISTS(SELECT 1 FROM public.personal_agent_standby_placements WHERE user_id=owner_id) THEN RETURN false; END IF;
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 r:=agent.backend_metadata->'erasure';
 IF r->>'attemptId' IS DISTINCT FROM attempt THEN RETURN false; END IF;
 SELECT authorization_attempts INTO history FROM public.byoc_setup_jobs WHERE user_id=owner_id FOR UPDATE;
 removed_at:=clock_timestamp();
 UPDATE public.personal_agent_cloud_removals SET completed_at=removed_at,
  archive=CASE WHEN op.recovery IS NULL THEN public.personal_agent_erasure_archive(r,history) ELSE public.legacy_cloud_removal_archive(r,history,op.recovery) END,
  released_identity=public.personal_agent_cloud_removal_identity(to_jsonb(agent),removed_at,attempt)
 WHERE user_id=owner_id AND attempt_id=attempt RETURNING * INTO op;
 IF public.personal_agent_erasure_archived(owner_id,r,history) IS NOT TRUE THEN
  RAISE EXCEPTION 'cloud removal archive unconfirmed' USING ERRCODE='42501'; END IF;
 DELETE FROM public.pod_lifecycle_events WHERE user_id=owner_id;
 DELETE FROM public.byoc_setup_jobs WHERE user_id=owner_id;
 DELETE FROM public.personal_agent_registry WHERE user_id=owner_id;
 replacement:=jsonb_populate_record(NULL::public.personal_agent_registry,op.released_identity);
 INSERT INTO public.personal_agent_registry SELECT replacement.*;
 RETURN true;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.legacy_cloud_removal_event_valid(recovery jsonb, event jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE p jsonb:=recovery->'plan'; item jsonb; prior jsonb; receipt jsonb:=event->'receipt'; key text:=event->>'resource'; stage text:=event->>'stage'; identity_hash text; active_source text; writer_key text; compute_key text;
BEGIN
 SELECT e->'receipt'->>'sourceRevision' INTO active_source
 FROM jsonb_array_elements(recovery->'events') WITH ORDINALITY x(e,ord)
 WHERE e->>'stage'='operator_source' ORDER BY ord DESC LIMIT 1;
 active_source:=coalesce(active_source,p->>'sourceRevision');
 writer_key:='service_account:'||(p->'runtime'->'principal'->>'email');
 compute_key:='cloud_run_service:'||regexp_replace(p->'runtime'->>'serviceName','^.*/','');
 IF jsonb_typeof(event) IS DISTINCT FROM 'object' OR event-ARRAY['sequence','resource','stage','receipt','recordedAt','executionId']<>'{}'::jsonb
 OR event->'sequence' IS DISTINCT FROM to_jsonb(jsonb_array_length(recovery->'events'))
 OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' OR octet_length(receipt::text)>65536
 OR coalesce(stage,'') NOT IN ('approval','operator_source','executor_started','native_writer_disabled_after_compute','writer_intent','writer_acknowledgement','writer_disabled','intent','acknowledgement','provider_dispatch','provider_ack','checkpoint','observation','attention','executor_exit')
 OR coalesce(event->>'recordedAt','')='' THEN RETURN false; END IF;
 IF stage='approval' THEN
  RETURN key='$approval' AND receipt-ARRAY['planSha256','ownerId','confirmation'] = '{}'::jsonb
   AND receipt->>'planSha256'=recovery->>'planSha256' AND receipt->>'ownerId'=p->>'ownerId'
   AND receipt->>'confirmation'=p->'project'->>'projectId';
 END IF;
 -- Source adoption is restricted to the reconciled, pre-data IAM phase. A
 -- missing session, timeout or acknowledgement alone cannot qualify an exit.
 IF stage='operator_source' AND EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals c
  WHERE c.user_id=p->>'ownerId' AND c.attempt_id=p->>'attemptId' AND c.recovery=legacy_cloud_removal_event_valid.recovery
   AND public.account_cloud_retirement_handoff_valid(c.user_id,c.retirement_handoff) IS TRUE
   AND public.account_cloud_retirement_quiescent(c.user_id,c.attempt_id) IS TRUE) THEN
  RETURN key='$executor' AND event->>'executionId' IS NULL
   AND receipt-ARRAY['previousSourceRevision','sourceRevision','planSha256','actor']='{}'::jsonb
   AND receipt->>'previousSourceRevision'=active_source
   AND coalesce(receipt->>'sourceRevision','') ~ '^[0-9a-f]{40}$'
   AND receipt->>'sourceRevision'<>active_source
   AND receipt->>'planSha256'=recovery->>'planSha256' AND receipt->>'actor'=p->>'actor';
 END IF;
 IF stage='operator_source' THEN
  RETURN key='$executor' AND event->>'executionId' IS NULL
   AND receipt-ARRAY['previousSourceRevision','sourceRevision','planSha256','actor']='{}'::jsonb
   AND receipt->>'previousSourceRevision'=active_source
   AND coalesce(receipt->>'sourceRevision','') ~ '^[0-9a-f]{40}$'
   AND receipt->>'sourceRevision'<>active_source
   AND receipt->>'planSha256'=recovery->>'planSha256' AND receipt->>'actor'=p->>'actor'
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'stage'='approval'
    AND e->'receipt'->>'planSha256'=recovery->>'planSha256'
    AND (e->>'recordedAt')::timestamptz>clock_timestamp()-interval '10 minutes')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'stage'='intent')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') started WHERE started->>'stage'='executor_started'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') exited WHERE exited->>'stage'='executor_exit'
     AND exited->'receipt'->>'executionId'=started->'receipt'->>'executionId'))
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') dispatch WHERE dispatch->>'stage'='provider_dispatch'
    AND (dispatch->>'resource'<>writer_key OR NOT EXISTS(
     SELECT 1 FROM jsonb_array_elements(recovery->'events') ack WHERE ack->>'stage'='provider_ack'
      AND ack->'receipt'->>'requestId'=dispatch->'receipt'->>'requestId'
      AND ack->'receipt'->>'targetSha256'=dispatch->'receipt'->>'targetSha256'
      AND coalesce(ack->'receipt'->>'operationName','')=''
      AND (ack->'receipt'->>'httpStatus' ~ '^2[0-9]{2}$' OR ack->'receipt'->>'httpStatus' IN ('401','403','412','429')))))
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') grant_event
    WHERE grant_event->>'stage'='checkpoint' AND grant_event->'receipt'->>'stage'='temporaryGrant'
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') removed
      WHERE removed->>'resource'=grant_event->>'resource' AND removed->>'stage'='checkpoint'
       AND removed->'receipt'->>'stage'='temporaryGrantRemoved'
       AND (removed->>'sequence')::int>(grant_event->>'sequence')::int));
 END IF;
 IF stage='executor_started' THEN
  IF key<>'$executor' OR receipt-ARRAY['executionId','sourceRevision','databasePid','databaseStartedAt']<>'{}'::jsonb
  OR coalesce(receipt->>'executionId','') !~ '^[0-9a-f]{32}$'
  OR receipt->>'sourceRevision' IS DISTINCT FROM active_source
  OR receipt->'databasePid' IS DISTINCT FROM to_jsonb(pg_backend_pid()) THEN RETURN false; END IF;
  RETURN receipt->>'databaseStartedAt'=(SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid())
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') started WHERE started->>'stage'='executor_started'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') exited WHERE exited->>'stage'='executor_exit'
     AND exited->'receipt'->>'executionId'=started->'receipt'->>'executionId'));
 END IF;
 IF stage NOT IN ('approval','executor_exit') AND NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(recovery->'events') started
  WHERE started->>'stage'='executor_started' AND started->'receipt'->>'executionId'=event->>'executionId'
   AND started->'receipt'->>'sourceRevision'=active_source
   AND started->'receipt'->'databasePid'=to_jsonb(pg_backend_pid())
   AND started->'receipt'->>'databaseStartedAt'=(SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid())
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') exited WHERE exited->>'stage'='executor_exit'
    AND exited->'receipt'->>'executionId'=event->>'executionId')) THEN RETURN false; END IF;
 IF stage='attention' THEN
  RETURN coalesce(receipt->>'code','') ~ '^[A-Z][A-Z0-9_]{0,63}$'
   AND receipt-ARRAY['code','uncertain'] = '{}'::jsonb AND jsonb_typeof(receipt->'uncertain')='boolean';
 END IF;
 IF stage='executor_exit' THEN
  RETURN key='$executor' AND receipt-ARRAY['executionId','sourceRevision','outcome','supervisorVerified','databasePid','databaseStartedAt','processExitCode'] = '{}'::jsonb
   AND coalesce(receipt->>'executionId','') ~ '^[0-9a-f]{32}$'
   AND coalesce(receipt->>'sourceRevision','') ~ '^[0-9a-f]{40}$' AND receipt->>'outcome' IN ('returned','failed','cancelled')
   AND receipt->'supervisorVerified'='true'::jsonb
   AND jsonb_typeof(receipt->'processExitCode')='number'
   AND (receipt->>'outcome'='returned')=(receipt->'processExitCode'='0'::jsonb)
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') started WHERE started->>'stage'='executor_started'
    AND started->'receipt'->>'executionId'=receipt->>'executionId'
    AND started->'receipt'->>'sourceRevision'=receipt->>'sourceRevision'
    AND started->'receipt'->'databasePid'=receipt->'databasePid'
    AND started->'receipt'->'databaseStartedAt'=receipt->'databaseStartedAt')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'stage'='executor_exit'
    AND e->'receipt'->>'executionId'=receipt->>'executionId')
   AND NOT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE to_jsonb(a.pid)=receipt->'databasePid' AND a.backend_start::text=receipt->>'databaseStartedAt');
 END IF;
 SELECT value INTO item FROM jsonb_array_elements(p->'resources') WHERE (value->>'type')||':'||(value->>'id')=key;
 IF item IS NULL THEN RETURN false; END IF;
 identity_hash:=encode(sha256(convert_to((item->'identity')::text,'UTF8')),'hex');
 IF receipt->>'identitySha256' IS DISTINCT FROM identity_hash THEN RETURN false; END IF;
 IF stage='provider_dispatch' THEN
  RETURN item->>'authority'='owner_reviewed'
   AND receipt-ARRAY['identitySha256','requestId','targetSha256','method','purpose']='{}'::jsonb
   AND coalesce(receipt->>'purpose','mutation') IN ('mutation','credential_probe')
   AND (receipt->>'purpose' IS DISTINCT FROM 'credential_probe' OR item->>'type'='service_account' AND receipt->>'method'='POST')
   AND coalesce(receipt->>'requestId','') ~ '^[0-9a-f]{32}$'
   AND coalesce(receipt->>'targetSha256','') ~ '^[0-9a-f]{64}$'
   AND receipt->>'method' IN ('DELETE','POST','PATCH','PUT')
   AND (item->>'type'<>'reasoning_engine' OR EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e
    WHERE e->>'resource'=key AND e->>'stage'='checkpoint' AND e->'receipt'->>'stage'='memoryBinding'
     AND e->'receipt'->'value' IS NOT DISTINCT FROM p->'memory'))
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key AND e->>'stage' IN ('intent','writer_intent'))
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key AND e->>'stage'='provider_dispatch'
    AND e->'receipt'->>'targetSha256'=receipt->>'targetSha256'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') ack WHERE ack->>'stage'='provider_ack'
      AND ack->'receipt'->>'requestId'=e->'receipt'->>'requestId'
      AND (ack->'receipt'->>'httpStatus' IN ('401','403','412','429') OR receipt->>'purpose'='credential_probe')));
 END IF;
 IF stage='provider_ack' THEN
  RETURN receipt-ARRAY['identitySha256','requestId','targetSha256','httpStatus','bodySha256','operationName']='{}'::jsonb
   AND coalesce(receipt->>'httpStatus','') ~ '^[1-5][0-9]{2}$'
   AND coalesce(receipt->>'bodySha256','') ~ '^[0-9a-f]{64}$'
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key AND e->>'stage'='provider_dispatch'
    AND e->'receipt'->>'requestId'=receipt->>'requestId' AND e->'receipt'->>'targetSha256'=receipt->>'targetSha256')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'stage'='provider_ack' AND e->'receipt'->>'requestId'=receipt->>'requestId');
 END IF;
 IF stage='checkpoint' AND receipt->>'stage'='disabledWriterComputeAdmission' THEN
  RETURN key=writer_key AND receipt-ARRAY['identitySha256','stage','value']='{}'::jsonb
   AND (receipt->'value')-ARRAY['runtimeIdentity','status','nativeReadbackSha256']='{}'::jsonb
   AND receipt->'value'->'runtimeIdentity' IS NOT DISTINCT FROM p->'runtime'->'principal'
   AND receipt->'value'->>'status'='disabled'
   AND coalesce(receipt->'value'->>'nativeReadbackSha256','') ~ '^[0-9a-f]{64}$'
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key
    AND e->>'stage'='writer_acknowledgement' AND e->'receipt'->'httpStatus'='200'::jsonb)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') dispatch WHERE dispatch->>'stage'='provider_dispatch'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') ack WHERE ack->>'stage'='provider_ack'
     AND ack->'receipt'->>'requestId'=dispatch->'receipt'->>'requestId'));
 END IF;
 IF stage='native_writer_disabled_after_compute' THEN
  RETURN key=writer_key AND receipt-ARRAY['identitySha256','status','runtimeIdentity','bootstrapIdentity','computeReceiptSha256']='{}'::jsonb
   AND receipt->>'status'='disabled'
   AND receipt->'runtimeIdentity' IS NOT DISTINCT FROM p->'runtime'->'principal'
   AND receipt->'bootstrapIdentity' IS NOT DISTINCT FROM (SELECT r->'identity'->'account'
    FROM jsonb_array_elements(p->'resources') r WHERE r->>'type'='bootstrap_access')
   AND receipt->'runtimeIdentity'->>'uniqueId'<>receipt->'bootstrapIdentity'->>'uniqueId'
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key
    AND e->>'stage'='checkpoint' AND e->'receipt'->>'stage'='disabledWriterComputeAdmission'
    AND e->>'executionId'=event->>'executionId')
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=compute_key
    AND e->>'stage'='observation' AND e->'receipt'->>'status'='deleted'
    AND e->'receipt'->'operationDone'='true'::jsonb
    AND e->'receipt'->'coverage'->'pendingOperations'='0'::jsonb
    AND e->'receipt'->'coverage'->'remainingRevisions'='0'::jsonb
    AND receipt->>'computeReceiptSha256'=encode(sha256(convert_to((e->'receipt')::text,'UTF8')),'hex'));
 END IF;
 IF stage='checkpoint' THEN
  RETURN item->>'type' IN ('gcs_bucket','kms_key','service_account','project_iam_policy','reasoning_engine')
   AND receipt-ARRAY['identitySha256','stage','value']='{}'::jsonb
   AND receipt->>'stage' IN ('bucketAdmission','bucketAcknowledgement','bucketDeletion','memoryBinding','inventory','admission','acknowledgement','destruction','completion','temporaryGrant','temporaryGrantRemoved')
   AND jsonb_typeof(receipt->'value')='object'
   AND (receipt->>'stage'<>'memoryBinding' OR (item->>'type'='reasoning_engine' AND receipt->'value' IS NOT DISTINCT FROM p->'memory'))
   AND (receipt->>'stage' NOT IN ('bucketAdmission','bucketAcknowledgement','bucketDeletion') OR
    (item->>'type'='gcs_bucket' AND receipt->'value'->'bucketIdentity' IS NOT DISTINCT FROM item->'identity'
     AND receipt->'value'->>'status'=CASE receipt->>'stage' WHEN 'bucketAdmission' THEN 'admitted' WHEN 'bucketAcknowledgement' THEN 'acknowledged' ELSE 'deleted' END
     AND coalesce(receipt->'value'->>'metageneration','') ~ '^[1-9][0-9]*$'))
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key AND e->>'stage' IN ('intent','writer_intent'));
 END IF;
 IF stage IN ('intent','writer_intent') THEN
  IF item->>'authority'<>'owner_reviewed' OR coalesce(receipt->>'requestId','') !~ '^[0-9a-f]{32}$'
  OR receipt-ARRAY['requestId','identitySha256','method']<>'{}'::jsonb
  OR receipt->>'method' NOT IN ('DELETE','POST','PATCH')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key AND e->>'stage'=stage) THEN RETURN false; END IF;
  IF stage='writer_intent' THEN RETURN item->>'type'='service_account' AND item->>'id'=p->'runtime'->'principal'->>'email'; END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'stage' IN ('writer_disabled','native_writer_disabled_after_compute'))
  AND NOT (item->>'type'='cloud_run_service' AND EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e
   WHERE e->>'resource'=writer_key AND e->>'stage'='checkpoint' AND e->'receipt'->>'stage'='disabledWriterComputeAdmission'
    AND e->>'executionId'=event->>'executionId')) THEN RETURN false; END IF;
  IF item->>'type'<>'cloud_run_service' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e
    WHERE e->>'resource'='cloud_run_service:'||regexp_replace(p->'runtime'->>'serviceName','^.*/','') AND e->>'stage'='observation' AND e->'receipt'->>'status'='deleted') THEN RETURN false; END IF;
  IF item->>'type' NOT IN ('cloud_run_service','reasoning_engine') AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e
    WHERE e->>'resource'='reasoning_engine:'||(p->'memory'->>'engineName') AND e->>'stage'='observation' AND e->'receipt'->>'status' IN ('deleted','observed_absent')) THEN RETURN false; END IF;
  IF item->>'type'='bootstrap_access' THEN
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'resources') candidate WHERE candidate->>'type'<>'bootstrap_access'
    AND coalesce((SELECT e->'receipt'->>'status' FROM jsonb_array_elements(recovery->'events') WITH ORDINALITY x(e,ord)
     WHERE e->>'resource'=(candidate->>'type')||':'||(candidate->>'id') AND e->>'stage'='observation' ORDER BY ord DESC LIMIT 1),'')
     NOT IN ('deleted','observed_absent','retained_shared')) THEN RETURN false; END IF;
   RETURN public.project_grant_release_is_exclusive(p->>'ownerId',p->'project'->>'projectId') IS TRUE;
  END IF;
  IF item->>'type'='project_iam_policy' THEN
   RETURN public.project_grant_release_is_exclusive(p->>'ownerId',p->'project'->>'projectId') IS TRUE;
  END IF;
  RETURN true;
 END IF;
 SELECT value INTO prior FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key
  AND e->>'stage'=CASE WHEN stage IN ('writer_acknowledgement','writer_disabled') THEN 'writer_intent' ELSE 'intent' END;
 IF stage IN ('acknowledgement','writer_acknowledgement') THEN
  RETURN prior IS NOT NULL AND receipt-ARRAY['requestId','identitySha256','httpStatus','operationName'] = '{}'::jsonb
   AND receipt->>'requestId'=prior->'receipt'->>'requestId' AND coalesce(receipt->>'httpStatus','') ~ '^2[0-9]{2}$'
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key AND e->>'stage'=stage);
 END IF;
 IF stage='writer_disabled' THEN
  RETURN prior IS NOT NULL AND item->>'id'=p->'runtime'->'principal'->>'email'
   AND receipt-ARRAY['identitySha256','status','nativeReadbackSha256','credentialDenied'] = '{}'::jsonb
   AND receipt->>'status'='disabled' AND receipt->'credentialDenied'='true'::jsonb
   AND coalesce(receipt->>'nativeReadbackSha256','') ~ '^[0-9a-f]{64}$';
 END IF;
 IF stage='observation' THEN
  IF receipt-ARRAY['identitySha256','status','httpStatus','nativeReadbackSha256','operationName','operationDone','coverage']<>'{}'::jsonb
  OR coalesce(receipt->>'nativeReadbackSha256','') !~ '^[0-9a-f]{64}$'
  OR coalesce(receipt->>'status','') NOT IN ('observed_absent','deleted','retained_shared','waiting_for_provider') THEN RETURN false; END IF;
  IF receipt->>'status'='observed_absent' THEN RETURN item->>'type'<>'gcs_bucket' AND receipt->'httpStatus'='404'::jsonb AND prior IS NULL; END IF;
  IF receipt->>'status'='retained_shared' THEN RETURN item->>'authority'='retain_shared' AND item->>'type'='artifact_repository' AND receipt->'httpStatus'='200'::jsonb AND prior IS NULL; END IF;
  IF receipt->>'status'='waiting_for_provider' THEN RETURN prior IS NOT NULL; END IF;
  IF item->>'type' IN ('project_iam_policy','bootstrap_access') AND receipt->>'status'='deleted' THEN
   RETURN prior IS NOT NULL AND receipt->'httpStatus'='200'::jsonb
    AND receipt->'coverage'->'bindingsAbsent'='true'::jsonb;
  END IF;
  IF item->>'type'='kms_key' AND receipt->>'status'='deleted' THEN
   RETURN prior IS NOT NULL AND receipt->'httpStatus'='200'::jsonb
    AND receipt->'coverage'->'allVersionsDestroyed'='true'::jsonb
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key
     AND e->>'stage'='checkpoint' AND e->'receipt'->>'stage'='completion');
  END IF;
  IF item->>'type'='gcs_bucket' AND receipt->>'status'='deleted' AND NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key
    AND e->>'stage'='checkpoint' AND e->'receipt'->>'stage'='bucketDeletion'
    AND e->'receipt'->'value'->>'status'='deleted'
    AND e->'receipt'->'value'->'bucketIdentity' IS NOT DISTINCT FROM item->'identity') THEN RETURN false; END IF;
  IF prior IS NULL OR receipt->'httpStatus'<>'404'::jsonb THEN RETURN false; END IF;
  IF item->>'type' IN ('cloud_run_service','reasoning_engine') THEN
   IF item->>'type'='reasoning_engine' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e
    WHERE e->>'resource'=key AND e->>'stage'='checkpoint' AND e->'receipt'->>'stage'='memoryBinding'
     AND e->'receipt'->'value' IS NOT DISTINCT FROM p->'memory') THEN RETURN false; END IF;
   IF receipt->'operationDone' IS DISTINCT FROM 'true'::jsonb OR coalesce(receipt->>'operationName','')=''
   OR receipt->'coverage'->'complete' IS DISTINCT FROM 'true'::jsonb
   OR receipt->'coverage'->'pendingOperations' IS DISTINCT FROM '0'::jsonb THEN RETURN false; END IF;
   IF item->>'type'='cloud_run_service' AND receipt->'coverage'->'remainingRevisions' IS DISTINCT FROM '0'::jsonb THEN RETURN false; END IF;
  END IF;
  RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key AND e->>'stage'='acknowledgement'
   AND e->'receipt'->'operationName' IS NOT DISTINCT FROM receipt->'operationName');
 END IF;
 RETURN false;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.assert_project_grant_admission(project_id text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
 IF project_id IS NULL OR project_id='' THEN RETURN; END IF;
 IF (project_id !~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$'
     AND project_id !~ '^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/resourceGroups/[A-Za-z0-9_().-]{0,89}[A-Za-z0-9_()-]$')
 OR current_setting('transaction_isolation') <> 'read committed' THEN
  RAISE EXCEPTION 'project grant admission unavailable' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(project_id,205));
 IF EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals c
  WHERE c.completed_at IS NULL AND c.cancelled_at IS NULL AND c.retirement_handoff IS NOT NULL
   AND c.recovery->'plan'->'project'->>'projectId'=project_id) THEN
  RAISE EXCEPTION 'project reserved for retired account cleanup' USING ERRCODE='42501'; END IF;
 IF EXISTS (SELECT 1 FROM public.personal_agent_registry r WHERE r.backend_metadata->'erasure'->'grantRelease'->>'project'=project_id)
 OR EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals c WHERE c.completed_at IS NULL AND c.cancelled_at IS NULL
  AND c.recovery->'plan'->'project'->>'projectId'=project_id
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.recovery->'events') e
   WHERE e->>'resource' IN (SELECT (x->>'type')||':'||(x->>'id') FROM jsonb_array_elements(c.recovery->'plan'->'resources') x WHERE x->>'type' IN ('bootstrap_access','project_iam_policy')) AND e->>'stage'='intent')) THEN
  RAISE EXCEPTION 'project grant release reserved' USING ERRCODE='42501'; END IF;
END;
$function$
;

REVOKE ALL ON FUNCTION public.account_cloud_retirement_contract_version() FROM PUBLIC;

REVOKE ALL ON FUNCTION public.account_cloud_retirement_reservation(text,text) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.account_cloud_retirement_ready(text,text) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.account_cloud_retirement_quiescent(text,text) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.account_cloud_retirement_handoff_valid(text,jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.retain_account_cloud_retirement(text,uuid,text) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.account_cloud_retirement_retained(text) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.account_cloud_retirement_transition_valid(jsonb,jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.account_cloud_retirement_local_erasure_ready(text) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.guard_byoc_authorization_attempts() FROM PUBLIC;

REVOKE ALL ON FUNCTION public.finalize_personal_agent_cloud_removal(text,text,text) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.assert_project_grant_admission(text) FROM PUBLIC;

COMMENT ON COLUMN public.personal_agent_cloud_removals.retirement_handoff IS 'Immutable, bounded cleanup custody for a deleted account generation. It grants no account access and is not physical-erasure proof.';
COMMIT;
