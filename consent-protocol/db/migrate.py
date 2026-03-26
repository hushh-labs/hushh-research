#!/usr/bin/env python3
"""
Database Migration Script - Modular Per-Table

Usage:
    python db/migrate.py --table vault_keys        # Create vault_keys table
    python db/migrate.py --table consent_audit     # Create consent_audit table
    python db/migrate.py --consent                 # Create all consent-related tables
    python db/migrate.py --release                 # Apply the canonical release lane
    python db/migrate.py --full                    # Drop and recreate ALL tables (DESTRUCTIVE!)
    python db/migrate.py --clear consent_audit     # Clear specific table
    python db/migrate.py --status                  # Show table summary

Environment:
    DB_USER, DB_PASSWORD, DB_HOST, DB_PORT, DB_NAME (same as runtime — strict parity)
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

# Load env so DB_* are available (same as runtime)
load_dotenv()

# Use same DB_* as runtime (db/connection.py)
from db.connection import get_database_ssl, get_database_url  # noqa: E402

try:
    _database_url = get_database_url()
    _ssl_config = get_database_ssl()
except EnvironmentError as e:
    print(f"❌ ERROR: {e}")
    print("   Set DB_USER, DB_PASSWORD, DB_HOST in .env (and optionally DB_PORT, DB_NAME).")
    sys.exit(1)

MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"
RELEASE_MANIFEST_PATH = Path(__file__).resolve().parent / "release_migration_manifest.json"


def _load_release_manifest(path: Path) -> tuple[tuple[str, ...], tuple[str, ...], tuple[str, ...]]:
    if not path.exists():
        raise FileNotFoundError(f"Release migration manifest missing: {path}")

    payload = json.loads(path.read_text(encoding="utf-8"))
    ordered = payload.get("ordered_migrations")
    groups = payload.get("groups", {})
    iam = groups.get("iam")
    pkm = groups.get("pkm")

    if not isinstance(ordered, list) or not ordered:
        raise RuntimeError("release_migration_manifest.json must define ordered_migrations")
    if not isinstance(iam, list) or not iam:
        raise RuntimeError("release_migration_manifest.json must define groups.iam")
    if not isinstance(pkm, list) or not pkm:
        raise RuntimeError("release_migration_manifest.json must define groups.pkm")

    ordered_tuple = tuple(str(item).strip() for item in ordered if str(item).strip())
    iam_tuple = tuple(str(item).strip() for item in iam if str(item).strip())
    pkm_tuple = tuple(str(item).strip() for item in pkm if str(item).strip())
    ordered_set = set(ordered_tuple)
    if any(item not in ordered_set for item in iam_tuple + pkm_tuple):
        raise RuntimeError(
            "release_migration_manifest.json groups must be subsets of ordered_migrations"
        )
    return ordered_tuple, iam_tuple, pkm_tuple


RELEASE_MIGRATION_FILES, IAM_MIGRATION_FILES, PKM_MIGRATION_FILES = _load_release_manifest(
    RELEASE_MANIFEST_PATH
)


# ============================================================================
# TABLE DEFINITIONS (Modular)
# ============================================================================


async def create_vault_keys(pool: asyncpg.Pool):
    """Create vault_keys table (vault header + recovery wrapper)."""
    print("📦 Creating vault_keys table...")
    await pool.execute("""
        CREATE TABLE IF NOT EXISTS vault_keys (
            user_id TEXT PRIMARY KEY,
            vault_status TEXT NOT NULL DEFAULT 'active' CHECK (vault_status IN ('placeholder', 'active')),
            vault_key_hash TEXT,
            primary_method TEXT NOT NULL DEFAULT 'passphrase',
            primary_wrapper_id TEXT NOT NULL DEFAULT 'default',
            recovery_encrypted_vault_key TEXT,
            recovery_salt TEXT,
            recovery_iv TEXT,
            first_login_at BIGINT,
            last_login_at BIGINT,
            login_count INTEGER NOT NULL DEFAULT 0,
            pre_onboarding_completed BOOLEAN,
            pre_onboarding_skipped BOOLEAN,
            pre_onboarding_completed_at BIGINT,
            pre_nav_tour_completed_at BIGINT,
            pre_nav_tour_skipped_at BIGINT,
            pre_state_updated_at BIGINT,
            created_at BIGINT NOT NULL,
            updated_at BIGINT NOT NULL,
            CONSTRAINT vault_keys_placeholder_integrity_check CHECK (
                (vault_status = 'placeholder'
                    AND vault_key_hash IS NULL
                    AND recovery_encrypted_vault_key IS NULL
                    AND recovery_salt IS NULL
                    AND recovery_iv IS NULL)
                OR
                (vault_status = 'active'
                    AND vault_key_hash IS NOT NULL
                    AND recovery_encrypted_vault_key IS NOT NULL
                    AND recovery_salt IS NOT NULL
                    AND recovery_iv IS NOT NULL)
            )
        )
    """)
    print("✅ vault_keys ready!")


async def create_vault_key_wrappers(pool: asyncpg.Pool):
    """Create vault_key_wrappers table (one wrapper per method per user)."""
    print("🔐 Creating vault_key_wrappers table...")
    await pool.execute("""
        CREATE TABLE IF NOT EXISTS vault_key_wrappers (
            id BIGSERIAL PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
            method TEXT NOT NULL,
            wrapper_id TEXT NOT NULL DEFAULT 'default',
            encrypted_vault_key TEXT NOT NULL,
            salt TEXT NOT NULL,
            iv TEXT NOT NULL,
            passkey_credential_id TEXT,
            passkey_prf_salt TEXT,
            passkey_rp_id TEXT,
            passkey_provider TEXT,
            passkey_device_label TEXT,
            passkey_last_used_at BIGINT,
            created_at BIGINT NOT NULL,
            updated_at BIGINT NOT NULL,
            UNIQUE(user_id, method, wrapper_id)
        )
    """)
    await pool.execute("CREATE INDEX IF NOT EXISTS idx_vkw_user_id ON vault_key_wrappers(user_id)")
    await pool.execute("CREATE INDEX IF NOT EXISTS idx_vkw_method ON vault_key_wrappers(method)")
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_vkw_user_method_wrapper ON vault_key_wrappers(user_id, method, wrapper_id)"
    )
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_vkw_passkey_rp_id ON vault_key_wrappers(passkey_rp_id)"
    )
    print("✅ vault_key_wrappers ready!")


async def create_consent_audit(pool: asyncpg.Pool):
    """Create consent_audit table (consent token audit trail)."""
    print("📋 Creating consent_audit table...")
    await pool.execute("""
        CREATE TABLE IF NOT EXISTS consent_audit (
            id SERIAL PRIMARY KEY,
            token_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            scope TEXT NOT NULL,
            action TEXT NOT NULL,
            issued_at BIGINT NOT NULL,
            expires_at BIGINT,
            revoked_at BIGINT,
            metadata JSONB,
            token_type VARCHAR(20) DEFAULT 'consent',
            ip_address VARCHAR(45),
            user_agent TEXT,
            request_id VARCHAR(32),
            scope_description TEXT,
            poll_timeout_at BIGINT
        )
    """)
    await pool.execute("CREATE INDEX IF NOT EXISTS idx_consent_user ON consent_audit(user_id)")
    await pool.execute("CREATE INDEX IF NOT EXISTS idx_consent_token ON consent_audit(token_id)")
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_consent_audit_created ON consent_audit(issued_at DESC)"
    )
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_consent_audit_user_action ON consent_audit(user_id, action)"
    )
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_consent_audit_request_id ON consent_audit(request_id) WHERE request_id IS NOT NULL"
    )
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_consent_audit_pending ON consent_audit(user_id) WHERE action = 'REQUESTED'"
    )
    await pool.execute("""
        CREATE OR REPLACE FUNCTION consent_audit_notify()
        RETURNS TRIGGER AS $$
        DECLARE payload TEXT;
        BEGIN
          payload := json_build_object(
            'user_id', NEW.user_id,
            'request_id', COALESCE(NEW.request_id, ''),
            'action', NEW.action,
            'scope', COALESCE(NEW.scope, ''),
            'agent_id', COALESCE(NEW.agent_id, ''),
            'scope_description', COALESCE(NEW.scope_description, ''),
            'issued_at', NEW.issued_at,
            'bundle_id', COALESCE(NEW.metadata->>'bundle_id', ''),
            'bundle_label', COALESCE(NEW.metadata->>'bundle_label', ''),
            'bundle_scope_count', COALESCE(NEW.metadata->>'bundle_scope_count', '1')
          )::TEXT;
          PERFORM pg_notify('consent_audit_new', payload);
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
    """)
    await pool.execute("DROP TRIGGER IF EXISTS consent_audit_after_insert ON consent_audit")
    await pool.execute("""
        CREATE TRIGGER consent_audit_after_insert
        AFTER INSERT ON consent_audit
        FOR EACH ROW EXECUTE FUNCTION consent_audit_notify()
    """)
    print("✅ consent_audit ready!")


async def create_user_push_tokens(pool: asyncpg.Pool):
    """Create user_push_tokens table (push token registry)."""
    print("📲 Creating user_push_tokens table...")
    await pool.execute("""
        CREATE TABLE IF NOT EXISTS user_push_tokens (
            id SERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            token TEXT NOT NULL,
            platform TEXT NOT NULL CHECK (platform IN ('web', 'ios', 'android')),
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (user_id, platform)
        )
    """)
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_user_push_tokens_user_id ON user_push_tokens(user_id)"
    )
    print("✅ user_push_tokens ready!")


async def create_internal_access_events(pool: asyncpg.Pool):
    """Create internal_access_events table (self/internal activity ledger)."""
    print("🧾 Creating internal_access_events table...")
    await pool.execute("""
        CREATE TABLE IF NOT EXISTS internal_access_events (
            id SERIAL PRIMARY KEY,
            token_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            scope TEXT NOT NULL,
            action TEXT NOT NULL,
            issued_at BIGINT NOT NULL,
            expires_at BIGINT,
            revoked_at BIGINT,
            metadata JSONB,
            token_type VARCHAR(20) DEFAULT 'internal',
            request_id VARCHAR(32),
            scope_description TEXT
        )
    """)
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_internal_access_events_user_id ON internal_access_events(user_id)"
    )
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_internal_access_events_user_action ON internal_access_events(user_id, action)"
    )
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_internal_access_events_issued_at ON internal_access_events(issued_at DESC)"
    )
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_internal_access_events_user_scope_agent ON internal_access_events(user_id, agent_id, scope, issued_at DESC)"
    )
    print("✅ internal_access_events ready!")


async def create_pkm_data(pool: asyncpg.Pool):
    """
    Create pkm_data table (PRIVATE, E2E ENCRYPTED USER DATA).

    This is the PRIMARY storage for ALL user data using BYOK encryption.
    Single encrypted blob containing all domain data (financial, food, professional, etc.).
    """
    print("🔐 Creating pkm_data table...")

    await pool.execute("""
        CREATE TABLE IF NOT EXISTS pkm_data (
            user_id TEXT PRIMARY KEY REFERENCES vault_keys(user_id) ON DELETE CASCADE,
            
            -- Encrypted data blob (BYOK - client encrypts, server stores only ciphertext)
            encrypted_data_ciphertext TEXT NOT NULL,
            encrypted_data_iv TEXT NOT NULL,
            encrypted_data_tag TEXT NOT NULL,
            algorithm TEXT DEFAULT 'aes-256-gcm',
            
            -- Version tracking
            data_version INTEGER DEFAULT 1,
            
            -- Timestamps
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)

    print("✅ pkm_data ready!")


