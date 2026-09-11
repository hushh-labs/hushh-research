BEGIN;
LOCK TABLE public.personal_agent_registry,public.byoc_setup_jobs,public.personal_agent_deletion_tombstones IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.personal_agent_deletion_tombstones WHERE status='erasure_completed') THEN
  RAISE EXCEPTION 'completed erasure evidence requires preservation'; END IF;
END $$;
DROP FUNCTION public.finalize_personal_agent_erasure(text);
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
    RAISE EXCEPTION 'personal agent erasure reserved' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.guard_byoc_authorization_attempts()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE k text; v jsonb; old_v jsonb; intent jsonb; receipt jsonb; binding jsonb; identity jsonb;
BEGIN
 IF TG_OP='DELETE' THEN
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
$$;

DROP TRIGGER zz_personal_agent_erasure_archive ON public.personal_agent_deletion_tombstones;
DROP INDEX public.personal_agent_completed_erasure_owner;
DROP FUNCTION public.personal_agent_erasure_archived(text,jsonb,jsonb);
DROP FUNCTION public.guard_personal_agent_erasure_archive();
DROP FUNCTION public.personal_agent_erasure_complete(text);
DROP FUNCTION public.personal_agent_erasure_archive(jsonb,jsonb);
COMMIT;
