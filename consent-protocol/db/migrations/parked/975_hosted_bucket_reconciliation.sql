-- Dev only. Reopen one failed deterministic bucket create after native absence.
-- The original failed checkpoint remains in the existing attempt's history.
BEGIN;
CREATE OR REPLACE FUNCTION public.reconcile_hosted_bucket_absence(
 p_owner text, p_attempt text, expected_checkpoint jsonb, observation jsonb
) RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE
 r public.personal_agent_registry%ROWTYPE;
 attempt jsonb; admission jsonb; prior jsonb; results jsonb; history jsonb;
 resource jsonb; replacement jsonb; prefix jsonb; n integer; gen integer;
 prior_setting text; observed_at timestamptz;
BEGIN
 IF jsonb_typeof(observation) IS DISTINCT FROM 'object'
 OR observation-ARRAY['version','actor','sourceRevision','imageDigest','projectIdentity',
      'bucketName','method','httpStatus','status','observedAt']<>'{}'::jsonb
 OR (observation ?& ARRAY['version','actor','sourceRevision','imageDigest','projectIdentity',
      'bucketName','method','httpStatus','status','observedAt']) IS NOT TRUE
 OR observation->'version' IS DISTINCT FROM '1'::jsonb
 OR observation->>'method' IS DISTINCT FROM 'GET'
 OR observation->'httpStatus' IS DISTINCT FROM '404'::jsonb
 OR observation->>'status' IS DISTINCT FROM 'observed_absent'
 OR jsonb_typeof(observation->'observedAt') IS DISTINCT FROM 'string'
 OR octet_length(observation::text)>4096
 THEN RETURN false; END IF;
 BEGIN observed_at:=(observation->>'observedAt')::timestamptz;
 EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false; END;
 IF observed_at<clock_timestamp()-interval '60 seconds'
 OR observed_at>clock_timestamp()+interval '5 seconds' THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,198));
 SELECT * INTO r FROM public.personal_agent_registry WHERE user_id=p_owner FOR UPDATE;
 IF NOT FOUND OR r.deployment_target IS DISTINCT FROM 'gcp'
 OR r.status IS DISTINCT FROM 'provisioning' OR r.backend_metadata ? 'erasure'
 THEN RETURN false; END IF;
 attempt:=r.backend_metadata->'provisionAttempt';
 admission:=attempt->'hostedAdmission';
 prior:=attempt->'evidence'->'reserved'->'hostedCheckpoint';
 IF attempt->>'ownerId' IS DISTINCT FROM p_owner
 OR attempt->>'attemptId' IS DISTINCT FROM p_attempt
 OR attempt->>'phase' IS DISTINCT FROM 'reserved'
 OR prior IS DISTINCT FROM expected_checkpoint
 OR prior->>'phase' IS DISTINCT FROM 'observed'
 OR prior->>'step' IS DISTINCT FROM 'cmek_bucket'
 OR observation->>'sourceRevision' IS DISTINCT FROM admission->>'sourceRevision'
 OR observation->>'imageDigest' IS DISTINCT FROM admission->>'imageDigest'
 OR observation->>'actor' IS DISTINCT FROM admission->'assignment'->'preparationContract'->>'operatorPrincipal'
 OR observation->'projectIdentity' IS DISTINCT FROM attempt->'evidence'->'reserved'->'projectObservation'
 OR public.hosted_pod_execution_admitted(p_owner,p_attempt,admission,
      observation->'projectIdentity','bootstrap') IS NOT TRUE
 OR attempt->'evidence'->'reserved'->'hostedPreparation'->>'phase' IS DISTINCT FROM 'observed'
 OR jsonb_array_length(attempt->'evidence'->'reserved'->'hostedPreparation'->'completed') IS DISTINCT FROM 3
 THEN RETURN false; END IF;
 results:=prior->'completed';
 IF jsonb_typeof(results) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 n:=jsonb_array_length(results);
 IF n<2 OR n>64 OR results->(n-1) IS DISTINCT FROM
      jsonb_build_object('step','cmek_bucket','status',503,'ok',false)
 OR admission->'assignment'->'bootstrapContract'->'steps'->>(n-1) IS DISTINCT FROM 'cmek_bucket'
 OR (prior->>'generation' ~ '^[1-9][0-9]{0,3}$') IS NOT TRUE
 THEN RETURN false; END IF;
 prefix:=results-(n-1);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(prefix) WITH ORDINALITY x(value,ord)
   WHERE value->'ok' IS DISTINCT FROM 'true'::jsonb
    OR value->>'step' IS DISTINCT FROM admission->'assignment'->'bootstrapContract'->'steps'->>(ord::integer-1))
 THEN RETURN false; END IF;
 IF jsonb_typeof(admission->'assignment'->'bootstrapContract'->'plan'->'resources') IS DISTINCT FROM 'array'
 THEN RETURN false; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(admission->'assignment'->'bootstrapContract'->'plan'->'resources') x
     WHERE x->>'type'='gcs_bucket') IS DISTINCT FROM 1::bigint THEN RETURN false; END IF;
 SELECT x INTO resource FROM jsonb_array_elements(admission->'assignment'->'bootstrapContract'->'plan'->'resources') x
   WHERE x->>'type'='gcs_bucket';
 IF observation->>'bucketName' IS DISTINCT FROM resource->>'id'
 OR jsonb_typeof(observation->'bucketName') IS DISTINCT FROM 'string'
 THEN RETURN false; END IF;
 history:=coalesce(attempt->'evidence'->'reserved'->'hostedCheckpointReconciliations','[]'::jsonb);
 IF jsonb_typeof(history) IS DISTINCT FROM 'array' OR jsonb_array_length(history)>=8 THEN RETURN false; END IF;
 gen:=(prior->>'generation')::integer;
 IF gen>=9999 THEN RETURN false; END IF;
 replacement:=prior || jsonb_build_object('expectedGeneration',gen,'generation',gen+1,
      'step',prefix->(n-2)->>'step','completed',prefix);
 history:=history || jsonb_build_array(jsonb_build_object('failedCheckpoint',prior,
      'observation',observation,'reconciledAt',clock_timestamp()));
 -- Lock waits cannot turn an old absence observation into fresh authority.
 IF observed_at<clock_timestamp()-interval '60 seconds'
 OR observed_at>clock_timestamp()+interval '5 seconds' THEN RETURN false; END IF;
 prior_setting:=current_setting('hussh.provision_attempt',true);
 PERFORM set_config('hussh.provision_attempt',p_attempt,true);
 attempt:=jsonb_set(attempt,'{evidence,reserved}',attempt->'evidence'->'reserved' ||
      jsonb_build_object('hostedCheckpoint',replacement,'hostedCheckpointReconciliations',history));
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,
      '{provisionAttempt}',attempt),updated_at=clock_timestamp() WHERE user_id=p_owner;
 PERFORM set_config('hussh.provision_attempt',coalesce(prior_setting,''),true);
 RETURN true;
END;
$$;

DO $bucket_reconciliation_acl$
DECLARE client_role text;
BEGIN
 REVOKE ALL ON FUNCTION public.reconcile_hosted_bucket_absence(text,text,jsonb,jsonb) FROM PUBLIC;
 FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=client_role) THEN
   EXECUTE format('REVOKE ALL ON FUNCTION public.reconcile_hosted_bucket_absence(text,text,jsonb,jsonb) FROM %I',client_role);
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  GRANT EXECUTE ON FUNCTION public.reconcile_hosted_bucket_absence(text,text,jsonb,jsonb) TO service_role;
 END IF;
END;
$bucket_reconciliation_acl$;
COMMIT;