async def create_pkm_index(pool: asyncpg.Pool):
    """
    Create pkm_index table (QUERYABLE INDEX FOR PKM).

    This is the queryable metadata layer for the PKM.
    Non-encrypted, used for UI display and MCP scope generation.
    """
    print("📊 Creating pkm_index table...")

    await pool.execute("""
        CREATE TABLE IF NOT EXISTS pkm_index (
            user_id TEXT PRIMARY KEY REFERENCES vault_keys(user_id) ON DELETE CASCADE,
            
            -- Domain summaries (JSONB - { domain_key: { summary_data } })
            domain_summaries JSONB DEFAULT '{}',
            
            -- List of available domains
            available_domains TEXT[] DEFAULT '{}',
            
            -- Computed tags for search/filtering
            computed_tags TEXT[] DEFAULT '{}',
            
            -- Activity signals
            activity_score DECIMAL(3,2),
            last_active_at TIMESTAMPTZ,
            total_attributes INTEGER DEFAULT 0,
            
            -- Model version
            model_version INTEGER DEFAULT 2,
            
            -- Timestamps
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)

    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_pkm_index_domains ON pkm_index USING GIN(domain_summaries)"
    )
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_pkm_index_available ON pkm_index USING GIN(available_domains)"
    )
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_pkm_index_tags ON pkm_index USING GIN(computed_tags)"
    )

    print("✅ pkm_index ready!")


async def create_consent_exports(pool: asyncpg.Pool):
    """
    Create consent_exports table (MCP zero-knowledge export data storage).

    Stores encrypted export data for MCP zero-knowledge flow.
    Data survives server restarts and is available across all instances.
    """
    print("🔐 Creating consent_exports table...")

    await pool.execute("""
        CREATE TABLE IF NOT EXISTS consent_exports (
            consent_token TEXT PRIMARY KEY,
            
            -- User reference
            user_id TEXT REFERENCES vault_keys(user_id) ON DELETE CASCADE,
            
            -- Encrypted export data (MCP decrypts with export_key)
            encrypted_data TEXT NOT NULL,
            iv TEXT NOT NULL,
            tag TEXT NOT NULL,
            export_key TEXT,
            wrapped_key_bundle JSONB,
            connector_key_id TEXT,
            connector_wrapping_alg TEXT,
            export_revision INTEGER NOT NULL DEFAULT 1,
            export_generated_at TIMESTAMPTZ DEFAULT NOW(),
            source_content_revision INTEGER,
            source_manifest_revision INTEGER,
            refresh_status TEXT NOT NULL DEFAULT 'current' CHECK (refresh_status IN ('current', 'refresh_pending', 'stale')),
            
            -- Scope this export is for
            scope TEXT NOT NULL,
            
            -- Expiry
            expires_at TIMESTAMPTZ NOT NULL,
            
            -- Timestamps
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)

    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_consent_exports_user ON consent_exports(user_id)"
    )
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_consent_exports_expires ON consent_exports(expires_at)"
    )

    print("✅ consent_exports ready!")


