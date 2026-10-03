-- A person's synced standby agent, and the placement epoch that fences a switch.
--
-- PARKED (dev-only band, same contract as 900-949): out of
-- db/release_migration_manifest.json, applied only by the dev migration lane.
-- Design: docs/future/personal-agent/STANDBY-SYNC.md (engineering decisions E4,
-- E8, E9, E10). Inherits docs/reference/architecture/private-agent-north-star.md.
--
-- What changes, and why
-- ---------------------
-- * personal_agent_registry stays the PRIMARY's view, so every existing reader keeps
--   working. It gains placement_epoch (0 for every existing row), bumped by exactly
--   one on every promotion. A signed pod request from a person with a standby, or
--   with an epoch above 0, must carry the epoch it was told (X-Hushh-Pod-Epoch); a
--   stale one is refused by the hub verifier, which is what fences a returning old
--   primary out of every write.
-- * personal_agent_standby_placements holds at most ONE standby per person (user_id
--   is the primary key): the same placement coordinates the registry holds for the
--   primary, its address, its PUBLIC keys, and the last synced sequence and head
--   hash. No private key, token, bundle or record content ever belongs here: the hub
--   ferries ciphertext and cannot open it.
-- * synced_seq only moves forward (trigger below), and the standby's keys must differ
--   from the primary's, so the verifier can always tell the two placements apart.
-- * The standby row is keyed to the registry row it belongs to (ON DELETE RESTRICT):
--   the registry row of a person with a standby cannot be deleted out from under it,
--   so a standby can never become an orphaned cloud resource nobody records.
--
-- Idempotent under the dev lane: every constraint and trigger is dropped once before
-- it is created.

BEGIN;

ALTER TABLE public.personal_agent_registry
  ADD COLUMN IF NOT EXISTS placement_epoch BIGINT NOT NULL DEFAULT 0;

ALTER TABLE public.personal_agent_registry
  DROP CONSTRAINT IF EXISTS personal_agent_registry_placement_epoch_check;
ALTER TABLE public.personal_agent_registry
  ADD CONSTRAINT personal_agent_registry_placement_epoch_check CHECK (placement_epoch >= 0);

