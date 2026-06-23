-- 070_developer_registry.sql
--
-- Canonical, versioned DDL for the developer-token registry.
--
-- These three tables (developer_applications, developer_apps, developer_tokens)
-- back the /developers self-serve API and external MCP/developer token auth.
-- Historically they were created only by imperative runtime code
-- (hushh_mcp/services/developer_registry_service.py::ensure_tables and
-- db/migrate.py), so they were absent from the numbered migration chain and
-- from db/release_migration_manifest.json. A database provisioned purely from
-- the manifest was therefore missing the developer registry until first
-- runtime touch.
--
-- This migration makes the migration chain the single source of truth. It is
-- byte-for-byte compatible with ensure_tables() (which now becomes a guard):
-- same columns, constraints, indexes, and the historical rename DO-blocks
-- (developer_api_keys -> developer_tokens, key_prefix -> token_prefix,
-- key_hash -> token_hash, and the matching constraint/index renames). All
-- statements are idempotent and safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS developer_applications (
    id BIGSERIAL PRIMARY KEY,
    slug TEXT NOT NULL,
    display_name TEXT NOT NULL,
    contact_name TEXT,
    contact_email TEXT NOT NULL,
    support_url TEXT,
    policy_url TEXT,
    website_url TEXT,
    use_case TEXT,
    requested_tool_groups JSONB NOT NULL DEFAULT '["core_consent"]'::jsonb,
    requested_agent_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    notes TEXT,
    reviewed_at BIGINT,
    reviewed_by TEXT,
    rejection_reason TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    CONSTRAINT developer_applications_status_check
        CHECK (status IN ('pending', 'approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS idx_developer_applications_status
    ON developer_applications(status);
CREATE INDEX IF NOT EXISTS idx_developer_applications_created_at
    ON developer_applications(created_at DESC);

CREATE TABLE IF NOT EXISTS developer_apps (
    app_id TEXT PRIMARY KEY,
    application_id BIGINT REFERENCES developer_applications(id) ON DELETE SET NULL,
    agent_id TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    contact_email TEXT NOT NULL,
    support_url TEXT,
    policy_url TEXT,
    website_url TEXT,
    brand_image_url TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    allowed_tool_groups JSONB NOT NULL DEFAULT '["core_consent"]'::jsonb,
    approved_at BIGINT,
    approved_by TEXT,
    notes TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    owner_firebase_uid TEXT,
    owner_email TEXT,
    owner_display_name TEXT,
    owner_provider_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    CONSTRAINT developer_apps_status_check
        CHECK (status IN ('active', 'suspended', 'revoked'))
);

-- Owner columns are added defensively for databases that predate them.
ALTER TABLE developer_apps ADD COLUMN IF NOT EXISTS owner_firebase_uid TEXT;
ALTER TABLE developer_apps ADD COLUMN IF NOT EXISTS owner_email TEXT;
ALTER TABLE developer_apps ADD COLUMN IF NOT EXISTS owner_display_name TEXT;
ALTER TABLE developer_apps
    ADD COLUMN IF NOT EXISTS owner_provider_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE developer_apps ADD COLUMN IF NOT EXISTS brand_image_url TEXT;

CREATE INDEX IF NOT EXISTS idx_developer_apps_status ON developer_apps(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_developer_apps_owner_firebase_uid
    ON developer_apps(owner_firebase_uid)
    WHERE owner_firebase_uid IS NOT NULL;

-- ── Historical renames (developer_api_keys -> developer_tokens) ──────────────
-- Rename the legacy table when it exists and the new one does not yet.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'developer_api_keys'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'developer_tokens'
    ) THEN
        EXECUTE 'ALTER TABLE developer_api_keys RENAME TO developer_tokens';
    END IF;
END
$$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'developer_tokens'
          AND column_name = 'key_prefix'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'developer_tokens'
          AND column_name = 'token_prefix'
    ) THEN
        EXECUTE 'ALTER TABLE developer_tokens RENAME COLUMN key_prefix TO token_prefix';
    END IF;
END
$$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'developer_tokens'
          AND column_name = 'key_hash'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'developer_tokens'
          AND column_name = 'token_hash'
    ) THEN
        EXECUTE 'ALTER TABLE developer_tokens RENAME COLUMN key_hash TO token_hash';
    END IF;
END
$$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = current_schema()
          AND table_name = 'developer_tokens'
          AND constraint_name = 'developer_api_keys_app_id_fkey'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = current_schema()
          AND table_name = 'developer_tokens'
          AND constraint_name = 'developer_tokens_app_id_fkey'
    ) THEN
        EXECUTE 'ALTER TABLE developer_tokens RENAME CONSTRAINT developer_api_keys_app_id_fkey TO developer_tokens_app_id_fkey';
    END IF;
END
$$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_class
        WHERE relkind = 'i' AND relname = 'idx_developer_api_keys_app_id'
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE relkind = 'i' AND relname = 'idx_developer_tokens_app_id'
    ) THEN
        EXECUTE 'ALTER INDEX idx_developer_api_keys_app_id RENAME TO idx_developer_tokens_app_id';
    END IF;
END
$$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_class
        WHERE relkind = 'i' AND relname = 'idx_developer_api_keys_revoked_at'
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE relkind = 'i' AND relname = 'idx_developer_tokens_revoked_at'
    ) THEN
        EXECUTE 'ALTER INDEX idx_developer_api_keys_revoked_at RENAME TO idx_developer_tokens_revoked_at';
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS developer_tokens (
    id BIGSERIAL PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES developer_apps(app_id) ON DELETE CASCADE,
    token_prefix TEXT NOT NULL UNIQUE,
    token_hash TEXT NOT NULL UNIQUE,
    label TEXT,
    created_by TEXT,
    revoked_by TEXT,
    created_at BIGINT NOT NULL,
    revoked_at BIGINT,
    last_used_at BIGINT,
    last_used_ip TEXT,
    last_used_user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_developer_tokens_app_id ON developer_tokens(app_id);
CREATE INDEX IF NOT EXISTS idx_developer_tokens_revoked_at ON developer_tokens(revoked_at);

COMMENT ON TABLE developer_applications IS
  'Developer access applications submitted for review before an app is provisioned.';
COMMENT ON TABLE developer_apps IS
  'Provisioned developer apps. owner_firebase_uid binds a self-serve app to a One user.';
COMMENT ON TABLE developer_tokens IS
  'Developer API tokens. Only peppered HMAC-SHA256 hashes are stored; raw tokens (hdk_*) are returned once at creation.';

COMMIT;
