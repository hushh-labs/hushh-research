from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import time
from dataclasses import dataclass
from typing import Any, Callable, Mapping

from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.consent.connector_crypto_profiles import get_connector_crypto_profile
from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services.hushh_tech_uat_database_attestation import (
    UAT_DATABASE_ATTESTATION_SQL,
    UAT_INSTANCE,
    is_attested_hushh_tech_uat_database,
    parse_connected_database_identity,
)
from mcp_modules.canonical_contract import canonical_tool_name, published_tool_name
from mcp_modules.public_contract import get_public_tool_names

logger = logging.getLogger(__name__)

_pepper_fallback_warned = False


def _warn_pepper_fallback_once(message: str) -> None:
    """Log the developer-token pepper fallback once per process."""
    global _pepper_fallback_warned
    if _pepper_fallback_warned:
        return
    _pepper_fallback_warned = True
    logger.warning(message)


TOOL_GROUP_CORE_CONSENT = "core_consent"
TOOL_GROUP_RIA_READ = "ria_read"
TOOL_GROUP_KAI_VOICE = "kai_voice"
TOOL_GROUP_HUSHH_TECH_CLIENT = "hushh_tech_client"

HUSHH_TECH_UAT_PROJECT_ID = "hushh-pda-uat"
HUSHH_TECH_UAT_CLOUDSQL_INSTANCE = UAT_INSTANCE
HUSHH_TECH_CONNECTOR_WRAPPING_ALG = "X25519-AES256-GCM"

KNOWN_TOOL_GROUPS = (
    TOOL_GROUP_CORE_CONSENT,
    TOOL_GROUP_RIA_READ,
    TOOL_GROUP_KAI_VOICE,
    TOOL_GROUP_HUSHH_TECH_CLIENT,
)

DEFAULT_PUBLIC_TOOL_GROUPS = (TOOL_GROUP_CORE_CONSENT,)
SCHEMA_PROFILE_STANDARD = "standard"
SCHEMA_PROFILE_FLAT = "flat"
SCHEMA_PROFILE_AGENTFORCE = "agentforce"
KNOWN_SCHEMA_PROFILES = (
    SCHEMA_PROFILE_STANDARD,
    SCHEMA_PROFILE_FLAT,
    SCHEMA_PROFILE_AGENTFORCE,
)

TOOL_GROUP_TOOL_NAMES = {
    TOOL_GROUP_CORE_CONSENT: get_public_tool_names(),
    TOOL_GROUP_RIA_READ: (
        "list_ria_profiles",
        "get_ria_profile",
        "list_marketplace_investors",
        "get_ria_verification_status",
        "get_ria_client_access_summary",
    ),
    TOOL_GROUP_KAI_VOICE: (
        "kai_analyze_stock",
        "kai_open_dashboard",
        "kai_open_import",
        "kai_open_history",
        "kai_open_consent",
        "kai_open_profile",
        "kai_open_home",
        "kai_navigate_back",
        "kai_resume_active_analysis",
        "kai_cancel_active_analysis",
    ),
    # Dedicated UAT product-client scope. It grants only the consented,
    # encrypted connector flow and never direct PKM/private-place access.
    TOOL_GROUP_HUSHH_TECH_CLIENT: (
        "request_consent",
        "check_consent_status",
        "get_encrypted_scoped_export",
    ),
}


def assert_hushh_tech_uat_registry_target(
    *,
    app_id: str,
    environment: Mapping[str, str] | None = None,
) -> None:
    """Fail before registry I/O unless the exact isolated UAT target is selected."""

    values = environment if environment is not None else os.environ
    lane = str(values.get("ENVIRONMENT") or "").strip().lower()
    project_id = str(values.get("GOOGLE_CLOUD_PROJECT") or "").strip()
    instance = str(values.get("CLOUDSQL_INSTANCE_CONNECTION_NAME") or "").strip()
    configured_app_id = str(values.get("HUSSH_TECH_DEVELOPER_APP_ID") or "").strip()
    clean_app_id = str(app_id or "").strip()
    if lane != "uat":
        raise ValueError("HushhTech developer-app reconciliation is UAT-only")
    if project_id != HUSHH_TECH_UAT_PROJECT_ID:
        raise ValueError("HushhTech developer-app reconciliation requires hushh-pda-uat")
    if instance != HUSHH_TECH_UAT_CLOUDSQL_INSTANCE:
        raise ValueError("HushhTech developer-app reconciliation requires hushh-uat-pg")
    if not configured_app_id or configured_app_id != clean_app_id:
        raise ValueError("app_id must exactly match HUSSH_TECH_DEVELOPER_APP_ID")


def assert_connected_hushh_tech_uat_database(connection: Any) -> None:
    """Attest the connected PostgreSQL server before any registry write."""

    try:
        result = connection.execute(text(UAT_DATABASE_ATTESTATION_SQL))
        row = result.mappings().first()
    except Exception as exc:
        raise ValueError("connected UAT database identity could not be verified") from exc
    if not row:
        raise ValueError("connected UAT database identity could not be verified")
    try:
        identity = parse_connected_database_identity(row)
    except ValueError as exc:
        raise ValueError("connected UAT database identity could not be verified") from exc
    if not is_attested_hushh_tech_uat_database(identity):
        raise ValueError("connected database is not the attested hushh-uat-pg target")


TOOL_CATALOG = (
    {
        "name": "search_user_scopes",
        "group": TOOL_GROUP_CORE_CONSENT,
        "compatibility_status": "recommended",
        "description": "Deterministically ranked, least-privilege-first lookup over a user's discoverable scopes.",
    },
    {
        "name": "prepare_campaign_context",
        "group": TOOL_GROUP_CORE_CONSENT,
        "compatibility_status": "compatibility",
        "description": "Hardened one-shot consent lifecycle used by Hussh ADK campaign agents.",
    },
    {
        "name": "request_consent",
        "group": TOOL_GROUP_CORE_CONSENT,
        "compatibility_status": "recommended",
        "description": "Create a consent request; retrieval and connector-side decryption remain blocked until the user grants it.",
    },
    {
        "name": "check_consent_status",
        "group": TOOL_GROUP_CORE_CONSENT,
        "compatibility_status": "recommended",
        "description": "Check lifecycle state; decrypt only after granted with a grant reference.",
    },
    {
        "name": "get_encrypted_scoped_export",
        "group": TOOL_GROUP_CORE_CONSENT,
        "compatibility_status": "recommended",
        "description": "Deliver an approved export for connector-side decryption outside model context using securely retained connector key material.",
    },
    {
        "name": "list_ria_profiles",
        "group": TOOL_GROUP_RIA_READ,
        "compatibility_status": "partner_preview",
        "description": "Partner-only RIA marketplace discovery surface.",
    },
    {
        "name": "get_ria_profile",
        "group": TOOL_GROUP_RIA_READ,
        "compatibility_status": "partner_preview",
        "description": "Partner-only RIA profile reader.",
    },
    {
        "name": "list_marketplace_investors",
        "group": TOOL_GROUP_RIA_READ,
        "compatibility_status": "partner_preview",
        "description": "Partner-only investor marketplace discovery surface.",
    },
    {
        "name": "get_ria_verification_status",
        "group": TOOL_GROUP_RIA_READ,
        "compatibility_status": "partner_preview",
        "description": "Partner-only advisor verification reader.",
    },
    {
        "name": "get_ria_client_access_summary",
        "group": TOOL_GROUP_RIA_READ,
        "compatibility_status": "partner_preview",
        "description": "Partner-only client access summary for RIA flows.",
    },
    # ── Kai compatibility voice actions ────────────────────────────────
    {
        "name": "kai_analyze_stock",
        "group": TOOL_GROUP_KAI_VOICE,
        "compatibility_status": "recommended",
        "description": "Trigger a stock analysis by ticker or company name.",
    },
    {
        "name": "kai_open_dashboard",
        "group": TOOL_GROUP_KAI_VOICE,
        "compatibility_status": "recommended",
        "description": "Navigate to the Portfolio / Dashboard tab.",
    },
    {
        "name": "kai_open_import",
        "group": TOOL_GROUP_KAI_VOICE,
        "compatibility_status": "recommended",
        "description": "Navigate to the Import / Upload Statement tab.",
    },
    {
        "name": "kai_open_history",
        "group": TOOL_GROUP_KAI_VOICE,
        "compatibility_status": "recommended",
        "description": "Navigate to Analysis History with optional sub-tab.",
    },
    {
        "name": "kai_open_consent",
        "group": TOOL_GROUP_KAI_VOICE,
        "compatibility_status": "recommended",
        "description": "Navigate to the Consents / Privacy tab.",
    },
    {
        "name": "kai_open_profile",
        "group": TOOL_GROUP_KAI_VOICE,
        "compatibility_status": "recommended",
        "description": "Navigate to the Profile tab.",
    },
    {
        "name": "kai_open_home",
        "group": TOOL_GROUP_KAI_VOICE,
        "compatibility_status": "recommended",
        "description": "Navigate to the Market / Home tab.",
    },
    {
        "name": "kai_navigate_back",
        "group": TOOL_GROUP_KAI_VOICE,
        "compatibility_status": "recommended",
        "description": "Navigate back one screen.",
    },
    {
        "name": "kai_resume_active_analysis",
        "group": TOOL_GROUP_KAI_VOICE,
        "compatibility_status": "recommended",
        "description": "Resume the currently running background analysis.",
    },
    {
        "name": "kai_cancel_active_analysis",
        "group": TOOL_GROUP_KAI_VOICE,
        "compatibility_status": "recommended",
        "description": "Cancel the currently running background analysis.",
    },
)


