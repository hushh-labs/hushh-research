BEGIN;
LOCK TABLE public.hosted_pod_pilot_policy IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.hosted_pod_pilot_policy) THEN
   RAISE EXCEPTION 'retain admitted pilot allocation; disable new admission and preserve recovery';
 END IF;
END $$;
DROP FUNCTION public.publish_hosted_pod_bootstrap_checkpoint(text,text,jsonb);
DROP FUNCTION public.publish_hosted_pod_preparation_checkpoint(text,text,jsonb);
DROP FUNCTION public.publish_hosted_pod_step_checkpoint(text,text,jsonb,text);
DROP FUNCTION public.valid_hosted_preparation_result(jsonb,jsonb);
DROP FUNCTION public.valid_hosted_policy_observation(jsonb,text,text,text,text);
DROP FUNCTION public.hosted_pod_pilot_admission_current(text,text,jsonb,jsonb);
DROP FUNCTION public.retain_hosted_pod_project_observation(text,text,jsonb);
DROP FUNCTION public.claim_hosted_pod_pilot_provision(text,text,jsonb,jsonb);
DROP TABLE public.hosted_pod_pilot_policy;
DROP FUNCTION public.guard_hosted_pod_pilot_policy();
DROP FUNCTION public.valid_hosted_pod_pilot_assignments(jsonb);
DROP FUNCTION public.valid_hosted_bootstrap_contract(jsonb,text,text);
DROP FUNCTION public.valid_hosted_preparation_contract(jsonb);
COMMIT;
