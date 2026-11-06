-- Recover an exited legacy writer probe through the existing compute-first port.
-- 985 and its original plan/approval remain immutable. No credential-denial proof
-- is inferred from native disablement, executor exit or elapsed time.
BEGIN;
DO $preimage$ DECLARE observed text; BEGIN
 LOCK TABLE public.personal_agent_cloud_removals IN ACCESS EXCLUSIVE MODE;
 SELECT encode(sha256(convert_to(pg_get_functiondef('public.legacy_cloud_removal_event_valid(jsonb,jsonb)'::regprocedure),'UTF8')),'hex') INTO observed;
 IF observed NOT IN ('467cd3be25eb9920286158ba9ad286f4690b5da2a1715443f6af570d800ec67b','494ff6364b1ab6bf3abbca3bde15731a3340a311f1ad0540b8e59e49c5dcb3a4') THEN
  RAISE EXCEPTION 'Unqualified legacy removal event preimage'; END IF;
END $preimage$;
CREATE OR REPLACE FUNCTION public.legacy_cloud_removal_event_valid(recovery jsonb,event jsonb)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
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
$$;

COMMIT;
