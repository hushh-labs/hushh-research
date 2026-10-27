BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.hosted_pod_pilot_policy) THEN
  RAISE EXCEPTION 'retain admitted managed custody; use forward recovery';
 END IF;
END; $$;
CREATE OR REPLACE FUNCTION public.expected_erasure_bootstrap_release(owner_id text, r jsonb, recovery_member text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE history jsonb; job record; identity jsonb; binding jsonb; groups jsonb:='{}'::jsonb;
 g jsonb; k text; target_project text; recovery_key text; n integer:=0;
BEGIN
 -- 954: a never-hosted reservation has no planned resources and no repository; its
 -- re-derived receipt stands in for both. Every other reservation is unchanged.
 IF public.erasure_never_hosted_admitted(owner_id,r) IS DISTINCT FROM true THEN
 IF public.erasure_planned_resources_covered(r) IS DISTINCT FROM true THEN RETURN NULL; END IF;
 IF public.valid_erasure_repository_retention(r,r->'repositoryRetention') IS DISTINCT FROM true THEN RETURN NULL; END IF;
 END IF;
 target_project:=r->'registrySnapshot'->>'user_cloud_project';
 SELECT authorization_attempts INTO history FROM public.byoc_setup_jobs WHERE user_id=owner_id;
 IF jsonb_typeof(history) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 FOR job IN SELECT key,value FROM jsonb_each(history) ORDER BY key LOOP
  IF job.value->'intent'->>'project' IS DISTINCT FROM target_project THEN CONTINUE; END IF;
  n:=n+1;
  IF n>1024 OR job.value->'intent'->>'ownerId' IS DISTINCT FROM owner_id
   OR job.value->'intent'->>'jobId' IS DISTINCT FROM job.key OR NOT (job.value ? 'receipt') THEN RETURN NULL; END IF;
  identity:=job.value->'receipt'->'bootstrapIdentity'; binding:=job.value->'receipt'->'bindingObservation';
  IF identity->>'projectId' IS DISTINCT FROM target_project OR binding->>'role' IS DISTINCT FROM 'roles/iam.serviceAccountTokenCreator'
   OR binding->>'member' IS DISTINCT FROM 'serviceAccount:'||(job.value->'intent'->>'callerEmail')
   OR (binding->>'disposition' IN ('added','already_present')) IS DISTINCT FROM true THEN RETURN NULL; END IF;
  k:=(identity->>'uniqueId')||'|'||(binding->>'member');
  IF k IS NULL THEN RETURN NULL; END IF;
  g:=groups->k;
  IF g IS NULL THEN g:=jsonb_build_object('jobIds','[]'::jsonb,'bootstrapIdentity',identity,'bindingObservation',NULL); END IF;
  IF g->'bootstrapIdentity' IS DISTINCT FROM identity THEN RETURN NULL; END IF;
  g:=jsonb_set(g,'{jobIds}',(g->'jobIds')||jsonb_build_array(job.key));
  IF binding->>'disposition'='added' AND g->'bindingObservation'='null'::jsonb THEN g:=jsonb_set(g,'{bindingObservation}',binding); END IF;
  groups:=jsonb_set(groups,ARRAY[k],g,true);
  IF binding->>'member'=recovery_member AND identity->>'email'=regexp_replace(r->'registrySnapshot'->>'user_cloud_bootstrap_sa','^serviceAccount:','') THEN
   IF recovery_key IS NOT NULL AND recovery_key<>k THEN RETURN NULL; END IF;
   recovery_key:=k;
  END IF;
 END LOOP;
 IF n=0 OR recovery_key IS NULL THEN RETURN NULL; END IF;
 FOR g IN SELECT value FROM jsonb_each(groups) LOOP
  IF g->'bindingObservation'='null'::jsonb THEN RETURN NULL; END IF;
 END LOOP;
 RETURN jsonb_build_object('ownerId',owner_id,'attemptId',r->>'attemptId','project',target_project,
  'groups',groups,'recoveryMember',recovery_member,'recoveryGrantKey',recovery_key,'status','reserved');
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_personal_agent_erasure_registry()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE reservation jsonb; snapshot jsonb;
BEGIN
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
$$;

CREATE OR REPLACE FUNCTION public.guard_project_grant_registry_admission()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
 IF TG_OP='INSERT' THEN
  -- ON CONFLICT acquires its existing row only after BEFORE INSERT. Match
  -- lifecycle admission's owner -> row -> project order before that happens.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id,171));
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id,198));
  PERFORM 1 FROM public.personal_agent_registry WHERE user_id=NEW.user_id FOR UPDATE;
  PERFORM public.assert_project_grant_admission(NEW.user_cloud_project);
 ELSIF NEW.user_cloud_project IS DISTINCT FROM OLD.user_cloud_project
 OR NEW.user_cloud_bootstrap_sa IS DISTINCT FROM OLD.user_cloud_bootstrap_sa
 OR NEW.backend_metadata->'upgradeLease' IS DISTINCT FROM OLD.backend_metadata->'upgradeLease' AND NEW.backend_metadata->>'upgradeLease' IS NOT NULL
 OR NEW.backend_metadata->'provisionAttempt'->>'attemptId' IS DISTINCT FROM OLD.backend_metadata->'provisionAttempt'->>'attemptId'
 THEN PERFORM public.assert_project_grant_admission(NEW.user_cloud_project);
 END IF;
 RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.personal_agent_erasure_archive(r jsonb, history jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
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
   || jsonb_strip_nulls(jsonb_build_object('neverHosted',r->'neverHosted'))
   || CASE WHEN jsonb_typeof(r->'azureTeardown')='object'
      THEN jsonb_build_object('azureCleanup',r->'azureTeardown',
       'agentCryptoErase',r->'agentCryptoErase','ownerAccessErasure',r->'ownerAccessErasure') ELSE '{}'::jsonb END
   || CASE WHEN jsonb_array_length(coalesce(r->'substrateInventory'->'operatorBindingObservations','[]'::jsonb))>0
    THEN jsonb_build_object('operatorNotificationCustody',jsonb_build_object(
     'bindings',r->'substrateInventory'->'operatorBindingObservations',
     'topics',(SELECT coalesce(jsonb_agg(x),'[]'::jsonb)
      FROM jsonb_array_elements(r->'substrateInventory'->'resourceObservations') x
      WHERE x->>'type'='pubsub_topic' AND starts_with(x->>'id','projects/'))))
    ELSE '{}'::jsonb END
   || CASE WHEN r->'runtimeGrantErasure' ? 'quota'
    THEN jsonb_build_object('runtimeQuotaGrantDeletion',r->'runtimeGrantErasure'->'quota'->'deletion') ELSE '{}'::jsonb END);
$function$;

