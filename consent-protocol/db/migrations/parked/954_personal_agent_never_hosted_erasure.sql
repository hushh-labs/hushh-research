-- Dev-only: let an erasure finish for a private agent that was never hosted.
--
-- PARKED (dev-only band, same contract as 900-953): out of
-- db/release_migration_manifest.json, applied only by the dev migration lane.
--
-- Measured on the dev registry, 2026-10-06: an owner whose Connect Google Cloud
-- setup reached `recorded` but whose agent was never built (snapshot `pending`,
-- no provisionAttempt, one `registry_row` lifecycle event) was reserved for
-- erasure and could never complete. 935's completion requires a provisioned
-- snapshot and every hosted-resource receipt, and 934's bootstrap release
-- requires full resource coverage, none of which can exist for an agent that was
-- never built. The account sweep retried it every pass, refused, forever.
--
-- 917 writes provisionAttempt BEFORE any substrate or host is requested, so its
-- absence (with no backend, no agent id and no host or substrate lifecycle event)
-- proves Hussh never created anything in the person's project. For that case
-- only, Hussh releases its own access (the bootstrap impersonation grant) and
-- deletes nothing: the project and its bootstrap service account were the
-- person's before setup and stay theirs. The receipt says exactly that.
--
-- The receipt is DERIVED here, never accepted from Python: retention, the
-- bootstrap release and completion each re-derive the evidence from the live
-- rows, so a Python bug cannot claim a never-hosted erasure. The managed tier
-- (`gcp`) and Azure never qualify. The same append also records `grantRelease`
-- (927's project fence), so the person's project stays fenced against a new setup
-- while Hussh releases its grant, exactly as on the hosted path.
--
-- Function bodies replaced here are copied verbatim from their latest definition
-- (949 guard, 935 completion, 941 archive, 934 bootstrap release) and changed
-- only where marked "954"; tests/test_personal_agent_never_hosted_erasure_postgres.py
-- asserts that. 940 records what rewriting the guard by hand once lost.
BEGIN;

-- The never-hosted receipt, re-derived from the database alone; NULL unless every
-- piece of evidence holds. It names what remains with the person and that Hussh
-- deletes neither.
CREATE OR REPLACE FUNCTION public.expected_erasure_never_hosted(owner_id text, r jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE s jsonb; live public.personal_agent_registry%ROWTYPE; setup public.byoc_setup_jobs%ROWTYPE;
 project text; sa text;
BEGIN
 -- Types first, each on its own: a jsonb operator on the wrong type raises.
 IF owner_id IS NULL OR btrim(owner_id)='' OR jsonb_typeof(r) IS DISTINCT FROM 'object'
 OR jsonb_typeof(r->'registrySnapshot') IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 s:=r->'registrySnapshot';
 project:=s->>'user_cloud_project';
 sa:=regexp_replace(coalesce(s->>'user_cloud_bootstrap_sa',''),'^serviceAccount:','');
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR r->>'version' IS DISTINCT FROM '1'
 OR r->>'phase' IS DISTINCT FROM 'reserved'
 OR coalesce(r->>'attemptId','')='' OR coalesce(r->>'hushhId','')=''
 OR s->>'user_id' IS DISTINCT FROM owner_id OR s->>'hushh_id' IS DISTINCT FROM r->>'hushhId'
 -- Pre-host only, and only the person's own Google Cloud project: never the managed tier.
 OR (s->>'status' IN ('pending','unprovisioned')) IS NOT TRUE
 OR s->>'deployment_target' IS DISTINCT FROM 'user_gcp'
 OR nullif(s->>'backend','') IS NOT NULL OR nullif(s->>'external_agent_id','') IS NOT NULL
 -- No provisionAttempt, serviceUid, service or anything else: 917 claims before substrate.
 OR (jsonb_typeof(s->'backend_metadata')='null' OR s->'backend_metadata'='{}'::jsonb) IS NOT TRUE
 OR (project ~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$') IS NOT TRUE
 OR (sa ~ ('^[a-z][a-z0-9-]{4,28}[a-z0-9]@'||project||'\.iam\.gserviceaccount\.com$')) IS NOT TRUE
 THEN RETURN NULL; END IF;
 -- The live row is this reservation, frozen, and still carries nothing hosted.
 SELECT * INTO live FROM public.personal_agent_registry WHERE user_id=owner_id;
 IF NOT FOUND OR live.status IS DISTINCT FROM 'suspended'
 OR live.hushh_id IS DISTINCT FROM r->>'hushhId' OR live.user_cloud_project IS DISTINCT FROM project
 OR nullif(live.backend,'') IS NOT NULL OR nullif(live.external_agent_id,'') IS NOT NULL
 OR jsonb_typeof(live.backend_metadata) IS DISTINCT FROM 'object'
 OR live.backend_metadata-'erasure'<>'{}'::jsonb
 OR live.backend_metadata->'erasure'->'registrySnapshot' IS DISTINCT FROM s
 OR live.backend_metadata->'erasure'->>'attemptId' IS DISTINCT FROM r->>'attemptId' THEN RETURN NULL; END IF;
 -- Only a registry row (and a pre-host failure) was ever logged: no host_* stage,
 -- no substrate_step, nothing else. An allow-list, so a new event kind refuses.
 IF EXISTS (SELECT 1 FROM public.pod_lifecycle_events e WHERE e.user_id=owner_id AND (
   e.substrate_step IS NOT NULL
   OR NOT ((coalesce(e.event,'')='stage' AND coalesce(e.stage,'') IN ('registry_row','failed'))
           OR (coalesce(e.event,'')='terminal' AND coalesce(e.stage,'')='failed'))))
 OR EXISTS (SELECT 1 FROM public.pod_migration_jobs WHERE user_id=owner_id) THEN RETURN NULL; END IF;
 SELECT * INTO setup FROM public.byoc_setup_jobs WHERE user_id=owner_id;
 IF NOT FOUND OR setup.status IS DISTINCT FROM 'recorded' OR setup.project_id IS DISTINCT FROM project THEN
  RETURN NULL; END IF;
 RETURN jsonb_build_object('version',1,'ownerId',owner_id,'attemptId',r->>'attemptId',
  'hushhId',r->>'hushhId','status','never_hosted','project',project,
  'remainsWithPerson',jsonb_build_array('projects/'||project,'projects/'||project||'/serviceAccounts/'||sa),
  'deletedByHussh','[]'::jsonb,'husshReleases','bootstrapGrantRelease');
END;
$$;

-- True only for a reservation that carries exactly the derived receipt, the
-- matching project fence and, at most, the bootstrap release and its receipts.
CREATE OR REPLACE FUNCTION public.erasure_never_hosted_admitted(owner_id text, r jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE receipt jsonb;
BEGIN
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR NOT (r ? 'neverHosted') THEN RETURN false; END IF;
 receipt:=public.expected_erasure_never_hosted(owner_id,r);
 RETURN coalesce(receipt IS NOT NULL
  AND r - ARRAY['version','ownerId','attemptId','hushhId','phase','registrySnapshot',
                'neverHosted','grantRelease','bootstrapGrantRelease','bootstrapGrantErasure']='{}'::jsonb
  AND r->'neverHosted'=receipt
  AND r->'grantRelease'=jsonb_build_object('ownerId',owner_id,'attemptId',r->>'attemptId',
       'project',receipt->>'project','status','reserved'), false);
END;
$$;

-- The one append: the receipt and the project fence together, onto a bare reservation.
CREATE OR REPLACE FUNCTION public.valid_erasure_never_hosted_append(owner_id text, old_r jsonb, new_r jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
BEGIN
 IF jsonb_typeof(old_r) IS DISTINCT FROM 'object' OR jsonb_typeof(new_r) IS DISTINCT FROM 'object' THEN
  RETURN false; END IF;
 RETURN coalesce(old_r - ARRAY['version','ownerId','attemptId','hushhId','phase','registrySnapshot']='{}'::jsonb
  AND new_r ?& ARRAY['neverHosted','grantRelease']
  AND new_r - ARRAY['neverHosted','grantRelease']=old_r
  AND public.erasure_never_hosted_admitted(owner_id,new_r) IS TRUE, false);
END;
$$;

-- Retained once per attempt. Takes no receipt: the database derives it.
CREATE OR REPLACE FUNCTION public.retain_erasure_never_hosted(owner_id text, attempt_id text, expected jsonb)
RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE current_row public.personal_agent_registry%ROWTYPE; r jsonb; receipt jsonb; candidate jsonb;
BEGIN
 IF owner_id IS NULL OR btrim(owner_id)='' THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 r:=current_row.backend_metadata->'erasure';
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR r->>'attemptId' IS DISTINCT FROM attempt_id THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger
     WHERE tgrelid='public.personal_agent_registry'::regclass
       AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
       AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
       AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
 IF r ? 'neverHosted' THEN RETURN public.erasure_never_hosted_admitted(owner_id,r) IS TRUE; END IF;
 IF r IS DISTINCT FROM expected THEN RETURN false; END IF;
 receipt:=public.expected_erasure_never_hosted(owner_id,r);
 IF receipt IS NULL THEN RETURN false; END IF;
 candidate:=r||jsonb_build_object('neverHosted',receipt,'grantRelease',jsonb_build_object(
  'ownerId',owner_id,'attemptId',attempt_id,'project',receipt->>'project','status','reserved'));
 IF public.valid_erasure_never_hosted_append(owner_id,r,candidate) IS NOT TRUE
 OR public.project_grant_release_is_exclusive(owner_id,receipt->>'project') IS NOT TRUE THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{erasure}',candidate,true)
 WHERE user_id=owner_id;
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.expected_erasure_bootstrap_release(owner_id text,r jsonb,recovery_member text)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=public AS $$
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
$$;

CREATE OR REPLACE FUNCTION public.guard_personal_agent_erasure_registry()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE reservation jsonb; snapshot jsonb;
BEGIN
  IF TG_OP='DELETE' AND public.personal_agent_erasure_archived(OLD.user_id,OLD.backend_metadata->'erasure') IS TRUE THEN RETURN OLD; END IF;
  IF OLD.backend_metadata ? 'erasure' THEN
    reservation := OLD.backend_metadata->'erasure';
    snapshot := reservation->'registrySnapshot';

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
    'pubsub_topic',r->'mailErasure'->'pubsub_topic'->'deletion'),
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

CREATE OR REPLACE FUNCTION public.personal_agent_erasure_complete(owner_id text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
DECLARE row_state public.personal_agent_registry%ROWTYPE; setup public.byoc_setup_jobs%ROWTYPE;
 r jsonb; release jsonb; expected_release jsonb; item record; stages jsonb; wanted jsonb;
 archive jsonb; table_name text; never_hosted boolean;
BEGIN
 IF owner_id IS NULL OR btrim(owner_id)='' OR current_setting('transaction_isolation')<>'read committed' THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO row_state FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR row_state.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 -- Own setup writers acquire their tuple before project205. Prelock it here,
 -- before project exclusivity, because finalization will delete it later.
 SELECT * INTO setup FROM public.byoc_setup_jobs WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR setup.status IS DISTINCT FROM 'recorded' THEN RETURN false; END IF;
 r:=row_state.backend_metadata->'erasure'; release:=r->'bootstrapGrantRelease';
 -- 954: a never-hosted reservation completes only on its SQL-re-derived evidence.
 never_hosted:=coalesce(r ? 'neverHosted',false);
 IF never_hosted AND public.erasure_never_hosted_admitted(owner_id,r) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR r->'registrySnapshot'->>'user_id' IS DISTINCT FROM owner_id
 OR r->>'hushhId' IS DISTINCT FROM row_state.hushh_id OR row_state.hushh_id IS NULL OR row_state.hushh_id=''
 OR r->>'attemptId' IS NULL OR r->>'attemptId'=''
 OR jsonb_typeof(release) IS DISTINCT FROM 'object'
 OR r ?| ARRAY['lateUpgradeAcknowledgement','lateProvisionAcknowledgement']
 OR nullif(r->'registrySnapshot'->'backend_metadata'->>'upgradeLease','') IS NOT NULL
 OR (NOT never_hosted AND r->'registrySnapshot'->'backend_metadata'->'provisionAttempt'->>'phase' IS DISTINCT FROM 'provisioned')
 OR setup.project_id IS DISTINCT FROM r->'registrySnapshot'->>'user_cloud_project' THEN RETURN false; END IF;
 IF public.project_grant_release_is_exclusive(owner_id,r->'grantRelease'->>'project') IS DISTINCT FROM true THEN RETURN false; END IF;
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
 archive:=public.personal_agent_erasure_archive(r,setup.authorization_attempts);
 IF octet_length(archive::text)>2097152 THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM public.personal_agent_deletion_tombstones t WHERE
  (t.hushh_id=row_state.hushh_id OR t.metadata->>'ownerId'=owner_id OR t.metadata->>'user_id'=owner_id)
  AND (t.status IS DISTINCT FROM 'erasure_completed' OR t.metadata IS DISTINCT FROM archive
       OR t.external_agent_id IS DISTINCT FROM row_state.external_agent_id)) THEN RETURN false; END IF;
 RETURN true;
END;
$$;

COMMIT;
