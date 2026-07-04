BEGIN;

-- Owner-consent override for the PKM slice marketplace.
--
-- The visibility guardrail (_normalize_visibility_posture) downgrades a
-- `default_available` request back to `consent_required` when a scope's
-- sensitivity_tier is `restricted`. That is correct as a default, but the
-- marketplace lets an owner explicitly consent to publishing a safe projection
-- of THEIR OWN restricted-tier data. This column records that explicit,
-- per-scope owner consent so the override is honored on BOTH the write path and
-- the read/normalize path (otherwise the buyer's read would re-downgrade it and
-- the slice would "vanish").
--
-- Scope of the override (enforced in code, not here): it lifts ONLY the
-- `restricted` sensitivity-tier block. Structural blocked keys
-- (_DEFAULT_AVAILABLE_BLOCKED_KEYS: hash/metadata/provenance/schema_version/
-- workflow/workflow_id) remain hard-blocked even with owner consent.
ALTER TABLE pkm_scope_registry
  ADD COLUMN IF NOT EXISTS owner_consent_override BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