CREATE OR REPLACE FUNCTION public.personal_agent_erasure_archived(owner_id text, r jsonb, history jsonb DEFAULT NULL::jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT jsonb_typeof(r)='object' AND r->>'ownerId'=owner_id AND coalesce(r->>'attemptId','')<>''
 AND (
  (EXISTS(SELECT 1 FROM public.personal_agent_deletion_tombstones t WHERE t.status='erasure_completed'
    AND t.metadata->>'ownerId'=owner_id AND t.hushh_id=r->>'hushhId' AND t.metadata->>'attemptId'=r->>'attemptId'
    AND t.metadata->>'reservationSha256'=encode(sha256(convert_to(r::text,'UTF8')),'hex')
    AND (history IS NULL OR t.metadata->>'authorizationHistorySha256'=encode(sha256(convert_to(history::text,'UTF8')),'hex')))
   AND EXISTS(SELECT 1 FROM public.account_deletion_tombstones WHERE cleanup_intent_kind='full_account'
    AND user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex')))
  OR (public.personal_agent_cloud_removal_ready() IS TRUE AND EXISTS(
   SELECT 1 FROM public.personal_agent_cloud_removals c WHERE c.user_id=owner_id AND c.attempt_id=r->>'attemptId'
    AND c.completed_at IS NOT NULL AND c.archive->>'hushhId'=r->>'hushhId'
    AND c.snapshot_sha256=encode(sha256(convert_to((r->'registrySnapshot')::text,'UTF8')),'hex')
    AND c.placement_epoch=(r->'registrySnapshot'->>'placement_epoch')::bigint
    AND c.archive->>'reservationSha256'=encode(sha256(convert_to(r::text,'UTF8')),'hex')
    AND (history IS NULL OR c.archive->>'authorizationHistorySha256'=encode(sha256(convert_to(history::text,'UTF8')),'hex')))))
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_deletion_tombstones'::regclass
  AND tgname='zz_personal_agent_erasure_archive' AND tgtype=31 AND tgenabled IN ('O','A')
  AND tgfoid='public.guard_personal_agent_erasure_archive()'::regprocedure AND tgnargs=0 AND tgqual IS NULL);
$function$;

CREATE OR REPLACE FUNCTION public.personal_agent_erasure_complete(owner_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE row_state public.personal_agent_registry%ROWTYPE; setup public.byoc_setup_jobs%ROWTYPE;
 r jsonb; release jsonb; expected_release jsonb; item record; stages jsonb; wanted jsonb;
 archive jsonb; table_name text; never_hosted boolean; azure_hosted boolean; group_scope text;
BEGIN
 IF owner_id IS NULL OR btrim(owner_id)='' OR current_setting('transaction_isolation')<>'read committed' THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO row_state FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR row_state.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 -- Own setup writers acquire their tuple before project205. Prelock it here,
 -- before project exclusivity, because finalization will delete it later.
 SELECT * INTO setup FROM public.byoc_setup_jobs WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 r:=row_state.backend_metadata->'erasure'; release:=r->'bootstrapGrantRelease';
 azure_hosted:=coalesce(r->'registrySnapshot'->>'deployment_target'='user_azure',false)
  OR public.azure_setup_never_deployed(owner_id,r->'registrySnapshot') IS TRUE;
 IF (NOT azure_hosted AND setup.status IS DISTINCT FROM 'recorded')
 OR (azure_hosted AND setup.status NOT IN ('recorded','failed')) THEN RETURN false; END IF;
 -- 954: a never-hosted reservation completes only on its SQL-re-derived evidence.
 never_hosted:=coalesce(r ? 'neverHosted',false);
 IF never_hosted AND public.erasure_never_hosted_admitted(owner_id,r) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR r->'registrySnapshot'->>'user_id' IS DISTINCT FROM owner_id
 OR r->>'hushhId' IS DISTINCT FROM row_state.hushh_id OR row_state.hushh_id IS NULL OR row_state.hushh_id=''
 OR r->>'attemptId' IS NULL OR r->>'attemptId'=''
 OR (NOT azure_hosted AND jsonb_typeof(release) IS DISTINCT FROM 'object')
 OR r ?| ARRAY['lateUpgradeAcknowledgement','lateProvisionAcknowledgement']
 OR nullif(r->'registrySnapshot'->'backend_metadata'->>'upgradeLease','') IS NOT NULL
 OR (NOT azure_hosted AND NOT never_hosted AND r->'registrySnapshot'->'backend_metadata'->'provisionAttempt'->>'phase' IS DISTINCT FROM 'provisioned')
 OR (NOT azure_hosted AND setup.project_id IS DISTINCT FROM r->'registrySnapshot'->>'user_cloud_project') THEN RETURN false; END IF;
 IF azure_hosted THEN
  -- Nonblocking: actual workers hold206 until their real thread and exit persistence finish.
  IF (public.byoc_azure_worker_session_held(owner_id) IS TRUE
    AND r->'azureTeardown'->'worker'->'backendPid'=to_jsonb(pg_backend_pid()))
   OR NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,206))
   OR public.azure_erasure_resources_complete(owner_id,r) IS NOT TRUE THEN RETURN false; END IF;
  group_scope:=setup.project_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(group_scope,205));
  IF EXISTS(SELECT 1 FROM public.byoc_setup_jobs WHERE user_id<>owner_id AND project_id=group_scope)
   OR EXISTS(SELECT 1 FROM public.personal_agent_registry WHERE user_id<>owner_id
    AND '/subscriptions/'||user_cloud_subscription_id||'/resourceGroups/'||user_cloud_resource_group=group_scope)
  THEN RETURN false; END IF;
 ELSE
  IF public.project_grant_release_is_exclusive(owner_id,r->'grantRelease'->>'project') IS DISTINCT FROM true THEN RETURN false; END IF;
 END IF;
 -- The canonical identity barrier must cover late registry/setup/log/migration insertion.
 FOREACH table_name IN ARRAY ARRAY['personal_agent_registry','byoc_setup_jobs','pod_lifecycle_events','pod_migration_jobs'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||table_name)::regclass
   AND tgname='trg_reject_deleted_account_insert' AND tgtype=7 AND tgenabled IN ('O','A')
   AND tgfoid='public.reject_deleted_account_identity_write()'::regprocedure
   AND tgnargs=1 AND tgargs=decode('757365725f696400','hex') AND tgqual IS NULL) THEN RETURN false; END IF;
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_deletion_tombstones'::regclass
  AND tgname='zz_personal_agent_erasure_archive' AND tgtype=31 AND tgenabled IN ('O','A')
  AND tgfoid='public.guard_personal_agent_erasure_archive()'::regprocedure AND tgqual IS NULL AND tgnargs=0) THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM public.pod_migration_jobs WHERE user_id=owner_id)
 OR EXISTS (SELECT 1 FROM public.pod_lifecycle_events WHERE user_id=owner_id AND hushh_id IS NOT NULL AND hushh_id<>row_state.hushh_id)
 OR jsonb_typeof(setup.authorization_attempts) IS DISTINCT FROM 'object'
 OR EXISTS (SELECT 1 FROM jsonb_each(setup.authorization_attempts) h
   WHERE h.value->'intent'->>'project' IS DISTINCT FROM setup.project_id OR NOT h.value ? 'receipt') THEN RETURN false; END IF;
 IF NOT azure_hosted THEN
 IF NOT never_hosted AND (public.erasure_planned_resources_covered(r) IS DISTINCT FROM true
 OR public.valid_erasure_repository_grant_receipt(r,'deletion',r->'repositoryGrantErasure'->'deletion') IS DISTINCT FROM true
 OR public.valid_erasure_repository_retention(r,r->'repositoryRetention') IS DISTINCT FROM true) THEN RETURN false; END IF;
 expected_release:=public.expected_erasure_bootstrap_release(owner_id,r,release->>'recoveryMember');
 IF expected_release IS NULL OR release IS DISTINCT FROM expected_release
 OR jsonb_typeof(r->'bootstrapGrantErasure') IS DISTINCT FROM 'object'
 OR (SELECT array_agg(key ORDER BY key) FROM jsonb_each(r->'bootstrapGrantErasure')) IS DISTINCT FROM
    (SELECT array_agg(key ORDER BY key) FROM jsonb_each(release->'groups')) THEN RETURN false; END IF;
 FOR item IN SELECT * FROM jsonb_each(release->'groups') LOOP
  stages:=r->'bootstrapGrantErasure'->item.key;
  wanted:=jsonb_build_object('ownerId',owner_id,'attemptId',r->>'attemptId',
   'bootstrapIdentity',item.value->'bootstrapIdentity','bindingObservation',item.value->'bindingObservation');
  IF jsonb_typeof(stages) IS DISTINCT FROM 'object' OR stages-ARRAY['admission','acknowledgement','deletion']<>'{}'::jsonb
   OR stages->'admission' IS DISTINCT FROM wanted||jsonb_build_object('status','admitted')
   OR stages->'deletion' IS DISTINCT FROM wanted||jsonb_build_object('status','observed_absent')
   OR (stages ? 'acknowledgement' AND stages->'acknowledgement' IS DISTINCT FROM wanted||jsonb_build_object('status','acknowledged')) THEN RETURN false; END IF;
 END LOOP;
 END IF;
 archive:=public.personal_agent_erasure_archive(r,setup.authorization_attempts);
 IF octet_length(archive::text)>2097152 THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM public.personal_agent_deletion_tombstones t WHERE
  (t.hushh_id=row_state.hushh_id OR t.metadata->>'ownerId'=owner_id OR t.metadata->>'user_id'=owner_id)
  AND (t.status IS DISTINCT FROM 'erasure_completed' OR t.metadata IS DISTINCT FROM archive
       OR t.external_agent_id IS DISTINCT FROM row_state.external_agent_id)) THEN RETURN false; END IF;
 RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.project_grant_release_is_exclusive(owner_id text, target_project text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
 IF target_project IS NULL OR target_project !~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$' OR current_setting('transaction_isolation') <> 'read committed' THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(target_project,205));
 IF (SELECT count(*) FROM pg_trigger WHERE
  (tgrelid='public.personal_agent_registry'::regclass AND tgname='zx_project_grant_registry' AND tgfoid='public.guard_project_grant_registry_admission()'::regprocedure AND tgtype=23)
  OR (tgrelid='public.byoc_setup_jobs'::regclass AND tgname='zx_project_grant_setup' AND tgfoid='public.guard_project_grant_setup_admission()'::regprocedure AND tgtype=23)
  OR (tgrelid='public.personal_agent_registry'::regclass AND tgname='zz_personal_agent_erasure_registry' AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure AND tgtype=27)
  OR (tgrelid='public.byoc_setup_jobs'::regclass AND tgname='zz_byoc_authorization_attempts' AND tgfoid='public.guard_byoc_authorization_attempts()'::regprocedure AND tgtype=31)) <> 4 THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('zx_project_grant_registry','zx_project_grant_setup','zz_personal_agent_erasure_registry','zz_byoc_authorization_attempts') AND tgrelid IN ('public.personal_agent_registry'::regclass,'public.byoc_setup_jobs'::regclass) AND (tgenabled NOT IN ('O','A') OR tgnargs<>0 OR tgqual IS NOT NULL)) THEN RETURN false; END IF;
 -- Never lock other owners' rows under the project lock. Unresolved users retain grants.
 IF EXISTS (SELECT 1 FROM public.personal_agent_registry x WHERE x.user_id<>owner_id AND
   (x.user_cloud_project=target_project OR x.backend_metadata->'provisionAttempt'->'intent'->>'user_cloud_project'=target_project))
 OR EXISTS (SELECT 1 FROM public.byoc_setup_jobs j WHERE j.project_id=target_project AND (j.user_id<>owner_id OR j.status IS DISTINCT FROM 'recorded')) THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM public.byoc_setup_jobs j CROSS JOIN LATERAL jsonb_each(j.authorization_attempts) a WHERE a.value->'intent'->>'project'=target_project AND (j.user_id<>owner_id OR NOT (a.value ? 'receipt'))) THEN RETURN false; END IF;
 RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reserve_erasure_grant_release(owner_id text, attempt_id text, expected jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE current_row public.personal_agent_registry%ROWTYPE; r jsonb; project_id text; receipt jsonb;
BEGIN
 IF current_setting('transaction_isolation') <> 'read committed' THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 r:=current_row.backend_metadata->'erasure'; project_id:=r->'registrySnapshot'->>'user_cloud_project';
 receipt:=jsonb_build_object('ownerId',owner_id,'attemptId',attempt_id,'project',project_id,'status','reserved');
 IF public.valid_erasure_grant_release(r,receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(project_id,205));
 IF NOT public.project_grant_release_is_exclusive(owner_id,project_id) THEN RETURN false; END IF;
 IF r ? 'grantRelease' THEN RETURN r->'grantRelease'=receipt; END IF;
 IF r IS DISTINCT FROM expected THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,ARRAY['erasure','grantRelease'],receipt,true) WHERE user_id=owner_id;
 RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reserve_personal_agent_erasure(owner_id text, attempt_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  current_row public.personal_agent_registry%ROWTYPE;
  reservation jsonb;
BEGIN
  IF owner_id IS NULL OR btrim(owner_id) = '' OR attempt_id IS NULL OR btrim(attempt_id) = '' THEN
    RAISE EXCEPTION 'invalid personal agent erasure admission' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id, 171));
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id, 198));
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
      AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
      AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
      AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.consent_audit'::regclass
      AND tgname='zy_personal_agent_erasure_grant' AND tgenabled IN ('O','A')
      AND tgtype=7 AND tgnargs=0 AND tgqual IS NULL
      AND tgfoid='public.guard_personal_agent_erasure_grant()'::regprocedure
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.consent_audit'::regclass
      AND tgname='trg_reject_deleted_account_insert' AND tgenabled IN ('O','A')
      AND tgfoid='public.reject_deleted_account_identity_write()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'personal agent erasure guards unavailable' USING ERRCODE='42501';
  END IF;
  SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id = owner_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'personal agent erasure registry unavailable' USING ERRCODE = '42501';
  END IF;
  IF current_row.backend_metadata IS NOT NULL AND jsonb_typeof(current_row.backend_metadata) <> 'object' THEN
    RAISE EXCEPTION 'personal agent erasure metadata invalid' USING ERRCODE = '42501';
  END IF;
  IF current_row.backend_metadata ? 'erasure' THEN
    RETURN current_row.backend_metadata->'erasure';
  END IF;
  reservation := jsonb_build_object(
    'version', 1, 'ownerId', owner_id, 'attemptId', attempt_id,
    'hushhId', current_row.hushh_id, 'phase', 'reserved',
    'registrySnapshot', to_jsonb(current_row)
  );
  UPDATE public.personal_agent_registry SET
    backend_metadata = coalesce(backend_metadata, '{}'::jsonb) || jsonb_build_object('erasure', reservation),
    status = 'suspended', updated_at = clock_timestamp()
  WHERE user_id = owner_id;
  RETURN reservation;
