-- Dev-only: keep authorization evidence across setup retries in its existing row.
BEGIN;
ALTER TABLE public.byoc_setup_jobs ADD COLUMN IF NOT EXISTS authorization_attempts jsonb NOT NULL DEFAULT '{}'::jsonb;
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
CREATE TRIGGER zz_byoc_authorization_attempts BEFORE INSERT OR UPDATE OR DELETE ON public.byoc_setup_jobs
FOR EACH ROW EXECUTE FUNCTION public.guard_byoc_authorization_attempts();
CREATE OR REPLACE FUNCTION public.retain_byoc_authorization(owner_id text,target_job text,intent jsonb,receipt jsonb DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE current_row public.byoc_setup_jobs%ROWTYPE; old_v jsonb; new_v jsonb;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.byoc_setup_jobs'::regclass AND tgname='zz_byoc_authorization_attempts' AND tgfoid='public.guard_byoc_authorization_attempts()'::regprocedure AND tgtype=31 AND tgenabled IN ('O','A') AND tgnargs=0 AND tgqual IS NULL) THEN RETURN false; END IF;
 SELECT * INTO current_row FROM public.byoc_setup_jobs WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 old_v:=current_row.authorization_attempts->target_job;
 new_v:=jsonb_build_object('intent',intent);
 IF receipt IS NOT NULL THEN
  IF old_v IS NULL OR old_v->'intent' IS DISTINCT FROM intent THEN RETURN false; END IF;
  new_v:=new_v||jsonb_build_object('receipt',receipt);
 END IF;
 IF receipt IS NULL AND old_v IS NOT NULL THEN RETURN false; END IF;
 IF old_v=new_v THEN RETURN true; END IF;
 UPDATE public.byoc_setup_jobs SET authorization_attempts=jsonb_set(authorization_attempts,ARRAY[target_job],new_v,true) WHERE user_id=owner_id;
 RETURN true;
END;
$$;
CREATE OR REPLACE FUNCTION public.project_grant_release_is_exclusive(owner_id text,target_project text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
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
$$;
COMMIT;