async def create_consent_export_refresh_jobs(pool: asyncpg.Pool):
    """Create consent_export_refresh_jobs table (on-device refresh queue metadata)."""
    print("🔁 Creating consent_export_refresh_jobs table...")

    await pool.execute("""
        CREATE TABLE IF NOT EXISTS consent_export_refresh_jobs (
            id BIGSERIAL PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
            consent_token TEXT NOT NULL REFERENCES consent_exports(consent_token) ON DELETE CASCADE,
            granted_scope TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
            trigger_domain TEXT,
            trigger_paths JSONB NOT NULL DEFAULT '[]'::JSONB,
            requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_error TEXT,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (consent_token)
        )
    """)

    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_consent_export_refresh_jobs_user ON consent_export_refresh_jobs(user_id, requested_at DESC)"
    )
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_consent_export_refresh_jobs_status ON consent_export_refresh_jobs(status, updated_at DESC)"
    )
    await pool.execute(
        "DROP TRIGGER IF EXISTS trigger_update_consent_export_refresh_jobs_timestamp ON consent_export_refresh_jobs"
    )
    await pool.execute("""
        CREATE TRIGGER trigger_update_consent_export_refresh_jobs_timestamp
        BEFORE UPDATE ON consent_export_refresh_jobs
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
    """)

    print("✅ consent_export_refresh_jobs ready!")


