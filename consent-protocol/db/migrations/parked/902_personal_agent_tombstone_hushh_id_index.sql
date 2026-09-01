-- Index the deletion tombstones by HusshID for recycled-phone generation
-- rotation (Phase 0 — SECURITY-REVIEW.md L1).
--
-- PARKED (unapplied, flag-off): 900-band, out of the active sequence, not in
-- db/release_migration_manifest.json. Renumbered into sequence + manifested at
-- greenlight. High band avoids per-sync collision with main's migration head.
--
-- provision() derives a candidate HusshID per generation and asks whether that
-- HusshID was already tombstoned (a prior owner of a since-recycled phone). That
-- lookup keys on hushh_id, so index it. Rare (once per provision) but the
-- tombstone table grows unbounded over time, so avoid a seq scan.
--
-- Non-breaking + idempotent. Inert until PERSONAL_AGENT_ENABLED is on.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_personal_agent_tombstones_hushh_id
    ON personal_agent_deletion_tombstones(hushh_id);

COMMIT;
