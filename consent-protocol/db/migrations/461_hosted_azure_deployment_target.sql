-- Admit Hussh-Hosted Azure ('azure') placement while keeping owner-cloud coordinates NULL.
SELECT pg_advisory_xact_lock(2690461);
LOCK TABLE public.personal_agent_registry IN ACCESS EXCLUSIVE MODE;

DO $migration$
DECLARE
  installed TEXT;
BEGIN
  SELECT replace(pg_get_constraintdef(oid, true), ' ', '')
  INTO installed
  FROM pg_constraint
  WHERE conrelid = 'public.personal_agent_registry'::regclass
    AND conname = 'personal_agent_registry_deployment_target_check'
    AND convalidated;

  IF installed IS NULL OR position('''azure''::text' IN installed) = 0 THEN
    ALTER TABLE public.personal_agent_registry
      DROP CONSTRAINT IF EXISTS personal_agent_registry_deployment_target_check;
    ALTER TABLE public.personal_agent_registry
      ADD CONSTRAINT personal_agent_registry_deployment_target_check
      CHECK (
        deployment_target IS NULL
        OR deployment_target IN ('gcp', 'azure', 'user_gcp', 'user_azure', 'null')
      );
  END IF;
END
$migration$;

ALTER TABLE public.personal_agent_registry
  DROP CONSTRAINT IF EXISTS personal_agent_registry_hosted_azure_no_owner_cloud_check;
ALTER TABLE public.personal_agent_registry
  ADD CONSTRAINT personal_agent_registry_hosted_azure_no_owner_cloud_check
  CHECK (
    deployment_target IS DISTINCT FROM 'azure'
    OR (
      user_cloud_project IS NULL
      AND user_cloud_region IS NULL
      AND user_cloud_bootstrap_sa IS NULL
      AND user_cloud_authorized_at IS NULL
      AND user_cloud_tenant_id IS NULL
      AND user_cloud_subscription_id IS NULL
      AND user_cloud_resource_group IS NULL
    )
  );