async def create_domain_registry(pool: asyncpg.Pool):
    """
    Create domain_registry table (DYNAMIC DOMAIN REGISTRY).

    Registry of all available domains in the PKM.
    Used for UI display and scope generation.
    """
    print("📂 Creating domain_registry table...")

    await pool.execute("""
        CREATE TABLE IF NOT EXISTS domain_registry (
            domain_key TEXT PRIMARY KEY,
            
            -- Display information
            display_name TEXT NOT NULL,
            description TEXT,
            icon_name TEXT DEFAULT 'folder',
            color_hex TEXT DEFAULT '#6B7280',
            
            -- Hierarchy
            parent_domain TEXT REFERENCES domain_registry(domain_key),
            
            -- Statistics
            attribute_count INTEGER DEFAULT 0,
            user_count INTEGER DEFAULT 0,
            
            -- Timestamps
            first_seen_at TIMESTAMPTZ DEFAULT NOW(),
            last_updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)

    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_domain_parent ON domain_registry(parent_domain)"
    )

    print("✅ domain_registry ready!")


async def create_tickers(pool: asyncpg.Pool):
    """
    Create tickers table (public company tickers imported from SEC).

    Columns:
      - ticker: STOCK symbol (PRIMARY KEY)
      - title: Company name
      - cik: SEC CIK (zero-padded 10 digits)
      - exchange: Exchange code (if available)
      - created_at, updated_at timestamps
    """
    print("📈 Creating tickers table...")
    await pool.execute("""
        CREATE TABLE IF NOT EXISTS tickers (
            ticker TEXT PRIMARY KEY,
            title TEXT,
            cik TEXT,
            exchange TEXT,
            sic_code TEXT,
            sic_description TEXT,
            sector_primary TEXT,
            industry_primary TEXT,
            sector_tags TEXT[] DEFAULT '{}',
            metadata_confidence FLOAT DEFAULT 0.0,
            tradable BOOLEAN DEFAULT TRUE,
            last_enriched_at TIMESTAMPTZ,
            sec_entity_type TEXT,
            sec_filer_category TEXT,
            sec_state_incorporation TEXT,
            sec_fiscal_year_end TEXT,
            sec_latest_10k_date DATE,
            sec_latest_10q_date DATE,
            instrument_type TEXT,
            metadata_source_primary TEXT,
            metadata_updated_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    # Backward-compatible additive columns for already-provisioned environments.
    await pool.execute("ALTER TABLE tickers ADD COLUMN IF NOT EXISTS sic_code TEXT")
    await pool.execute("ALTER TABLE tickers ADD COLUMN IF NOT EXISTS sic_description TEXT")
    await pool.execute("ALTER TABLE tickers ADD COLUMN IF NOT EXISTS sector_primary TEXT")
    await pool.execute("ALTER TABLE tickers ADD COLUMN IF NOT EXISTS industry_primary TEXT")
    await pool.execute(
        "ALTER TABLE tickers ADD COLUMN IF NOT EXISTS sector_tags TEXT[] DEFAULT '{}'"
    )
    await pool.execute(
        "ALTER TABLE tickers ADD COLUMN IF NOT EXISTS metadata_confidence FLOAT DEFAULT 0.0"
    )
    await pool.execute("ALTER TABLE tickers ADD COLUMN IF NOT EXISTS tradable BOOLEAN DEFAULT TRUE")
    await pool.execute("ALTER TABLE tickers ADD COLUMN IF NOT EXISTS last_enriched_at TIMESTAMPTZ")
    await pool.execute("ALTER TABLE tickers ADD COLUMN IF NOT EXISTS sec_entity_type TEXT")
    await pool.execute("ALTER TABLE tickers ADD COLUMN IF NOT EXISTS sec_filer_category TEXT")
    await pool.execute("ALTER TABLE tickers ADD COLUMN IF NOT EXISTS sec_state_incorporation TEXT")
    await pool.execute("ALTER TABLE tickers ADD COLUMN IF NOT EXISTS sec_fiscal_year_end TEXT")
    await pool.execute("ALTER TABLE tickers ADD COLUMN IF NOT EXISTS sec_latest_10k_date DATE")
    await pool.execute("ALTER TABLE tickers ADD COLUMN IF NOT EXISTS sec_latest_10q_date DATE")
    await pool.execute("ALTER TABLE tickers ADD COLUMN IF NOT EXISTS instrument_type TEXT")
    await pool.execute("ALTER TABLE tickers ADD COLUMN IF NOT EXISTS metadata_source_primary TEXT")
    await pool.execute(
        "ALTER TABLE tickers ADD COLUMN IF NOT EXISTS metadata_updated_at TIMESTAMPTZ"
    )
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_tickers_ticker_lower ON tickers (LOWER(ticker))"
    )
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_tickers_title ON tickers USING GIN (to_tsvector('english', coalesce(title, ''))) "
    )
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_tickers_last_enriched_at ON tickers(last_enriched_at DESC)"
    )
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_tickers_metadata_updated_at ON tickers(metadata_updated_at DESC)"
    )
    await pool.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname = 'tickers_metadata_confidence_range_chk'
            ) THEN
                ALTER TABLE tickers
                ADD CONSTRAINT tickers_metadata_confidence_range_chk
                CHECK (
                    metadata_confidence IS NULL
                    OR (metadata_confidence >= 0.0 AND metadata_confidence <= 1.0)
                );
            END IF;
        END $$;
    """)

    print("✅ tickers ready!")


async def create_ticker_facts_snapshot(pool: asyncpg.Pool):
    """Create SEC fundamentals snapshot table for ticker analysis context."""
    print("📊 Creating ticker_facts_snapshot table...")
    await pool.execute("""
        CREATE TABLE IF NOT EXISTS ticker_facts_snapshot (
            ticker TEXT PRIMARY KEY REFERENCES tickers(ticker) ON DELETE CASCADE,
            cik TEXT NOT NULL,
            as_of_date DATE,
            shares_outstanding NUMERIC,
            public_float_usd NUMERIC,
            revenue_ttm_usd NUMERIC,
            net_income_ttm_usd NUMERIC,
            assets_usd NUMERIC,
            liabilities_usd NUMERIC,
            eps_diluted_ttm NUMERIC,
            source TEXT NOT NULL DEFAULT 'sec_companyfacts',
            source_updated_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_ticker_facts_source_updated_at ON ticker_facts_snapshot(source_updated_at DESC)"
    )
    print("✅ ticker_facts_snapshot ready!")


