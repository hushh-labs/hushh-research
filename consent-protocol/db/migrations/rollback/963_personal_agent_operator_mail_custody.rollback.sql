-- Retained operator provenance requires forward recovery, never silent loss.
BEGIN;
LOCK TABLE public.personal_agent_registry IN SHARE MODE;
LOCK TABLE public.personal_agent_standby_placements IN SHARE MODE;
LOCK TABLE public.personal_agent_deletion_tombstones IN SHARE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.personal_agent_registry WHERE
   jsonb_path_exists(backend_metadata,'$.**.operatorBindingObservations ? (@.size() > 0)')
   OR jsonb_path_exists(backend_metadata,'$.**.azureTeardown')
   OR jsonb_path_exists(backend_metadata,'$.** ? (@.type == "pubsub_topic" && @.id like_regex "^projects/")'))
 OR EXISTS(SELECT 1 FROM public.personal_agent_standby_placements WHERE
   jsonb_path_exists(backend_metadata,'$.**.operatorBindingObservations ? (@.size() > 0)')
   OR jsonb_path_exists(backend_metadata,'$.**.azureTeardown')
   OR jsonb_path_exists(backend_metadata,'$.** ? (@.type == "pubsub_topic" && @.id like_regex "^projects/")'))
 OR EXISTS(SELECT 1 FROM public.personal_agent_deletion_tombstones WHERE
   jsonb_path_exists(to_jsonb(personal_agent_deletion_tombstones),'$.**.operatorNotificationCustody')
   OR jsonb_path_exists(to_jsonb(personal_agent_deletion_tombstones),'$.**.azureCleanup'))
 THEN RAISE EXCEPTION 'Operator notification custody requires forward recovery'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.notification_erasure_custody_archived(owner_id text,r jsonb,placement jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT public.personal_agent_erasure_archived(owner_id,r) IS TRUE
 AND placement->>'user_id'=owner_id AND placement->>'hushh_id'=r->>'hushhId'
 AND placement->>'user_cloud_project'=r->'registrySnapshot'->>'user_cloud_project'
 AND placement->>'user_cloud_region'=r->'registrySnapshot'->>'user_cloud_region'
 AND placement->'backend_metadata'->>'serviceUid'=r->'registrySnapshot'->'backend_metadata'->>'serviceUid'
 AND placement->'backend_metadata'->'notificationCheckpoint'->>'phase'='observed'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(r->'registrySnapshot'->'backend_metadata'->'detachedPlacements','[]'::jsonb)) item WHERE item=placement)
 AND jsonb_typeof(placement->'backend_metadata'->'notificationCheckpoint'->'plan'->'plannedResources')='array'
 AND r->'substrateInventory'->'plannedResources' @> (placement->'backend_metadata'->'notificationCheckpoint'->'plan'->'plannedResources')
 AND jsonb_typeof(placement->'backend_metadata'->'substrateReceipt'->'plannedResources')='array'
 AND r->'substrateInventory'->'plannedResources' @> (placement->'backend_metadata'->'substrateReceipt'->'plannedResources')
 AND r->'substrateInventory'->'resourceObservations' @> coalesce(placement->'backend_metadata'->'substrateReceipt'->'resourceObservations','[]'::jsonb)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(placement->'backend_metadata'->'notificationCheckpoint'->'completed','[]'::jsonb)) result
  WHERE result ? 'resourceObservation' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'substrateInventory'->'resourceObservations') observation WHERE observation=result->'resourceObservation'))
 AND public.erasure_planned_resources_covered(r) IS TRUE
 AND public.erasure_mail_resources_deleted(r) IS TRUE;
$$;

CREATE OR REPLACE FUNCTION public.personal_agent_erasure_archive(r jsonb, history jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT jsonb_build_object(
  'version',1,'ownerId',r->>'ownerId','hushhId',r->>'hushhId','attemptId',r->>'attemptId',
  'project',r->'registrySnapshot'->>'user_cloud_project',
  'reservationSha256',encode(sha256(convert_to(r::text,'UTF8')),'hex'),
  'authorizationHistorySha256',encode(sha256(convert_to(history::text,'UTF8')),'hex'),
  'receipts',jsonb_build_object(
   'memoryDeletion',r->'memoryDeletion','computeDeletion',r->'computeDeletion',
   'writerDisabled',r->'writerDisabled','bucketDeletion',r->'bucketDeletion',
   'mailDeletion',jsonb_build_object(
    'cloud_scheduler_job',r->'mailErasure'->'cloud_scheduler_job'->'deletion',
    'pubsub_subscription',r->'mailErasure'->'pubsub_subscription'->'deletion',
    'pubsub_topic',r->'mailErasure'->'pubsub_topic'->'deletion') ||
    -- 956: preserve every independent resource's qualified stages in the archive.
    CASE WHEN EXISTS(SELECT 1 FROM jsonb_each(coalesce(r->'mailErasure','{}'::jsonb)) x WHERE x.value ? 'resources')
     THEN jsonb_build_object('resourcesByKind',r->'mailErasure') ELSE '{}'::jsonb END,
   'kmsCompletion',r->'kmsErasure'->'completion','secretDeletion',r->'secretErasure'->'deletion',
   'accountDeletion',r->'accountErasure'->'deletion',
   'runtimeGrantDeletion',r->'runtimeGrantErasure'->'deletion',
   'repositoryGrantDeletion',r->'repositoryGrantErasure'->'deletion',
   'repositoryRetention',r->'repositoryRetention',
   'bootstrapGrantRelease',r->'bootstrapGrantRelease',
   'bootstrapGrantErasure',r->'bootstrapGrantErasure') ||
   CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(r->'substrateInventory'->'plannedResources') x WHERE x->>'type'='cloud_tasks_queue')
    THEN jsonb_build_object('filesErasure',r->'filesErasure') ELSE '{}'::jsonb END
   -- 954: keep the person's never-hosted receipt; absent (no key) on every hosted archive.
   || jsonb_strip_nulls(jsonb_build_object('neverHosted',r->'neverHosted')));
