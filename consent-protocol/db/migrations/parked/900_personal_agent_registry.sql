-- Per-user personal-information agent registry (Phase 0 — schema only).
--
-- PARKED (unapplied, flag-off): numbered in the 900 band, deliberately OUT of the
-- active migration sequence. It is NOT in db/release_migration_manifest.json, so it
-- is never applied until the personal-agent feature is greenlit; at that point it is
-- renumbered into sequence and added to the manifest. The high band keeps it from
-- colliding with main's fast-moving migration head on every branch sync.
--
-- One row per Hushh One user maps their phone-number primary key (stored ONLY
-- as an HMAC hash, never raw) and their opaque HusshID to the always-on
-- personal agent: its A2A route, the pod's X25519 PUBLIC key (Hushh never holds
-- the pod private key — zero-knowledge, same guarantee as the local MCP
-- connector), and the runtime/prompt versions the pod is pinned to.
--
-- backend / external_agent_id / a2a_route / pod_pubkey stay NULL until the agent
-- is actually provisioned (Phase 1) by the selected compute backend. The design
-- is backend-neutral: `backend` names the host (gcp | anypoint | null), and
-- `external_agent_id` is its host id (was `anypoint_agent_id`). Phase 0 only lands
-- the schema; nothing reads or writes this table until the PERSONAL_AGENT_ENABLED
-- kill-switch is turned on. Non-breaking + idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS personal_agent_registry (
    user_id                 TEXT PRIMARY KEY,
    hushh_id                TEXT NOT NULL,
    phone_e164_hash         TEXT,
    space_id                TEXT,
    backend                 TEXT,
    external_agent_id       TEXT,
    a2a_route               TEXT,
    backend_metadata        JSONB,
    attestation_ref         TEXT,
    pod_pubkey              TEXT,
    pod_key_id              TEXT,
    pod_key_wrapping_alg    TEXT,
    runtime_version         TEXT,
    prompt_version          TEXT,
    status                  TEXT NOT NULL DEFAULT 'unprovisioned',
    region                  TEXT,
    provisioned_at          TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_agent_registry_hushh_id
    ON personal_agent_registry(hushh_id);

CREATE INDEX IF NOT EXISTS idx_personal_agent_registry_status
    ON personal_agent_registry(status);

-- Retained AFTER account deletion (outside the per-user delete cascade) so that
-- deprovisioning the external agent endpoint stays auditable once the user's
-- rows are gone. Holds no raw PII: only the opaque HusshID + external agent id.
CREATE TABLE IF NOT EXISTS personal_agent_deletion_tombstones (
    id                  BIGSERIAL PRIMARY KEY,
    hushh_id            TEXT NOT NULL,
    external_agent_id   TEXT,
    status              TEXT NOT NULL DEFAULT 'deprovision_requested',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_personal_agent_tombstones_status
    ON personal_agent_deletion_tombstones(status);

-- Orphan address: WHERE an unreclaimed pod lives (project/region/target) so a
-- billing host stays reclaimable after the registry row is gone. Additive +
-- idempotent so the dev parked lane can re-apply it onto an existing table.
ALTER TABLE personal_agent_deletion_tombstones
    ADD COLUMN IF NOT EXISTS metadata JSONB;

COMMENT ON TABLE personal_agent_registry IS
    'Per-user personal-information agent: phone(hashed) -> HusshID -> pod route + pod PUBLIC key + version pins. Feature-flagged (PERSONAL_AGENT_ENABLED). Phase 0.';
COMMENT ON COLUMN personal_agent_registry.phone_e164_hash IS
    'HMAC hash of the verified E.164 phone (the user primary key). Never the raw phone number.';
COMMENT ON COLUMN personal_agent_registry.pod_pubkey IS
    'Base64 X25519 PUBLIC key of the user pod. Hushh wraps scoped exports to it; the pod holds the private key. Zero-knowledge.';
COMMENT ON COLUMN personal_agent_registry.backend IS
    'Which compute backend hosts this agent (gcp | anypoint | null). Backend-neutral provider abstraction. NULL until provisioned.';
COMMENT ON COLUMN personal_agent_registry.external_agent_id IS
    'Backend-neutral host id for the provisioned agent (formerly anypoint_agent_id). NULL until provisioned.';
COMMENT ON COLUMN personal_agent_registry.space_id IS
    'The spaceID of this agent instance (one node/instance per HusshID). NULL until provisioned.';

COMMIT;