async def create_ticker_enrichment_runs(pool: asyncpg.Pool):
    """Create ticker enrichment run audit/idempotency table."""
    print("🧾 Creating ticker_enrichment_runs table...")
    await pool.execute("""
        CREATE TABLE IF NOT EXISTS ticker_enrichment_runs (
            id BIGSERIAL PRIMARY KEY,
            run_key TEXT NOT NULL UNIQUE,
            mode TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'started',
            enable_openfigi BOOLEAN NOT NULL DEFAULT FALSE,
            source_tickers_exchange_etag TEXT,
            source_tickers_exchange_last_modified TEXT,
            source_submissions_etag TEXT,
            source_submissions_last_modified TEXT,
            source_companyfacts_etag TEXT,
            source_companyfacts_last_modified TEXT,
            source_hash_tickers_exchange TEXT,
            source_hash_submissions TEXT,
            source_hash_companyfacts TEXT,
            rows_tickers_upserted INTEGER NOT NULL DEFAULT 0,
            rows_facts_upserted INTEGER NOT NULL DEFAULT 0,
            rows_figi_classified INTEGER NOT NULL DEFAULT 0,
            coverage_exchange NUMERIC,
            coverage_sector NUMERIC,
            coverage_industry NUMERIC,
            coverage_sec_entity NUMERIC,
            coverage_facts NUMERIC,
            duration_ms INTEGER,
            error_message TEXT,
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            finished_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_ticker_enrichment_runs_status ON ticker_enrichment_runs(status)"
    )
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_ticker_enrichment_runs_started_at ON ticker_enrichment_runs(started_at DESC)"
    )
    print("✅ ticker_enrichment_runs ready!")


async def create_kai_market_cache_entries(pool: asyncpg.Pool):
    """Create L2 cache table for generalized Kai market modules."""
    print("🧠 Creating kai_market_cache_entries table...")
    await pool.execute("""
        CREATE TABLE IF NOT EXISTS kai_market_cache_entries (
            cache_key TEXT PRIMARY KEY,
            payload_json JSONB NOT NULL,
            fresh_until TIMESTAMPTZ NOT NULL,
            stale_until TIMESTAMPTZ NOT NULL,
            provider_status_json JSONB DEFAULT '{}'::jsonb,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_kai_market_cache_fresh_until ON kai_market_cache_entries(fresh_until)"
    )
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_kai_market_cache_stale_until ON kai_market_cache_entries(stale_until)"
    )
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_kai_market_cache_updated_at ON kai_market_cache_entries(updated_at DESC)"
    )
    print("✅ kai_market_cache_entries ready!")