@dataclass(frozen=True)
class DeveloperPrincipal:
    app_id: str
    agent_id: str
    display_name: str
    allowed_tool_groups: tuple[str, ...]
    allowed_capabilities: tuple[str, ...] = ()
    support_url: str | None = None
    policy_url: str | None = None
    website_url: str | None = None
    brand_image_url: str | None = None
    contact_email: str | None = None
    token_id: int | None = None
    auth_source: str = "registry"
    is_internal_fallback: bool = False
    # self_serve = portal-provisioned human developer app;
    # partner_crm = ops-provisioned app representing one CRM system.
    kind: str = "self_serve"
    crm_id: str | None = None
    schema_profile: str = SCHEMA_PROFILE_STANDARD
    oauth_client_credentials_enabled: bool = False
    mcp_execution_mode: str = "execute"


def normalize_tool_groups(raw_groups: Any) -> tuple[str, ...]:
    if isinstance(raw_groups, str):
        stripped = raw_groups.strip()
        if stripped.startswith("["):
            try:
                parsed = json.loads(stripped)
                return normalize_tool_groups(parsed)
            except json.JSONDecodeError:
                candidates = [part.strip() for part in stripped.split(",") if part.strip()]
        else:
            candidates = [part.strip() for part in stripped.split(",") if part.strip()]
    elif isinstance(raw_groups, (list, tuple, set)):
        candidates = [str(item).strip() for item in raw_groups if str(item).strip()]
    else:
        candidates = []

    filtered = [group for group in candidates if group in KNOWN_TOOL_GROUPS]
    if not filtered:
        return DEFAULT_PUBLIC_TOOL_GROUPS

    seen: set[str] = set()
    ordered: list[str] = []
    for group in filtered:
        if group in seen:
            continue
        seen.add(group)
        ordered.append(group)
    return tuple(ordered)


def normalize_schema_profile(value: Any) -> str:
    normalized = str(value or SCHEMA_PROFILE_STANDARD).strip().lower()
    return normalized if normalized in KNOWN_SCHEMA_PROFILES else SCHEMA_PROFILE_STANDARD


def visible_tool_names_for_groups(
    tool_groups: tuple[str, ...] | list[str] | None,
) -> tuple[str, ...]:
    normalized = normalize_tool_groups(tool_groups)
    visible: list[str] = []
    seen: set[str] = set()
    for group in normalized:
        for configured_name in TOOL_GROUP_TOOL_NAMES[group]:
            tool_name = canonical_tool_name(configured_name) or configured_name
            if tool_name in seen:
                continue
            seen.add(tool_name)
            visible.append(tool_name)
    return tuple(visible)


