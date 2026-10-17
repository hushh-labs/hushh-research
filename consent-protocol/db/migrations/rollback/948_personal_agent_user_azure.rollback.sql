-- Roll back 948 only while no Azure placement exists: dropping the coordinates of a
-- live owner Azure agent would orphan resources in the person's own subscription.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.personal_agent_registry
    WHERE deployment_target = 'user_azure'
       OR model_credential_mode = 'user_azure_mi'
       OR user_cloud_tenant_id IS NOT NULL
       OR user_cloud_subscription_id IS NOT NULL
       OR user_cloud_resource_group IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Azure placements must be moved or erased before 948 is rolled back';
  END IF;
END;
$$;

DROP INDEX IF EXISTS idx_personal_agent_registry_one_owner_per_azure_group;

ALTER TABLE personal_agent_registry
    DROP CONSTRAINT IF EXISTS personal_agent_registry_azure_ids_shape_check;
ALTER TABLE personal_agent_registry
    DROP CONSTRAINT IF EXISTS personal_agent_registry_user_azure_needs_coordinates_check;

ALTER TABLE personal_agent_registry
    DROP CONSTRAINT IF EXISTS personal_agent_registry_deployment_target_check;
ALTER TABLE personal_agent_registry
    ADD CONSTRAINT personal_agent_registry_deployment_target_check
    CHECK (deployment_target IS NULL
           OR deployment_target IN ('gcp', 'user_gcp', 'anypoint', 'null'));

ALTER TABLE personal_agent_registry
    DROP CONSTRAINT IF EXISTS personal_agent_registry_model_credential_mode_check;
ALTER TABLE personal_agent_registry
    ADD CONSTRAINT personal_agent_registry_model_credential_mode_check
    CHECK (model_credential_mode IS NULL
           OR model_credential_mode IN ('user_adc', 'byok_per_turn', 'fleet_adc'));

ALTER TABLE personal_agent_registry
    DROP COLUMN IF EXISTS user_cloud_resource_group,
    DROP COLUMN IF EXISTS user_cloud_subscription_id,
    DROP COLUMN IF EXISTS user_cloud_tenant_id;

COMMENT ON COLUMN personal_agent_registry.backend IS
    'Which compute backend hosts this agent (gcp | anypoint | null). Backend-neutral provider abstraction. NULL until provisioned.';
COMMENT ON COLUMN personal_agent_registry.external_agent_id IS
    'Backend-neutral host id for the provisioned agent (formerly anypoint_agent_id). NULL until provisioned.';

COMMIT;