async def create_developer_registry(pool: asyncpg.Pool):
    """Create public developer registry tables for UAT/public MCP beta."""
    print("🧩 Creating developer registry tables...")
    await pool.execute("""
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
        )
    """)
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_developer_applications_status ON developer_applications(status)"
    )
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_developer_applications_created_at ON developer_applications(created_at DESC)"
    )
    await pool.execute("""
        CREATE TABLE IF NOT EXISTS developer_apps (
            app_id TEXT PRIMARY KEY,
            application_id BIGINT REFERENCES developer_applications(id) ON DELETE SET NULL,
            agent_id TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            contact_email TEXT NOT NULL,
            support_url TEXT,
            policy_url TEXT,
            website_url TEXT,
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
        )
    """)
    await pool.execute(
        "ALTER TABLE developer_apps ADD COLUMN IF NOT EXISTS owner_firebase_uid TEXT"
    )
    await pool.execute("ALTER TABLE developer_apps ADD COLUMN IF NOT EXISTS owner_email TEXT")
    await pool.execute(
        "ALTER TABLE developer_apps ADD COLUMN IF NOT EXISTS owner_display_name TEXT"
    )
    await pool.execute(
        "ALTER TABLE developer_apps ADD COLUMN IF NOT EXISTS owner_provider_ids JSONB NOT NULL DEFAULT '[]'::jsonb"
    )
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_developer_apps_status ON developer_apps(status)"
    )
    await pool.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_developer_apps_owner_firebase_uid ON developer_apps(owner_firebase_uid) WHERE owner_firebase_uid IS NOT NULL"
    )
    await pool.execute("""
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
    """)
    await pool.execute("""
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
    """)
    await pool.execute("""
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
    """)
    await pool.execute("""
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
        )
    """)
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_developer_tokens_app_id ON developer_tokens(app_id)"
    )
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_developer_tokens_revoked_at ON developer_tokens(revoked_at)"
    )
    print("✅ developer registry ready!")


# Table registry for modular access
TABLE_CREATORS = {
    "vault_keys": create_vault_keys,
    "vault_key_wrappers": create_vault_key_wrappers,
    "consent_audit": create_consent_audit,
    "user_push_tokens": create_user_push_tokens,
    "internal_access_events": create_internal_access_events,
    "pkm_data": create_pkm_data,
    "pkm_index": create_pkm_index,
    "domain_registry": create_domain_registry,
    "tickers": create_tickers,
    "ticker_facts_snapshot": create_ticker_facts_snapshot,
    "ticker_enrichment_runs": create_ticker_enrichment_runs,
    "consent_exports": create_consent_exports,
    "consent_export_refresh_jobs": create_consent_export_refresh_jobs,
    "kai_market_cache_entries": create_kai_market_cache_entries,
    "developer_registry": create_developer_registry,
}


# ============================================================================
# MIGRATION OPERATIONS
# ============================================================================


async def apply_migration_files(
    pool: asyncpg.Pool,
    filenames: tuple[str, ...],
    *,
    label: str,
):
    """Apply an explicit ordered list of SQL migration files."""
    print(f"Running {label} migration set (explicit mode)...")
    async with pool.acquire() as conn:
        for filename in filenames:
            migration_path = MIGRATIONS_DIR / filename
            if not migration_path.exists():
                raise FileNotFoundError(f"{label} migration file missing: {migration_path}")
            sql = migration_path.read_text(encoding="utf-8")
            print(f"  -> applying {filename}")
            await conn.execute(sql)
    print(f"{label} migration set complete!")


async def run_full_migration(pool: asyncpg.Pool):
    """Drop all tables and recreate (DESTRUCTIVE!)."""
    print("⚠️  FULL MIGRATION - This will DROP all tables!")
    print("🗑️  Dropping existing tables...")

    # Drop current tables
    for table in [
        "vault_key_wrappers",
        "vault_keys",
        "consent_audit",
        "user_push_tokens",
        "internal_access_events",
        "pkm_data",
        "pkm_index",
        "domain_registry",
        "ticker_facts_snapshot",
        "ticker_enrichment_runs",
        "consent_exports",
        "consent_export_refresh_jobs",
        "kai_market_cache_entries",
        "developer_tokens",
        "developer_api_keys",
        "developer_apps",
        "developer_applications",
        "tickers",
    ]:
        await pool.execute(f"DROP TABLE IF EXISTS {table} CASCADE")

    # Create in dependency order
    print("\n[1/13] Creating vault_keys (vault headers + recovery wrapper)...")
    await create_vault_keys(pool)

    print("[2/11] Creating vault_key_wrappers (enrolled unlock methods)...")
    await create_vault_key_wrappers(pool)

    print("[3/13] Creating consent_audit (consent tracking)...")
    await create_consent_audit(pool)

    print("[4/13] Creating user_push_tokens (push token registry)...")
    await create_user_push_tokens(pool)

    print("[5/13] Creating internal_access_events (self/internal ledger)...")
    await create_internal_access_events(pool)

    print("[6/13] Creating pkm_data (encrypted user data blob)...")
    await create_pkm_data(pool)

    print("[7/13] Creating pkm_index (queryable metadata index)...")
    await create_pkm_index(pool)

    print("[8/13] Creating domain_registry (dynamic domain registry)...")
    await create_domain_registry(pool)

    print("[9/13] Creating tickers (symbol master)...")
    await create_tickers(pool)
    print("[10/13] Creating ticker_facts_snapshot (SEC fundamentals snapshot)...")
    await create_ticker_facts_snapshot(pool)
    print("[11/13] Creating ticker_enrichment_runs (run audit)...")
    await create_ticker_enrichment_runs(pool)
    print("[12/13] Creating consent_exports (MCP zero-knowledge export)...")
    await create_consent_exports(pool)
    print("[13/15] Creating consent_export_refresh_jobs (encrypted export refresh queue)...")
    await create_consent_export_refresh_jobs(pool)
    print("[14/15] Creating kai_market_cache_entries (Kai market L2 cache)...")
    await create_kai_market_cache_entries(pool)
    print("[15/15] Creating developer registry (public MCP beta auth)...")
    await create_developer_registry(pool)
    print("[16/16] Applying canonical release migrations...")
    await run_release_migration(pool)

    print("\n✅ Full migration complete!")


