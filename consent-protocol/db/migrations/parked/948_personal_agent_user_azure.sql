-- The person's own Azure subscription as a pod home; Anypoint retired as one.
--
-- PARKED (dev-only band, same contract as 900-946): out of
-- db/release_migration_manifest.json, applied only by the dev migration lane.
--
-- What changes, and why
-- ---------------------
-- * deployment_target gains 'user_azure' (docs/reference/architecture/byoc-azure.md)
--   and LOSES 'anypoint': Anypoint is no longer a hosting option (founder decision
--   2026-10-01; the MuleSoft CRM connector is unaffected, it never used this column).
--   A row still naming it is refused below rather than rewritten: moving a person's
--   placement is a decision, not a side effect of a schema change.
-- * model_credential_mode gains 'user_azure_mi': the agent's own managed identity
--   calling Azure OpenAI in the person's subscription.
-- * Three coordinate columns say WHICH subscription, as user_cloud_project does for
--   GCP. The Azure location rides user_cloud_region, so one fact has one column.
-- * One owner per (tenant, subscription, resource group): two people must never
--   resolve to one agent's resources, stated where it cannot be bypassed.
-- * The column comments from 900 still described Anypoint; they are rewritten.
--
-- Idempotent under the dev lane: every constraint is dropped once before it is added.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.personal_agent_registry WHERE deployment_target = 'anypoint'
  ) THEN
    RAISE EXCEPTION 'personal_agent_registry has anypoint placements; reassign them before 948';
  END IF;
END;
$$;

ALTER TABLE personal_agent_registry
    ADD COLUMN IF NOT EXISTS user_cloud_tenant_id       TEXT,
    ADD COLUMN IF NOT EXISTS user_cloud_subscription_id TEXT,
    ADD COLUMN IF NOT EXISTS user_cloud_resource_group  TEXT;

ALTER TABLE personal_agent_registry
    DROP CONSTRAINT IF EXISTS personal_agent_registry_deployment_target_check;
ALTER TABLE personal_agent_registry
    ADD CONSTRAINT personal_agent_registry_deployment_target_check
    CHECK (deployment_target IS NULL
           OR deployment_target IN ('gcp', 'user_gcp', 'user_azure', 'null'));

ALTER TABLE personal_agent_registry
    DROP CONSTRAINT IF EXISTS personal_agent_registry_model_credential_mode_check;
ALTER TABLE personal_agent_registry
    ADD CONSTRAINT personal_agent_registry_model_credential_mode_check
    CHECK (model_credential_mode IS NULL
           OR model_credential_mode IN ('user_adc', 'byok_per_turn', 'fleet_adc', 'user_azure_mi'));

-- The Azure twin of user_gcp_needs_project: a user_azure row missing any coordinate
-- is the row that could only be resolved by guessing, so the schema refuses it.
ALTER TABLE personal_agent_registry
    DROP CONSTRAINT IF EXISTS personal_agent_registry_user_azure_needs_coordinates_check;
ALTER TABLE personal_agent_registry
    ADD CONSTRAINT personal_agent_registry_user_azure_needs_coordinates_check
    CHECK (deployment_target IS DISTINCT FROM 'user_azure'
           OR (user_cloud_tenant_id IS NOT NULL
               AND user_cloud_subscription_id IS NOT NULL
               AND user_cloud_resource_group IS NOT NULL
               AND user_cloud_region IS NOT NULL));

-- Lower-case GUIDs only, so the one-owner index cannot be split by letter case.
ALTER TABLE personal_agent_registry
    DROP CONSTRAINT IF EXISTS personal_agent_registry_azure_ids_shape_check;
ALTER TABLE personal_agent_registry
    ADD CONSTRAINT personal_agent_registry_azure_ids_shape_check
    CHECK ((user_cloud_tenant_id IS NULL
            OR user_cloud_tenant_id ~ '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$')
           AND (user_cloud_subscription_id IS NULL
            OR user_cloud_subscription_id ~ '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_agent_registry_one_owner_per_azure_group
    ON personal_agent_registry(user_cloud_tenant_id, user_cloud_subscription_id,
                               user_cloud_resource_group)
    WHERE deployment_target = 'user_azure';

COMMENT ON COLUMN personal_agent_registry.backend IS
    'Which compute backend hosts this agent (gcp | user_gcp | user_azure | null). Backend-neutral provider abstraction. NULL until provisioned.';
COMMENT ON COLUMN personal_agent_registry.external_agent_id IS
    'Backend-neutral host id for the provisioned agent: a Cloud Run service name, or the container app ARM id in the owner''s Azure subscription. NULL until provisioned.';
COMMENT ON COLUMN personal_agent_registry.user_cloud_tenant_id IS
    'user_azure: the Microsoft Entra directory (tenant id) that owns the person''s subscription. Recorded by the setup job, never inferred.';
COMMENT ON COLUMN personal_agent_registry.user_cloud_subscription_id IS
    'user_azure: the person''s own Azure subscription id, chosen by them at Connect Azure.';
COMMENT ON COLUMN personal_agent_registry.user_cloud_resource_group IS
    'user_azure: the resource group the person''s own setup created for their agent (rg-hussh-one-<keyed digest>).';

COMMIT;