END;
$function$;

CREATE OR REPLACE FUNCTION public.valid_erasure_files_receipt(r jsonb, kind text, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE inv jsonb:=r->'substrateInventory'; obs jsonb:=receipt->'resourceObservation'; identity jsonb:=obs->'identity';
 project text:=r->'registrySnapshot'->>'user_cloud_project'; region text:=r->'registrySnapshot'->>'user_cloud_region';
 slug text:='one-files-'||left(encode(sha256(convert_to(r->>'hushhId','UTF8')),'hex'),20);
 rid text; rtype text; admitted jsonb;
BEGIN
 IF kind IS NULL OR kind NOT IN ('queue','worker') OR stage IS NULL OR stage NOT IN ('admission','quiescence','acknowledgement','deletion')
 OR public.valid_erasure_writer_receipt(r,'writerDisabled',r->'writerDisabled') IS DISTINCT FROM true
 OR public.valid_erasure_compute_receipt(r,'computeDeletion',r->'computeDeletion') IS DISTINCT FROM true
 OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
 OR receipt-ARRAY['ownerId','attemptId','resourceObservation','status']<>'{}'::jsonb
 OR receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR r->'registrySnapshot'->>'deployment_target' IS DISTINCT FROM 'user_gcp'
 OR project IS NULL OR region IS NULL OR slug IS NULL
 OR jsonb_typeof(obs) IS DISTINCT FROM 'object' OR obs-ARRAY['type','id','disposition','identity']<>'{}'::jsonb
 OR obs->>'disposition' IS DISTINCT FROM 'created' THEN RETURN false; END IF;
 rtype:=CASE kind WHEN 'queue' THEN 'cloud_tasks_queue' ELSE 'service_account' END;
 rid:=CASE kind WHEN 'queue' THEN slug ELSE slug||'@'||project||'.iam.gserviceaccount.com' END;
 IF obs->>'type' IS DISTINCT FROM rtype OR obs->>'id' IS DISTINCT FROM rid
 OR (SELECT count(*) FROM jsonb_array_elements(inv->'plannedResources') x WHERE x->>'type'=rtype AND x->>'id'=rid)<>1
 OR (SELECT count(*) FROM jsonb_array_elements(inv->'resourceObservations') x WHERE x=obs)<>1 THEN RETURN false; END IF;
 IF kind='queue' THEN
   IF identity IS DISTINCT FROM jsonb_build_object('name','projects/'||project||'/locations/'||region||'/queues/'||rid,
     'rateLimits',jsonb_build_object('maxDispatchesPerSecond',1,'maxConcurrentDispatches',1),
     'retryConfig',jsonb_build_object('maxAttempts',3,'maxRetryDuration','0s','minBackoff','10s','maxBackoff','60s','maxDoublings',2)) THEN RETURN false; END IF;
 ELSE
   IF jsonb_typeof(identity) IS DISTINCT FROM 'object' OR identity-ARRAY['name','email','projectId','uniqueId']<>'{}'::jsonb
    OR (identity->>'name' IS DISTINCT FROM 'projects/'||project||'/serviceAccounts/'||rid AND identity->>'name' IS DISTINCT FROM 'projects/'||project||'/serviceAccounts/'||(identity->>'uniqueId'))
    OR identity->>'email' IS DISTINCT FROM rid OR identity->>'projectId' IS DISTINCT FROM project
    OR (coalesce(identity->>'uniqueId','') !~ '^[0-9]{1,32}$' OR identity->>'uniqueId' !~ '[1-9]')
    OR identity->>'email'=r->'writerDisabled'->'runtimeIdentity'->>'email'
    OR public.valid_erasure_files_receipt(r,'queue','deletion',r->'filesErasure'->'queue'->'deletion') IS DISTINCT FROM true THEN RETURN false; END IF;
 END IF;
 IF stage='admission' THEN RETURN receipt->>'status'='admitted'; END IF;
 admitted:=r->'filesErasure'->kind->'admission';
 IF public.valid_erasure_files_receipt(r,kind,'admission',admitted) IS DISTINCT FROM true OR receipt-'status' IS DISTINCT FROM admitted-'status' THEN RETURN false; END IF;
 IF stage='quiescence' THEN RETURN receipt->>'status'='quiesced'; END IF;
 IF public.valid_erasure_files_receipt(r,kind,'quiescence',r->'filesErasure'->kind->'quiescence') IS DISTINCT FROM true THEN RETURN false; END IF;
 IF stage='acknowledgement' THEN RETURN receipt->>'status'='acknowledged'; END IF;
 RETURN receipt->>'status'='absent' AND public.valid_erasure_files_receipt(r,kind,'acknowledgement',r->'filesErasure'->kind->'acknowledgement') IS TRUE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.valid_erasure_grant_release(r jsonb, receipt jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 SELECT jsonb_typeof(receipt)='object'
 AND receipt - ARRAY['ownerId','attemptId','project','status']='{}'::jsonb
 AND receipt->>'ownerId'=r->>'ownerId' AND receipt->>'attemptId'=r->>'attemptId'
 AND receipt->>'project'=r->'registrySnapshot'->>'user_cloud_project'
 AND receipt->>'project' ~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$'
 AND receipt->>'status'='reserved'
 AND public.valid_erasure_account_receipt(r,'deletion',r->'accountErasure'->'deletion') IS TRUE;
$function$;

CREATE OR REPLACE FUNCTION public.valid_erasure_kms_receipt(r jsonb, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.valid_erasure_mail_receipt(reservation jsonb, kind text, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE inventory jsonb; observation jsonb; identity jsonb; project text; resource_name text; dependency text; admitted jsonb; dependency_resource jsonb; states jsonb; terms jsonb; origin text;
BEGIN
 IF public.valid_erasure_writer_receipt(reservation,'writerDisabled',reservation->'writerDisabled') IS DISTINCT FROM true
    OR kind IS NULL OR kind NOT IN ('cloud_scheduler_job','pubsub_subscription','pubsub_topic')
    OR stage IS NULL OR stage NOT IN ('admission','acknowledgement','deletion')
    OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 inventory:=reservation->'substrateInventory'; observation:=receipt->'resourceObservation'; identity:=observation->'identity';
 project:=reservation->'registrySnapshot'->>'user_cloud_project';
 terms:=reservation->'registrySnapshot'->'backend_metadata'->'notificationCheckpoint';
 IF receipt->>'ownerId' IS DISTINCT FROM reservation->>'ownerId'
    OR receipt->>'attemptId' IS DISTINCT FROM reservation->>'attemptId'
    OR receipt - ARRAY['ownerId','attemptId','resourceObservation','status'] <> '{}'::jsonb
    OR jsonb_typeof(observation) IS DISTINCT FROM 'object'
    OR observation - ARRAY['type','id','disposition','identity'] <> '{}'::jsonb
    OR observation->>'type' IS DISTINCT FROM kind OR observation->>'disposition' IS DISTINCT FROM 'created'
    OR observation->>'id' IS NULL OR (observation->>'id' !~ '^[A-Za-z0-9_.~-]{1,255}$' AND (
      kind='pubsub_topic' AND terms->>'ownerId'=reservation->>'ownerId'
      AND terms->>'hushhId'=reservation->>'hushhId' AND terms->>'project'=project
      AND observation->>'id'='projects/'||(terms->'plan'->>'oauthProject')||'/topics/one-mail-'||
        left(trim(both '-' from regexp_replace(lower(reservation->>'hushhId'),'[^a-z0-9-]+','-','g')),40)) IS NOT TRUE)
    OR jsonb_typeof(identity) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 resource_name := CASE WHEN kind='pubsub_topic' AND starts_with(observation->>'id','projects/')
 THEN observation->>'id' ELSE 'projects/' || project || '/' || CASE kind
    WHEN 'cloud_scheduler_job' THEN 'locations/' || (reservation->'registrySnapshot'->>'user_cloud_region') || '/jobs/'
    WHEN 'pubsub_subscription' THEN 'subscriptions/' ELSE 'topics/' END || (observation->>'id') END;
 IF resource_name IS NULL OR identity->>'name' IS DISTINCT FROM resource_name THEN RETURN false; END IF;
 IF starts_with(observation->>'id','projects/') AND public.operator_mail_grants_qualified(reservation,observation->>'id') IS NOT TRUE THEN RETURN false; END IF;
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
$function$;

CREATE OR REPLACE FUNCTION public.valid_erasure_repository_grant_receipt(r jsonb, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE binding jsonb; identity jsonb; admitted jsonb;
BEGIN
 IF stage IS NULL OR stage NOT IN ('admission','acknowledgement','deletion') OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
 OR public.valid_erasure_grant_release(r,r->'grantRelease') IS DISTINCT FROM true THEN RETURN false; END IF;
 IF public.erasure_runtime_grants_complete(r) IS DISTINCT FROM true THEN RETURN false; END IF;
 identity:=receipt->'repositoryIdentity'; binding:=receipt->'bindingObservation';
 IF jsonb_typeof(identity) IS DISTINCT FROM 'object'
 OR identity - ARRAY['name','format','createTime']<>'{}'::jsonb
 OR identity->>'name' IS DISTINCT FROM 'projects/'||(r->'grantRelease'->>'project')||'/locations/'||(r->'registrySnapshot'->>'user_cloud_region')||'/repositories/one-pod'
 OR identity->>'format' IS DISTINCT FROM 'DOCKER'
 OR (identity->>'createTime' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$') IS DISTINCT FROM true
 OR (SELECT count(*) FROM jsonb_array_elements(r->'substrateInventory'->'plannedResources') p WHERE p->>'type'='artifact_repository' AND p->>'id'='one-pod')<>1
 OR (SELECT count(*) FROM jsonb_array_elements(r->'substrateInventory'->'resourceObservations') o WHERE o=jsonb_build_object('type','artifact_repository','id','one-pod','disposition','created','identity',identity))<>1 THEN RETURN false; END IF;
 IF receipt - ARRAY['ownerId','attemptId','repositoryIdentity','bindingObservation','status']<>'{}'::jsonb
 OR receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR receipt->'repositoryIdentity' IS DISTINCT FROM identity OR jsonb_typeof(binding) IS DISTINCT FROM 'object'
 OR binding - ARRAY['step','policyResource','role','member','disposition','beforeEtag','afterEtag']<>'{}'::jsonb
 OR binding->>'step' IS DISTINCT FROM 'artifact_repo_grant_copy_writer' OR binding->>'role' IS DISTINCT FROM 'roles/artifactregistry.writer'
 OR binding->>'disposition' IS DISTINCT FROM 'added'
 OR (binding->>'member' ~ '^serviceAccount:[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.gserviceaccount\.com$') IS DISTINCT FROM true
 OR binding->>'policyResource' IS DISTINCT FROM 'https://artifactregistry.googleapis.com/v1/'||(identity->>'name')||':getIamPolicy'
 OR coalesce(length(binding->>'beforeEtag'),0) NOT BETWEEN 1 AND 512 OR coalesce(length(binding->>'afterEtag'),0) NOT BETWEEN 1 AND 512
 OR (SELECT count(*) FROM jsonb_array_elements(r->'substrateInventory'->'bindingObservations') b WHERE b=binding)<>1 THEN RETURN false; END IF;
 IF stage='admission' THEN RETURN receipt->>'status'='admitted'; END IF;
 admitted:=r->'repositoryGrantErasure'->'admission';
 IF public.valid_erasure_repository_grant_receipt(r,'admission',admitted) IS DISTINCT FROM true OR receipt - 'status' IS DISTINCT FROM admitted - 'status' THEN RETURN false; END IF;
 IF stage='acknowledgement' THEN RETURN receipt->>'status'='acknowledged'; END IF;
 -- Fresh observed absence may reconcile a lost write acknowledgement; never fabricate it.
 RETURN receipt->>'status'='observed_absent';
END;
$function$;

CREATE OR REPLACE FUNCTION public.valid_erasure_repository_inventory(r jsonb, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE ident jsonb; image jsonb; prefix text; name_prefix text; admitted jsonb; deleted jsonb;
BEGIN
 -- The immutable predecessor was validated on its original guarded append.
 -- This unresolved observation adds no cleanup authority; do not recursively
 -- revalidate every earlier KMS/mail/account checkpoint for an inventory read.
 admitted:=r->'repositoryGrantErasure'->'admission'; deleted:=r->'repositoryGrantErasure'->'deletion';
 IF jsonb_typeof(admitted) IS DISTINCT FROM 'object' OR jsonb_typeof(deleted) IS DISTINCT FROM 'object'
 OR admitted->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR admitted->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR admitted->>'status' IS DISTINCT FROM 'admitted' OR deleted->>'status' IS DISTINCT FROM 'observed_absent'
 OR deleted - 'status' IS DISTINCT FROM admitted - 'status'
 OR jsonb_typeof(r->'substrateInventory'->'resourceObservations') IS DISTINCT FROM 'array'
 OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' 
 OR receipt - ARRAY['ownerId','attemptId','repositoryIdentity','images','paginationComplete','classification']<>'{}'::jsonb
 OR receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId'
 OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR receipt->'paginationComplete' IS DISTINCT FROM 'true'::jsonb
 OR receipt->>'classification' IS DISTINCT FROM 'unresolved'
 OR receipt->'repositoryIdentity' IS DISTINCT FROM r->'repositoryGrantErasure'->'deletion'->'repositoryIdentity'
 OR jsonb_typeof(receipt->'images') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 ident:=receipt->'repositoryIdentity';
 IF jsonb_typeof(ident) IS DISTINCT FROM 'object'
 OR ident->>'name' IS DISTINCT FROM 'projects/'||(r->'registrySnapshot'->>'user_cloud_project')||'/locations/'||(r->'registrySnapshot'->>'user_cloud_region')||'/repositories/one-pod'
 OR (SELECT count(*) FROM jsonb_array_elements(r->'substrateInventory'->'resourceObservations') o
     WHERE o=jsonb_build_object('type','artifact_repository','id','one-pod','disposition','created','identity',ident))<>1 THEN RETURN false; END IF;
 prefix:=(r->'registrySnapshot'->>'user_cloud_region')||'-docker.pkg.dev/'||(r->'grantRelease'->>'project')||'/one-pod/';
 name_prefix:=(ident->>'name')||'/dockerImages/';
 IF jsonb_array_length(receipt->'images')>10000 THEN RETURN false; END IF;
 FOR image IN SELECT * FROM jsonb_array_elements(receipt->'images') LOOP
  IF jsonb_typeof(image) IS DISTINCT FROM 'object' OR image - ARRAY['name','uri']<>'{}'::jsonb
  OR jsonb_typeof(image->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(image->'uri') IS DISTINCT FROM 'string'
  OR length(image->>'name') NOT BETWEEN 1 AND 2048 OR length(image->>'uri') NOT BETWEEN 1 AND 2048
  OR left(image->>'name',length(name_prefix)) IS DISTINCT FROM name_prefix
  OR left(image->>'uri',length(prefix)) IS DISTINCT FROM prefix
  OR (substring(image->>'uri' FROM length(prefix)+1) ~ '^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$') IS DISTINCT FROM true
  OR substring(image->>'name' FROM length(name_prefix)+1) IS DISTINCT FROM substring(image->>'uri' FROM length(prefix)+1) THEN RETURN false; END IF;
 END LOOP;
 RETURN (SELECT count(*)=count(DISTINCT x->>'name') AND count(*)=count(DISTINCT x->>'uri') FROM jsonb_array_elements(receipt->'images') x);
END;
$function$;

CREATE OR REPLACE FUNCTION public.valid_erasure_secret_receipt(r jsonb, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE obs jsonb; ident jsonb; inv jsonb; admitted jsonb; project text;
BEGIN
 IF stage IS NULL OR stage NOT IN ('admission','acknowledgement','deletion')
 OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
 OR public.valid_erasure_kms_receipt(r,'completion',r->'kmsErasure'->'completion') IS DISTINCT FROM true THEN RETURN false; END IF;
 obs:=receipt->'resourceObservation'; ident:=obs->'identity'; inv:=r->'substrateInventory'; project:=r->'registrySnapshot'->>'user_cloud_project';
 IF receipt - ARRAY['ownerId','attemptId','resourceObservation','etag','status'] <> '{}'::jsonb
 OR receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR jsonb_typeof(receipt->'etag') IS DISTINCT FROM 'string' OR length(btrim(receipt->>'etag')) NOT BETWEEN 1 AND 512
 OR jsonb_typeof(obs) IS DISTINCT FROM 'object' OR obs - ARRAY['type','id','disposition','identity'] <> '{}'::jsonb
 OR obs->>'type' IS DISTINCT FROM 'secret' OR obs->>'disposition' IS DISTINCT FROM 'created'
 OR obs->>'id' IS NULL OR obs->>'id' !~ '^[A-Za-z0-9_-]{1,255}$'
 OR jsonb_typeof(ident) IS DISTINCT FROM 'object' OR ident - ARRAY['name','projectId','projectNumber','createTime'] <> '{}'::jsonb
 OR project IS NULL OR ident->>'projectId' IS DISTINCT FROM project
 OR jsonb_typeof(ident->'createTime') IS DISTINCT FROM 'string' OR length(ident->>'createTime') NOT BETWEEN 1 AND 64
 OR (SELECT count(*) FROM jsonb_array_elements(inv->'plannedResources') x WHERE x->>'type'='secret') <> 1
 OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inv->'plannedResources') x WHERE x->>'type'='secret' AND x->>'id'=obs->>'id')
 OR (SELECT count(*) FROM jsonb_array_elements(inv->'resourceObservations') x WHERE x=obs) <> 1 THEN RETURN false; END IF;
 IF ident ? 'projectNumber' AND (jsonb_typeof(ident->'projectNumber') IS DISTINCT FROM 'string' OR ident->>'projectNumber' !~ '^[1-9][0-9]{0,19}$') THEN RETURN false; END IF;
 IF ident->>'name' IS DISTINCT FROM 'projects/' || project || '/secrets/' || (obs->>'id')
 AND (NOT (ident ? 'projectNumber') OR ident->>'name' IS DISTINCT FROM 'projects/' || (ident->>'projectNumber') || '/secrets/' || (obs->>'id')) THEN RETURN false; END IF;
 IF stage='admission' THEN RETURN receipt->>'status'='admitted'; END IF;
 admitted:=r->'secretErasure'->'admission';
 IF jsonb_typeof(admitted) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF admitted->>'status' IS DISTINCT FROM 'admitted' OR receipt - 'status' IS DISTINCT FROM admitted - 'status' THEN RETURN false; END IF;
 IF stage='acknowledgement' THEN RETURN receipt->>'status'='acknowledged'; END IF;
 admitted:=r->'secretErasure'->'acknowledgement';
 IF jsonb_typeof(admitted) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 RETURN receipt->>'status'='absent' AND admitted->>'status' IS NOT DISTINCT FROM 'acknowledged'
   AND receipt - 'status' IS NOT DISTINCT FROM admitted - 'status';
END;
$function$;

CREATE OR REPLACE FUNCTION public.valid_erasure_writer_receipt(reservation jsonb, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE snapshot jsonb; inventory jsonb; runtime_identity jsonb; bootstrap_identity jsonb; project text; bootstrap_ref text;
BEGIN
 snapshot := reservation->'registrySnapshot'; inventory := reservation->'substrateInventory';
 IF public.valid_erasure_substrate_inventory(reservation,inventory) IS DISTINCT FROM true
    OR stage NOT IN ('writerAdmission','writerDisabled') OR stage IS NULL
    OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 runtime_identity := receipt->'runtimeIdentity'; bootstrap_identity := receipt->'bootstrapIdentity';
 project := snapshot->>'user_cloud_project';
 bootstrap_ref := regexp_replace(snapshot->>'user_cloud_bootstrap_sa','^serviceAccount:','');
 IF project IS NULL OR project !~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$'
    OR receipt->>'ownerId' IS DISTINCT FROM reservation->>'ownerId'
    OR receipt->>'attemptId' IS DISTINCT FROM reservation->>'attemptId'
    OR receipt - ARRAY['ownerId','attemptId','runtimeIdentity','bootstrapIdentity','status'] <> '{}'::jsonb
    OR jsonb_typeof(runtime_identity) IS DISTINCT FROM 'object'
    OR jsonb_typeof(bootstrap_identity) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF runtime_identity->>'projectId' IS DISTINCT FROM project
    OR bootstrap_identity->>'projectId' IS DISTINCT FROM project
    OR runtime_identity->>'email' IS DISTINCT FROM snapshot->'backend_metadata'->>'runtime_service_account'
    OR runtime_identity->>'uniqueId' IS NULL OR runtime_identity->>'uniqueId' !~ '^[1-9][0-9]{0,31}$'
    OR bootstrap_identity->>'uniqueId' IS NULL OR bootstrap_identity->>'uniqueId' !~ '^[1-9][0-9]{0,31}$'
    OR runtime_identity->>'uniqueId' = bootstrap_identity->>'uniqueId'
    OR bootstrap_ref IS NULL
    OR bootstrap_ref NOT IN (bootstrap_identity->>'email',bootstrap_identity->>'uniqueId') THEN RETURN false; END IF;
 IF bootstrap_identity - ARRAY['name','email','projectId','uniqueId'] <> '{}'::jsonb
    OR bootstrap_identity->>'email' IS NULL
    OR bootstrap_identity->>'email' NOT LIKE '%@' || project || '.iam.gserviceaccount.com'
    OR bootstrap_identity->>'name' IS NULL
    OR bootstrap_identity->>'name' NOT IN ('projects/' || project || '/serviceAccounts/' || (bootstrap_identity->>'email'),
                                         'projects/' || project || '/serviceAccounts/' || (bootstrap_identity->>'uniqueId')) THEN RETURN false; END IF;
 IF jsonb_typeof(inventory->'resourceObservations') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(inventory->'resourceObservations') AS r
     WHERE r->>'type'='service_account' AND r->>'disposition'='created'
       AND r->>'id'=runtime_identity->>'email' AND r->'identity'=runtime_identity) <> 1
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inventory->'plannedResources') AS r
                   WHERE r->>'type'='service_account' AND r->>'id'=runtime_identity->>'email') THEN RETURN false; END IF;
 IF stage='writerAdmission' THEN RETURN receipt->>'status'='admitted'; END IF;
 RETURN receipt->>'status'='disabled'
    AND public.valid_erasure_writer_receipt(reservation,'writerAdmission',reservation->'writerAdmission')
    AND receipt - 'status' = (reservation->'writerAdmission') - 'status';
END;
$function$;

CREATE OR REPLACE FUNCTION public.valid_erasure_gcp_files_upgrade_observation(r jsonb, observation jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE snapshot jsonb:=r->'registrySnapshot'; metadata jsonb:=snapshot->'backend_metadata';
 approval jsonb:=metadata->'upgradeApproval'; plan jsonb:=approval->'capabilityPlan';
 intent jsonb:=metadata->'filesUpgradeCheckpoint'; prefix jsonb:=intent->'completed';
 completed jsonb:=observation->'completed'; result jsonb; resource jsonb; ident jsonb; binding jsonb;
 project text:=plan->>'project'; region text:=plan->>'region'; step text:=intent->>'step';
 slug text:='one-files-'||left(encode(sha256(convert_to(r->>'hushhId','UTF8')),'hex'),20);
 worker text; queue text; expected_role text; expected_url text; expected_member text; project_number text;
 steps text[]:=ARRAY['enable_services','generate_files_task_identity','iam_files_task_identity',
  'iam_files_queue_admin','files_worker_account','files_queue','iam_files_enqueuer','iam_files_worker_actas',
  'iam_files_bucket_metadata','iam_files_invoker'];
BEGIN
 IF jsonb_typeof(observation) IS DISTINCT FROM 'object'
 OR observation-ARRAY['version','planDigest','operationId','attemptId','phase','step','completed']<>'{}'::jsonb
 OR observation->'version' IS DISTINCT FROM '1'::jsonb OR observation->>'phase' IS DISTINCT FROM 'observed'
 OR octet_length(observation::text)>65536
 OR r->>'ownerId' IS DISTINCT FROM snapshot->>'user_id'
 OR snapshot->>'deployment_target' IS DISTINCT FROM 'user_gcp'
 OR plan->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR plan->>'hushhId' IS DISTINCT FROM r->>'hushhId'
 OR plan->>'serviceUid' IS DISTINCT FROM metadata->>'serviceUid'
 OR plan->>'targetImage' IS DISTINCT FROM approval->>'targetImage'
 OR plan->>'project' IS DISTINCT FROM snapshot->>'user_cloud_project'
 OR plan->>'region' IS DISTINCT FROM snapshot->>'user_cloud_region'
 OR plan->>'service' IS DISTINCT FROM snapshot->>'external_agent_id'
 OR plan->>'runtimeAccount' IS DISTINCT FROM metadata->>'runtime_service_account'
 OR plan->>'bootstrapAccount' IS DISTINCT FROM snapshot->>'user_cloud_bootstrap_sa'
 OR coalesce(metadata->>'upgradeLease','')='' OR intent->>'phase' IS DISTINCT FROM 'intent'
 OR intent->>'planDigest' IS DISTINCT FROM approval->>'capabilityPlanDigest'
 OR coalesce(intent->>'planDigest','') !~ '^[a-f0-9]{64}$'
 OR intent->>'operationId' IS DISTINCT FROM approval->>'operationId'
 OR coalesce(intent->>'operationId','')=''
 OR intent->>'attemptId' IS DISTINCT FROM encode(sha256(convert_to(metadata->>'upgradeLease','UTF8')),'hex')
 OR observation-ARRAY['phase','completed'] IS DISTINCT FROM intent-ARRAY['phase','completed']
 OR jsonb_typeof(prefix) IS DISTINCT FROM 'array' OR jsonb_typeof(completed) IS DISTINCT FROM 'array'
 THEN RETURN false; END IF;
 IF jsonb_array_length(prefix)>=cardinality(steps)
 OR step IS DISTINCT FROM steps[jsonb_array_length(prefix)+1]
 OR jsonb_array_length(completed)<>jsonb_array_length(prefix)+1
 OR completed-(jsonb_array_length(completed)-1) IS DISTINCT FROM prefix THEN RETURN false; END IF;
 result:=completed->-1;
 IF jsonb_typeof(result) IS DISTINCT FROM 'object'
 OR result-ARRAY['step','status','ok','skipped','resourceObservation','bindingObservations']<>'{}'::jsonb
 OR result->>'step' IS DISTINCT FROM step OR jsonb_typeof(result->'ok') IS DISTINCT FROM 'boolean'
 OR jsonb_typeof(result->'status') IS DISTINCT FROM 'number'
 OR coalesce(result->>'status','') !~ '^[0-9]{1,3}$'
 OR (result ? 'skipped' AND result->'skipped' IS DISTINCT FROM 'false'::jsonb)
 THEN RETURN false; END IF;
 SELECT x->'identity'->>'projectNumber' INTO project_number
 FROM jsonb_array_elements(metadata->'substrateReceipt'->'resourceObservations') x
 WHERE x->>'type'='gcs_bucket' AND x->>'id'=plan->>'bucket'
 AND x->'identity'->>'name'=plan->>'bucket';
 IF coalesce(project_number,'') !~ '^[1-9][0-9]{0,19}$' THEN RETURN false; END IF;
 worker:=slug||'@'||project||'.iam.gserviceaccount.com';
 queue:='projects/'||project||'/locations/'||region||'/queues/'||slug;
 resource:=result->'resourceObservation';
 IF resource IS NOT NULL THEN
  IF result->'ok' IS DISTINCT FROM 'true'::jsonb OR result->>'status' NOT IN ('200','201')
  OR jsonb_typeof(resource) IS DISTINCT FROM 'object'
  OR resource-ARRAY['type','id','disposition','identity']<>'{}'::jsonb
  OR resource->>'disposition' IS DISTINCT FROM 'created'
  OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(metadata->'substrateReceipt'->'plannedResources') x
     WHERE x=jsonb_build_object('type',resource->>'type','id',resource->>'id')) THEN RETURN false; END IF;
  ident:=resource->'identity';
  IF step='files_queue' THEN
   IF resource->>'type' IS DISTINCT FROM 'cloud_tasks_queue' OR resource->>'id' IS DISTINCT FROM slug
   OR ident IS DISTINCT FROM jsonb_build_object('name',queue,
    'rateLimits',jsonb_build_object('maxDispatchesPerSecond',1,'maxConcurrentDispatches',1),
    'retryConfig',jsonb_build_object('maxAttempts',3,'maxRetryDuration','0s','minBackoff','10s','maxBackoff','60s','maxDoublings',2))
   THEN RETURN false; END IF;
  ELSIF step='files_worker_account' THEN
   IF resource->>'type' IS DISTINCT FROM 'service_account' OR resource->>'id' IS DISTINCT FROM worker
   OR jsonb_typeof(ident) IS DISTINCT FROM 'object' OR ident-ARRAY['name','email','projectId','uniqueId']<>'{}'::jsonb
   OR ident->>'email' IS DISTINCT FROM worker OR ident->>'projectId' IS DISTINCT FROM project
   OR (coalesce(ident->>'uniqueId','') !~ '^[0-9]{1,32}$' OR ident->>'uniqueId' !~ '[1-9]')
   OR (ident->>'name' IS DISTINCT FROM 'projects/'||project||'/serviceAccounts/'||worker
       AND ident->>'name' IS DISTINCT FROM 'projects/'||project||'/serviceAccounts/'||(ident->>'uniqueId'))
   THEN RETURN false; END IF;
  ELSE RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(metadata->'substrateReceipt'->'resourceObservations','[]'::jsonb)) x
    WHERE x->>'type'=resource->>'type' AND x->>'id'=resource->>'id' AND x<>resource) THEN RETURN false; END IF;
 END IF;
 IF result ? 'bindingObservations' THEN
  IF jsonb_typeof(result->'bindingObservations') IS DISTINCT FROM 'array'
  OR jsonb_array_length(result->'bindingObservations')>1 THEN RETURN false; END IF;
  IF jsonb_array_length(result->'bindingObservations')>0 AND
    (result->'ok' IS DISTINCT FROM 'true'::jsonb OR result->>'status' NOT IN ('200','201')) THEN RETURN false; END IF;
  CASE step
   WHEN 'iam_files_queue_admin' THEN
    expected_role:='roles/cloudtasks.queueAdmin'; expected_member:='serviceAccount:'||(plan->>'bootstrapAccount');
    expected_url:='https://cloudresourcemanager.googleapis.com/v1/projects/'||project||':getIamPolicy';
   WHEN 'iam_files_task_identity' THEN
    expected_role:='roles/cloudtasks.serviceAgent'; expected_member:='serviceAccount:service-'||project_number||'@gcp-sa-cloudtasks.iam.gserviceaccount.com';
    expected_url:='https://cloudresourcemanager.googleapis.com/v1/projects/'||project||':getIamPolicy';
   WHEN 'iam_files_enqueuer' THEN
    expected_role:='roles/cloudtasks.enqueuer'; expected_member:='serviceAccount:'||(plan->>'runtimeAccount');
    expected_url:='https://cloudtasks.googleapis.com/v2/'||queue||':getIamPolicy';
   WHEN 'iam_files_worker_actas' THEN
    expected_role:='roles/iam.serviceAccountUser'; expected_member:='serviceAccount:'||(plan->>'runtimeAccount');
    expected_url:='https://iam.googleapis.com/v1/projects/'||project||'/serviceAccounts/'||worker||':getIamPolicy';
   WHEN 'iam_files_bucket_metadata' THEN
    expected_role:='roles/storage.legacyBucketReader'; expected_member:='serviceAccount:'||(plan->>'runtimeAccount');
    expected_url:='https://storage.googleapis.com/storage/v1/b/'||(plan->>'bucket')||'/iam';
   WHEN 'iam_files_invoker' THEN
    expected_role:='roles/run.invoker'; expected_member:='serviceAccount:'||worker;
    expected_url:='https://'||region||'-run.googleapis.com/v1/projects/'||project||'/locations/'||region||'/services/'||(plan->>'service')||':getIamPolicy';
   ELSE RETURN false;
  END CASE;
  FOR binding IN SELECT value FROM jsonb_array_elements(result->'bindingObservations') LOOP
   IF jsonb_typeof(binding) IS DISTINCT FROM 'object'
   OR binding-ARRAY['step','policyResource','role','member','disposition','beforeEtag','afterEtag']<>'{}'::jsonb
   OR binding->>'step' IS DISTINCT FROM step OR binding->>'policyResource' IS DISTINCT FROM expected_url
   OR binding->>'role' IS DISTINCT FROM expected_role
   OR coalesce(binding->>'disposition','') NOT IN ('added','already_present')
   OR jsonb_typeof(binding->'beforeEtag') IS DISTINCT FROM 'string' OR length(binding->>'beforeEtag') NOT BETWEEN 1 AND 512
   OR jsonb_typeof(binding->'afterEtag') IS DISTINCT FROM 'string' OR length(binding->>'afterEtag') NOT BETWEEN 1 AND 512
   OR (expected_member IS NOT NULL AND binding->>'member' IS DISTINCT FROM expected_member)
   OR (expected_member IS NULL AND coalesce(binding->>'member','') !~ '^serviceAccount:service-[1-9][0-9]*@gcp-sa-cloudtasks[.]iam[.]gserviceaccount[.]com$')
   THEN RETURN false; END IF;
  END LOOP;
 END IF;
 RETURN true;
END;
$function$;
DROP FUNCTION public.valid_managed_preparation_cleanup_append(jsonb,jsonb);
DROP FUNCTION public.valid_managed_preparation_cleanup(jsonb,text,jsonb);
DROP FUNCTION public.valid_erasure_managed_retirement_append(jsonb,jsonb);
DROP FUNCTION public.valid_erasure_managed_project_retirement(jsonb,text,jsonb);
DROP FUNCTION public.valid_erasure_managed_model_grant_receipt(jsonb,text,text,jsonb);
DROP FUNCTION public.valid_erasure_managed_model_grant_append(jsonb,jsonb);
DROP FUNCTION public.retain_managed_preparation_cleanup(text,text,jsonb,text,jsonb);
DROP FUNCTION public.retain_hosted_pod_project_authorization(text,text);
DROP FUNCTION public.retain_erasure_managed_project_retirement(text,text,jsonb,text,jsonb);
DROP FUNCTION public.retain_erasure_managed_model_grant_receipt(text,text,jsonb,text,text,jsonb);
DROP FUNCTION public.private_gcp_coordinates(jsonb);
DROP FUNCTION public.managed_preparation_cleanup_coordinates(jsonb);
DROP FUNCTION public.hosted_preparation_cleanup_admitted(text,text,jsonb);
DROP FUNCTION public.hosted_pod_upgrade_admitted(text,text,jsonb,boolean);
DROP FUNCTION public.hosted_pod_retained_admitted(text,jsonb);
DROP FUNCTION public.hosted_pod_execution_admitted(text,text,jsonb,jsonb,text);
DROP FUNCTION public.hosted_pod_cleanup_admitted(text,text,jsonb);
DROP FUNCTION public.erasure_private_coordinates(jsonb);
DROP FUNCTION public.erasure_managed_model_grants_complete(jsonb);
DROP FUNCTION public.erasure_authorization_history(jsonb,jsonb);
DROP FUNCTION IF EXISTS public.managed_prefix_abort_complete(jsonb);
DROP FUNCTION IF EXISTS public.retain_managed_prefix_abort(text,text,jsonb,text,text,text,jsonb);
DROP FUNCTION IF EXISTS public.valid_managed_prefix_abort_append(jsonb,jsonb);
DROP FUNCTION IF EXISTS public.valid_managed_prefix_abort_receipt(jsonb,text,text,text,jsonb);
DROP FUNCTION IF EXISTS public.managed_prefix_nonkey_complete(jsonb);
DROP FUNCTION IF EXISTS public.valid_managed_prefix_resource_result(jsonb,jsonb,jsonb,jsonb);
DROP FUNCTION IF EXISTS public.managed_prefix_items_complete(jsonb,text);
DROP FUNCTION IF EXISTS public.managed_prefix_base(jsonb);
DROP FUNCTION IF EXISTS public.valid_managed_prefix_inventory_admission(jsonb,jsonb);
DROP FUNCTION IF EXISTS public.valid_managed_prefix_inventory(jsonb,jsonb);
DROP FUNCTION IF EXISTS public.valid_managed_prefix_memory_absence(jsonb,jsonb);
DROP FUNCTION IF EXISTS public.managed_prefix_failed_binding_checks(jsonb);
DROP FUNCTION IF EXISTS public.managed_prefix_bindings(jsonb);
DROP FUNCTION IF EXISTS public.managed_prefix_binding_contract(jsonb,text,text);
DROP FUNCTION IF EXISTS public.valid_managed_prefix_created_identity(jsonb,jsonb,jsonb);
DROP FUNCTION IF EXISTS public.managed_prefix_resource_name(jsonb,jsonb);
DROP FUNCTION IF EXISTS public.managed_prefix_resource_step(text);
DROP FUNCTION IF EXISTS public.hosted_prefix_abort_admitted(text,text,jsonb);
DROP FUNCTION IF EXISTS public.managed_prefix_abort_context(jsonb);
DROP FUNCTION IF EXISTS public.managed_prefix_terminal_failure(jsonb);
COMMIT;
