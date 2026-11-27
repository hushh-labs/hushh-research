-- Accept provider-valid six-to-thirty-character owner service-account IDs.
-- Keep the exact owner plan, operator-topic custody, and all project/service guards.
BEGIN;

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
 OR coalesce(plan->>'bootstrapAccount','') !~ ('^[a-z][a-z0-9-]{4,28}[a-z0-9]@'||project||'[.]iam[.]gserviceaccount[.]com$')
 OR plan->>'service' IS DISTINCT FROM service
 OR coalesce(plan->>'runtimeAccount','') !~ ('^[a-z][a-z0-9-]{4,28}[a-z0-9]@'||project||'[.]iam[.]gserviceaccount[.]com$')
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
  jsonb_build_object('type','cloud_scheduler_job','id',stem||'-watch-renew'))
 AND plan->'plannedResources' IS DISTINCT FROM (jsonb_build_array(
  jsonb_build_object('type','pubsub_topic','id',stem||'-dead-letter'),
  jsonb_build_object('type','pubsub_subscription','id',stem||'-direct-sub'),
  jsonb_build_object('type','pubsub_subscription','id',stem||'-dead-letter-sub'),
  jsonb_build_object('type','cloud_scheduler_job','id',stem||'-watch-renew'))||jsonb_build_array(
  jsonb_build_object('type','pubsub_topic','id','projects/'||(plan->>'oauthProject')||'/topics/'||stem))) THEN RETURN false; END IF;
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
  IF (approval->'version' IS DISTINCT FROM '1'::jsonb AND public.valid_gcp_browser_update_approval(snapshot,approval) IS NOT TRUE) OR approval->>'ownerId' IS DISTINCT FROM snapshot->>'user_id'
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
   IF result->>'step'='oauth_mail_topic' AND jsonb_array_length(plan->'plannedResources')=5
    AND NOT(result ? 'resourceObservation') THEN RETURN false; END IF;
   IF result->>'step' IN ('gmail_runtime_configuration','gmail_direct_invoker','mail_subscription_configuration') AND NOT(result ? 'configurationObservation') THEN RETURN false; END IF;
   IF result->>'step'='watch_renew_job' AND NOT(result ?| ARRAY['resourceObservation','configurationObservation']) THEN RETURN false; END IF;
  END IF;
  resource:=result->'resourceObservation';
  IF resource IS NOT NULL THEN
   IF resource-ARRAY['type','id','disposition','identity']<>'{}'::jsonb OR resource->>'disposition' IS DISTINCT FROM 'created'
    OR NOT plan->'plannedResources' @> jsonb_build_array(jsonb_build_object('type',resource->>'type','id',resource->>'id')) THEN RETURN false; END IF;
   ident:=resource->'identity';
   CASE result->>'step'
    WHEN 'oauth_mail_topic' THEN expected_name:='projects/'||(plan->>'oauthProject')||'/topics/'||stem;
     IF resource->>'type' IS DISTINCT FROM 'pubsub_topic' OR ident IS DISTINCT FROM jsonb_build_object('name',expected_name) THEN RETURN false; END IF;
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
   IF resource->>'id' IS DISTINCT FROM (CASE WHEN result->>'step'='oauth_mail_topic' THEN expected_name ELSE regexp_replace(expected_name,'^.*/','') END) THEN RETURN false; END IF;
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

REVOKE ALL ON FUNCTION public.valid_personal_agent_notification_checkpoint(jsonb,jsonb,jsonb) FROM PUBLIC;
DO $grant_notification_checkpoint$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  GRANT EXECUTE ON FUNCTION public.valid_personal_agent_notification_checkpoint(jsonb,jsonb,jsonb) TO service_role;
 END IF;
END;
$grant_notification_checkpoint$;
COMMIT;
