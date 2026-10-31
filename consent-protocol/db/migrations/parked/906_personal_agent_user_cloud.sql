-- The person's own cloud: WHERE their pod runs, and WHOSE model credential serves it.
--
-- PARKED (dev-only band, same contract as 900-905): out of
-- db/release_migration_manifest.json, applied only by the dev migration lane, so
-- the release migration head is untouched.
--
-- Why this exists
-- ---------------
-- `PodSpec` has carried `deployment_target` and `model_credential_mode` since the
-- per-person deployment axes landed, and the registry has had nowhere to put either.
-- The consequence is not that BYOC is untested -- it is that BYOC is SINGLE-TENANT.
-- `byoc_substrate.resolve_substrate_ensurer` and `UserGcpBackend.__init__` both read
-- HUSSH_USER_GCP_PROJECT from the process environment, so the second person to choose
-- their own cloud has their pod, their CMEK bucket, their KMS key and their service
-- account created inside the FIRST person's project. That is an isolation failure, not
-- a configuration gap, and these columns are the coordinates that end it.
--
-- Why columns and not backend_metadata JSONB
-- ------------------------------------------
-- backend_metadata is written at personal_agent_provisioning_service.py:522, AFTER
-- backend.provision returns. The substrate ensurer is resolved at :501, BEFORE it. So
-- tenant coordinates stored in backend_metadata are unreadable at the exact moment they
-- are needed. backend_metadata is an OUTPUT of provisioning; these are INPUTS to it, and
-- putting an input in the output blob means every provision overwrites the input with
-- whatever the backend reported. Teardown and the orphan sweep also need to find a
-- tenant BY QUERY, which a sometimes-absent JSONB key cannot support.
--
-- Six columns, six distinct facts. Collapsing any two would lose information:
--
--   deployment_target        -- WHICH backend builds this person's pod. Nullable, and
--                               NULL means "the deployment default", which is what
--                               every pre-existing row honestly is.
--
--   model_credential_mode    -- WHOSE credential the agent spends. Orthogonal to the
--                               target on purpose: a person on their own cloud may
--                               still hand over an API key, and the pair is what makes
--                               that expressible rather than a special case.
--
--   user_cloud_project       -- The person's OWN GCP project id. The single fact whose
--                               absence made the whole tier single-tenant.
--
--   user_cloud_region        -- Their region. Separate from the existing `region`
--                               column, which records where the pod was actually
--                               placed; this records where they ASKED for it. They
--                               differ when a region is unavailable, and a request and
--                               an outcome must not share a column.
--
--   user_cloud_bootstrap_sa  -- The account they authorized. STORED, never derived from
--                               the project name, for the reason user_gcp_backend.py
--                               already gives about identities: a guessed account that
--                               happens to exist would be used silently, and the entire
--                               point of the grant is that it was deliberately made.
--
--   user_cloud_authorized_at -- WHEN hushh last proved it can actually act there, by
--                               minting a token and reading the bindings back. Separate
--                               from user_cloud_project because "they typed a name" and
--                               "hushh can act in it" are different facts, and
--                               collapsing them into one boolean is how a gate becomes
--                               decorative. NULL is the honest state for a project that
--                               was named but never authorized, and provisioning must
--                               refuse it rather than fall back to hushh's own cloud.

BEGIN;

ALTER TABLE personal_agent_registry
    ADD COLUMN IF NOT EXISTS deployment_target        TEXT,
    ADD COLUMN IF NOT EXISTS model_credential_mode    TEXT,
    ADD COLUMN IF NOT EXISTS user_cloud_project       TEXT,
    ADD COLUMN IF NOT EXISTS user_cloud_region        TEXT,
    ADD COLUMN IF NOT EXISTS user_cloud_bootstrap_sa  TEXT,
    ADD COLUMN IF NOT EXISTS user_cloud_authorized_at TIMESTAMPTZ;

-- Legal values, enforced in the schema rather than only in Python, for the same reason
-- 905 gives: the registry is read by the provisioning brain, the substrate resolver, the
-- presence surface and operators, and a typo'd target that reached the table would be a
-- silent wrong answer in all four. NULL stays legal -- it means "deployment default".
--
-- Each constraint is dropped exactly once before being added. A bare ADD CONSTRAINT
-- succeeds on the first deploy and raises DuplicateObjectError forever after, because
-- the release guard replays the set on every deploy. Migration 141 taught this twice.
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

-- A user_gcp row without a project is the exact shape of the single-tenant bug: it is
-- the row that would silently fall back to the process-wide environment variable and put
-- this person's pod in somebody else's project. Refuse it in the schema, so no code path
-- anywhere can create one.
ALTER TABLE personal_agent_registry
    DROP CONSTRAINT IF EXISTS personal_agent_registry_user_gcp_needs_project_check;
ALTER TABLE personal_agent_registry
    ADD CONSTRAINT personal_agent_registry_user_gcp_needs_project_check
    CHECK (deployment_target IS DISTINCT FROM 'user_gcp'
           OR user_cloud_project IS NOT NULL);

-- Two people must not resolve to one project. This is the isolation invariant stated
-- where it cannot be bypassed: with it, "user #2 provisioned into user #1's cloud" stops
-- being a bug that needs a test and becomes a state the database will not hold.
--
-- Partial, because it applies only to the tier that owns a project. Rows on hushh's own
-- backends share hushh's project by design and must not collide.
--
-- Reversible: an enterprise that genuinely wants several people in one project is a real
-- future case, and it is a DROP INDEX plus a decision about what isolation then means --
-- not a schema rewrite.
CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_agent_registry_one_owner_per_cloud
    ON personal_agent_registry(user_cloud_project)
    WHERE deployment_target = 'user_gcp' AND user_cloud_project IS NOT NULL;

-- Teardown and the orphan sweep both ask "what did we create in project X?". Without
-- this they ask it with a sequential scan over the whole fleet.
CREATE INDEX IF NOT EXISTS idx_personal_agent_registry_user_cloud_project
    ON personal_agent_registry(user_cloud_project)
    WHERE user_cloud_project IS NOT NULL;

COMMIT;
