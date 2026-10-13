CREATE TABLE IF NOT EXISTS kai_receipt_memory_artifacts (
    artifact_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL DEFAULT 'gmail_receipts',
    artifact_version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'ready',
    deterministic_schema_version INTEGER NOT NULL DEFAULT 1,
    enrichment_schema_version INTEGER,
    enrichment_cache_key TEXT NOT NULL,
    inference_window_days INTEGER NOT NULL DEFAULT 365,
    highlights_window_days INTEGER NOT NULL DEFAULT 90,
    source_watermark_hash TEXT NOT NULL,
    source_watermark_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    deterministic_projection_hash TEXT NOT NULL,
    enrichment_hash TEXT,
    candidate_pkm_payload_hash TEXT NOT NULL,
    deterministic_projection_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    enrichment_json JSONB,
    candidate_pkm_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    debug_stats_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    persisted_pkm_data_version INTEGER,
    persisted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kai_receipt_memory_artifacts_user_created
    ON kai_receipt_memory_artifacts(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_kai_receipt_memory_artifacts_cache_lookup
    ON kai_receipt_memory_artifacts(
        user_id,
        source_watermark_hash,
        deterministic_schema_version,
        enrichment_cache_key,
        created_at DESC
    );