async def run_consent_migration(pool: asyncpg.Pool):
    """Create all consent-related tables."""
    print("Running consent protocol migration...")
    await create_consent_audit(pool)
    await create_user_push_tokens(pool)
    await create_internal_access_events(pool)
    await create_developer_registry(pool)
    print("Consent protocol tables ready!")


async def run_iam_migration(pool: asyncpg.Pool):
    """Apply IAM foundation schema through explicit migration files."""
    await apply_migration_files(pool, IAM_MIGRATION_FILES, label="IAM schema")


async def run_pkm_migration(pool: asyncpg.Pool):
    """Apply the canonical PKM evolution lane, including upgrade and strict-ZK work."""
    await apply_migration_files(pool, PKM_MIGRATION_FILES, label="PKM schema")


async def run_release_migration(pool: asyncpg.Pool):
    """Apply the full canonical release schema lane used by operators and UAT automation."""
    await apply_migration_files(pool, RELEASE_MIGRATION_FILES, label="release schema")


async def run_init_migration(pool: asyncpg.Pool):
    """
    Initialize all tables in correct dependency order.
    Non-destructive - uses CREATE TABLE IF NOT EXISTS.
    Safe for first-time setup or adding missing tables.
    """
    print("Initializing database tables (non-destructive)...")

    # Create in dependency order
    print("\n[1/13] Creating vault_keys (vault headers + recovery wrapper)...")
    await create_vault_keys(pool)

    print("[2/11] Creating vault_key_wrappers (enrolled unlock methods)...")
    await create_vault_key_wrappers(pool)

    print("[3/13] Creating consent_audit (consent tracking)...")
    await create_consent_audit(pool)

    print("[4/13] Creating user_push_tokens (push token registry)...")
    await create_user_push_tokens(pool)

    print("[5/13] Creating internal_access_events (self/internal ledger)...")
    await create_internal_access_events(pool)

    print("[6/13] Creating pkm_data (encrypted user data blob)...")
    await create_pkm_data(pool)

    print("[7/13] Creating pkm_index (queryable metadata index)...")
    await create_pkm_index(pool)

    print("[8/13] Creating domain_registry (dynamic domain registry)...")
    await create_domain_registry(pool)

    print("[9/13] Creating tickers (symbol master)...")
    await create_tickers(pool)
    print("[10/13] Creating ticker_facts_snapshot (SEC fundamentals snapshot)...")
    await create_ticker_facts_snapshot(pool)
    print("[11/13] Creating ticker_enrichment_runs (run audit)...")
    await create_ticker_enrichment_runs(pool)
    print("[12/13] Creating consent_exports (MCP zero-knowledge export)...")
    await create_consent_exports(pool)
    print("[13/15] Creating consent_export_refresh_jobs (encrypted export refresh queue)...")
    await create_consent_export_refresh_jobs(pool)
    print("[14/15] Creating kai_market_cache_entries (Kai market L2 cache)...")
    await create_kai_market_cache_entries(pool)
    print("[15/15] Creating developer registry (public MCP beta auth)...")
    await create_developer_registry(pool)
    print("[16/16] Applying canonical release migrations...")
    await run_release_migration(pool)

    print("\nAll tables initialized successfully!")


async def clear_table(pool: asyncpg.Pool, table_name: str):
    """Clear all entries from a table."""
    print(f"🧹 Clearing {table_name} table...")
    await pool.execute(f"TRUNCATE {table_name} RESTART IDENTITY")  # noqa: S608
    print(f"✅ {table_name} cleared!")