$$;

CREATE OR REPLACE FUNCTION public.valid_erasure_mail_receipt(reservation jsonb, kind text, stage text, receipt jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE inventory jsonb; observation jsonb; identity jsonb; project text; resource_name text; dependency text; admitted jsonb; dependency_resource jsonb; states jsonb; terms jsonb; origin text;
BEGIN
 IF public.valid_erasure_writer_receipt(reservation,'writerDisabled',reservation->'writerDisabled') IS DISTINCT FROM true
    OR kind IS NULL OR kind NOT IN ('cloud_scheduler_job','pubsub_subscription','pubsub_topic')
    OR stage IS NULL OR stage NOT IN ('admission','acknowledgement','deletion')
    OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 inventory:=reservation->'substrateInventory'; observation:=receipt->'resourceObservation'; identity:=observation->'identity';
 project:=reservation->'registrySnapshot'->>'user_cloud_project';
 IF receipt->>'ownerId' IS DISTINCT FROM reservation->>'ownerId'
    OR receipt->>'attemptId' IS DISTINCT FROM reservation->>'attemptId'
    OR receipt - ARRAY['ownerId','attemptId','resourceObservation','status'] <> '{}'::jsonb
    OR jsonb_typeof(observation) IS DISTINCT FROM 'object'
    OR observation - ARRAY['type','id','disposition','identity'] <> '{}'::jsonb
    OR observation->>'type' IS DISTINCT FROM kind OR observation->>'disposition' IS DISTINCT FROM 'created'
    OR observation->>'id' IS NULL OR observation->>'id' !~ '^[A-Za-z0-9_.~-]{1,255}$'
    OR jsonb_typeof(identity) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 resource_name := 'projects/' || project || '/' || CASE kind
    WHEN 'cloud_scheduler_job' THEN 'locations/' || (reservation->'registrySnapshot'->>'user_cloud_region') || '/jobs/'
    WHEN 'pubsub_subscription' THEN 'subscriptions/' ELSE 'topics/' END || (observation->>'id');
 IF resource_name IS NULL OR identity->>'name' IS DISTINCT FROM resource_name THEN RETURN false; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(inventory->'plannedResources') AS r WHERE r->>'type'=kind AND r->>'id'=observation->>'id') <> 1
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inventory->'plannedResources') AS r WHERE r->>'type'=kind AND r->>'id'=observation->>'id')
    OR (SELECT count(*) FROM jsonb_array_elements(inventory->'resourceObservations') AS r WHERE r=observation) <> 1 THEN RETURN false; END IF;
 IF kind='pubsub_topic' AND identity - 'name' <> '{}'::jsonb THEN RETURN false; END IF;
 -- 956: a direct subscription may attach only to this operation's operator topic.
 terms:=reservation->'registrySnapshot'->'backend_metadata'->'notificationCheckpoint';
 IF kind='pubsub_subscription' AND (identity - ARRAY['name','topic'] <> '{}'::jsonb
    OR (EXISTS (SELECT 1 FROM jsonb_array_elements(inventory->'plannedResources') AS r WHERE r->>'type'='pubsub_topic' AND identity->>'topic'='projects/' || project || '/topics/' || (r->>'id'))
      OR (terms->>'ownerId'=reservation->>'ownerId' AND terms->>'hushhId'=reservation->>'hushhId' AND terms->>'project'=project
       AND observation->>'id'='one-mail-'||left(trim(both '-' from regexp_replace(lower(reservation->>'hushhId'),'[^a-z0-9-]+','-','g')),40)||'-direct-sub'
       AND identity->>'topic'='projects/'||(terms->'plan'->>'oauthProject')||'/topics/one-mail-'||left(trim(both '-' from regexp_replace(lower(reservation->>'hushhId'),'[^a-z0-9-]+','-','g')),40))) IS DISTINCT FROM true) THEN RETURN false; END IF;
 IF kind='cloud_scheduler_job' AND NOT (identity ? 'httpTarget') AND (identity - ARRAY['name','pubsubTarget','schedule','timeZone'] <> '{}'::jsonb
    OR jsonb_typeof(identity->'pubsubTarget') IS DISTINCT FROM 'object'
    OR (identity->'pubsubTarget') - 'topicName' <> '{}'::jsonb
    OR jsonb_typeof(identity->'schedule') IS DISTINCT FROM 'string' OR length(identity->>'schedule') NOT BETWEEN 1 AND 128
    OR jsonb_typeof(identity->'timeZone') IS DISTINCT FROM 'string' OR length(identity->>'timeZone') NOT BETWEEN 1 AND 128
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inventory->'plannedResources') AS r WHERE r->>'type'='pubsub_topic' AND identity->'pubsubTarget'->>'topicName'='projects/' || project || '/topics/' || (r->>'id'))) THEN RETURN false; END IF;
 IF kind='cloud_scheduler_job' AND identity ? 'httpTarget' THEN
  origin:=identity->'httpTarget'->'oidcToken'->>'audience';
  IF terms->>'ownerId' IS DISTINCT FROM reservation->>'ownerId' OR terms->>'project' IS DISTINCT FROM project
   OR terms->>'serviceUid' IS DISTINCT FROM reservation->'registrySnapshot'->'backend_metadata'->>'serviceUid'
   OR coalesce(origin,'') !~ '^https://[a-z0-9][a-z0-9.-]+$'
   OR identity IS DISTINCT FROM jsonb_build_object('name',resource_name,'schedule','0 4 * * *','timeZone','Etc/UTC',
      'httpTarget',jsonb_build_object('uri',origin||'/api/one/pod/maintenance/tick','httpMethod','POST',
       'oidcToken',jsonb_build_object('audience',origin,'serviceAccountEmail',terms->'plan'->>'runtimeAccount')))
   OR origin IS DISTINCT FROM rtrim(reservation->'registrySnapshot'->'backend_metadata'->>'url','/') THEN RETURN false; END IF;
 END IF;
 IF stage='admission' THEN
    dependency := CASE kind WHEN 'pubsub_subscription' THEN 'cloud_scheduler_job' WHEN 'pubsub_topic' THEN 'pubsub_subscription' ELSE NULL END;
    -- 956: every dependent resource needs its own qualified deletion.
    IF dependency IS NOT NULL THEN
     FOR dependency_resource IN SELECT value FROM jsonb_array_elements(inventory->'plannedResources') x WHERE x->>'type'=dependency LOOP
      states:=public.erasure_mail_resource_state(reservation,dependency,dependency_resource->>'id');
      IF public.valid_erasure_mail_receipt(reservation,dependency,'deletion',states->'deletion') IS DISTINCT FROM true THEN RETURN false; END IF;
     END LOOP;
    END IF;
    RETURN receipt->>'status'='admitted';
 END IF;
 states:=public.erasure_mail_resource_state(reservation,kind,observation->>'id');
 admitted:=states->'admission';
 IF public.valid_erasure_mail_receipt(reservation,kind,'admission',admitted) IS DISTINCT FROM true
    OR receipt - 'status' IS DISTINCT FROM admitted - 'status' THEN RETURN false; END IF;
 IF stage='acknowledgement' THEN RETURN receipt->>'status'='acknowledged'; END IF;
 RETURN receipt->>'status'='absent' AND public.valid_erasure_mail_receipt(reservation,kind,'acknowledgement',states->'acknowledgement');
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_personal_agent_notification_checkpoint(snapshot jsonb, checkpoint jsonb, previous jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE metadata jsonb:=snapshot->'backend_metadata'; plan jsonb:=checkpoint->'plan';
 reservation jsonb:=metadata->'provisionAttempt'; approval jsonb:=metadata->'upgradeApproval';
 slug text:=left(trim(both '-' from regexp_replace(lower(snapshot->>'hushh_id'),'[^a-z0-9-]+','-','g')),40);
 stem text:='one-mail-'||slug; project text:=snapshot->>'user_cloud_project'; region text:=snapshot->>'user_cloud_region';
 service text:=rtrim(left('one-pod-'||trim(both '-' from regexp_replace(lower(snapshot->>'hushh_id'),'[^a-z0-9-]+','-','g')),63),'-');
 uid text; step text:=checkpoint->>'step'; phase text:=checkpoint->>'phase'; result jsonb; prior jsonb;
 resource jsonb; ident jsonb; binding jsonb; config jsonb; origin text; expected_name text; expected_topic text;
 expected_role text; expected_url text; member_pattern text; expected_env jsonb; pinned_origin text:=rtrim(metadata->>'url','/');
BEGIN
 IF jsonb_typeof(snapshot) IS DISTINCT FROM 'object' OR snapshot->>'deployment_target' IS DISTINCT FROM 'user_gcp'
 OR jsonb_typeof(checkpoint) IS DISTINCT FROM 'object' OR octet_length(checkpoint::text)>65536
 OR checkpoint-ARRAY['version','ownerId','hushhId','kind','attemptId','operationId','project','region','plan','serviceUid','generation','phase','step','completed']<>'{}'::jsonb
 OR checkpoint->'version' IS DISTINCT FROM '1'::jsonb
 OR checkpoint->>'ownerId' IS DISTINCT FROM snapshot->>'user_id' OR checkpoint->>'hushhId' IS DISTINCT FROM snapshot->>'hushh_id'
 OR checkpoint->>'project' IS DISTINCT FROM project OR checkpoint->>'region' IS DISTINCT FROM region
 OR coalesce(project,'') !~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$' OR coalesce(region,'') !~ '^[a-z0-9-]+$'
 OR jsonb_typeof(plan) IS DISTINCT FROM 'object'
 OR plan-ARRAY['oauthProject','runtimeAccount','bootstrapAccount','service','plannedResources']<>'{}'::jsonb
 OR coalesce(plan->>'oauthProject','') !~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$'
 OR plan->>'bootstrapAccount' IS DISTINCT FROM snapshot->>'user_cloud_bootstrap_sa'
 OR coalesce(plan->>'bootstrapAccount','') !~ ('^[a-z][a-z0-9-]{4,28}@'||project||'[.]iam[.]gserviceaccount[.]com$')
 OR plan->>'service' IS DISTINCT FROM service
 OR coalesce(plan->>'runtimeAccount','') !~ ('^[a-z][a-z0-9-]{4,28}@'||project||'[.]iam[.]gserviceaccount[.]com$')
 OR jsonb_typeof(checkpoint->'generation') IS DISTINCT FROM 'number' OR coalesce(checkpoint->>'generation','') !~ '^[1-9][0-9]{0,15}$'
 OR coalesce(phase,'') NOT IN ('intent','observed') OR jsonb_typeof(checkpoint->'completed') IS DISTINCT FROM 'array'
 OR jsonb_array_length(checkpoint->'completed')>16
 OR coalesce(step,'') NOT IN ('gmail_notification_prerequisite','oauth_mail_topic','iam_gmail_publisher_on_topic',
 'mail_dead_letter_topic','mail_dead_letter_subscription','mail_subscription','generate_pubsub_service_identity',
 'generate_scheduler_service_identity','iam_pubsub_oidc_on_pod','iam_scheduler_oidc_on_pod',
 'iam_pubsub_dead_letter_publisher','iam_pubsub_source_subscriber','gmail_runtime_configuration',
 'gmail_direct_invoker','mail_subscription_configuration','watch_renew_job')
 THEN RETURN false; END IF;
 IF plan->'plannedResources' IS DISTINCT FROM jsonb_build_array(
  jsonb_build_object('type','pubsub_topic','id',stem||'-dead-letter'),
  jsonb_build_object('type','pubsub_subscription','id',stem||'-direct-sub'),
  jsonb_build_object('type','pubsub_subscription','id',stem||'-dead-letter-sub'),
  jsonb_build_object('type','cloud_scheduler_job','id',stem||'-watch-renew')) THEN RETURN false; END IF;
 IF checkpoint->>'kind'='provision' THEN
  IF reservation->>'ownerId' IS DISTINCT FROM snapshot->>'user_id'
  OR reservation->>'attemptId' IS DISTINCT FROM checkpoint->>'attemptId'
  OR checkpoint->>'operationId' IS DISTINCT FROM checkpoint->>'attemptId'
  OR coalesce(reservation->>'phase','') NOT IN ('reserved','substrate','host_requested','host_acknowledged','connecting')
  OR coalesce(snapshot->>'status','') NOT IN ('provisioning','connecting') THEN RETURN false; END IF;
  uid:=reservation->'evidence'->'host_requested'->'creationAcknowledgement'->>'serviceUid';
  IF uid IS NOT NULL AND (reservation->'evidence'->'host_requested'->'creationAcknowledgement'->>'service' IS DISTINCT FROM service
    OR reservation->'evidence'->'host_requested'->'creationAcknowledgement'->>'project' IS DISTINCT FROM project
    OR reservation->'evidence'->'host_requested'->'creationAcknowledgement'->>'region' IS DISTINCT FROM region) THEN RETURN false; END IF;
 ELSE
  IF checkpoint->>'kind' IS DISTINCT FROM 'upgrade' OR snapshot->>'status' IS DISTINCT FROM 'provisioned'
  OR coalesce(metadata->>'upgradeLease','')=''
  OR checkpoint->>'attemptId' IS DISTINCT FROM encode(sha256(convert_to(metadata->>'upgradeLease','UTF8')),'hex')
  OR coalesce(approval->>'operationId','')='' OR checkpoint->>'operationId' IS DISTINCT FROM approval->>'operationId'
  OR snapshot->>'external_agent_id' IS DISTINCT FROM service THEN RETURN false; END IF;
  IF approval->'version' IS DISTINCT FROM '1'::jsonb OR approval->>'ownerId' IS DISTINCT FROM snapshot->>'user_id'
   OR approval->>'hushhId' IS DISTINCT FROM snapshot->>'hushh_id' OR approval->>'podIncarnation' IS DISTINCT FROM metadata->>'serviceUid'
   OR coalesce(approval->>'status','') NOT IN ('approved','scheduled','updating')
   OR coalesce(approval->>'targetImage','') !~ '^.+@sha256:[a-f0-9]{64}$' THEN RETURN false; END IF;
  uid:=metadata->>'serviceUid';
 END IF;
 IF metadata->>'serviceUid' IS NOT NULL AND uid IS DISTINCT FROM metadata->>'serviceUid' THEN RETURN false; END IF;
 IF uid IS NOT NULL AND checkpoint->>'serviceUid' IS DISTINCT FROM uid THEN RETURN false; END IF;
 IF step IN ('gmail_runtime_configuration','gmail_direct_invoker','mail_subscription_configuration','watch_renew_job')
 AND (coalesce(uid,'')='' OR checkpoint->>'serviceUid' IS DISTINCT FROM uid) THEN RETURN false; END IF;
 IF uid IS NULL AND checkpoint->'serviceUid' IS DISTINCT FROM 'null'::jsonb THEN RETURN false; END IF;
 IF previous IS NOT NULL THEN
  IF (checkpoint->>'generation')::bigint<>(previous->>'generation')::bigint+1 THEN RETURN false; END IF;
  IF checkpoint->>'attemptId'=previous->>'attemptId' AND checkpoint->>'kind'=previous->>'kind' THEN
   IF checkpoint-ARRAY['generation','phase','step','completed','serviceUid'] IS DISTINCT FROM previous-ARRAY['generation','phase','step','completed','serviceUid'] THEN RETURN false; END IF;
   IF phase='intent' AND (previous->>'phase' IS DISTINCT FROM 'observed' OR checkpoint->'completed' IS DISTINCT FROM previous->'completed') THEN RETURN false; END IF;
   IF phase='observed' AND (previous->>'phase' IS DISTINCT FROM 'intent' OR previous->>'step' IS DISTINCT FROM step) THEN RETURN false; END IF;
   FOR prior IN SELECT value FROM jsonb_array_elements(previous->'completed') LOOP
    IF prior->>'step'<>step OR phase='intent' THEN
     IF NOT checkpoint->'completed' @> jsonb_build_array(prior) THEN RETURN false; END IF;
    END IF;
   END LOOP;
   IF phase='observed' AND (SELECT count(*) FROM jsonb_array_elements(checkpoint->'completed') x WHERE x->>'step'<>step)<>(SELECT count(*) FROM jsonb_array_elements(previous->'completed') x WHERE x->>'step'<>step) THEN RETURN false; END IF;
  ELSIF previous->>'phase' IS DISTINCT FROM 'observed' OR phase IS DISTINCT FROM 'intent' OR checkpoint->'completed' IS DISTINCT FROM '[]'::jsonb THEN RETURN false; END IF;
 ELSIF checkpoint->'generation' IS DISTINCT FROM '1'::jsonb OR phase IS DISTINCT FROM 'intent' OR checkpoint->'completed' IS DISTINCT FROM '[]'::jsonb THEN RETURN false;
 END IF;
 IF phase='observed' AND (SELECT count(*) FROM jsonb_array_elements(checkpoint->'completed') x WHERE x->>'step'=step)<>1 THEN RETURN false; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(checkpoint->'completed'))<>(SELECT count(DISTINCT x->>'step') FROM jsonb_array_elements(checkpoint->'completed') x) THEN RETURN false; END IF;
 FOR result IN SELECT value FROM jsonb_array_elements(checkpoint->'completed') LOOP
  origin:=NULL;
  IF jsonb_typeof(result) IS DISTINCT FROM 'object'
   OR result-ARRAY['step','status','ok','skipped','capability','resourceObservation','bindingObservations','operatorBindingObservations','configurationObservation']<>'{}'::jsonb
   OR jsonb_typeof(result->'ok') IS DISTINCT FROM 'boolean' OR jsonb_typeof(result->'status') IS DISTINCT FROM 'number' OR coalesce(result->>'status','') !~ '^[0-9]{1,3}$'
   OR (result ? 'capability' AND result->>'capability' IS DISTINCT FROM 'gmail_notifications')
   OR (result ? 'skipped' AND jsonb_typeof(result->'skipped') IS DISTINCT FROM 'boolean') THEN RETURN false; END IF;
  IF result ?| ARRAY['resourceObservation','bindingObservations','operatorBindingObservations','configurationObservation']
   AND (result->'ok' IS DISTINCT FROM 'true'::jsonb OR result->>'status' NOT IN ('200','201') OR result->'skipped'='true'::jsonb) THEN RETURN false; END IF;
  IF result->'ok'='true'::jsonb AND result->>'status' IN ('200','201') THEN
   IF result->>'step' IN ('mail_dead_letter_topic','mail_dead_letter_subscription','mail_subscription') AND NOT(result ? 'resourceObservation') THEN RETURN false; END IF;
   IF result->>'step' IN ('gmail_runtime_configuration','gmail_direct_invoker','mail_subscription_configuration') AND NOT(result ? 'configurationObservation') THEN RETURN false; END IF;
   IF result->>'step'='watch_renew_job' AND NOT(result ?| ARRAY['resourceObservation','configurationObservation']) THEN RETURN false; END IF;
  END IF;
  resource:=result->'resourceObservation';
  IF resource IS NOT NULL THEN
   IF resource-ARRAY['type','id','disposition','identity']<>'{}'::jsonb OR resource->>'disposition' IS DISTINCT FROM 'created'
    OR NOT plan->'plannedResources' @> jsonb_build_array(jsonb_build_object('type',resource->>'type','id',resource->>'id')) THEN RETURN false; END IF;
   ident:=resource->'identity';
   CASE result->>'step'
    WHEN 'mail_dead_letter_topic' THEN expected_name:='projects/'||project||'/topics/'||stem||'-dead-letter';
     IF resource->>'type' IS DISTINCT FROM 'pubsub_topic' OR ident IS DISTINCT FROM jsonb_build_object('name',expected_name) THEN RETURN false; END IF;
    WHEN 'mail_subscription' THEN expected_name:='projects/'||project||'/subscriptions/'||stem||'-direct-sub'; expected_topic:='projects/'||(plan->>'oauthProject')||'/topics/'||stem;
     IF resource->>'type' IS DISTINCT FROM 'pubsub_subscription' OR ident IS DISTINCT FROM jsonb_build_object('name',expected_name,'topic',expected_topic) THEN RETURN false; END IF;
    WHEN 'mail_dead_letter_subscription' THEN expected_name:='projects/'||project||'/subscriptions/'||stem||'-dead-letter-sub'; expected_topic:='projects/'||project||'/topics/'||stem||'-dead-letter';
     IF resource->>'type' IS DISTINCT FROM 'pubsub_subscription' OR ident IS DISTINCT FROM jsonb_build_object('name',expected_name,'topic',expected_topic) THEN RETURN false; END IF;
    WHEN 'watch_renew_job' THEN expected_name:='projects/'||project||'/locations/'||region||'/jobs/'||stem||'-watch-renew';
     IF resource->>'type' IS DISTINCT FROM 'cloud_scheduler_job' OR ident->>'name' IS DISTINCT FROM expected_name THEN RETURN false; END IF;
    ELSE RETURN false;
   END CASE;
   IF resource->>'id' IS DISTINCT FROM regexp_replace(expected_name,'^.*/','') THEN RETURN false; END IF;
  END IF;
  IF result ? 'bindingObservations' AND (jsonb_typeof(result->'bindingObservations') IS DISTINCT FROM 'array' OR jsonb_array_length(result->'bindingObservations')>2) THEN RETURN false; END IF;
  IF result ? 'operatorBindingObservations' AND (jsonb_typeof(result->'operatorBindingObservations') IS DISTINCT FROM 'array' OR jsonb_array_length(result->'operatorBindingObservations')>2) THEN RETURN false; END IF;
  FOR binding IN SELECT value FROM jsonb_array_elements(coalesce(result->'bindingObservations','[]'::jsonb)) LOOP
   IF binding-ARRAY['step','policyResource','role','member','disposition','beforeEtag','afterEtag']<>'{}'::jsonb
    OR binding->>'step' IS DISTINCT FROM result->>'step' OR coalesce(binding->>'disposition','') NOT IN ('added','already_present')
    OR jsonb_typeof(binding->'beforeEtag') IS DISTINCT FROM 'string' OR jsonb_typeof(binding->'afterEtag') IS DISTINCT FROM 'string'
    OR length(coalesce(binding->>'beforeEtag','')) NOT BETWEEN 1 AND 512 OR length(coalesce(binding->>'afterEtag','')) NOT BETWEEN 1 AND 512 THEN RETURN false; END IF;
   CASE result->>'step'
    WHEN 'iam_pubsub_oidc_on_pod' THEN expected_role:='roles/iam.serviceAccountOpenIdTokenCreator'; member_pattern:='^serviceAccount:service-[1-9][0-9]*@gcp-sa-pubsub[.]iam[.]gserviceaccount[.]com$'; expected_url:='https://iam.googleapis.com/v1/projects/'||project||'/serviceAccounts/'||(plan->>'runtimeAccount')||':getIamPolicy';
    WHEN 'iam_scheduler_oidc_on_pod' THEN expected_role:='roles/iam.serviceAccountOpenIdTokenCreator'; member_pattern:='^serviceAccount:service-[1-9][0-9]*@gcp-sa-cloudscheduler[.]iam[.]gserviceaccount[.]com$'; expected_url:='https://iam.googleapis.com/v1/projects/'||project||'/serviceAccounts/'||(plan->>'runtimeAccount')||':getIamPolicy';
    WHEN 'iam_pubsub_dead_letter_publisher' THEN expected_role:='roles/pubsub.publisher'; member_pattern:='^serviceAccount:service-[1-9][0-9]*@gcp-sa-pubsub[.]iam[.]gserviceaccount[.]com$'; expected_url:='https://pubsub.googleapis.com/v1/projects/'||project||'/topics/'||stem||'-dead-letter:getIamPolicy';
    WHEN 'iam_pubsub_source_subscriber' THEN expected_role:='roles/pubsub.subscriber'; member_pattern:='^serviceAccount:service-[1-9][0-9]*@gcp-sa-pubsub[.]iam[.]gserviceaccount[.]com$'; expected_url:='https://pubsub.googleapis.com/v1/projects/'||project||'/subscriptions/'||stem||'-direct-sub:getIamPolicy';
    ELSE RETURN false;
   END CASE;
   IF binding->>'role' IS DISTINCT FROM expected_role OR binding->>'policyResource' IS DISTINCT FROM expected_url OR coalesce(binding->>'member','') !~ member_pattern THEN RETURN false; END IF;
  END LOOP;
  FOR binding IN SELECT value FROM jsonb_array_elements(coalesce(result->'operatorBindingObservations','[]'::jsonb)) LOOP
   IF result->>'step' IS DISTINCT FROM 'iam_gmail_publisher_on_topic'
    OR binding-ARRAY['step','policyResource','role','member','disposition','beforeEtag','afterEtag']<>'{}'::jsonb
    OR binding->>'step' IS DISTINCT FROM result->>'step'
    OR binding->>'policyResource' IS DISTINCT FROM 'https://pubsub.googleapis.com/v1/projects/'||(plan->>'oauthProject')||'/topics/'||stem||':getIamPolicy'
    OR (binding->>'role',binding->>'member') NOT IN (('roles/pubsub.publisher','serviceAccount:gmail-api-push@system.gserviceaccount.com'),('roles/pubsub.subscriber','serviceAccount:'||(plan->>'bootstrapAccount')))
    OR coalesce(binding->>'disposition','') NOT IN ('added','already_present') OR jsonb_typeof(binding->'beforeEtag') IS DISTINCT FROM 'string' OR jsonb_typeof(binding->'afterEtag') IS DISTINCT FROM 'string'
    OR length(coalesce(binding->>'beforeEtag','')) NOT BETWEEN 1 AND 512 OR length(coalesce(binding->>'afterEtag','')) NOT BETWEEN 1 AND 512 THEN RETURN false; END IF;
  END LOOP;
  config:=result->'configurationObservation';
  IF config IS NOT NULL OR result->>'step'='watch_renew_job' AND resource IS NOT NULL THEN
   CASE result->>'step'
    WHEN 'gmail_runtime_configuration' THEN
     expected_env:=config->'runtimeEnv'; origin:=expected_env->>'POD_GMAIL_PUSH_AUDIENCE';
     IF config-ARRAY['service','serviceUid','runtimeEnv']<>'{}'::jsonb OR config->>'service' IS DISTINCT FROM service OR config->>'serviceUid' IS DISTINCT FROM uid
      OR expected_env-ARRAY['POD_GMAIL_TOPIC','POD_GMAIL_PUSH_SUBSCRIPTION','POD_GMAIL_PUSH_SERVICE_ACCOUNT','POD_GMAIL_PUSH_AUDIENCE','POD_GMAIL_CONFIG_GENERATION','HUSSH_POD_TICK_AUDIENCE','HUSSH_POD_TICK_ALLOWED_EMAILS']<>'{}'::jsonb
      OR coalesce(origin,'') !~ '^https://[a-z0-9][a-z0-9.-]+$'
      OR expected_env->>'POD_GMAIL_TOPIC' IS DISTINCT FROM 'projects/'||(plan->>'oauthProject')||'/topics/'||stem
      OR expected_env->>'POD_GMAIL_PUSH_SUBSCRIPTION' IS DISTINCT FROM 'projects/'||project||'/subscriptions/'||stem||'-direct-sub'
      OR expected_env->>'POD_GMAIL_PUSH_SERVICE_ACCOUNT' IS DISTINCT FROM plan->>'runtimeAccount'
      OR expected_env->>'POD_GMAIL_CONFIG_GENERATION' IS DISTINCT FROM encode(sha256(convert_to(
        '{"POD_GMAIL_PUSH_AUDIENCE":'||to_jsonb(origin)::text||',"POD_GMAIL_PUSH_SERVICE_ACCOUNT":'||to_jsonb(plan->>'runtimeAccount')::text||
        ',"POD_GMAIL_PUSH_SUBSCRIPTION":'||to_jsonb('projects/'||project||'/subscriptions/'||stem||'-direct-sub')::text||
        ',"POD_GMAIL_TOPIC":'||to_jsonb('projects/'||(plan->>'oauthProject')||'/topics/'||stem)::text||'}','UTF8')),'hex')
      OR expected_env->>'HUSSH_POD_TICK_AUDIENCE' IS DISTINCT FROM origin
      OR expected_env->>'HUSSH_POD_TICK_ALLOWED_EMAILS' IS DISTINCT FROM plan->>'runtimeAccount' THEN RETURN false; END IF;
    WHEN 'gmail_direct_invoker' THEN
     IF config IS DISTINCT FROM jsonb_build_object('service',service,'serviceUid',uid,'role','roles/run.invoker','member','serviceAccount:'||(plan->>'runtimeAccount')) THEN RETURN false; END IF;
    WHEN 'mail_subscription_configuration' THEN
     origin:=config->'pushConfig'->'oidcToken'->>'audience';
     IF config IS DISTINCT FROM jsonb_build_object('name','projects/'||project||'/subscriptions/'||stem||'-direct-sub','topic','projects/'||(plan->>'oauthProject')||'/topics/'||stem,
      'pushConfig',jsonb_build_object('pushEndpoint',origin||'/api/one/pod/gmail/push','oidcToken',jsonb_build_object('serviceAccountEmail',plan->>'runtimeAccount','audience',origin)),
      'ackDeadlineSeconds',60,'retryPolicy',jsonb_build_object('minimumBackoff','10s','maximumBackoff','600s'),'messageRetentionDuration','604800s','expirationPolicy','{}'::jsonb,
      'deadLetterPolicy',jsonb_build_object('deadLetterTopic','projects/'||project||'/topics/'||stem||'-dead-letter','maxDeliveryAttempts',10)) OR coalesce(origin,'') !~ '^https://[a-z0-9][a-z0-9.-]+$' THEN RETURN false; END IF;
    WHEN 'watch_renew_job' THEN
     config:=coalesce(config,ident); origin:=config->'httpTarget'->'oidcToken'->>'audience';
     IF config IS DISTINCT FROM jsonb_build_object('name','projects/'||project||'/locations/'||region||'/jobs/'||stem||'-watch-renew','schedule','0 4 * * *','timeZone','Etc/UTC',
      'httpTarget',jsonb_build_object('uri',origin||'/api/one/pod/maintenance/tick','httpMethod','POST','oidcToken',jsonb_build_object('audience',origin,'serviceAccountEmail',plan->>'runtimeAccount')))
      OR coalesce(origin,'') !~ '^https://[a-z0-9][a-z0-9.-]+$' THEN RETURN false; END IF;
    ELSE RETURN false;
   END CASE;
   IF origin IS NOT NULL THEN
    IF pinned_origin IS NOT NULL AND origin IS DISTINCT FROM pinned_origin THEN RETURN false; END IF;
    pinned_origin:=origin;
   END IF;
  END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_parameter_value THEN RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.notification_checkpoint_inventory(inventory jsonb, checkpoint jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE item jsonb; result jsonb; values_array jsonb; resources jsonb;
BEGIN
 IF inventory IS NULL OR inventory='null'::jsonb THEN
  inventory:=jsonb_build_object('version','byoc.substrate.receipt.v1','tenantRef',checkpoint->>'project'||'/'||(checkpoint->>'region'),
   'resourceIds','[]'::jsonb,'plannedResources','[]'::jsonb,'resourceObservations','[]'::jsonb,'bindingObservations','[]'::jsonb,'applied',false);
 END IF;
 resources:=coalesce(inventory->'plannedResources','[]'::jsonb);
 FOR item IN SELECT value FROM jsonb_array_elements(checkpoint->'plan'->'plannedResources') LOOP
  IF NOT resources @> jsonb_build_array(item) THEN resources:=resources||jsonb_build_array(item); END IF;
 END LOOP;
 inventory:=jsonb_set(inventory,'{plannedResources}',resources,true);
 SELECT jsonb_agg(id ORDER BY id) INTO values_array FROM (
  SELECT DISTINCT value->>'id' id FROM jsonb_array_elements(resources)
 ) ids;
 inventory:=jsonb_set(inventory,'{resourceIds}',coalesce(values_array,'[]'::jsonb),true);
 FOR result IN SELECT value FROM jsonb_array_elements(checkpoint->'completed') LOOP
  IF result ? 'resourceObservation' THEN
   item:=result->'resourceObservation'; values_array:=coalesce(inventory->'resourceObservations','[]'::jsonb);
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(values_array) x WHERE x->>'type'=item->>'type' AND x->>'id'=item->>'id' AND x<>item) THEN RETURN NULL; END IF;
   IF NOT values_array @> jsonb_build_array(item) THEN values_array:=values_array||jsonb_build_array(item); END IF;
   inventory:=jsonb_set(inventory,'{resourceObservations}',values_array,true);
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(coalesce(result->'bindingObservations','[]'::jsonb)) LOOP
   values_array:=coalesce(inventory->'bindingObservations','[]'::jsonb);
   IF NOT values_array @> jsonb_build_array(item) THEN values_array:=values_array||jsonb_build_array(item); END IF;
   inventory:=jsonb_set(inventory,'{bindingObservations}',values_array,true);
  END LOOP;
 END LOOP;
 RETURN inventory;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_personal_agent_notification_registry()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE previous jsonb:=OLD.backend_metadata->'notificationCheckpoint'; candidate jsonb:=NEW.backend_metadata->'notificationCheckpoint';
