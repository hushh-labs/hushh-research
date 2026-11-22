SELECT pg_advisory_xact_lock(2690461);
LOCK TABLE public.personal_agent_registry IN ACCESS EXCLUSIVE MODE;

DO $rollback$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.personal_agent_registry WHERE deployment_target = 'azure'
  ) THEN
    RAISE EXCEPTION 'hosted azure placements must be migrated or retired before rolling back 461';
  END IF;
END
$rollback$;

ALTER TABLE public.personal_agent_registry
  DROP CONSTRAINT IF EXISTS personal_agent_registry_hosted_azure_no_owner_cloud_check;
ALTER TABLE public.personal_agent_registry
  DROP CONSTRAINT IF EXISTS personal_agent_registry_deployment_target_check;
ALTER TABLE public.personal_agent_registry
  ADD CONSTRAINT personal_agent_registry_deployment_target_check
  CHECK (
    deployment_target IS NULL
    OR deployment_target IN ('gcp', 'user_gcp', 'user_azure', 'null')
  );
