BEGIN;
LOCK TABLE public.hosted_pod_pilot_policy IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.hosted_pod_pilot_policy) THEN
   RAISE EXCEPTION 'retain admitted pilot allocation; disable new admission and preserve recovery';
 END IF;
END $$;
DROP FUNCTION public.claim_hosted_pod_pilot_provision(text,text,jsonb,jsonb);
DROP TABLE public.hosted_pod_pilot_policy;
DROP FUNCTION public.guard_hosted_pod_pilot_policy();
DROP FUNCTION public.valid_hosted_pod_pilot_assignments(jsonb);
COMMIT;
