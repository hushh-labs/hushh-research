SELECT pg_advisory_xact_lock(2690462);
LOCK TABLE public.personal_agent_registry IN ACCESS EXCLUSIVE MODE;

DO $rollback$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.personal_agent_registry WHERE deployment_target = 'ace'
  ) THEN
    RAISE EXCEPTION 'hosted ace placements must be migrated or retired before rolling back 462';
  END IF;
END
$rollback$;

ALTER TABLE public.personal_agent_registry
  DROP CONSTRAINT IF EXISTS personal_agent_registry_hosted_ace_no_owner_cloud_check;
ALTER TABLE public.personal_agent_registry
  DROP CONSTRAINT IF EXISTS personal_agent_registry_deployment_target_check;
ALTER TABLE public.personal_agent_registry
  ADD CONSTRAINT personal_agent_registry_deployment_target_check
  CHECK (
    deployment_target IS NULL
    OR deployment_target IN ('gcp', 'azure', 'user_gcp', 'user_azure', 'null')
  );
