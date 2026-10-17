BEGIN;
LOCK TABLE public.byoc_setup_jobs IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.byoc_setup_jobs WHERE authorization_attempts<>'{}'::jsonb) THEN RAISE EXCEPTION 'authorization receipts require preservation'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.project_grant_release_is_exclusive(owner_id text,target_project text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
BEGIN
 IF target_project IS NULL OR target_project !~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$' OR current_setting('transaction_isolation') <> 'read committed' THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(target_project,205));
 IF (SELECT count(*) FROM pg_trigger WHERE
  (tgrelid='public.personal_agent_registry'::regclass AND tgname='zx_project_grant_registry' AND tgfoid='public.guard_project_grant_registry_admission()'::regprocedure AND tgtype=23)
  OR (tgrelid='public.byoc_setup_jobs'::regclass AND tgname='zx_project_grant_setup' AND tgfoid='public.guard_project_grant_setup_admission()'::regprocedure AND tgtype=23)
  OR (tgrelid='public.personal_agent_registry'::regclass AND tgname='zz_personal_agent_erasure_registry' AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure AND tgtype=27)) <> 3 THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('zx_project_grant_registry','zx_project_grant_setup','zz_personal_agent_erasure_registry') AND tgrelid IN ('public.personal_agent_registry'::regclass,'public.byoc_setup_jobs'::regclass) AND (tgenabled NOT IN ('O','A') OR tgnargs<>0 OR tgqual IS NOT NULL)) THEN RETURN false; END IF;
 -- Never lock other owners' rows under the project lock. Unresolved users retain grants.
 IF EXISTS (SELECT 1 FROM public.personal_agent_registry x WHERE x.user_id<>owner_id AND
   (x.user_cloud_project=target_project OR x.backend_metadata->'provisionAttempt'->'intent'->>'user_cloud_project'=target_project))
 OR EXISTS (SELECT 1 FROM public.byoc_setup_jobs j WHERE j.project_id=target_project AND (j.user_id<>owner_id OR j.status IS DISTINCT FROM 'recorded')) THEN RETURN false; END IF;
 RETURN true;
END;
$$;
DROP FUNCTION public.retain_byoc_authorization(text,text,jsonb,jsonb);
DROP TRIGGER zz_byoc_authorization_attempts ON public.byoc_setup_jobs;
DROP FUNCTION public.guard_byoc_authorization_attempts();
ALTER TABLE public.byoc_setup_jobs DROP COLUMN authorization_attempts;
COMMIT;
