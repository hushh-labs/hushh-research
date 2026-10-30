-- Versioned prompt store for hot prompt-sync WITHOUT redeploy (Phase 0 — schema).
--
-- PARKED (unapplied, flag-off): 900-band, out of the active sequence, not in
-- db/release_migration_manifest.json. Renumbered into sequence + manifested at
-- greenlight. High band avoids per-sync collision with main's migration head.
--
-- Agents resolve their system prompt from this table at runtime (see the
-- GET /api/one/agent-prompt endpoint). Editing a prompt = insert a new version
-- row and flip its status to 'active' (optionally staged via canary_percent) —
-- no redeploy — and rollback is flipping the prior version back to 'active'.
-- At most one 'active' row per (agent_id, channel) is enforced below.
--
-- Non-breaking + idempotent. Inert until PERSONAL_AGENT_ENABLED is on.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_prompt_versions (
    id              BIGSERIAL PRIMARY KEY,
    agent_id        TEXT NOT NULL,
    channel         TEXT NOT NULL DEFAULT 'default',
    version         TEXT NOT NULL,
    prompt_text     TEXT NOT NULL,
    prompt_sha256   TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'canary',
    canary_percent  INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT agent_prompt_versions_status_check
        CHECK (status IN ('active', 'canary', 'retired')),
    CONSTRAINT agent_prompt_versions_canary_pct_check
        CHECK (canary_percent BETWEEN 0 AND 100)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_prompt_versions_unique
    ON agent_prompt_versions(agent_id, channel, version);

-- At most one active prompt per (agent_id, channel): the "flip active" contract.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_prompt_versions_one_active
    ON agent_prompt_versions(agent_id, channel)
    WHERE status = 'active';

COMMENT ON TABLE agent_prompt_versions IS
    'Versioned agent prompts for runtime sync without redeploy. Flip status=active (or stage via canary_percent) to roll forward/back. Phase 0.';

COMMIT;