async def show_status(pool: asyncpg.Pool):
    """Show current table counts."""
    print("\n📊 Table summary:")

    tables = await pool.fetch("""
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public' ORDER BY table_name
    """)
    print(f"   Tables: {', '.join(r['table_name'] for r in tables)}")

    # Check all tables, not just those in TABLE_CREATORS
    all_tables = [r["table_name"] for r in tables]

    for table in [
        "vault_keys",
        "vault_key_wrappers",
        "consent_audit",
        "user_push_tokens",
        "internal_access_events",
        "pkm_data",
        "pkm_index",
        "domain_registry",
        "tickers",
        "ticker_facts_snapshot",
        "ticker_enrichment_runs",
        "consent_exports",
        "kai_market_cache_entries",
        "developer_applications",
        "developer_apps",
        "developer_tokens",
        "developer_api_keys",
        "runtime_persona_state",
        "pkm_index",
        "pkm_blobs",
        "pkm_manifests",
        "pkm_manifest_paths",
        "pkm_scope_registry",
        "pkm_events",
        "pkm_migration_state",
        "pkm_upgrade_runs",
        "pkm_upgrade_steps",
        "consent_export_refresh_jobs",
        "relationship_share_grants",
        "relationship_share_events",
    ]:
        if table in all_tables:
            try:
                count = await pool.fetchval(f"SELECT COUNT(*) FROM {table}")  # noqa: S608
                print(f"   {table}: {count} rows")
            except Exception as e:
                print(f"   {table}: error counting ({e})")
        else:
            print(f"   {table}: (not found)")


# ============================================================================
# MAIN
# ============================================================================


async def main():
    parser = argparse.ArgumentParser(
        description="Hushh Database Migration - Modular Per-Table",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python db/migrate.py --init                    # First-time setup (RECOMMENDED)
  python db/migrate.py --table pkm_data  # Create single table
  python db/migrate.py --consent                 # Create all consent tables
  python db/migrate.py --iam                     # Apply IAM schema foundation lane
  python db/migrate.py --pkm                     # Apply PKM evolution lane (030-035)
  python db/migrate.py --release                 # Apply the full canonical release lane
  python db/migrate.py --full                    # Full reset (WARNING: DESTRUCTIVE!)
  python db/migrate.py --status                  # Show table summary
        """,
    )
    parser.add_argument(
        "--init",
        action="store_true",
        help="Initialize all tables in correct order (non-destructive, recommended for first-time setup)",
    )
    parser.add_argument(
        "--table",
        choices=list(TABLE_CREATORS.keys()),
        help=(
            "Create a specific table (vault_keys, vault_key_wrappers, consent_audit, "
            "pkm_data, pkm_index, domain_registry, tickers, "
            "ticker_facts_snapshot, ticker_enrichment_runs, consent_exports, "
            "kai_market_cache_entries)"
        ),
    )
    parser.add_argument("--consent", action="store_true", help="Create all consent-related tables")
    parser.add_argument(
        "--iam",
        action="store_true",
        help="Apply the IAM schema foundation lane from release_migration_manifest.json",
    )
    parser.add_argument(
        "--pkm",
        action="store_true",
        help="Apply the PKM evolution lane from release_migration_manifest.json",
    )
    parser.add_argument(
        "--release",
        action="store_true",
        help="Apply the full canonical release lane from release_migration_manifest.json",
    )
    parser.add_argument(
        "--full", action="store_true", help="Drop and recreate ALL tables (DESTRUCTIVE!)"
    )
    parser.add_argument(
        "--clear", choices=list(TABLE_CREATORS.keys()), help="Clear a specific table"
    )
    parser.add_argument("--status", action="store_true", help="Show table summary")

    args = parser.parse_args()

    if not any(
        [
            args.init,
            args.table,
            args.consent,
            args.iam,
            args.pkm,
            args.release,
            args.full,
            args.clear,
            args.status,
        ]
    ):
        parser.print_help()
        return

    # Mask password in URL for display
    display_url = _database_url
    try:
        parts = _database_url.split(":")
        if len(parts) >= 3 and "@" in parts[2]:
            display_url = (
                f"{parts[0]}:{parts[1]}:****@{parts[2].split('@')[1]}:{':'.join(parts[3:])}"
            )
    except Exception:
        display_url = _database_url
    print("Connecting to database (DB_* env)...")
    print(f"   URL: {display_url}")
    if _ssl_config:
        print("   SSL: enabled (Supabase)")

    pool = await asyncpg.create_pool(
        _database_url,
        min_size=1,
        max_size=2,
        ssl=_ssl_config,
    )

    try:
        print("Connected successfully!")

        if args.init:
            await run_init_migration(pool)

        if args.full:
            await run_full_migration(pool)

        if args.table:
            table_func = TABLE_CREATORS.get(args.table)
            if table_func:
                await table_func(pool)
            else:
                print(f"Unknown table: {args.table}")

        if args.consent:
            await run_consent_migration(pool)

        if args.iam:
            await run_iam_migration(pool)

        if args.pkm:
            await run_pkm_migration(pool)

        if args.release:
            await run_release_migration(pool)

        if args.clear:
            await clear_table(pool, args.clear)

        # Always show status at end
        await show_status(pool)

        print("\nMigration complete!")

    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