class DeveloperRegistryService:
    _tables_ensured = False

    def __init__(self) -> None:
        self._db = get_db()

    @staticmethod
    def _now_ms() -> int:
        return int(time.time() * 1000)

    @staticmethod
    def _pepper() -> str:
        configured_pepper = str(os.getenv("DEVELOPER_TOKEN_PEPPER", "")).strip()
        if configured_pepper:
            return configured_pepper
        # Transition fallbacks, logged for operator visibility. Provision
        # DEVELOPER_TOKEN_PEPPER in Secret Manager to separate trust domains;
        # the hardcoded literal is retained only until that rollout completes
        # (existing token hashes were computed under the active fallback).
        try:
            pepper = get_core_security_settings().app_signing_key
            _warn_pepper_fallback_once(
                "DEVELOPER_TOKEN_PEPPER not set; using APP_SIGNING_KEY as "
                "developer-token pepper. Provision a dedicated pepper to "
                "separate the trust domains."
            )
            return pepper
        except ValueError:
            _warn_pepper_fallback_once(
                "DEVELOPER_TOKEN_PEPPER and APP_SIGNING_KEY both unavailable; "
                "using the legacy hardcoded pepper. This is NOT safe for "
                "production - provision DEVELOPER_TOKEN_PEPPER."
            )
            return "hushh-developer-token-pepper"

    @classmethod
    def _hash_token(cls, raw_token: str) -> str:
        digest = hmac.new(
            cls._pepper().encode("utf-8"),
            raw_token.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        return digest

    @staticmethod
    def _slugify(value: str, *, fallback: str) -> str:
        lowered = str(value or "").strip().lower()
        slug = re.sub(r"[^a-z0-9]+", "-", lowered).strip("-")
        return slug[:40] or fallback

    @staticmethod
    def _sanitize_optional_text(value: str | None) -> str | None:
        text = str(value or "").strip()
        return text or None

    @classmethod
    def _sanitize_url(cls, value: str | None) -> str | None:
        text = cls._sanitize_optional_text(value)
        if not text:
            return None
        if text.startswith("http://") or text.startswith("https://"):
            return text
        return f"https://{text}"

    @classmethod
    def _default_contact_email(cls, owner_firebase_uid: str, owner_email: str | None) -> str:
        email = cls._sanitize_optional_text(owner_email)
        if email:
            return email.lower()
        fallback_uid = cls._slugify(owner_firebase_uid, fallback="developer")
        return f"{fallback_uid}@users.one.hushh.ai"

    @classmethod
    def _default_display_name(cls, owner_display_name: str | None, owner_email: str | None) -> str:
        display_name = cls._sanitize_optional_text(owner_display_name)
        if display_name:
            return display_name
        email = cls._sanitize_optional_text(owner_email)
        if email and "@" in email:
            return email.split("@", 1)[0].replace(".", " ").replace("_", " ").title()
        return "Kai Developer"

    @classmethod
    def _make_app_identity(
        cls,
        display_name: str,
        owner_firebase_uid: str,
    ) -> tuple[str, str]:
        slug = cls._slugify(display_name, fallback="developer-app")
        owner_suffix = hashlib.sha256(owner_firebase_uid.encode("utf-8")).hexdigest()[:8]
        app_id = f"app_{slug}_{owner_suffix}"
        agent_id = f"developer:{app_id}"
        return app_id, agent_id

    @staticmethod
    def _parse_json_array(value: Any) -> tuple[str, ...]:
        if isinstance(value, list):
            return tuple(str(item).strip() for item in value if str(item).strip())
        if isinstance(value, str):
            stripped = value.strip()
            if not stripped:
                return ()
            try:
                parsed = json.loads(stripped)
                if isinstance(parsed, list):
                    return tuple(str(item).strip() for item in parsed if str(item).strip())
            except json.JSONDecodeError:
                return tuple(part.strip() for part in stripped.split(",") if part.strip())
        return ()

    @classmethod
    def _parse_allowed_tool_groups(cls, value: Any) -> tuple[str, ...]:
        parsed = cls._parse_json_array(value)
        return normalize_tool_groups(parsed)

    @classmethod
    def _parse_allowed_capabilities(cls, value: Any) -> tuple[str, ...]:
        from hushh_mcp.constants import EXTERNAL_REQUESTABLE_RESERVED_SCOPE_VALUES

        return tuple(
            capability
            for capability in cls._parse_json_array(value)
            if capability in EXTERNAL_REQUESTABLE_RESERVED_SCOPE_VALUES
        )

    @classmethod
    def _principal_from_row(cls, row: dict[str, Any]) -> DeveloperPrincipal:
        return DeveloperPrincipal(
            app_id=str(row.get("app_id") or "").strip(),
            agent_id=str(row.get("agent_id") or "").strip(),
            display_name=str(row.get("display_name") or "").strip() or "Kai developer app",
            allowed_tool_groups=cls._parse_allowed_tool_groups(row.get("allowed_tool_groups")),
            allowed_capabilities=cls._parse_allowed_capabilities(row.get("allowed_capabilities")),
            support_url=cls._sanitize_optional_text(row.get("support_url")),
            policy_url=cls._sanitize_optional_text(row.get("policy_url")),
            website_url=cls._sanitize_optional_text(row.get("website_url")),
            brand_image_url=cls._sanitize_optional_text(row.get("brand_image_url")),
            contact_email=cls._sanitize_optional_text(row.get("contact_email")),
            token_id=row.get("token_id"),
            auth_source=str(row.get("auth_source") or "registry"),
            is_internal_fallback=bool(row.get("is_internal_fallback")),
            kind=str(row.get("kind") or "self_serve").strip() or "self_serve",
            crm_id=cls._sanitize_optional_text(row.get("crm_id")),
            schema_profile=normalize_schema_profile(row.get("schema_profile")),
            oauth_client_credentials_enabled=bool(row.get("oauth_client_credentials_enabled")),
            mcp_execution_mode=(
                "catalog_only"
                if str(row.get("mcp_execution_mode") or "").strip() == "catalog_only"
                else (
                    "catalog_only"
                    if str(row.get("schema_profile") or "").strip() == "agentforce"
                    else "execute"
                )
            ),
        )

    def ensure_tables(self) -> None:
        if self.__class__._tables_ensured:
            return

        # Canonical schema source: db/migrations/070_developer_registry.sql
        # (registered in db/release_migration_manifest.json under the
        # "developer" group). The idempotent CREATE TABLE IF NOT EXISTS DDL
        # below is retained only as a runtime safety net so a backend booting
        # against a database that has not yet applied migration 070 still
        # functions. The migration is authoritative; keep the two in sync.
        #
        # Offline mode: the developer_* tables are pre-created by the SQLite
        # offline schema (db/offline_schema.sql). The Postgres DDL below uses
        # BIGSERIAL/JSONB/::jsonb casts that SQLite cannot parse, so skip it.
        if str(os.getenv("DB_OFFLINE", "0")).strip().lower() in ("1", "true", "yes", "on"):
            self.__class__._tables_ensured = True
            return

        statements = [
            """
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
            """,
            "CREATE INDEX IF NOT EXISTS idx_developer_applications_status ON developer_applications(status)",
            "CREATE INDEX IF NOT EXISTS idx_developer_applications_created_at ON developer_applications(created_at DESC)",
            """
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
                allowed_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
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
            """,
            "ALTER TABLE developer_apps ADD COLUMN IF NOT EXISTS owner_firebase_uid TEXT",
            "ALTER TABLE developer_apps ADD COLUMN IF NOT EXISTS owner_email TEXT",
            "ALTER TABLE developer_apps ADD COLUMN IF NOT EXISTS owner_display_name TEXT",
            "ALTER TABLE developer_apps ADD COLUMN IF NOT EXISTS owner_provider_ids JSONB NOT NULL DEFAULT '[]'::jsonb",
            "ALTER TABLE developer_apps ADD COLUMN IF NOT EXISTS brand_image_url TEXT",
            "ALTER TABLE developer_apps ADD COLUMN IF NOT EXISTS allowed_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb",
            # Partner-class apps (canonical: db/migrations/085_developer_partner_apps.sql).
            "ALTER TABLE developer_apps ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'self_serve'",
            "ALTER TABLE developer_apps ADD COLUMN IF NOT EXISTS crm_id TEXT",
            # Agentforce-compatible profiles and client credentials are opt-in
            # per app. Defaults preserve the standard v0.3 surface.
            "ALTER TABLE developer_apps ADD COLUMN IF NOT EXISTS schema_profile TEXT NOT NULL DEFAULT 'standard'",
            "ALTER TABLE developer_apps ADD COLUMN IF NOT EXISTS oauth_client_credentials_enabled BOOLEAN NOT NULL DEFAULT FALSE",
            "CREATE INDEX IF NOT EXISTS idx_developer_apps_kind ON developer_apps(kind)",
            "CREATE INDEX IF NOT EXISTS idx_developer_apps_status ON developer_apps(status)",
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_developer_apps_owner_firebase_uid ON developer_apps(owner_firebase_uid) WHERE owner_firebase_uid IS NOT NULL",
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1
                    FROM information_schema.tables
                    WHERE table_schema = current_schema()
                      AND table_name = 'developer_api_keys'
                ) AND NOT EXISTS (
                    SELECT 1
                    FROM information_schema.tables
                    WHERE table_schema = current_schema()
                      AND table_name = 'developer_tokens'
                ) THEN
                    EXECUTE 'ALTER TABLE developer_api_keys RENAME TO developer_tokens';
                END IF;
            END
            $$;
            """,
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'developer_tokens'
                      AND column_name = 'key_prefix'
                ) AND NOT EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'developer_tokens'
                      AND column_name = 'token_prefix'
                ) THEN
                    EXECUTE 'ALTER TABLE developer_tokens RENAME COLUMN key_prefix TO token_prefix';
                END IF;
            END
            $$;
            """,
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'developer_tokens'
                      AND column_name = 'key_hash'
                ) AND NOT EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'developer_tokens'
                      AND column_name = 'token_hash'
                ) THEN
                    EXECUTE 'ALTER TABLE developer_tokens RENAME COLUMN key_hash TO token_hash';
                END IF;
            END
            $$;
            """,
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1
                    FROM information_schema.table_constraints
                    WHERE table_schema = current_schema()
                      AND table_name = 'developer_tokens'
                      AND constraint_name = 'developer_api_keys_app_id_fkey'
                ) AND NOT EXISTS (
                    SELECT 1
                    FROM information_schema.table_constraints
                    WHERE table_schema = current_schema()
                      AND table_name = 'developer_tokens'
                      AND constraint_name = 'developer_tokens_app_id_fkey'
                ) THEN
                    EXECUTE 'ALTER TABLE developer_tokens RENAME CONSTRAINT developer_api_keys_app_id_fkey TO developer_tokens_app_id_fkey';
                END IF;
            END
            $$;
            """,
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1
                    FROM pg_class
                    WHERE relkind = 'i'
                      AND relname = 'idx_developer_api_keys_app_id'
                ) AND NOT EXISTS (
                    SELECT 1
                    FROM pg_class
                    WHERE relkind = 'i'
                      AND relname = 'idx_developer_tokens_app_id'
                ) THEN
                    EXECUTE 'ALTER INDEX idx_developer_api_keys_app_id RENAME TO idx_developer_tokens_app_id';
                END IF;
            END
            $$;
            """,
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1
                    FROM pg_class
                    WHERE relkind = 'i'
                      AND relname = 'idx_developer_api_keys_revoked_at'
                ) AND NOT EXISTS (
                    SELECT 1
                    FROM pg_class
                    WHERE relkind = 'i'
                      AND relname = 'idx_developer_tokens_revoked_at'
                ) THEN
                    EXECUTE 'ALTER INDEX idx_developer_api_keys_revoked_at RENAME TO idx_developer_tokens_revoked_at';
                END IF;
            END
            $$;
            """,
            """
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
            """,
            "CREATE INDEX IF NOT EXISTS idx_developer_tokens_app_id ON developer_tokens(app_id)",
            "CREATE INDEX IF NOT EXISTS idx_developer_tokens_revoked_at ON developer_tokens(revoked_at)",
            """
            CREATE TABLE IF NOT EXISTS developer_connector_keys (
                app_id TEXT NOT NULL REFERENCES developer_apps(app_id) ON DELETE CASCADE,
                connector_key_id TEXT NOT NULL,
                connector_public_key TEXT NOT NULL,
                recipient_key_fingerprint TEXT NOT NULL,
                connector_wrapping_alg TEXT NOT NULL DEFAULT 'X25519-AES256-GCM',
                status TEXT NOT NULL DEFAULT 'active',
                created_at BIGINT NOT NULL,
                retired_at BIGINT,
                revoked_at BIGINT,
                PRIMARY KEY (app_id, connector_key_id)
            )
            """,
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_developer_connector_keys_one_active_per_app ON developer_connector_keys(app_id) WHERE status = 'active'",
        ]
        for statement in statements:
            self._db.execute_raw(statement)

        self.__class__._tables_ensured = True

    def get_app(self, app_id: str) -> dict[str, Any] | None:
        self.ensure_tables()
        result = self._db.execute_raw(
            """
            SELECT *
            FROM developer_apps
            WHERE app_id = :app_id
            LIMIT 1
            """,
            {"app_id": app_id},
        )
        return result.data[0] if result.data else None

    def get_active_connector_key(self, *, app_id: str) -> dict[str, Any] | None:
        """Return the one key allowed for new encrypted grants for an app."""

        self.ensure_tables()
        result = self._db.execute_raw(
            """
            SELECT app_id, connector_key_id, connector_public_key,
                   recipient_key_fingerprint, connector_wrapping_alg, status,
                   created_at
            FROM developer_connector_keys
            WHERE app_id = :app_id AND status = 'active'
            ORDER BY created_at DESC
            LIMIT 1
            """,
            {"app_id": app_id},
        )
        return result.data[0] if result.data else None

    def register_connector_key(
        self,
        *,
        app_id: str,
        connector_key_id: str,
        connector_public_key: str,
        connector_wrapping_alg: str = "X25519-AES256-GCM",
        retire_existing: bool = False,
    ) -> dict[str, Any]:
        """Register one profile-validated partner public key without a private key."""

        clean_key_id = str(connector_key_id or "").strip()
        clean_public_key = str(connector_public_key or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", clean_key_id):
            raise ValueError("connector_key_id is invalid")
        try:
            profile = get_connector_crypto_profile(connector_wrapping_alg)
        except ValueError as exc:
            raise ValueError("connector_wrapping_alg is not an enabled crypto profile") from exc
        try:
            fingerprint = profile.fingerprint_recipient_key(clean_public_key)
        except ValueError as exc:
            raise ValueError(
                "connector_public_key does not match the selected crypto profile"
            ) from exc

        self.ensure_tables()

        app = self.get_app(app_id)
        if not app or str(app.get("status") or "") != "active":
            raise ValueError("developer app is not active")
        existing = self._db.execute_raw(
            """
            SELECT app_id, connector_key_id, connector_public_key,
                   recipient_key_fingerprint, connector_wrapping_alg, status, created_at
            FROM developer_connector_keys
            WHERE app_id = :app_id AND connector_key_id = :connector_key_id
            LIMIT 1
            """,
            {"app_id": app_id, "connector_key_id": clean_key_id},
        )
        if existing.data:
            row = existing.data[0]
            if (
                str(row.get("connector_public_key")) == clean_public_key
                and str(row.get("connector_wrapping_alg")) == connector_wrapping_alg
            ):
                return row
            raise ValueError("connector_key_id is already bound to a different public key")

        active = self.get_active_connector_key(app_id=app_id)
        if active and not retire_existing:
            raise ValueError(
                "an active connector key already exists; retire it explicitly before rotation"
            )
        now = self._now_ms()
        if active:
            self._db.execute_raw(
                """
                UPDATE developer_connector_keys
                SET status = 'retired', retired_at = :now
                WHERE app_id = :app_id AND status = 'active'
                """,
                {"app_id": app_id, "now": now},
            )
        result = self._db.execute_raw(
            """
            INSERT INTO developer_connector_keys (
                app_id, connector_key_id, connector_public_key,
                recipient_key_fingerprint, connector_wrapping_alg, status, created_at
            ) VALUES (
                :app_id, :connector_key_id, :connector_public_key,
                :recipient_key_fingerprint, :connector_wrapping_alg, 'active', :created_at
            )
            RETURNING app_id, connector_key_id, connector_public_key,
                      recipient_key_fingerprint, connector_wrapping_alg, status, created_at
            """,
            {
                "app_id": app_id,
                "connector_key_id": clean_key_id,
                "connector_public_key": clean_public_key,
                "recipient_key_fingerprint": fingerprint,
                "connector_wrapping_alg": connector_wrapping_alg,
                "created_at": now,
            },
        )
        return result.data[0]

    @staticmethod
    def _result_first_mapping(result: Any) -> dict[str, Any] | None:
        row = result.mappings().first()
        return dict(row) if row else None

    @staticmethod
    def _result_all_mappings(result: Any) -> list[dict[str, Any]]:
        return [dict(row) for row in result.mappings().all()]

    @classmethod
    def _validate_hushh_tech_uat_app_policy_rows(
        cls,
        *,
        app: dict[str, Any] | None,
        connector_keys: list[dict[str, Any]],
        app_id: str,
        connector_key_id: str,
        connector_public_key: str,
        connector_fingerprint: str,
        crm_id: str,
    ) -> dict[str, Any]:
        """Validate raw rows without normalizing unknown privileges away."""

        if not app or str(app.get("app_id") or "") != app_id:
            raise ValueError("configured HushhTech developer app does not exist")
        if str(app.get("agent_id") or "") != f"developer:{app_id}":
            raise ValueError("configured HushhTech developer app has agent-identity drift")
        if app.get("application_id") is not None:
            raise ValueError("configured HushhTech developer app has application-binding drift")
        if str(app.get("status") or "") != "active":
            raise ValueError("configured HushhTech developer app is not active")
        if str(app.get("kind") or "") != "partner_crm":
            raise ValueError("configured HushhTech developer app is not ops-managed")
        if cls._sanitize_optional_text(app.get("owner_firebase_uid")):
            raise ValueError("configured HushhTech developer app is bound to a human owner")
        if cls._parse_json_array(app.get("allowed_tool_groups")) != (TOOL_GROUP_HUSHH_TECH_CLIENT,):
            raise ValueError("configured HushhTech developer app has tool-group drift")
        if cls._parse_json_array(app.get("allowed_capabilities")) != ():
            raise ValueError("configured HushhTech developer app has capability drift")
        if bool(app.get("oauth_client_credentials_enabled")):
            raise ValueError("configured HushhTech developer app has generic OAuth access")
        if normalize_schema_profile(app.get("schema_profile")) != SCHEMA_PROFILE_STANDARD:
            raise ValueError("configured HushhTech developer app has schema-profile drift")
        if cls._sanitize_optional_text(app.get("crm_id")) != cls._sanitize_optional_text(crm_id):
            raise ValueError("configured HushhTech developer app has registration-id drift")

        active_keys = [row for row in connector_keys if str(row.get("status") or "") == "active"]
        if len(active_keys) != 1:
            raise ValueError("configured HushhTech developer app must have exactly one active key")
        active_key = active_keys[0]
        if (
            str(active_key.get("connector_key_id") or "") != connector_key_id
            or str(active_key.get("connector_public_key") or "") != connector_public_key
            or str(active_key.get("connector_wrapping_alg") or "")
            != HUSHH_TECH_CONNECTOR_WRAPPING_ALG
            or str(active_key.get("recipient_key_fingerprint") or "") != connector_fingerprint
        ):
            raise ValueError("configured HushhTech connector key does not match")
        return {"app": app, "connector_key": active_key}

    @classmethod
    def _load_and_validate_hushh_tech_uat_app_policy(
        cls,
        connection: Any,
        *,
        app_id: str,
        connector_key_id: str,
        connector_public_key: str,
        connector_fingerprint: str,
        crm_id: str,
        provisioned_by: str,
    ) -> dict[str, Any]:
        app = cls._result_first_mapping(
            connection.execute(
                text("SELECT * FROM developer_apps WHERE app_id = :app_id LIMIT 1"),
                {"app_id": app_id},
            )
        )
        keys = cls._result_all_mappings(
            connection.execute(
                text(
                    """
                    SELECT app_id, connector_key_id, connector_public_key,
                           recipient_key_fingerprint, connector_wrapping_alg, status,
                           created_at, retired_at, revoked_at
                    FROM developer_connector_keys
                    WHERE app_id = :app_id
                    ORDER BY created_at ASC, connector_key_id ASC
                    """
                ),
                {"app_id": app_id},
            )
        )
        verified = cls._validate_hushh_tech_uat_app_policy_rows(
            app=app,
            connector_keys=keys,
            app_id=app_id,
            connector_key_id=connector_key_id,
            connector_public_key=connector_public_key,
            connector_fingerprint=connector_fingerprint,
            crm_id=crm_id,
        )
        active_tokens = cls._result_all_mappings(
            connection.execute(
                text(
                    """
                    SELECT id, app_id, token_prefix, label, created_by,
                           created_at, revoked_at, last_used_at
                    FROM developer_tokens
                    WHERE app_id = :app_id AND revoked_at IS NULL
                    ORDER BY created_at ASC, id ASC
                    """
                ),
                {"app_id": app_id},
            )
        )
        if (
            len(active_tokens) != 1
            or str(active_tokens[0].get("label") or "") != "hushh-tech-uat-primary"
            or str(active_tokens[0].get("created_by") or "") != provisioned_by
        ):
            raise ValueError(
                "configured HushhTech developer app must have exactly one intended token"
            )
        active_oauth_clients = cls._result_all_mappings(
            connection.execute(
                text(
                    """
                    SELECT client_id FROM developer_oauth_clients
                    WHERE app_id = :app_id AND revoked_at IS NULL
                    """
                ),
                {"app_id": app_id},
            )
        )
        active_oauth_tokens = cls._result_all_mappings(
            connection.execute(
                text(
                    """
                    SELECT id FROM developer_oauth_tokens
                    WHERE app_id = :app_id AND revoked_at IS NULL
                    """
                ),
                {"app_id": app_id},
            )
        )
        if active_oauth_clients or active_oauth_tokens:
            raise ValueError("configured HushhTech developer app has active generic OAuth access")
        return {**verified, "active_token": active_tokens[0]}

    def verify_hushh_tech_uat_app_policy(
        self,
        *,
        app_id: str,
        connector_key_id: str,
        connector_public_key: str,
        crm_id: str = "hushh-tech-uat-client",
        provisioned_by: str = "ops_hushh_tech_uat_reconciliation",
    ) -> dict[str, Any]:
        """Read and verify the exact app/key policy on the attested UAT server."""

        assert_hushh_tech_uat_registry_target(app_id=app_id)
        clean_app_id = str(app_id or "").strip()
        clean_key_id = str(connector_key_id or "").strip()
        clean_public_key = str(connector_public_key or "").strip()
        profile = get_connector_crypto_profile(HUSHH_TECH_CONNECTOR_WRAPPING_ALG)
        try:
            fingerprint = profile.fingerprint_recipient_key(clean_public_key)
        except ValueError as exc:
            raise ValueError("connector_public_key is not a valid X25519 public key") from exc
        clean_provisioned_by = str(provisioned_by or "").strip()
        if not clean_provisioned_by:
            raise ValueError("provisioned_by is required")

        with self._db.engine.connect() as connection:
            assert_connected_hushh_tech_uat_database(connection)
            return self._load_and_validate_hushh_tech_uat_app_policy(
                connection,
                app_id=clean_app_id,
                connector_key_id=clean_key_id,
                connector_public_key=clean_public_key,
                connector_fingerprint=fingerprint,
                crm_id=crm_id,
                provisioned_by=clean_provisioned_by,
            )

    def reconcile_hushh_tech_uat_app(
        self,
        *,
        app_id: str,
        display_name: str,
        contact_email: str,
        connector_key_id: str,
        connector_public_key: str,
        crm_id: str = "hushh-tech-uat-client",
        provisioned_by: str = "ops_hushh_tech_uat_reconciliation",
        issued_token_sink: Callable[[str], None] | None = None,
    ) -> dict[str, Any]:
        """Converge the UAT product app to its least-privilege policy.

        The operation deliberately removes migration-era capabilities such as
        ``cap.one.invoke`` from a reused product registration. Connector-key
        rotation is fail closed: a retired or revoked key id is never revived,
        and a key id is never rebound to different key material.
        """

        assert_hushh_tech_uat_registry_target(app_id=app_id)
        clean_app_id = str(app_id or "").strip()
        if not re.fullmatch(r"app_[a-z0-9][a-z0-9_-]{2,123}", clean_app_id):
            raise ValueError("app_id is invalid")
        clean_display_name = str(display_name or "").strip()
        if not clean_display_name:
            raise ValueError("display_name is required")
        clean_contact_email = str(contact_email or "").strip().lower()
        if not clean_contact_email or "@" not in clean_contact_email:
            raise ValueError("A valid contact_email is required")
        clean_key_id = str(connector_key_id or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", clean_key_id):
            raise ValueError("connector_key_id is invalid")
        clean_public_key = str(connector_public_key or "").strip()
        profile = get_connector_crypto_profile(HUSHH_TECH_CONNECTOR_WRAPPING_ALG)
        try:
            fingerprint = profile.fingerprint_recipient_key(clean_public_key)
        except ValueError as exc:
            raise ValueError("connector_public_key is not a valid X25519 public key") from exc

        now_ms = self._now_ms()
        approved_by = self._sanitize_optional_text(provisioned_by)
        if not approved_by:
            raise ValueError("provisioned_by is required")
        registration_id = self._sanitize_optional_text(crm_id)
        issued_token = False
        with self._db.engine.begin() as connection:
            # The connected-server proof is deliberately the first SQL issued.
            # No runtime schema safety-net DDL is used by this ops path.
            assert_connected_hushh_tech_uat_database(connection)
            connection.execute(
                text("SELECT pg_advisory_xact_lock(hashtext(:lock_key))"),
                {"lock_key": f"hushh-tech-uat-registry:{clean_app_id}"},
            )
            existing_app = self._result_first_mapping(
                connection.execute(
                    text(
                        """
                        SELECT app_id, agent_id, application_id, status,
                               owner_firebase_uid
                        FROM developer_apps
                        WHERE app_id = :app_id
                        FOR UPDATE
                        """
                    ),
                    {"app_id": clean_app_id},
                )
            )
            if existing_app and (
                str(existing_app.get("status") or "") != "active"
                or self._sanitize_optional_text(existing_app.get("owner_firebase_uid"))
                or str(existing_app.get("agent_id") or "") != f"developer:{clean_app_id}"
                or existing_app.get("application_id") is not None
            ):
                raise ValueError(
                    "existing app is revoked, owner-bound, or has tenant-identity drift"
                )
            policy_result = connection.execute(
                text(
                    """
                    INSERT INTO developer_apps (
                        app_id, application_id, agent_id, display_name, contact_email,
                        status, allowed_tool_groups, allowed_capabilities, approved_at,
                        approved_by, notes, created_at, updated_at, kind, crm_id,
                        schema_profile, oauth_client_credentials_enabled
                    ) VALUES (
                        :app_id, NULL, :agent_id, :display_name, :contact_email,
                        'active', CAST(:allowed_tool_groups AS JSONB), '[]'::JSONB,
                        :approved_at, :approved_by, :notes, :created_at, :updated_at,
                        'partner_crm', :crm_id, 'standard', FALSE
                    )
                    ON CONFLICT (app_id) DO UPDATE
                    SET display_name = EXCLUDED.display_name,
                        contact_email = EXCLUDED.contact_email,
                        allowed_tool_groups = EXCLUDED.allowed_tool_groups,
                        allowed_capabilities = '[]'::JSONB,
                        approved_by = EXCLUDED.approved_by,
                        notes = EXCLUDED.notes,
                        updated_at = EXCLUDED.updated_at,
                        kind = 'partner_crm',
                        crm_id = EXCLUDED.crm_id,
                        schema_profile = 'standard',
                        oauth_client_credentials_enabled = FALSE
                    WHERE developer_apps.status = 'active'
                      AND developer_apps.owner_firebase_uid IS NULL
                      AND developer_apps.agent_id = EXCLUDED.agent_id
                      AND developer_apps.application_id IS NULL
                    RETURNING *
                    """
                ),
                {
                    "app_id": clean_app_id,
                    "agent_id": f"developer:{clean_app_id}",
                    "display_name": clean_display_name,
                    "contact_email": clean_contact_email,
                    "allowed_tool_groups": json.dumps([TOOL_GROUP_HUSHH_TECH_CLIENT]),
                    "approved_at": now_ms,
                    "approved_by": approved_by,
                    "notes": "UAT-only HushhTech product client; generic access is disabled.",
                    "created_at": now_ms,
                    "updated_at": now_ms,
                    "crm_id": registration_id,
                },
            )
            if self._result_first_mapping(policy_result) is None:
                raise ValueError("existing app is revoked, suspended, or bound to a human owner")

            keys = self._result_all_mappings(
                connection.execute(
                    text(
                        """
                        SELECT app_id, connector_key_id, connector_public_key,
                               recipient_key_fingerprint, connector_wrapping_alg, status,
                               created_at, retired_at, revoked_at
                        FROM developer_connector_keys
                        WHERE app_id = :app_id
                        ORDER BY created_at ASC, connector_key_id ASC
                        FOR UPDATE
                        """
                    ),
                    {"app_id": clean_app_id},
                )
            )
            target_key = next(
                (row for row in keys if str(row.get("connector_key_id") or "") == clean_key_id),
                None,
            )
            staged_target = False
            if target_key is None:
                # Stage the replacement as non-active, then read back and
                # validate every binding before touching the old active key.
                inserted_target = self._result_first_mapping(
                    connection.execute(
                        text(
                            """
                            INSERT INTO developer_connector_keys (
                                app_id, connector_key_id, connector_public_key,
                                recipient_key_fingerprint, connector_wrapping_alg,
                                status, created_at, retired_at
                            ) VALUES (
                                :app_id, :connector_key_id, :connector_public_key,
                                :recipient_key_fingerprint, :connector_wrapping_alg,
                                'retired', :created_at, :created_at
                            )
                            ON CONFLICT (app_id, connector_key_id) DO NOTHING
                            RETURNING app_id, connector_key_id, connector_public_key,
                                      recipient_key_fingerprint, connector_wrapping_alg,
                                      status, created_at, retired_at, revoked_at
                            """
                        ),
                        {
                            "app_id": clean_app_id,
                            "connector_key_id": clean_key_id,
                            "connector_public_key": clean_public_key,
                            "recipient_key_fingerprint": fingerprint,
                            "connector_wrapping_alg": HUSHH_TECH_CONNECTOR_WRAPPING_ALG,
                            "created_at": now_ms,
                        },
                    )
                )
                target_key = inserted_target or self._result_first_mapping(
                    connection.execute(
                        text(
                            """
                            SELECT app_id, connector_key_id, connector_public_key,
                                   recipient_key_fingerprint, connector_wrapping_alg,
                                   status, created_at, retired_at, revoked_at
                            FROM developer_connector_keys
                            WHERE app_id = :app_id AND connector_key_id = :connector_key_id
                            FOR UPDATE
                            """
                        ),
                        {"app_id": clean_app_id, "connector_key_id": clean_key_id},
                    )
                )
                staged_target = inserted_target is not None

            if not target_key:
                raise ValueError("connector key could not be staged")
            if (
                str(target_key.get("connector_public_key") or "") != clean_public_key
                or str(target_key.get("connector_wrapping_alg") or "")
                != HUSHH_TECH_CONNECTOR_WRAPPING_ALG
                or str(target_key.get("recipient_key_fingerprint") or "") != fingerprint
            ):
                raise ValueError("connector_key_id is already bound to different key material")
            target_status = str(target_key.get("status") or "")
            if staged_target:
                if target_status != "retired":
                    raise ValueError("staged connector key has an invalid status")
            elif target_status != "active":
                raise ValueError("a retired or revoked connector key id cannot be reactivated")

            # Only after the target binding is present and validated do we
            # retire older active keys. The surrounding transaction guarantees
            # any later failure restores the previous active key.
            connection.execute(
                text(
                    """
                    UPDATE developer_connector_keys
                    SET status = 'retired', retired_at = :now
                    WHERE app_id = :app_id
                      AND status = 'active'
                      AND connector_key_id <> :connector_key_id
                    """
                ),
                {"app_id": clean_app_id, "connector_key_id": clean_key_id, "now": now_ms},
            )
            if staged_target:
                connection.execute(
                    text(
                        """
                        UPDATE developer_connector_keys
                        SET status = 'active', retired_at = NULL
                        WHERE app_id = :app_id
                          AND connector_key_id = :connector_key_id
                          AND status = 'retired'
                          AND revoked_at IS NULL
                        """
                    ),
                    {"app_id": clean_app_id, "connector_key_id": clean_key_id},
                )

            # The product app never uses generic OAuth. Revoke any legacy
            # client and access/refresh tokens in the same transaction.
            connection.execute(
                text(
                    """
                    UPDATE developer_oauth_tokens
                    SET revoked_at = :now
                    WHERE app_id = :app_id AND revoked_at IS NULL
                    """
                ),
                {"app_id": clean_app_id, "now": now_ms},
            )
            connection.execute(
                text(
                    """
                    UPDATE developer_oauth_clients
                    SET revoked_at = :now
                    WHERE app_id = :app_id AND revoked_at IS NULL
                    """
                ),
                {"app_id": clean_app_id, "now": now_ms},
            )

            active_tokens = self._result_all_mappings(
                connection.execute(
                    text(
                        """
                        SELECT id, app_id, token_prefix, label, created_by,
                               created_at, revoked_at, last_used_at
                        FROM developer_tokens
                        WHERE app_id = :app_id AND revoked_at IS NULL
                        ORDER BY created_at ASC, id ASC
                        FOR UPDATE
                        """
                    ),
                    {"app_id": clean_app_id},
                )
            )
            intended_token = (
                active_tokens[0]
                if len(active_tokens) == 1
                and str(active_tokens[0].get("label") or "") == "hushh-tech-uat-primary"
                and str(active_tokens[0].get("created_by") or "") == approved_by
                else None
            )
            token_to_deliver: str | None = None
            if intended_token is None:
                if issued_token_sink is None:
                    raise ValueError(
                        "a secure token output sink is required before issuing a developer token"
                    )
                connection.execute(
                    text(
                        """
                        UPDATE developer_tokens
                        SET revoked_at = :now, revoked_by = :revoked_by
                        WHERE app_id = :app_id AND revoked_at IS NULL
                        """
                    ),
                    {"app_id": clean_app_id, "now": now_ms, "revoked_by": approved_by},
                )
                token_identifier = secrets.token_hex(4)
                token_secret = secrets.token_urlsafe(24)
                token_to_deliver = f"hdk_{token_identifier}_{token_secret}"
                intended_token = self._result_first_mapping(
                    connection.execute(
                        text(
                            """
                            INSERT INTO developer_tokens (
                                app_id, token_prefix, token_hash, label,
                                created_by, created_at
                            ) VALUES (
                                :app_id, :token_prefix, :token_hash, :label,
                                :created_by, :created_at
                            )
                            RETURNING id, app_id, token_prefix, label, created_by,
                                      created_at, revoked_at, last_used_at
                            """
                        ),
                        {
                            "app_id": clean_app_id,
                            "token_prefix": f"hdk_{token_identifier}",
                            "token_hash": self._hash_token(token_to_deliver),
                            "label": "hushh-tech-uat-primary",
                            "created_by": approved_by,
                            "created_at": now_ms,
                        },
                    )
                )
                if intended_token is None:
                    raise ValueError("developer token could not be issued")
                issued_token = True
            verified = self._load_and_validate_hushh_tech_uat_app_policy(
                connection,
                app_id=clean_app_id,
                connector_key_id=clean_key_id,
                connector_public_key=clean_public_key,
                connector_fingerprint=fingerprint,
                crm_id=crm_id,
                provisioned_by=approved_by,
            )
            if token_to_deliver is not None:
                # Delivery happens before the transaction commits. A sink
                # failure raises and rolls back the app, key, and token rows.
                issued_token_sink(token_to_deliver)
        return {
            **verified,
            "issued_token": issued_token,
        }

    def configure_partner_mcp_profile(
        self,
        *,
        app_id: str,
        schema_profile: str,
        enable_client_credentials: bool,
    ) -> dict[str, Any]:
        """Explicitly configure a partner app's public MCP capability projection."""

        self.ensure_tables()
        profile = normalize_schema_profile(schema_profile)
        app = self.get_app(app_id)
        if not app or str(app.get("kind") or "") != "partner_crm":
            raise ValueError("only partner_crm apps can be configured by this operations path")
        # Authentication does not choose a different public MCP catalog.
        # Client credentials can therefore be enabled for the canonical
        # standard profile as well as constrained legacy projections.  The
        # OAuth client's execution mode, rather than this app-wide setting,
        # determines whether a machine token is catalog-only or executable.
        result = self._db.execute_raw(
            """
            UPDATE developer_apps
            SET schema_profile = :schema_profile,
                oauth_client_credentials_enabled = :enabled,
                updated_at = :updated_at
            WHERE app_id = :app_id
            RETURNING *
            """,
            {
                "app_id": app_id,
                "schema_profile": profile,
                "enabled": bool(enable_client_credentials),
                "updated_at": self._now_ms(),
            },
        )
        if not result.data:
            raise ValueError("developer app configuration failed")
        return result.data[0]

    def get_app_by_owner_uid(self, owner_firebase_uid: str) -> dict[str, Any] | None:
        self.ensure_tables()
        result = self._db.execute_raw(
            """
            SELECT *
            FROM developer_apps
            WHERE owner_firebase_uid = :owner_firebase_uid
            LIMIT 1
            """,
            {"owner_firebase_uid": owner_firebase_uid},
        )
        return result.data[0] if result.data else None

    def get_active_token(self, *, app_id: str) -> dict[str, Any] | None:
        self.ensure_tables()
        result = self._db.execute_raw(
            """
            SELECT id, app_id, token_prefix, label, created_at, revoked_at, last_used_at,
                   last_used_ip, last_used_user_agent
            FROM developer_tokens
            WHERE app_id = :app_id
              AND revoked_at IS NULL
            ORDER BY created_at DESC
            LIMIT 1
            """,
            {"app_id": app_id},
        )
        return result.data[0] if result.data else None

    def list_tokens(self, *, app_id: str) -> list[dict[str, Any]]:
        self.ensure_tables()
        result = self._db.execute_raw(
            """
            SELECT id, app_id, token_prefix, label, created_by, created_at, revoked_by, revoked_at,
                   last_used_at, last_used_ip, last_used_user_agent
            FROM developer_tokens
            WHERE app_id = :app_id
            ORDER BY created_at DESC
            """,
            {"app_id": app_id},
        )
        return result.data

    def create_token(
        self,
        *,
        app_id: str,
        created_by: str | None,
        label: str | None = None,
    ) -> dict[str, Any]:
        self.ensure_tables()
        now_ms = self._now_ms()
        token_identifier = secrets.token_hex(4)
        token_secret = secrets.token_urlsafe(24)
        raw_token = f"hdk_{token_identifier}_{token_secret}"
        token_prefix = f"hdk_{token_identifier}"
        token_hash = self._hash_token(raw_token)

        result = self._db.execute_raw(
            """
            INSERT INTO developer_tokens (
                app_id,
                token_prefix,
                token_hash,
                label,
                created_by,
                created_at
            )
            VALUES (
                :app_id,
                :token_prefix,
                :token_hash,
                :label,
                :created_by,
                :created_at
            )
            RETURNING id, app_id, token_prefix, label, created_at, revoked_at, last_used_at
            """,
            {
                "app_id": app_id,
                "token_prefix": token_prefix,
                "token_hash": token_hash,
                "label": self._sanitize_optional_text(label),
                "created_by": self._sanitize_optional_text(created_by),
                "created_at": now_ms,
            },
        )
        created = result.data[0]
        created["raw_token"] = raw_token
        return created

    def revoke_token(self, *, token_id: int, revoked_by: str) -> dict[str, Any] | None:
        self.ensure_tables()
        now_ms = self._now_ms()
        result = self._db.execute_raw(
            """
            UPDATE developer_tokens
            SET revoked_at = :revoked_at,
                revoked_by = :revoked_by
            WHERE id = :token_id
              AND revoked_at IS NULL
            RETURNING id, app_id, token_prefix, label, created_at, revoked_at, last_used_at
            """,
            {
                "token_id": token_id,
                "revoked_at": now_ms,
                "revoked_by": self._sanitize_optional_text(revoked_by),
            },
        )
        return result.data[0] if result.data else None

    def revoke_active_tokens(self, *, app_id: str, revoked_by: str) -> None:
        self.ensure_tables()
        self._db.execute_raw(
            """
            UPDATE developer_tokens
            SET revoked_at = :revoked_at,
                revoked_by = :revoked_by
            WHERE app_id = :app_id
              AND revoked_at IS NULL
            """,
            {
                "app_id": app_id,
                "revoked_at": self._now_ms(),
                "revoked_by": self._sanitize_optional_text(revoked_by),
            },
        )

    def _sync_owner_metadata(
        self,
        *,
        app_id: str,
        owner_email: str | None,
        owner_display_name: str | None,
        owner_provider_ids: list[str] | tuple[str, ...] | None,
    ) -> dict[str, Any] | None:
        provider_ids = [
            str(item).strip() for item in (owner_provider_ids or []) if str(item).strip()
        ]
        result = self._db.execute_raw(
            """
            UPDATE developer_apps
            SET owner_email = :owner_email,
                owner_display_name = :owner_display_name,
                owner_provider_ids = CAST(:owner_provider_ids AS JSONB),
                updated_at = :updated_at
            WHERE app_id = :app_id
            RETURNING *
            """,
            {
                "app_id": app_id,
                "owner_email": self._sanitize_optional_text(owner_email),
                "owner_display_name": self._sanitize_optional_text(owner_display_name),
                "owner_provider_ids": json.dumps(provider_ids),
                "updated_at": self._now_ms(),
            },
        )
        return result.data[0] if result.data else None

    def ensure_self_serve_access(
        self,
        *,
        owner_firebase_uid: str,
        owner_email: str | None,
        owner_display_name: str | None,
        owner_provider_ids: list[str] | tuple[str, ...] | None = None,
    ) -> dict[str, Any]:
        self.ensure_tables()
        app = self.get_app_by_owner_uid(owner_firebase_uid)
        created_app = False

        if not app:
            display_name = self._default_display_name(owner_display_name, owner_email)
            app_id, agent_id = self._make_app_identity(display_name, owner_firebase_uid)
            now_ms = self._now_ms()
            result = self._db.execute_raw(
                """
                INSERT INTO developer_apps (
                    app_id,
                    application_id,
                    agent_id,
                    display_name,
                    contact_email,
                    support_url,
                    policy_url,
                    website_url,
                    brand_image_url,
                    status,
                    allowed_tool_groups,
                    approved_at,
                    approved_by,
                    notes,
                    created_at,
                    updated_at,
                    owner_firebase_uid,
                    owner_email,
                    owner_display_name,
                    owner_provider_ids
                )
                VALUES (
                    :app_id,
                    NULL,
                    :agent_id,
                    :display_name,
                    :contact_email,
                    NULL,
                    NULL,
                    NULL,
                    NULL,
                    'active',
                    '["core_consent"]'::jsonb,
                    :approved_at,
                    'self_serve',
                    'Self-serve developer access enabled from /developers.',
                    :created_at,
                    :updated_at,
                    :owner_firebase_uid,
                    :owner_email,
                    :owner_display_name,
                    CAST(:owner_provider_ids AS JSONB)
                )
                RETURNING *
                """,
                {
                    "app_id": app_id,
                    "agent_id": agent_id,
                    "display_name": display_name,
                    "contact_email": self._default_contact_email(owner_firebase_uid, owner_email),
                    "approved_at": now_ms,
                    "created_at": now_ms,
                    "updated_at": now_ms,
                    "owner_firebase_uid": owner_firebase_uid,
                    "owner_email": self._sanitize_optional_text(owner_email),
                    "owner_display_name": self._sanitize_optional_text(owner_display_name),
                    "owner_provider_ids": json.dumps(
                        [
                            str(item).strip()
                            for item in (owner_provider_ids or [])
                            if str(item).strip()
                        ]
                    ),
                },
            )
            app = result.data[0]
            created_app = True
        else:
            synced = self._sync_owner_metadata(
                app_id=str(app["app_id"]),
                owner_email=owner_email,
                owner_display_name=owner_display_name,
                owner_provider_ids=owner_provider_ids,
            )
            if synced:
                app = synced

        active_token = self.get_active_token(app_id=str(app["app_id"]))
        issued_token = False
        raw_token: str | None = None
        if active_token is None:
            active_token = self.create_token(
                app_id=str(app["app_id"]),
                created_by=owner_firebase_uid,
                label="primary",
            )
            raw_token = str(active_token.get("raw_token") or "")
            issued_token = True

        return {
            "app": app,
            "active_token": active_token,
            "raw_token": raw_token,
            "created_app": created_app,
            "issued_token": issued_token,
        }

    def get_partner_app_by_display_name(self, display_name: str) -> dict[str, Any] | None:
        self.ensure_tables()
        result = self._db.execute_raw(
            """
            SELECT * FROM developer_apps
            WHERE kind = 'partner_crm'
              AND display_name = :display_name
            LIMIT 1
            """,
            {"display_name": str(display_name or "").strip()},
        )
        return result.data[0] if result.data else None

    def provision_partner_app(
        self,
        *,
        display_name: str,
        contact_email: str,
        crm_id: str | None = None,
        allowed_tool_groups: list[str] | tuple[str, ...] | None = None,
        notes: str | None = None,
        provisioned_by: str = "ops_partner_provisioning",
    ) -> dict[str, Any]:
        """Provision (idempotently) a partner-class app for one CRM system.

        Architecture rule: every CRM system gets its OWN app + token so
        revocation, audit, and last-used telemetry stay per-system. Partner
        apps have no owner_firebase_uid: they never collide with the
        self-serve one-app-per-Firebase-user contract and stay invisible to
        the /developers portal (ops-managed by design).

        Re-running for the same display_name reuses the existing app and only
        issues a token when none is active. The raw token is returned exactly
        once per issuance; it is never persisted in plaintext.
        """
        self.ensure_tables()
        clean_display_name = str(display_name or "").strip()
        if not clean_display_name:
            raise ValueError("display_name is required for partner app provisioning")
        clean_contact_email = str(contact_email or "").strip().lower()
        if not clean_contact_email or "@" not in clean_contact_email:
            raise ValueError("A valid contact_email is required for partner app provisioning")
        clean_crm_id = self._sanitize_optional_text(crm_id)

        app = self.get_partner_app_by_display_name(clean_display_name)
        created_app = False
        if not app:
            # Stable identity: partner apps have no owner uid, so derive the
            # suffix from the partner identity itself for idempotent re-runs.
            identity_seed = f"partner_crm:{clean_display_name}:{clean_crm_id or ''}"
            slug = self._slugify(clean_display_name, fallback="partner-crm")
            suffix = hashlib.sha256(identity_seed.encode("utf-8")).hexdigest()[:8]
            app_id = f"app_{slug}_{suffix}"
            agent_id = f"developer:{app_id}"
            now_ms = self._now_ms()
            groups = normalize_tool_groups(allowed_tool_groups or DEFAULT_PUBLIC_TOOL_GROUPS)
            result = self._db.execute_raw(
                """
                INSERT INTO developer_apps (
                    app_id,
                    application_id,
                    agent_id,
                    display_name,
                    contact_email,
                    status,
                    allowed_tool_groups,
                    approved_at,
                    approved_by,
                    notes,
                    created_at,
                    updated_at,
                    kind,
                    crm_id
                )
                VALUES (
                    :app_id,
                    NULL,
                    :agent_id,
                    :display_name,
                    :contact_email,
                    'active',
                    CAST(:allowed_tool_groups AS JSONB),
                    :approved_at,
                    :approved_by,
                    :notes,
                    :created_at,
                    :updated_at,
                    'partner_crm',
                    :crm_id
                )
                RETURNING *
                """,
                {
                    "app_id": app_id,
                    "agent_id": agent_id,
                    "display_name": clean_display_name,
                    "contact_email": clean_contact_email,
                    "allowed_tool_groups": json.dumps(list(groups)),
                    "approved_at": now_ms,
                    "approved_by": self._sanitize_optional_text(provisioned_by),
                    "notes": self._sanitize_optional_text(notes)
                    or "Partner CRM app provisioned via ops script.",
                    "created_at": now_ms,
                    "updated_at": now_ms,
                    "crm_id": clean_crm_id,
                },
            )
            app = result.data[0]
            created_app = True

        active_token = self.get_active_token(app_id=str(app["app_id"]))
        issued_token = False
        raw_token: str | None = None
        if active_token is None:
            active_token = self.create_token(
                app_id=str(app["app_id"]),
                created_by=provisioned_by,
                label="partner-crm-primary",
            )
            raw_token = str(active_token.get("raw_token") or "")
            issued_token = True

        return {
            "app": app,
            "active_token": active_token,
            "raw_token": raw_token,
            "created_app": created_app,
            "issued_token": issued_token,
        }

    def update_self_serve_profile(
        self,
        *,
        owner_firebase_uid: str,
        display_name: str | None = None,
        website_url: str | None = None,
        brand_image_url: str | None = None,
        support_url: str | None = None,
        policy_url: str | None = None,
    ) -> dict[str, Any] | None:
        self.ensure_tables()
        app = self.get_app_by_owner_uid(owner_firebase_uid)
        if not app:
            return None

        next_display_name = (
            self._sanitize_optional_text(display_name) or str(app.get("display_name") or "").strip()
        )
        next_website_url = (
            self._sanitize_url(website_url) if website_url is not None else app.get("website_url")
        )
        next_brand_image_url = (
            self._sanitize_url(brand_image_url)
            if brand_image_url is not None
            else app.get("brand_image_url")
        )
        next_support_url = (
            self._sanitize_url(support_url) if support_url is not None else app.get("support_url")
        )
        next_policy_url = (
            self._sanitize_url(policy_url) if policy_url is not None else app.get("policy_url")
        )

        result = self._db.execute_raw(
            """
            UPDATE developer_apps
            SET display_name = :display_name,
                website_url = :website_url,
                brand_image_url = :brand_image_url,
                support_url = :support_url,
                policy_url = :policy_url,
                updated_at = :updated_at
            WHERE owner_firebase_uid = :owner_firebase_uid
            RETURNING *
            """,
            {
                "owner_firebase_uid": owner_firebase_uid,
                "display_name": next_display_name,
                "website_url": self._sanitize_optional_text(next_website_url),
                "brand_image_url": self._sanitize_optional_text(next_brand_image_url),
                "support_url": self._sanitize_optional_text(next_support_url),
                "policy_url": self._sanitize_optional_text(next_policy_url),
                "updated_at": self._now_ms(),
            },
        )
        return result.data[0] if result.data else None

    def rotate_self_serve_token(self, *, owner_firebase_uid: str) -> dict[str, Any] | None:
        self.ensure_tables()
        app = self.get_app_by_owner_uid(owner_firebase_uid)
        if not app:
            return None

        app_id = str(app["app_id"])
        self.revoke_active_tokens(app_id=app_id, revoked_by=owner_firebase_uid)
        active_token = self.create_token(
            app_id=app_id,
            created_by=owner_firebase_uid,
            label="primary",
        )
        return {
            "app": self.get_app(app_id) or app,
            "active_token": active_token,
            "raw_token": str(active_token.get("raw_token") or ""),
        }

    def authenticate_token(
        self,
        raw_token: str,
        *,
        ip_address: str | None = None,
        user_agent: str | None = None,
    ) -> DeveloperPrincipal | None:
        token = str(raw_token or "").strip()
        if not token:
            return None

        self.ensure_tables()
        token_hash = self._hash_token(token)
        result = self._db.execute_raw(
            """
            SELECT apps.app_id,
                   apps.agent_id,
                   apps.display_name,
                   apps.allowed_tool_groups,
                   apps.allowed_capabilities,
                   apps.support_url,
                   apps.policy_url,
                   apps.website_url,
                   apps.brand_image_url,
                   apps.contact_email,
                   apps.kind,
                   apps.crm_id,
                   apps.schema_profile,
                   apps.oauth_client_credentials_enabled,
                   tokens.id AS token_id
            FROM developer_tokens AS tokens
            INNER JOIN developer_apps AS apps
                ON apps.app_id = tokens.app_id
            WHERE tokens.token_hash = :token_hash
              AND tokens.revoked_at IS NULL
              AND apps.status = 'active'
            LIMIT 1
            """,
            {"token_hash": token_hash},
        )
        if not result.data:
            return None

        principal = self._principal_from_row(result.data[0])
        if principal.token_id is not None:
            self._db.execute_raw(
                """
                UPDATE developer_tokens
                SET last_used_at = :last_used_at,
                    last_used_ip = :last_used_ip,
                    last_used_user_agent = :last_used_user_agent
                WHERE id = :token_id
                """,
                {
                    "token_id": principal.token_id,
                    "last_used_at": self._now_ms(),
                    "last_used_ip": self._sanitize_optional_text(ip_address),
                    "last_used_user_agent": self._sanitize_optional_text(user_agent),
                },
            )
        return principal

    @staticmethod
    def build_consent_metadata(
        principal: DeveloperPrincipal,
        *,
        reason: str | None = None,
        connector_public_key: str | None = None,
        connector_key_id: str | None = None,
        connector_wrapping_alg: str | None = None,
    ) -> dict[str, Any]:
        metadata = {
            "developer_app_id": principal.app_id,
            "developer_agent_id": principal.agent_id,
            "developer_app_display_name": principal.display_name,
            "developer_allowed_tool_groups": list(principal.allowed_tool_groups),
            "developer_allowed_capabilities": list(principal.allowed_capabilities),
            "request_source": "developer_api_v1",
            "requester_actor_type": "developer",
        }
        if principal.support_url:
            metadata["developer_support_url"] = principal.support_url
        if principal.policy_url:
            metadata["developer_policy_url"] = principal.policy_url
        if principal.website_url:
            metadata["developer_website_url"] = principal.website_url
            metadata["requester_website_url"] = principal.website_url
        if principal.brand_image_url:
            metadata["developer_brand_image_url"] = principal.brand_image_url
            metadata["requester_image_url"] = principal.brand_image_url
        if principal.contact_email:
            metadata["developer_contact_email"] = principal.contact_email
        metadata["requester_label"] = principal.display_name
        if reason:
            metadata["reason"] = reason
        if connector_public_key:
            metadata["connector_public_key"] = connector_public_key
        if connector_key_id:
            metadata["connector_key_id"] = connector_key_id
        if connector_wrapping_alg:
            metadata["connector_wrapping_alg"] = connector_wrapping_alg
        return metadata

    def get_tool_catalog(self, *, principal: DeveloperPrincipal | None = None) -> dict[str, Any]:
        allowed_groups = principal.allowed_tool_groups if principal else DEFAULT_PUBLIC_TOOL_GROUPS
        exposed_tools = visible_tool_names_for_groups(allowed_groups)
        visible_names = set(exposed_tools)
        entries = [
            {**entry, "name": published_tool_name(entry["name"])}
            for entry in TOOL_CATALOG
            if entry["name"] in visible_names
        ]

        return {
            "version": "v0.4",
            "approval_required": False,
            "allowed_tool_groups": list(allowed_groups),
            "compatibility_status": "self_serve_public_beta",
            "recommended_flow": [
                "search-user-scopes",
                "prepare-campaign-context",
                "request-consent",
                "check-consent-status",
                "get-encrypted-scoped-export",
            ],
            "tools": entries,
            "tool_groups": [
                {
                    "name": group_name,
                    "status": (
                        "public_beta_default"
                        if group_name == TOOL_GROUP_CORE_CONSENT
                        else "partner_preview"
                        if group_name == TOOL_GROUP_RIA_READ
                        else "uat_product_client"
                        if group_name == TOOL_GROUP_HUSHH_TECH_CLIENT
                        else "internal_only"
                    ),
                }
                for group_name in allowed_groups
            ],
            "notes": [
                "Developers enable access themselves from /developers with Kai sign-in.",
                "User-specific access is determined by dynamic scope discovery plus explicit consent.",
                "Use get_encrypted_scoped_export for all consented reads; Hussh does not return plaintext user data to developer callers.",
                "RIA and marketplace reads stay partner-only unless explicitly granted to the app.",
            ],
        }