CREATE TABLE IF NOT EXISTS public.personal_agent_standby_placements (
    user_id TEXT PRIMARY KEY
        REFERENCES public.personal_agent_registry(user_id) ON DELETE RESTRICT,
    hushh_id TEXT NOT NULL
        REFERENCES public.personal_agent_registry(hushh_id) ON DELETE RESTRICT,
    -- Where the standby runs: the registry's own placement vocabulary.
    deployment_target TEXT NOT NULL,
    backend TEXT,
    external_agent_id TEXT NOT NULL,
    region TEXT,
    model_credential_mode TEXT,
    user_cloud_project TEXT,
    user_cloud_region TEXT,
    user_cloud_bootstrap_sa TEXT,
    user_cloud_authorized_at TIMESTAMPTZ,
    user_cloud_tenant_id TEXT,
    user_cloud_subscription_id TEXT,
    user_cloud_resource_group TEXT,
    url TEXT NOT NULL,
    -- Public keys only, recorded the same way the registry records the primary's.
    pod_pubkey TEXT NOT NULL,
    pod_key_id TEXT NOT NULL,
    pod_key_wrapping_alg TEXT,
    pod_signing_pubkey TEXT NOT NULL,
    pod_signing_key_id TEXT NOT NULL,
    runtime_version TEXT,
    prompt_version TEXT,
    -- Placement metadata that moves with the host on a switch (never person-level
    -- keys such as puppy* or detachedPlacements, never erasure or lease state).
    backend_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    provisioned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Sync progress: the standby holds every record up to synced_seq / synced_head_sha.
    synced_seq BIGINT NOT NULL DEFAULT 0,
    synced_head_sha TEXT,
    last_sync_at TIMESTAMPTZ,
    last_sync_attempt_at TIMESTAMPTZ,
    last_sync_status TEXT NOT NULL DEFAULT 'pending',
    -- Single-flight sync lease. Advisory: the pod-side compare-and-swap is the fence.
    sync_lease_id TEXT,
    sync_lease_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.personal_agent_standby_placements
  DROP CONSTRAINT IF EXISTS personal_agent_standby_target_check,
  DROP CONSTRAINT IF EXISTS personal_agent_standby_model_mode_check,
  DROP CONSTRAINT IF EXISTS personal_agent_standby_user_gcp_needs_project_check,
  DROP CONSTRAINT IF EXISTS personal_agent_standby_user_azure_needs_coordinates_check,
  DROP CONSTRAINT IF EXISTS personal_agent_standby_azure_ids_shape_check,
  DROP CONSTRAINT IF EXISTS personal_agent_standby_url_check,
  DROP CONSTRAINT IF EXISTS personal_agent_standby_signing_key_check,
  DROP CONSTRAINT IF EXISTS personal_agent_standby_metadata_check,
  DROP CONSTRAINT IF EXISTS personal_agent_standby_sync_check,
  DROP CONSTRAINT IF EXISTS personal_agent_standby_lease_check;

ALTER TABLE public.personal_agent_standby_placements
  ADD CONSTRAINT personal_agent_standby_target_check
    CHECK (deployment_target IN ('gcp', 'user_gcp', 'user_azure')),
  ADD CONSTRAINT personal_agent_standby_model_mode_check
    CHECK (model_credential_mode IS NULL
           OR model_credential_mode IN ('user_adc', 'byok_per_turn', 'fleet_adc', 'user_azure_mi')),
  ADD CONSTRAINT personal_agent_standby_user_gcp_needs_project_check
    CHECK (deployment_target IS DISTINCT FROM 'user_gcp' OR user_cloud_project IS NOT NULL),
  ADD CONSTRAINT personal_agent_standby_user_azure_needs_coordinates_check
    CHECK (deployment_target IS DISTINCT FROM 'user_azure'
           OR (user_cloud_tenant_id IS NOT NULL
               AND user_cloud_subscription_id IS NOT NULL
               AND user_cloud_resource_group IS NOT NULL
               AND user_cloud_region IS NOT NULL)),
  ADD CONSTRAINT personal_agent_standby_azure_ids_shape_check
    CHECK ((user_cloud_tenant_id IS NULL
            OR user_cloud_tenant_id ~ '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$')
           AND (user_cloud_subscription_id IS NULL
            OR user_cloud_subscription_id ~ '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$')),
  ADD CONSTRAINT personal_agent_standby_url_check
    CHECK (left(url, 8) = 'https://' AND length(url) <= 2048),
  ADD CONSTRAINT personal_agent_standby_signing_key_check
    CHECK (pod_signing_pubkey ~ '^[A-Za-z0-9+/]{43}=$'
           AND pod_signing_key_id ~ '^pods_[0-9a-f]{32}$'),
  ADD CONSTRAINT personal_agent_standby_metadata_check
    CHECK (jsonb_typeof(backend_metadata) = 'object'
           AND NOT (backend_metadata ?| ARRAY['erasure', 'upgradeLease', 'detachedPlacements', 'url'])
           AND (NOT (backend_metadata ? 'provisionAttempt')
                OR backend_metadata->'provisionAttempt'->>'phase' = 'provisioned')),
  ADD CONSTRAINT personal_agent_standby_sync_check
    CHECK (synced_seq >= 0
           AND (synced_seq = 0) = (synced_head_sha IS NULL)
           AND (synced_head_sha IS NULL OR synced_head_sha ~ '^[0-9a-f]{64}$')
           AND last_sync_status IN ('pending', 'synced', 'failed', 'diverged')),
  ADD CONSTRAINT personal_agent_standby_lease_check
    CHECK ((sync_lease_id IS NULL) = (sync_lease_at IS NULL)
           AND (sync_lease_id IS NULL OR sync_lease_id ~ '^[0-9a-f]{32}$'));

-- One owner per cloud home, across standbys as the registry states it for primaries.
CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_agent_standby_one_owner_per_cloud
    ON public.personal_agent_standby_placements(user_cloud_project)
    WHERE deployment_target = 'user_gcp' AND user_cloud_project IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_agent_standby_one_owner_per_azure_group
    ON public.personal_agent_standby_placements(user_cloud_tenant_id, user_cloud_subscription_id,
                                                user_cloud_resource_group)
    WHERE deployment_target = 'user_azure';
-- The sync sweep's scan: least recently attempted first.
CREATE INDEX IF NOT EXISTS idx_personal_agent_standby_sync_attempt
    ON public.personal_agent_standby_placements(last_sync_attempt_at NULLS FIRST);

-- The standby belongs to exactly the registry row it names, with distinct keys.
-- Two foreign keys alone would allow user_id of one row with hushh_id of another.
CREATE OR REPLACE FUNCTION public.guard_personal_agent_standby_placement()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE primary_row public.personal_agent_registry%ROWTYPE;
BEGIN
  SELECT * INTO primary_row FROM public.personal_agent_registry WHERE user_id = NEW.user_id;
  IF NOT FOUND OR primary_row.hushh_id IS DISTINCT FROM NEW.hushh_id THEN
    RAISE EXCEPTION 'standby placement must belong to its registry row' USING ERRCODE='42501';
  END IF;
  IF NEW.pod_signing_key_id IS NOT DISTINCT FROM primary_row.pod_signing_key_id
     OR NEW.pod_key_id IS NOT DISTINCT FROM primary_row.pod_key_id
     OR NEW.external_agent_id IS NOT DISTINCT FROM primary_row.external_agent_id THEN
    RAISE EXCEPTION 'standby placement must not share the primary''s keys or host' USING ERRCODE='42501';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.synced_seq < OLD.synced_seq THEN
    RAISE EXCEPTION 'standby synced sequence never moves backwards' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zx_personal_agent_standby_placement ON public.personal_agent_standby_placements;
-- A constraint trigger deferred to commit, so a switch that moves both rows in one
-- transaction is judged on the finished pair rather than on a half-moved one.
CREATE CONSTRAINT TRIGGER zx_personal_agent_standby_placement
AFTER INSERT OR UPDATE ON public.personal_agent_standby_placements
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.guard_personal_agent_standby_placement();

DROP TRIGGER IF EXISTS trg_reject_deleted_account_insert ON public.personal_agent_standby_placements;
CREATE TRIGGER trg_reject_deleted_account_insert BEFORE INSERT ON public.personal_agent_standby_placements
FOR EACH ROW EXECUTE FUNCTION public.reject_deleted_account_identity_write('user_id');
DROP TRIGGER IF EXISTS trg_reject_deleted_account_reference_update ON public.personal_agent_standby_placements;
CREATE TRIGGER trg_reject_deleted_account_reference_update BEFORE UPDATE OF user_id ON public.personal_agent_standby_placements
FOR EACH ROW EXECUTE FUNCTION public.reject_deleted_account_identity_write('user_id');

COMMENT ON COLUMN public.personal_agent_registry.placement_epoch IS
  'Bumped by one on every promotion of a standby. Signed pod requests from a person with a standby or an epoch above 0 must carry it (X-Hushh-Pod-Epoch); a stale one is refused.';
COMMENT ON TABLE public.personal_agent_standby_placements IS
  'At most one synced standby agent per person: placement coordinates, address, public keys and sync progress only. No private key, token or record content.';
COMMENT ON COLUMN public.personal_agent_standby_placements.synced_seq IS
  'Last commit-log sequence the standby is proven to hold (equal heads); never decreases.';
COMMENT ON COLUMN public.personal_agent_standby_placements.sync_lease_id IS
  'Single-flight sync lease (32 hex). Reclaimable after a TTL: the pod-side compare-and-swap on the log head is the real fence.';

COMMIT;
