-- Operational migration authority. Applied only by the explicit migrator lane.
-- This file is intentionally outside the historical release replay manifest.
CREATE TABLE IF NOT EXISTS schema_migrations (
    migration_id TEXT PRIMARY KEY,
    filename TEXT NOT NULL UNIQUE,
    checksum_sha256 CHAR(64) NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('applied', 'failed', 'baseline')),
    applied_at TIMESTAMPTZ,
    duration_ms BIGINT NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
    deploy_sha TEXT,
    failure_class TEXT,
    baseline_through INTEGER,
    preservation_manifest_id TEXT,
    database_identity_hash TEXT,
    catalog_sha256 CHAR(64),
    backup_checksum_sha256 CHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (status = 'baseline' AND baseline_through IS NOT NULL)
        OR (status <> 'baseline' AND baseline_through IS NULL)
    )
);

-- Additive compatibility for an environment that observed an earlier preview
-- of this operational ledger before baseline authorization was attempted.
ALTER TABLE schema_migrations
    ADD COLUMN IF NOT EXISTS backup_checksum_sha256 CHAR(64);
