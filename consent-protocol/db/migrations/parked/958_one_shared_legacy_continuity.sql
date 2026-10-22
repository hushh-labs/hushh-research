-- Preserve completed legacy Shared accounts at the first placement rollout.
-- Main's onboarding used connections, not the branch-only cloud capability.
-- Missing placement is still NOT a default for new or incomplete accounts.
--
-- Dev qualification only. Production graduation must include the placement
-- reader foundations and this one-time backfill before application traffic.
-- Do not change applied 955 or relocate any applied parked migration.
BEGIN;

DO $$
DECLARE
  already_captured BOOLEAN;
  captured_at TIMESTAMPTZ := transaction_timestamp();
BEGIN
  -- The column is the durable one-time boundary. New rows do not inherit it.
  -- Replay must not opt accounts created/completed after this snapshot into Shared.
  SELECT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.vault_keys'::regclass
      AND attname = 'one_hosting_legacy_shared_at' AND NOT attisdropped
  ) INTO already_captured;
  IF NOT already_captured THEN
    ALTER TABLE public.vault_keys ADD COLUMN one_hosting_legacy_shared_at TIMESTAMPTZ;
    UPDATE public.vault_keys AS vk
    SET one_hosting_choice = 'shared',
        one_hosting_choice_at = captured_at,
        one_hosting_legacy_shared_at = captured_at
    WHERE vk.setup_completed IS TRUE
      AND vk.one_hosting_choice IS NULL
      AND vk.one_hosting_choice_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.personal_agent_registry AS r
        WHERE r.user_id = vk.user_id AND (
          coalesce(r.deployment_target, '') <> ''
          OR coalesce(r.backend, '') <> ''
          OR coalesce(r.external_agent_id, '') <> ''
          OR coalesce(r.a2a_route, '') <> ''
          OR coalesce(r.pod_key_id, '') <> ''
          OR coalesce(r.pod_pubkey, '') <> ''
          OR coalesce(r.status, '') NOT IN ('', 'unprovisioned')
          OR (r.backend_metadata IS NOT NULL
              AND jsonb_typeof(r.backend_metadata) IS DISTINCT FROM 'object')
          -- Nonempty metadata can retain a URL, lease, erasure or provisioning
          -- receipt even with blank placement fields. Absence is not established.
          OR coalesce(r.backend_metadata, '{}'::jsonb) <> '{}'::jsonb
        )
      )
      AND NOT EXISTS (SELECT 1 FROM public.byoc_setup_jobs AS j WHERE j.user_id = vk.user_id);
  END IF;
END;
$$;

COMMENT ON COLUMN public.vault_keys.one_hosting_legacy_shared_at IS
  'One-time legacy Shared continuity receipt. New accounts require explicit placement; no default.';
COMMIT;