BEGIN
 IF OLD.backend_metadata ? 'erasure' THEN RETURN NEW; END IF;
 IF public.notification_initial_host_binding(to_jsonb(OLD),to_jsonb(NEW)) IS TRUE THEN RETURN NEW; END IF;
 -- 956: host custody may move a completed checkpoint, but cannot move an in-flight mutation.
 IF (previous IS NOT NULL OR candidate IS NOT NULL) AND (NEW.external_agent_id IS DISTINCT FROM OLD.external_agent_id
   OR NEW.deployment_target IS DISTINCT FROM OLD.deployment_target OR NEW.user_cloud_project IS DISTINCT FROM OLD.user_cloud_project
   OR NEW.user_cloud_region IS DISTINCT FROM OLD.user_cloud_region
   OR NEW.backend_metadata->>'serviceUid' IS DISTINCT FROM OLD.backend_metadata->>'serviceUid') THEN
  IF (previous IS NOT NULL AND previous->>'phase' IS DISTINCT FROM 'observed') OR OLD.status NOT IN ('provisioned','needs_reinit')
   OR OLD.backend_metadata ? 'upgradeLease'
   OR (OLD.backend_metadata ? 'provisionAttempt' AND OLD.backend_metadata->'provisionAttempt'->>'phase' IS DISTINCT FROM 'provisioned')
   OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.hushh_id IS DISTINCT FROM OLD.hushh_id
   OR (candidate IS NOT NULL AND (candidate->>'phase' IS DISTINCT FROM 'observed'
       OR NOT EXISTS(SELECT 1 FROM public.personal_agent_standby_placements standby WHERE standby.user_id=OLD.user_id AND standby.hushh_id=OLD.hushh_id
         AND standby.backend_metadata->'notificationCheckpoint'=candidate
         AND standby.external_agent_id=NEW.external_agent_id AND standby.deployment_target=NEW.deployment_target
         AND standby.user_cloud_project IS NOT DISTINCT FROM NEW.user_cloud_project AND standby.user_cloud_region IS NOT DISTINCT FROM NEW.user_cloud_region
         AND standby.pod_pubkey IS NOT DISTINCT FROM NEW.pod_pubkey AND standby.pod_key_id IS NOT DISTINCT FROM NEW.pod_key_id
         AND standby.pod_signing_pubkey IS NOT DISTINCT FROM NEW.pod_signing_pubkey AND standby.pod_signing_key_id IS NOT DISTINCT FROM NEW.pod_signing_key_id)
       OR candidate->>'ownerId' IS DISTINCT FROM NEW.user_id
       OR candidate->>'hushhId' IS DISTINCT FROM NEW.hushh_id OR candidate->>'project' IS DISTINCT FROM NEW.user_cloud_project
       OR candidate->>'region' IS DISTINCT FROM NEW.user_cloud_region
       OR candidate->'plan'->>'service' IS DISTINCT FROM NEW.external_agent_id
       OR (candidate->>'serviceUid' IS NOT NULL AND candidate->>'serviceUid' IS DISTINCT FROM NEW.backend_metadata->>'serviceUid')))
  THEN RAISE EXCEPTION 'notification checkpoint host transfer requires completed operation' USING ERRCODE='42501'; END IF;
  -- The deferred trigger below proves the old custody still exists after all swap CTEs finish.
  RETURN NEW;
 END IF;
 IF candidate IS DISTINCT FROM previous THEN
  -- The marker is caller-settable coordination, never authentication. Independently
  -- validate the owner operation, UID, generation and the exact derived inventory.
  IF current_setting('hussh.notification_generation',true) IS DISTINCT FROM coalesce(previous->>'generation','0')
   OR to_jsonb(NEW)-'backend_metadata' IS DISTINCT FROM to_jsonb(OLD)-'backend_metadata'
   OR NEW.backend_metadata-ARRAY['notificationCheckpoint','substrateReceipt'] IS DISTINCT FROM OLD.backend_metadata-ARRAY['notificationCheckpoint','substrateReceipt']
   OR public.valid_personal_agent_notification_checkpoint(to_jsonb(OLD),candidate,previous) IS DISTINCT FROM true
   OR NEW.backend_metadata->'substrateReceipt' IS DISTINCT FROM public.notification_checkpoint_inventory(OLD.backend_metadata->'substrateReceipt',candidate)
  THEN RAISE EXCEPTION 'notification checkpoint requires current owner operation' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END;
$$;

DROP FUNCTION public.operator_topic_custody_preserved(jsonb,jsonb);
DROP FUNCTION public.operator_notification_custody_ready();
DROP FUNCTION public.operator_mail_grants_qualified(jsonb,text);

COMMIT;
