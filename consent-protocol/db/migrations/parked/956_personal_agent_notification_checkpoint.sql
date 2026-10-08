-- Dev only: bounded Gmail notification receipts within the existing owner operation.
-- No new ledger; creationAcknowledgement remains immutable. Refusal never permits continuation.
BEGIN;
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

CREATE OR REPLACE FUNCTION public.valid_erasure_notification_observation(reservation jsonb, observation jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT reservation->>'ownerId'=reservation->'registrySnapshot'->>'user_id'
 AND observation->>'phase'='observed'
 AND reservation->'registrySnapshot'->'backend_metadata'->'notificationCheckpoint'->>'phase'='intent'
 AND public.valid_personal_agent_notification_checkpoint(reservation->'registrySnapshot',observation,
  reservation->'registrySnapshot'->'backend_metadata'->'notificationCheckpoint');
$$;

CREATE OR REPLACE FUNCTION public.notification_initial_host_binding(previous jsonb, candidate jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT coalesce(previous->>'status'='provisioning' AND previous->>'external_agent_id' IS NULL
 AND previous->'backend_metadata'->>'serviceUid' IS NULL
 AND previous->'backend_metadata'->'provisionAttempt'->>'phase'='host_requested'
 AND candidate->'backend_metadata'->'provisionAttempt'->>'phase'='host_acknowledged'
 AND candidate->>'user_id'=previous->>'user_id' AND candidate->>'hushh_id'=previous->>'hushh_id'
 AND candidate->'backend_metadata'->'provisionAttempt'->>'attemptId'=previous->'backend_metadata'->'provisionAttempt'->>'attemptId'
 AND candidate->'backend_metadata'->'notificationCheckpoint'=previous->'backend_metadata'->'notificationCheckpoint'
 AND candidate->>'external_agent_id'=previous->'backend_metadata'->'provisionAttempt'->'evidence'->'host_requested'->'creationAcknowledgement'->>'service'
 AND candidate->'backend_metadata'->>'serviceUid'=previous->'backend_metadata'->'provisionAttempt'->'evidence'->'host_requested'->'creationAcknowledgement'->>'serviceUid'
 AND candidate->>'backend'=previous->'backend_metadata'->'provisionAttempt'->'evidence'->'host_requested'->'creationAcknowledgement'->>'backend'
 AND candidate->>'user_cloud_project'=previous->>'user_cloud_project' AND candidate->>'user_cloud_region'=previous->>'user_cloud_region'
 AND candidate->>'user_cloud_project'=previous->'backend_metadata'->'provisionAttempt'->'evidence'->'host_requested'->'creationAcknowledgement'->>'project'
 AND candidate->>'user_cloud_region'=previous->'backend_metadata'->'provisionAttempt'->'evidence'->'host_requested'->'creationAcknowledgement'->>'region'
 AND candidate->'backend_metadata'->'provisionAttempt'->'evidence'->'host_requested'->'creationAcknowledgement'=previous->'backend_metadata'->'provisionAttempt'->'evidence'->'host_requested'->'creationAcknowledgement',false);
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
DROP TRIGGER IF EXISTS zx_personal_agent_notification_registry ON public.personal_agent_registry;
CREATE TRIGGER zx_personal_agent_notification_registry BEFORE UPDATE ON public.personal_agent_registry
FOR EACH ROW EXECUTE FUNCTION public.guard_personal_agent_notification_registry();

-- Public placement identity and cleanup evidence move as one custody record.
CREATE OR REPLACE FUNCTION public.notification_placement_custody(placement jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT jsonb_build_object('url',coalesce(placement->'url',placement->'backend_metadata'->'url'),
  'backend_metadata',(SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb)
   FROM jsonb_each(coalesce(placement->'backend_metadata','{}'::jsonb))
   WHERE key<>'url' AND key<>'detachedPlacements' AND key NOT LIKE 'puppy%')) ||
  (SELECT jsonb_object_agg(key,placement->key) FROM unnest(ARRAY['user_id','hushh_id','deployment_target','backend',
   'external_agent_id','region','model_credential_mode','user_cloud_project','user_cloud_region',
   'user_cloud_bootstrap_sa','user_cloud_authorized_at','user_cloud_tenant_id','user_cloud_subscription_id',
   'user_cloud_resource_group','pod_pubkey','pod_key_id','pod_key_wrapping_alg','pod_signing_pubkey',
   'pod_signing_key_id','runtime_version','prompt_version','provisioned_at']) key);
$$;

CREATE OR REPLACE FUNCTION public.guard_personal_agent_notification_standby_retention()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE primary_record jsonb; custody jsonb:=public.notification_placement_custody(to_jsonb(OLD));
BEGIN
 IF OLD.backend_metadata->'notificationCheckpoint' IS NULL THEN RETURN NEW; END IF;
 SELECT to_jsonb(r) INTO primary_record FROM public.personal_agent_registry r WHERE user_id=OLD.user_id AND hushh_id=OLD.hushh_id;
 IF EXISTS(SELECT 1 FROM public.personal_agent_standby_placements standby WHERE standby.user_id=OLD.user_id AND standby.hushh_id=OLD.hushh_id
   AND public.notification_placement_custody(to_jsonb(standby))=custody) THEN RETURN NEW; END IF;
 IF OLD.backend_metadata->'notificationCheckpoint'->>'phase' IS DISTINCT FROM 'observed' THEN
  RAISE EXCEPTION 'notification checkpoint standby transfer requires completed operation' USING ERRCODE='42501'; END IF;
 IF public.notification_placement_custody(primary_record)=custody
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(primary_record->'backend_metadata'->'detachedPlacements','[]'::jsonb)) item
    WHERE public.notification_placement_custody(item)=custody) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'notification checkpoint standby custody not retained' USING ERRCODE='42501';
