-- Dev only: retain Azure setup's non-secret binding BEFORE the first ARM write.
-- Stays in the existing setup job; no credential or second infrastructure ledger.
BEGIN;

CREATE OR REPLACE FUNCTION public.valid_byoc_azure_setup_intent(
  owner_id text, job_id text, target text, hushh_id text, intent jsonb
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
BEGIN
 IF jsonb_typeof(intent) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM unnest(ARRAY['jobId','hushhId','tenantId','subscriptionId',
   'resourceGroup','location','setupNonce']) field
   WHERE jsonb_typeof(intent->field) IS DISTINCT FROM 'string') THEN RETURN false; END IF;
 RETURN intent - ARRAY['version','jobId','hushhId','tenantId','subscriptionId',
   'resourceGroup','location','setupNonce'] = '{}'::jsonb
 AND intent ?& ARRAY['version','jobId','hushhId','tenantId','subscriptionId',
   'resourceGroup','location','setupNonce']
 AND intent->'version' = '1'::jsonb
 AND coalesce(owner_id,'') <> '' AND coalesce(job_id,'') <> ''
 AND intent->>'jobId' = job_id AND intent->>'hushhId' = hushh_id
 AND (intent->>'tenantId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') IS TRUE
 AND (intent->>'subscriptionId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') IS TRUE
 AND (intent->>'resourceGroup' ~ '^[A-Za-z0-9_().-]{0,89}[A-Za-z0-9_()-]$') IS TRUE
 AND (intent->>'location' ~ '^[a-z][a-z0-9]{1,39}$') IS TRUE
 AND (intent->>'setupNonce' ~ '^[0-9a-f]{16}$') IS TRUE
 AND target = '/subscriptions/' || (intent->>'subscriptionId') ||
   '/resourceGroups/' || (intent->>'resourceGroup')
 AND pg_column_size(intent) <= 4096;
END;
$$;

CREATE OR REPLACE FUNCTION public.retain_byoc_azure_setup_intent(
  owner_id text, expected_job text, intent jsonb
) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
DECLARE agent public.personal_agent_registry%ROWTYPE;
 job public.byoc_setup_jobs%ROWTYPE; previous jsonb; matches integer;
BEGIN
 IF public.byoc_azure_setup_guards_ready() IS NOT TRUE THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR agent.status NOT IN ('pending','unprovisioned','logical')
    OR agent.backend_metadata ? 'erasure'
    OR nullif(agent.backend,'') IS NOT NULL OR nullif(agent.external_agent_id,'') IS NOT NULL
    OR nullif(agent.user_cloud_project,'') IS NOT NULL
 THEN RETURN false; END IF;
 SELECT * INTO job FROM public.byoc_setup_jobs WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR job.job_id IS DISTINCT FROM expected_job OR job.status <> 'running'
    OR jsonb_typeof(job.stages) IS DISTINCT FROM 'array'
    OR public.valid_byoc_azure_setup_intent(owner_id,expected_job,job.project_id,
      agent.hushh_id,intent) IS NOT TRUE THEN RETURN false; END IF;
 PERFORM public.assert_project_grant_admission(job.project_id);
 SELECT count(*), (jsonb_agg(s->'intent'))->0 INTO matches, previous
   FROM jsonb_array_elements(job.stages) s WHERE s->>'stage'='azure_setup_intent';
 IF matches > 0 THEN RETURN matches=1 AND previous=intent; END IF;
 IF jsonb_array_length(job.stages) >= 256 THEN RETURN false; END IF;
 UPDATE public.byoc_setup_jobs SET stages=stages || jsonb_build_array(
   jsonb_build_object('stage','azure_setup_intent','intent',intent)), updated_at=now()
 WHERE user_id=owner_id AND job_id=expected_job AND status='running';
 RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.byoc_azure_worker_admitted(
  owner_id text, expected_job text
) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
DECLARE agent public.personal_agent_registry%ROWTYPE;
 job public.byoc_setup_jobs%ROWTYPE; intent jsonb; matches integer;
