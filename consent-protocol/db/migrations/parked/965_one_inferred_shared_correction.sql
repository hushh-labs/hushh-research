-- Dev-only forward correction to applied 958; never rewrite its checksum.
-- Only its exact inferred choice can be retired. Explicit choices, assignments,
-- setup jobs and the original historical receipt remain intact.
BEGIN;
UPDATE public.vault_keys AS vk
SET one_hosting_choice = NULL, one_hosting_choice_at = NULL
WHERE vk.one_hosting_choice = 'shared'
  AND vk.one_hosting_legacy_shared_at IS NOT NULL
  AND vk.one_hosting_choice_at = vk.one_hosting_legacy_shared_at
  AND (
    EXISTS (
      SELECT 1 FROM public.personal_agent_registry AS r
      WHERE r.user_id = vk.user_id AND (
        EXISTS (
          SELECT 1 FROM unnest(ARRAY[
            'deployment_target', 'backend', 'external_agent_id', 'a2a_route',
            'pod_key_id', 'pod_pubkey', 'pod_signing_pubkey', 'pod_signing_key_id',
            'user_cloud_project', 'user_cloud_region', 'user_cloud_bootstrap_sa',
            'user_cloud_authorized_at', 'user_cloud_tenant_id',
            'user_cloud_subscription_id', 'user_cloud_resource_group'
          ]) AS field(name)
          WHERE coalesce(to_jsonb(r)->>field.name, '') <> ''
        )
        OR coalesce(r.status, '') NOT IN ('', 'unprovisioned')
        OR (r.backend_metadata IS NOT NULL
            AND jsonb_typeof(r.backend_metadata) IS DISTINCT FROM 'object')
        OR coalesce(r.backend_metadata, '{}'::jsonb) <> '{}'::jsonb
      )
    )
    OR EXISTS (SELECT 1 FROM public.byoc_setup_jobs AS j WHERE j.user_id = vk.user_id)
  );
-- No rollback re-infers placement from an unsafe historical snapshot.
COMMIT;
