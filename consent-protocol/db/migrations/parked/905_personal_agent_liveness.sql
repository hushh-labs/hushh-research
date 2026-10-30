-- Pod liveness: a truthful source of "is this person's agent actually alive?".
--
-- PARKED (dev-only band, same contract as 900-904): out of
-- db/release_migration_manifest.json, applied only by the dev migration lane, so
-- the release migration head is untouched.
--
-- Why this exists
-- ---------------
-- personal_agent_reconcile_worker.py states the gap in its own docstring: the
-- registry has no last-activity column, so "there is no truthful source of pod
-- idleness in the schema today", and it refuses to reap on row AGE because that
-- would tear down warm pods belonging to active people. The worker was written to
-- take its idle set from an injected callable precisely so it would not have to
-- lie about what `updated_at` means. These columns are what that callable can
-- finally read.
--
-- Three columns, three distinct facts. Collapsing them would lose information:
--
--   last_heartbeat_at  -- OBSERVED. When the pod itself last spoke to the hub.
--                         Written only by the pod's own authenticated heartbeat,
--                         never inferred, so NULL genuinely means "never heard
--                         from" and not "we forgot to look".
--
--   health_state       -- JUDGED. The hub's conclusion about the pod, which is a
--                         different thing from the observation above and must not
--                         be recomputed from it at read time by every caller.
--                         Persisted so the presence surface, the reconcile sweep
--                         and an operator all read one verdict rather than three
--                         independently-derived ones that can disagree.
--
--   liveness_mode      -- The RULE by which silence is to be interpreted for THIS
--                         pod. See below; this is the column that keeps the whole
--                         feature from being wrong for half the fleet.
--
-- Why liveness_mode is stored per row and not read from the environment
-- --------------------------------------------------------------------
-- Silence means opposite things depending on how the pod was created:
--
--   warm     (minScale >= 1) -- a warm instance is paid for, so the pod is
--                               *supposed* to be running. Silence is a fault.
--   economy  (minScale  = 0) -- the pod is scale-to-zero. It is SUPPOSED to be
--                               asleep when idle. Silence is the healthy steady
--                               state, and "heal" here would mean waking (and
--                               billing) a pod nobody asked for.
--
-- HUSSH_POD_MIN_INSTANCES is a deploy-wide environment variable that can change at
-- any time. If liveness were judged against its CURRENT value, then flipping the
-- fleet to economy would instantly re-classify every already-running warm pod, and
-- flipping back would mark every sleeping economy pod as failed -- a mass false
-- alarm, or worse, a mass auto-heal. The rule is therefore captured per row at
-- creation from the value the pod was ACTUALLY created with, and each pod is
-- judged by its own contract for as long as it lives.
--
-- Default 'warm': migration 900 predates any economy tier and every pod created
-- before this migration was created with the minScale=1 default, so 'warm' is the
-- historically accurate backfill rather than a convenient guess. It is also the
-- safe direction -- a warm pod misjudged as economy would go unhealed and silently
-- stay dead, while an economy pod misjudged as warm merely produces a probe.

BEGIN;

ALTER TABLE personal_agent_registry
    ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS health_state      TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS liveness_mode     TEXT NOT NULL DEFAULT 'warm',
    -- When the hub last actually asked (probed) rather than merely waited. Keeps a
    -- confirm-then-heal sweep from re-probing the same silent pod every pass: the
    -- probe costs a request against a pod that may be asleep, and on the economy
    -- tier a probe is what WAKES it, so an unthrottled sweep would keep the whole
    -- economy fleet permanently awake -- exactly the bill the tier exists to avoid.
    ADD COLUMN IF NOT EXISTS last_probe_at     TIMESTAMPTZ,
    -- Consecutive confirmed failures. An auto-heal is a service replacement, so it
    -- must not fire on a single blip; the evaluator requires this to cross a
    -- threshold. Reset to 0 by any successful heartbeat or probe.
    ADD COLUMN IF NOT EXISTS liveness_failures INTEGER NOT NULL DEFAULT 0,
    -- When this pod was last auto-healed, so a pod that is broken in a way a
    -- restart cannot fix (bad image, poisoned config) cannot be restarted forever
    -- in a loop. The evaluator backs off against this.
    ADD COLUMN IF NOT EXISTS last_healed_at    TIMESTAMPTZ;

-- Legal values, enforced in the schema rather than only in Python. The registry is
-- read by the presence surface, the reconcile worker and operators; a typo'd state
-- that reached the table would be a silent wrong answer in all three.
ALTER TABLE personal_agent_registry
    DROP CONSTRAINT IF EXISTS personal_agent_registry_health_state_check;
ALTER TABLE personal_agent_registry
    ADD CONSTRAINT personal_agent_registry_health_state_check
    CHECK (health_state IN ('unknown', 'healthy', 'degraded', 'unreachable', 'sleeping'));

ALTER TABLE personal_agent_registry
    DROP CONSTRAINT IF EXISTS personal_agent_registry_liveness_mode_check;
ALTER TABLE personal_agent_registry
    ADD CONSTRAINT personal_agent_registry_liveness_mode_check
    CHECK (liveness_mode IN ('warm', 'economy'));

-- The sweep's access pattern: find pods whose heartbeat is older than a cutoff.
-- Partial on the statuses that can actually own a running host, because a row in
-- 'unprovisioned' or 'deprovisioned' has no pod to be alive or dead -- indexing
-- those would grow the index with rows the sweep must never act on.
CREATE INDEX IF NOT EXISTS idx_personal_agent_registry_heartbeat
    ON personal_agent_registry(last_heartbeat_at)
    WHERE status IN ('provisioning', 'connecting', 'provisioned');

-- Operator/dashboard access pattern: "show me everything not healthy right now".
CREATE INDEX IF NOT EXISTS idx_personal_agent_registry_health_state
    ON personal_agent_registry(health_state)
    WHERE health_state <> 'healthy';

COMMIT;