BEGIN
 IF public.byoc_azure_setup_guards_ready() IS NOT TRUE THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id;
 IF NOT FOUND OR agent.status NOT IN ('pending','unprovisioned','logical')
    OR agent.backend_metadata ? 'erasure'
    OR nullif(agent.backend,'') IS NOT NULL OR nullif(agent.external_agent_id,'') IS NOT NULL
    OR nullif(agent.user_cloud_project,'') IS NOT NULL
 THEN RETURN false; END IF;
 SELECT * INTO job FROM public.byoc_setup_jobs WHERE user_id=owner_id;
 IF NOT FOUND OR job.job_id IS DISTINCT FROM expected_job OR job.status <> 'running'
    OR jsonb_typeof(job.stages) IS DISTINCT FROM 'array'
 THEN RETURN false; END IF;
 SELECT count(*), (jsonb_agg(s->'intent'))->0 INTO matches, intent
   FROM jsonb_array_elements(job.stages) s WHERE s->>'stage'='azure_setup_intent';
 RETURN matches=1 AND public.valid_byoc_azure_setup_intent(owner_id,expected_job,
   job.project_id,agent.hushh_id,intent) IS TRUE;
END;
$$;

-- Azure jobs have no GCP authorization_attempts; their original binding must
-- nevertheless survive a reserved erasure. Worker liveness is not drain proof.
CREATE OR REPLACE FUNCTION public.guard_byoc_azure_erasure_job()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE reservation jsonb; owner_id text; previous_target text;
BEGIN
 IF TG_OP='INSERT' THEN owner_id:=NEW.user_id; previous_target:=NEW.project_id;
 ELSE owner_id:=OLD.user_id; previous_target:=OLD.project_id; END IF;
 IF (previous_target LIKE '/subscriptions/%/resourceGroups/%') IS NOT TRUE
   AND (TG_OP='DELETE' OR (NEW.project_id LIKE '/subscriptions/%/resourceGroups/%') IS NOT TRUE)
 THEN
   IF TG_OP='DELETE' THEN RETURN OLD; END IF;
   RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id
 THEN RAISE EXCEPTION 'Azure setup owner is immutable' USING ERRCODE='42501'; END IF;
 -- A raw UPDATE already holds its job row. Never block on owner locks in that
 -- inverted order; refuse and retry under the normal owner-first entrypoint.
 IF NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,171))
   OR NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,198))
 THEN RAISE EXCEPTION 'Azure setup admission is busy' USING ERRCODE='42501'; END IF;
 SELECT backend_metadata->'erasure' INTO reservation FROM public.personal_agent_registry
   WHERE user_id=owner_id;
 IF reservation IS NULL THEN
   IF TG_OP='DELETE' THEN RETURN OLD; END IF;
   RETURN NEW;
 END IF;
 IF TG_OP='DELETE' AND public.personal_agent_erasure_archived(owner_id,reservation) IS TRUE
 THEN RETURN OLD; END IF;
 IF TG_OP='UPDATE'
   AND to_jsonb(NEW)-ARRAY['status','error_code','error_message','updated_at'] =
       to_jsonb(OLD)-ARRAY['status','error_code','error_message','updated_at']
   AND (NEW.status=OLD.status OR (OLD.status='running' AND NEW.status='failed'))
 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Azure setup is fenced for erasure' USING ERRCODE='42501';
END;
$$;
DROP TRIGGER IF EXISTS zw_byoc_azure_erasure ON public.byoc_setup_jobs;
CREATE TRIGGER zw_byoc_azure_erasure BEFORE INSERT OR UPDATE OR DELETE ON public.byoc_setup_jobs
FOR EACH ROW EXECUTE FUNCTION public.guard_byoc_azure_erasure_job();

CREATE OR REPLACE FUNCTION public.byoc_azure_setup_guards_ready()
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT count(*)=2 FROM pg_trigger WHERE tgenabled IN ('O','A') AND tgnargs=0
 AND tgqual IS NULL AND (
   (tgrelid='public.byoc_setup_jobs'::regclass AND tgname='zw_byoc_azure_erasure'
    AND tgfoid='public.guard_byoc_azure_erasure_job()'::regprocedure AND tgtype=31)
   OR (tgrelid='public.personal_agent_registry'::regclass
    AND tgname='zz_personal_agent_erasure_registry'
    AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure AND tgtype=27));
$$;

COMMIT;