END;
$$;
DROP TRIGGER IF EXISTS zz_personal_agent_notification_standby_retention ON public.personal_agent_standby_placements;
CREATE CONSTRAINT TRIGGER zz_personal_agent_notification_standby_retention
AFTER UPDATE OR DELETE ON public.personal_agent_standby_placements
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.guard_personal_agent_notification_standby_retention();

CREATE OR REPLACE FUNCTION public.guard_personal_agent_notification_retention()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE archived jsonb; retained_metadata jsonb; current_metadata jsonb; detached jsonb;
BEGIN
 SELECT backend_metadata INTO current_metadata FROM public.personal_agent_registry WHERE user_id=OLD.user_id AND hushh_id=OLD.hushh_id;
 -- Previously detached custody remains protected even when the primary has no checkpoint.
 FOR detached IN SELECT value FROM jsonb_array_elements(coalesce(OLD.backend_metadata->'detachedPlacements','[]'::jsonb)) LOOP
  IF detached->'backend_metadata'->'notificationCheckpoint' IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(current_metadata->'detachedPlacements','[]'::jsonb)) item WHERE item=detached)
   AND public.notification_erasure_custody_archived(OLD.user_id,OLD.backend_metadata->'erasure',detached) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'notification checkpoint detached custody not retained' USING ERRCODE='42501'; END IF;
 END LOOP;
 IF OLD.backend_metadata->'notificationCheckpoint' IS NULL OR OLD.backend_metadata ? 'erasure' THEN RETURN NEW; END IF;
 IF public.notification_initial_host_binding(to_jsonb(OLD),to_jsonb(NEW)) IS TRUE THEN RETURN NEW; END IF;
 IF NEW.external_agent_id IS NOT DISTINCT FROM OLD.external_agent_id AND NEW.deployment_target IS NOT DISTINCT FROM OLD.deployment_target
  AND NEW.user_cloud_project IS NOT DISTINCT FROM OLD.user_cloud_project AND NEW.user_cloud_region IS NOT DISTINCT FROM OLD.user_cloud_region
  AND NEW.backend_metadata->>'serviceUid' IS NOT DISTINCT FROM OLD.backend_metadata->>'serviceUid' THEN RETURN NEW; END IF;
 -- Re-read after transaction writes. A same-statement temporary archive is not retention.
 SELECT backend_metadata INTO current_metadata FROM public.personal_agent_registry WHERE user_id=OLD.user_id AND hushh_id=OLD.hushh_id;
 archived:=(to_jsonb(OLD)-'backend_metadata')||jsonb_build_object('backend_metadata',OLD.backend_metadata-'detachedPlacements');
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(current_metadata->'detachedPlacements','[]'::jsonb)) item
    WHERE item-ARRAY['detachedAt','reason']=archived) THEN RETURN NEW; END IF;
 SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) INTO retained_metadata
 FROM jsonb_each(OLD.backend_metadata) WHERE key<>'url' AND key<>'detachedPlacements' AND key NOT LIKE 'puppy%';
 IF EXISTS(SELECT 1 FROM public.personal_agent_standby_placements standby WHERE standby.user_id=OLD.user_id AND standby.hushh_id=OLD.hushh_id
  AND standby.backend_metadata=retained_metadata AND standby.url IS NOT DISTINCT FROM OLD.backend_metadata->>'url'
  AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['deployment_target','backend','external_agent_id','region','model_credential_mode',
   'user_cloud_project','user_cloud_region','user_cloud_bootstrap_sa','user_cloud_authorized_at','user_cloud_tenant_id',
   'user_cloud_subscription_id','user_cloud_resource_group','pod_pubkey','pod_key_id','pod_key_wrapping_alg',
   'pod_signing_pubkey','pod_signing_key_id','runtime_version','prompt_version']) key
   WHERE to_jsonb(standby)->key IS DISTINCT FROM to_jsonb(OLD)->key)) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'notification checkpoint prior host custody not retained' USING ERRCODE='42501';
