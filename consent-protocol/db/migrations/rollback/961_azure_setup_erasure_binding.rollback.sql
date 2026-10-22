-- Stop and reconcile setup workers before removing their durable admission.
BEGIN;
LOCK TABLE public.personal_agent_registry IN SHARE MODE;
LOCK TABLE public.byoc_setup_jobs IN SHARE MODE;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.byoc_setup_jobs j WHERE
   j.project_id LIKE '/subscriptions/%/resourceGroups/%'
   AND (j.status='running' OR EXISTS (SELECT 1 FROM jsonb_array_elements(j.stages) s
     WHERE s->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent','azure_worker_started',
       'azure_worker_exited','azure_provider_request','azure_provider_ack','azure_provider_terminal'))))
 OR EXISTS (SELECT 1 FROM public.personal_agent_registry r
   JOIN public.byoc_setup_jobs j ON j.user_id=r.user_id
   WHERE r.backend_metadata ? 'erasure'
     AND j.project_id LIKE '/subscriptions/%/resourceGroups/%')
 THEN RAISE EXCEPTION 'Azure setup bindings require forward recovery'; END IF;
END $$;
DROP TRIGGER zw_byoc_azure_erasure ON public.byoc_setup_jobs;
DROP FUNCTION public.guard_byoc_azure_erasure_job();
DROP FUNCTION public.byoc_azure_worker_admitted(text,text);
DROP FUNCTION public.retain_byoc_azure_setup_intent(text,text,jsonb);
DROP FUNCTION public.begin_byoc_azure_worker(text,text,text,jsonb);
DROP FUNCTION public.begin_byoc_azure_worker(text,text,text);
DROP FUNCTION public.retain_byoc_azure_worker_event(text,text,jsonb);
DROP FUNCTION public.valid_byoc_azure_worker_event(text,text,jsonb,jsonb,text,text);
DROP FUNCTION public.valid_azure_arm_acknowledgement(jsonb,text);
DROP FUNCTION public.byoc_azure_worker_session_held(text);
DROP FUNCTION public.byoc_azure_worker_history_has_capacity(jsonb);
DROP FUNCTION public.byoc_azure_setup_guards_ready();
DROP FUNCTION public.byoc_azure_live_worker_admitted(text,text,boolean);
DROP FUNCTION public.byoc_azure_files_request_admitted(text,jsonb);
DROP FUNCTION public.byoc_azure_intent_admitted(public.personal_agent_registry,public.byoc_setup_jobs,jsonb,boolean);
DROP FUNCTION public.valid_byoc_azure_hosted_intent(text,text,text,text,jsonb);
DROP FUNCTION public.valid_byoc_azure_setup_intent(text,text,text,text,jsonb);
DROP FUNCTION public.valid_byoc_azure_hosted_request(jsonb,jsonb,text);
COMMIT;
