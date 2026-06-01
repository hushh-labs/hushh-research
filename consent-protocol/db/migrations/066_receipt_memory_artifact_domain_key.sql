ALTER TABLE kai_receipt_memory_artifacts
    ADD COLUMN IF NOT EXISTS memory_domain TEXT NOT NULL DEFAULT 'shopping';

DROP INDEX IF EXISTS idx_kai_receipt_memory_artifacts_cache_lookup;

CREATE INDEX IF NOT EXISTS idx_kai_receipt_memory_artifacts_cache_lookup
    ON kai_receipt_memory_artifacts(
        user_id,
        memory_domain,
        source_watermark_hash,
        deterministic_schema_version,
        enrichment_cache_key,
        created_at DESC
    );
