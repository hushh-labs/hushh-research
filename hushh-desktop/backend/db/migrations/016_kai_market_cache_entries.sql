-- 016_kai_market_cache_entries.sql
-- Shared L2 cache table for Kai generalized market modules.

CREATE TABLE IF NOT EXISTS kai_market_cache_entries (
    cache_key TEXT PRIMARY KEY,
    payload_json JSONB NOT NULL,
    fresh_until TIMESTAMPTZ NOT NULL,
    stale_until TIMESTAMPTZ NOT NULL,
    provider_status_json JSONB DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kai_market_cache_fresh_until
    ON kai_market_cache_entries (fresh_until);

CREATE INDEX IF NOT EXISTS idx_kai_market_cache_stale_until
    ON kai_market_cache_entries (stale_until);

CREATE INDEX IF NOT EXISTS idx_kai_market_cache_updated_at
    ON kai_market_cache_entries (updated_at DESC);