END;
$$;
DROP TRIGGER IF EXISTS zz_personal_agent_notification_retention ON public.personal_agent_registry;
CREATE CONSTRAINT TRIGGER zz_personal_agent_notification_retention AFTER UPDATE OR DELETE ON public.personal_agent_registry
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.guard_personal_agent_notification_retention();

CREATE OR REPLACE FUNCTION public.publish_personal_agent_notification_checkpoint(
 owner_id text, operation_kind text, attempt_id text, operation_id text, expected_generation bigint, checkpoint jsonb
) RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE current_row public.personal_agent_registry%ROWTYPE; metadata jsonb; previous jsonb; inventory jsonb; reservation jsonb; bound jsonb; marker text; notification_marker text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR checkpoint->>'ownerId' IS DISTINCT FROM owner_id OR checkpoint->>'kind' IS DISTINCT FROM operation_kind
 OR checkpoint->>'attemptId' IS DISTINCT FROM attempt_id OR checkpoint->>'operationId' IS DISTINCT FROM operation_id
 OR expected_generation IS NULL OR expected_generation<0 THEN RETURN NULL; END IF;
 metadata:=current_row.backend_metadata;
 IF public.notification_checkpoint_admission_ready() IS DISTINCT FROM true THEN RETURN NULL; END IF;
 IF metadata ? 'erasure' THEN
  reservation:=metadata->'erasure'; previous:=reservation->'registrySnapshot'->'backend_metadata'->'notificationCheckpoint';
  IF current_row.status IS DISTINCT FROM 'suspended' OR reservation->>'ownerId' IS DISTINCT FROM owner_id
   OR (previous->>'generation')::bigint IS DISTINCT FROM expected_generation
   OR reservation ? 'substrateInventory' OR public.valid_erasure_notification_observation(reservation,checkpoint) IS DISTINCT FROM true THEN RETURN NULL; END IF;
  IF reservation ? 'lateNotificationObservation' THEN RETURN NULL; END IF;
  UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,ARRAY['erasure','lateNotificationObservation'],checkpoint,true) WHERE user_id=owner_id;
  RETURN NULL; -- cleanup evidence never grants continued provider execution
 END IF;
 IF EXISTS(SELECT 1 FROM public.account_deletion_tombstones WHERE user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex')) THEN RETURN NULL; END IF;
 previous:=metadata->'notificationCheckpoint';
 IF coalesce((previous->>'generation')::bigint,0)<>expected_generation THEN RETURN NULL; END IF;
 bound:=checkpoint;
 IF operation_kind='provision' AND checkpoint->>'step' IN ('gmail_runtime_configuration','gmail_direct_invoker','mail_subscription_configuration','watch_renew_job') THEN
  IF checkpoint->>'serviceUid' IS NOT NULL AND checkpoint->>'serviceUid' IS DISTINCT FROM metadata->'provisionAttempt'->'evidence'->'host_requested'->'creationAcknowledgement'->>'serviceUid' THEN RETURN NULL; END IF;
  bound:=jsonb_set(bound,'{serviceUid}',metadata->'provisionAttempt'->'evidence'->'host_requested'->'creationAcknowledgement'->'serviceUid',true);
 END IF;
 IF public.valid_personal_agent_notification_checkpoint(to_jsonb(current_row),bound,previous) IS DISTINCT FROM true THEN RETURN NULL; END IF;
 inventory:=public.notification_checkpoint_inventory(metadata->'substrateReceipt',bound);
 IF inventory IS NULL THEN RETURN NULL; END IF;
 notification_marker:=current_setting('hussh.notification_generation',true);
 PERFORM set_config('hussh.notification_generation',expected_generation::text,true);
 marker:=current_setting('hussh.provision_attempt',true);
 PERFORM set_config('hussh.provision_attempt',coalesce(metadata->'provisionAttempt'->>'attemptId',''),true);
 UPDATE public.personal_agent_registry SET backend_metadata=backend_metadata||jsonb_build_object('notificationCheckpoint',bound,'substrateReceipt',inventory) WHERE user_id=owner_id;
 PERFORM set_config('hussh.provision_attempt',coalesce(marker,''),true);
 PERFORM set_config('hussh.notification_generation',coalesce(notification_marker,''),true);
 RETURN jsonb_build_object('checkpoint',bound,'inventory',inventory);
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_personal_agent_erasure_registry()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE reservation jsonb; snapshot jsonb;
BEGIN
  IF TG_OP='DELETE' AND public.personal_agent_erasure_archived(OLD.user_id,OLD.backend_metadata->'erasure') IS TRUE THEN RETURN OLD; END IF;
  IF OLD.backend_metadata ? 'erasure' THEN
    reservation := OLD.backend_metadata->'erasure';
    snapshot := reservation->'registrySnapshot';

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
$$;

CREATE OR REPLACE FUNCTION public.effective_erasure_substrate_inventory(r jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE inventory jsonb:=r->'registrySnapshot'->'backend_metadata'->'substrateReceipt';
 observation jsonb:=r->'lateFilesUpgradeObservation'; result jsonb; item jsonb; values_array jsonb;
BEGIN
 -- 956: merge the frozen notification intent and the one qualified late receipt.
 IF r->'registrySnapshot'->'backend_metadata' ? 'notificationCheckpoint' THEN
  inventory:=public.notification_checkpoint_inventory(inventory,r->'registrySnapshot'->'backend_metadata'->'notificationCheckpoint');
 END IF;
 IF r ? 'lateNotificationObservation' THEN
  IF public.valid_erasure_notification_observation(r,r->'lateNotificationObservation') IS DISTINCT FROM true THEN RETURN NULL; END IF;
  inventory:=public.notification_checkpoint_inventory(inventory,r->'lateNotificationObservation');
 END IF;
 IF inventory IS NULL OR observation IS NULL THEN RETURN inventory; END IF;
 IF public.valid_erasure_files_upgrade_observation(r,observation) IS DISTINCT FROM true THEN RETURN NULL; END IF;
 result:=observation->'completed'->-1;
 IF result ? 'resourceObservation' THEN
  item:=result->'resourceObservation'; values_array:=coalesce(inventory->'resourceObservations','[]'::jsonb);
  IF NOT values_array @> jsonb_build_array(item) THEN values_array:=values_array||jsonb_build_array(item); END IF;
  inventory:=jsonb_set(inventory,'{resourceObservations}',values_array,true);
 END IF;
 IF result ? 'bindingObservations' THEN
  values_array:=coalesce(inventory->'bindingObservations','[]'::jsonb);
  FOR item IN SELECT value FROM jsonb_array_elements(result->'bindingObservations') LOOP
   IF NOT values_array @> jsonb_build_array(item) THEN values_array:=values_array||jsonb_build_array(item); END IF;
  END LOOP;
  inventory:=jsonb_set(inventory,'{bindingObservations}',values_array,true);
 END IF;
 RETURN inventory;
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_erasure_substrate_inventory(reservation jsonb, inventory jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
BEGIN
 -- 956: do not freeze cleanup inventory while a notification mutation is in flight.
 IF reservation->'registrySnapshot'->'backend_metadata'->'notificationCheckpoint'->>'phase'='intent'
    AND NOT (reservation ? 'lateNotificationObservation') THEN RETURN false; END IF;
 IF jsonb_typeof(inventory) IS DISTINCT FROM 'object'
    OR inventory IS DISTINCT FROM public.effective_erasure_substrate_inventory(reservation)
    OR inventory->>'version' IS DISTINCT FROM 'byoc.substrate.receipt.v1'
    OR jsonb_typeof(inventory->'plannedResources') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(inventory->'plannedResources')=0 THEN RETURN false; END IF;
 RETURN coalesce(public.valid_erasure_compute_receipt(reservation,'computeDeletion',reservation->'computeDeletion'),false);
END;
$$;

-- 956: exact resource state; legacy receipts never alias a second resource.
CREATE OR REPLACE FUNCTION public.erasure_mail_resource_state(r jsonb, kind text, resource_id text)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT CASE WHEN r->'mailErasure'->kind->'resources' ? resource_id THEN r->'mailErasure'->kind->'resources'->resource_id
 WHEN r->'mailErasure'->kind->'admission'->'resourceObservation'->>'id'=resource_id THEN (r->'mailErasure'->kind)-'resources'
 ELSE '{}'::jsonb END;
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

CREATE OR REPLACE FUNCTION public.valid_erasure_mail_append(before_record jsonb, after_record jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE kind text; stage text; old_mail jsonb; new_mail jsonb; old_kind jsonb; new_kind jsonb; resource_id text; old_resources jsonb; new_resources jsonb; prior jsonb; incoming jsonb;
BEGIN
 old_mail:=coalesce(before_record->'mailErasure','{}'::jsonb); new_mail:=after_record->'mailErasure';
 IF jsonb_typeof(new_mail) IS DISTINCT FROM 'object' OR after_record-'mailErasure' IS DISTINCT FROM before_record-'mailErasure' THEN RETURN false; END IF;
 FOREACH kind IN ARRAY ARRAY['cloud_scheduler_job','pubsub_subscription','pubsub_topic'] LOOP
  old_kind:=coalesce(old_mail->kind,'{}'::jsonb); new_kind:=new_mail->kind;
  -- 956: append one stage of one exact resource, preserving every sibling.
  old_resources:=coalesce(old_kind->'resources','{}'::jsonb); new_resources:=new_kind->'resources';
  IF new_kind-'resources'=old_kind-'resources' AND jsonb_typeof(new_resources)='object'
   AND new_mail-kind=old_mail-kind THEN
   FOR resource_id,incoming IN SELECT * FROM jsonb_each(new_resources) LOOP
    prior:=coalesce(old_resources->resource_id,'{}'::jsonb);
    IF new_resources-resource_id IS DISTINCT FROM old_resources-resource_id THEN CONTINUE; END IF;
    FOREACH stage IN ARRAY ARRAY['admission','acknowledgement','deletion'] LOOP
     IF NOT (prior ? stage) AND incoming-stage=prior
      AND incoming->stage->'resourceObservation'->>'id'=resource_id
      AND public.valid_erasure_mail_receipt(before_record,kind,stage,incoming->stage) IS TRUE THEN RETURN true; END IF;
    END LOOP;
   END LOOP;
  END IF;
  FOREACH stage IN ARRAY ARRAY['admission','acknowledgement','deletion'] LOOP
   IF NOT (old_kind ? stage) AND new_kind ? stage AND new_mail-kind=old_mail-kind
      AND new_kind-stage=old_kind AND public.valid_erasure_mail_receipt(before_record,kind,stage,new_kind->stage) IS TRUE THEN RETURN true; END IF;
  END LOOP;
 END LOOP;
 RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.retain_erasure_mail_receipt(
 owner_id text, attempt_id text, expected jsonb, kind text, stage text, receipt jsonb
) RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE current_row public.personal_agent_registry%ROWTYPE; reservation jsonb; resource_id text:=receipt->'resourceObservation'->>'id'; states jsonb; incoming jsonb; kind_state jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 reservation := current_row.backend_metadata->'erasure';
 IF reservation->>'ownerId' IS DISTINCT FROM owner_id OR reservation->>'attemptId' IS DISTINCT FROM attempt_id
    OR public.valid_erasure_mail_receipt(reservation,kind,stage,receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
    AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
    AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
    AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
 states:=public.erasure_mail_resource_state(reservation,kind,resource_id);
 IF states ? stage THEN
   RETURN stage <> 'admission' AND states->stage=receipt;
 END IF;
 IF reservation IS DISTINCT FROM expected THEN RETURN false; END IF;
 -- 956: new receipts use exact IDs; an existing single-resource legacy state stays compatible.
 kind_state:=coalesce(reservation->'mailErasure'->kind,'{}'::jsonb);
 IF kind_state->'admission'->'resourceObservation'->>'id'=resource_id OR (kind_state='{}'::jsonb AND (SELECT count(*) FROM jsonb_array_elements(reservation->'substrateInventory'->'plannedResources') x WHERE x->>'type'=kind)=1) THEN
  kind_state:=kind_state||jsonb_build_object(stage,receipt);
 ELSE
  kind_state:=kind_state||jsonb_build_object('resources',coalesce(kind_state->'resources','{}'::jsonb)||jsonb_build_object(resource_id,states||jsonb_build_object(stage,receipt)));
 END IF;
 incoming:=coalesce(reservation->'mailErasure','{}'::jsonb)||jsonb_build_object(kind,kind_state);
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,ARRAY['erasure','mailErasure'],incoming,true)
 WHERE user_id=owner_id;
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.erasure_mail_resources_deleted(r jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE item jsonb; kind text; states jsonb;
BEGIN
 IF jsonb_typeof(r->'substrateInventory'->'plannedResources') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 FOREACH kind IN ARRAY ARRAY['cloud_scheduler_job','pubsub_subscription','pubsub_topic'] LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'substrateInventory'->'plannedResources') x WHERE x->>'type'=kind) THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(r->'substrateInventory'->'plannedResources') x WHERE x->>'type'=kind LOOP
   states:=public.erasure_mail_resource_state(r,kind,item->>'id');
   IF public.valid_erasure_mail_receipt(r,kind,'deletion',states->'deletion') IS DISTINCT FROM true THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 RETURN true;
END;
$$;


CREATE OR REPLACE FUNCTION public.valid_erasure_kms_receipt(r jsonb, stage text, receipt jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE obs jsonb; ident jsonb; inv jsonb; captured jsonb; version_name text; key_name text; kind text;
BEGIN
 IF stage IS NULL OR stage NOT IN ('inventory','admission','acknowledgement','destruction','completion')
 OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
 OR public.valid_erasure_bucket_receipt(r,'bucketDeletion',r->'bucketDeletion') IS DISTINCT FROM true THEN RETURN false; END IF;
 -- 956: every independently named mail resource must be deleted before key destruction.
 IF public.erasure_mail_resources_deleted(r) IS DISTINCT FROM true THEN RETURN false; END IF;
 inv:=r->'substrateInventory'; obs:=receipt->'resourceObservation'; ident:=obs->'identity';
 key_name:='projects/' || (r->'registrySnapshot'->>'user_cloud_project') || '/locations/' || (r->'registrySnapshot'->>'user_cloud_region') || '/keyRings/hushh-one/cryptoKeys/' || (obs->>'id');
 IF receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR jsonb_typeof(obs) IS DISTINCT FROM 'object' OR obs - ARRAY['type','id','disposition','identity'] <> '{}'::jsonb
 OR obs->>'type' IS DISTINCT FROM 'kms_key' OR obs->>'disposition' IS DISTINCT FROM 'created'
 OR obs->>'id' IS NULL OR obs->>'id' !~ '^[A-Za-z0-9_-]{1,63}$'
 OR jsonb_typeof(ident) IS DISTINCT FROM 'object' OR ident - ARRAY['name','purpose','createTime'] <> '{}'::jsonb
 OR key_name IS NULL OR ident->>'name' IS DISTINCT FROM key_name OR ident->>'purpose' IS DISTINCT FROM 'ENCRYPT_DECRYPT'
 OR jsonb_typeof(ident->'createTime') IS DISTINCT FROM 'string' OR length(ident->>'createTime') NOT BETWEEN 1 AND 64
 OR (SELECT count(*) FROM jsonb_array_elements(inv->'plannedResources') x WHERE x->>'type'='kms_key') <> 1
 OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inv->'plannedResources') x WHERE x->>'type'='kms_key' AND x->>'id'=obs->>'id')
 OR (SELECT count(*) FROM jsonb_array_elements(inv->'resourceObservations') x WHERE x=obs) <> 1 THEN RETURN false; END IF;
 IF stage='inventory' THEN
  IF receipt - ARRAY['ownerId','attemptId','resourceObservation','versionNames'] <> '{}'::jsonb
  OR jsonb_typeof(receipt->'versionNames') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(receipt->'versionNames') > 32000 THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(receipt->'versionNames') x WHERE jsonb_typeof(x) <> 'string'
    OR left(x #>> '{}',length(key_name || '/cryptoKeyVersions/')) <> key_name || '/cryptoKeyVersions/'
    OR substring(x #>> '{}' FROM length(key_name || '/cryptoKeyVersions/')+1) !~ '^[0-9]{1,20}$') THEN RETURN false; END IF;
  RETURN (SELECT count(*)=count(DISTINCT x) FROM jsonb_array_elements(receipt->'versionNames') x);
 END IF;
 captured:=r->'kmsErasure'->'inventory';
 IF public.valid_erasure_kms_receipt(r,'inventory',captured) IS DISTINCT FROM true
 OR receipt->'resourceObservation' IS DISTINCT FROM captured->'resourceObservation' THEN RETURN false; END IF;
 IF stage='completion' THEN
  IF receipt - 'status' IS DISTINCT FROM captured OR receipt->>'status' IS DISTINCT FROM 'destroyed' THEN RETURN false; END IF;
  FOR version_name IN SELECT jsonb_array_elements_text(captured->'versionNames') LOOP
   IF public.valid_erasure_kms_receipt(r,'destruction',r->'kmsErasure'->'versions'->version_name->'destruction') IS DISTINCT FROM true THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
 END IF;
 version_name:=receipt->>'versionName';
 IF receipt - ARRAY['ownerId','attemptId','resourceObservation','versionName','status'] <> '{}'::jsonb
 OR version_name IS NULL OR NOT (captured->'versionNames' ? version_name) THEN RETURN false; END IF;
 IF stage='admission' THEN RETURN receipt->>'status'='admitted'; END IF;
 IF stage='destruction' THEN RETURN receipt->>'status'='destroyed'; END IF;
 RETURN receipt->>'status'='scheduled'
 AND public.valid_erasure_kms_receipt(r,'admission',r->'kmsErasure'->'versions'->version_name->'admission') IS TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.verify_erasure_kms_preflight(owner_id text, attempt_id text, expected jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT public.verify_erasure_mail_preflight(owner_id,attempt_id,expected)
 AND public.valid_erasure_bucket_receipt(expected,'bucketDeletion',expected->'bucketDeletion') IS TRUE
 -- 956: exact per-resource closure, including both direct and DLQ subscriptions.
 AND public.erasure_mail_resources_deleted(expected) IS TRUE;
$$;

CREATE OR REPLACE FUNCTION public.erasure_planned_resources_covered(r jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE planned jsonb:=r->'substrateInventory'->'plannedResources'; item jsonb; receipt jsonb;
 kind text; captured_id text; wanted_status text;
BEGIN
 -- Coverage supplements existing immutable receipt validation; it never grants deletion authority.
 IF jsonb_typeof(planned) IS DISTINCT FROM 'array' OR jsonb_array_length(planned) NOT BETWEEN 1 AND 1024
 OR (SELECT count(*)<>count(DISTINCT x) FROM jsonb_array_elements(planned) x) THEN RETURN false; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(planned) LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item-ARRAY['type','id']<>'{}'::jsonb
   OR jsonb_typeof(item->'id') IS DISTINCT FROM 'string' OR length(item->>'id')=0 THEN RETURN false; END IF;
  kind:=item->>'type'; receipt:=NULL; captured_id:=NULL; wanted_status:=NULL;
  CASE kind
   WHEN 'cloud_run_service' THEN
    receipt:=r->'computeDeletion'; captured_id:=split_part(receipt->>'serviceName','/',6); wanted_status:='compute_deleted';
   WHEN 'gcs_bucket' THEN
    receipt:=r->'bucketDeletion'; captured_id:=receipt->'bucketIdentity'->>'name'; wanted_status:='deleted';
   WHEN 'service_account' THEN
    IF item->>'id'=r->'writerDisabled'->'runtimeIdentity'->>'email' THEN
     receipt:=r->'accountErasure'->'deletion';
    ELSE
     receipt:=r->'filesErasure'->'worker'->'deletion';
     IF public.valid_erasure_files_receipt(r,'worker','deletion',receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
    END IF;
    captured_id:=receipt->'resourceObservation'->>'id'; wanted_status:='absent';
   WHEN 'cloud_tasks_queue' THEN
    receipt:=r->'filesErasure'->'queue'->'deletion';
    IF public.valid_erasure_files_receipt(r,'queue','deletion',receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
    captured_id:=receipt->'resourceObservation'->>'id'; wanted_status:='absent';
   WHEN 'kms_key' THEN
    receipt:=r->'kmsErasure'->'completion'; captured_id:=receipt->'resourceObservation'->>'id'; wanted_status:='destroyed';
   WHEN 'secret' THEN
    receipt:=r->'secretErasure'->'deletion'; captured_id:=receipt->'resourceObservation'->>'id'; wanted_status:='absent';
   WHEN 'artifact_repository' THEN
    receipt:=r->'repositoryRetention'; captured_id:=split_part(receipt->'repositoryIdentity'->>'name','/',6);
    IF receipt->>'disposition' IS DISTINCT FROM 'retained_shared' THEN RETURN false; END IF;
   WHEN 'cloud_scheduler_job','pubsub_subscription','pubsub_topic' THEN
    -- 956: exact ID; a sibling receipt never covers this resource.
    receipt:=public.erasure_mail_resource_state(r,kind,item->>'id')->'deletion';
    captured_id:=receipt->'resourceObservation'->>'id'; wanted_status:='absent';
   ELSE RETURN false;
  END CASE;
  IF captured_id IS DISTINCT FROM item->>'id' OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
   OR (wanted_status IS NOT NULL AND receipt->>'status' IS DISTINCT FROM wanted_status) THEN RETURN false; END IF;
  -- Compute receipts are bound through the existing compute admission contract.
  IF kind<>'cloud_run_service' AND (receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId'
   OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId') THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END;
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

CREATE OR REPLACE FUNCTION public.notification_checkpoint_admission_ready()
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT to_regprocedure('public.publish_personal_agent_notification_checkpoint(text,text,text,text,bigint,jsonb)') IS NOT NULL
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
  AND tgname='zy_personal_agent_provision_registry' AND tgenabled IN ('O','A') AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
  AND tgfoid='public.guard_personal_agent_provision_registry()'::regprocedure)
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
  AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A') AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
  AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure)
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
  AND tgname='zx_personal_agent_notification_registry' AND tgenabled IN ('O','A') AND tgtype=19 AND tgnargs=0 AND tgqual IS NULL
  AND tgfoid='public.guard_personal_agent_notification_registry()'::regprocedure)
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
  AND tgname='zz_personal_agent_notification_retention' AND tgenabled IN ('O','A') AND tgtype=25 AND tgnargs=0 AND tgqual IS NULL
  AND tgdeferrable AND tginitdeferred AND tgfoid='public.guard_personal_agent_notification_retention()'::regprocedure)
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_standby_placements'::regclass
  AND tgname='zz_personal_agent_notification_standby_retention' AND tgenabled IN ('O','A') AND tgtype=25 AND tgnargs=0 AND tgqual IS NULL
  AND tgdeferrable AND tginitdeferred AND tgfoid='public.guard_personal_agent_notification_standby_retention()'::regprocedure)
 AND to_regprocedure('public.notification_placement_custody(jsonb)') IS NOT NULL
 AND to_regprocedure('public.notification_erasure_custody_archived(text,jsonb,jsonb)') IS NOT NULL
 AND to_regprocedure('public.valid_personal_agent_notification_checkpoint(jsonb,jsonb,jsonb)') IS NOT NULL
 AND to_regprocedure('public.notification_checkpoint_inventory(jsonb,jsonb)') IS NOT NULL
 AND position('notification_checkpoint_inventory' IN pg_get_functiondef('public.effective_erasure_substrate_inventory(jsonb)'::regprocedure))>0
 AND position('lateNotificationObservation' IN pg_get_functiondef('public.valid_erasure_substrate_inventory(jsonb,jsonb)'::regprocedure))>0
 AND position('valid_erasure_notification_observation' IN pg_get_functiondef('public.guard_personal_agent_erasure_registry()'::regprocedure))>0
 AND to_regprocedure('public.erasure_mail_resource_state(jsonb,text,text)') IS NOT NULL
 AND to_regprocedure('public.erasure_mail_resources_deleted(jsonb)') IS NOT NULL
 AND position('erasure_mail_resource_state' IN pg_get_functiondef('public.valid_erasure_mail_receipt(jsonb,text,text,jsonb)'::regprocedure))>0
 AND position('resources' IN pg_get_functiondef('public.valid_erasure_mail_append(jsonb,jsonb)'::regprocedure))>0
 AND position('erasure_mail_resources_deleted' IN pg_get_functiondef('public.valid_erasure_kms_receipt(jsonb,text,jsonb)'::regprocedure))>0
 AND position('erasure_mail_resources_deleted' IN pg_get_functiondef('public.verify_erasure_kms_preflight(text,text,jsonb)'::regprocedure))>0
 AND position('erasure_mail_resource_state' IN pg_get_functiondef('public.erasure_planned_resources_covered(jsonb)'::regprocedure))>0
 AND position('resourcesByKind' IN pg_get_functiondef('public.personal_agent_erasure_archive(jsonb,jsonb)'::regprocedure))>0;
$$;
COMMIT;
