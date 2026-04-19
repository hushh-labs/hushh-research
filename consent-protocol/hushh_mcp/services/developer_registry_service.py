from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import time
from dataclasses import dataclass
from typing import Any

from db.db_client import get_db
from hushh_mcp.runtime_settings import get_core_security_settings

TOOL_GROUP_CORE_CONSENT = "core_consent"
TOOL_GROUP_RIA_READ = "ria_read"
TOOL_GROUP_INTERNAL_ONLY = "internal_only"

KNOWN_TOOL_GROUPS = (
    TOOL_GROUP_CORE_CONSENT,
    TOOL_GROUP_RIA_READ,
    TOOL_GROUP_INTERNAL_ONLY,
)

DEFAULT_PUBLIC_TOOL_GROUPS = (TOOL_GROUP_CORE_CONSENT,)

TOOL_GROUP_TOOL_NAMES = {
    TOOL_GROUP_CORE_CONSENT: (
        "discover_user_domains",
        "request_consent",
        "check_consent_status",
        "get_encrypted_scoped_export",
        "validate_token",
        "list_scopes",
    ),
    TOOL_GROUP_RIA_READ: (
        "list_ria_profiles",
        "get_ria_profile",
        "list_marketplace_investors",
        "get_ria_verification_status",
        "get_ria_client_access_summary",
    ),
    TOOL_GROUP_INTERNAL_ONLY: ("delegate_to_agent",),
}

TOOL_CATALOG = (
    {
        "name": "discover_user_domains",
        "group": TOOL_GROUP_CORE_CONSENT,
        "compatibility_status": "recommended",
        "description": "Discover the dynamic scopes available for a specific user.",
    },
    {
        "name": "request_consent",
        "group": TOOL_GROUP_CORE_CONSENT,
        "compatibility_status": "recommended",
        "description": "Create a consent request that the user reviews in Kai.",
    },
    {
        "name": "check_consent_status",
        "group": TOOL_GROUP_CORE_CONSENT,
        "compatibility_status": "recommended",
        "description": "Check whether a pending scope request was granted or denied.",
    },
    {
        "name": "get_encrypted_scoped_export",
        "group": TOOL_GROUP_CORE_CONSENT,
        "compatibility_status": "recommended",
        "description": "Fetch the encrypted wrapped-key export for an approved consent token.",
    },
    {
        "name": "validate_token",
        "group": TOOL_GROUP_CORE_CONSENT,
        "compatibility_status": "recommended",
        "description": "Validate a consent token before attempting data access.",
    },
    {
        "name": "list_scopes",
        "group": TOOL_GROUP_CORE_CONSENT,
        "compatibility_status": "recommended",
        "description": "Read the canonical scope patterns and discovery guidance.",
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
    {
        "name": "delegate_to_agent",
        "group": TOOL_GROUP_INTERNAL_ONLY,
        "compatibility_status": "internal_only",
        "description": "Internal TrustLink delegation flow.",
    },
)


@dataclass(frozen=True)
class DeveloperPrincipal:
    app_id: str
    agent_id: str
    display_name: str
    allowed_tool_groups: tuple[str, ...]
    support_url: str | None = None
    policy_url: str | None = None
    website_url: str | None = None
    brand_image_url: str | None = None
    contact_email: str | None = None
    token_id: int | None = None
    auth_source: str = "registry"
    is_internal_fallback: bool = False


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


def visible_tool_names_for_groups(
    tool_groups: tuple[str, ...] | list[str] | None,
) -> tuple[str, ...]:
    normalized = normalize_tool_groups(tool_groups)
    visible: list[str] = []
    seen: set[str] = set()
    for catalog_entry in TOOL_CATALOG:
        if catalog_entry["group"] not in normalized:
            continue
        tool_name = catalog_entry["name"]
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
        try:
            return get_core_security_settings().app_signing_key
        except ValueError:
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
        return f"{fallback_uid}@users.kai.hushh.ai"

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
    def _principal_from_row(cls, row: dict[str, Any]) -> DeveloperPrincipal:
        return DeveloperPrincipal(
            app_id=str(row.get("app_id") or "").strip(),
            agent_id=str(row.get("agent_id") or "").strip(),
            display_name=str(row.get("display_name") or "").strip() or "Kai developer app",
            allowed_tool_groups=cls._parse_allowed_tool_groups(row.get("allowed_tool_groups")),
            support_url=cls._sanitize_optional_text(row.get("support_url")),
            policy_url=cls._sanitize_optional_text(row.get("policy_url")),
            website_url=cls._sanitize_optional_text(row.get("website_url")),
            brand_image_url=cls._sanitize_optional_text(row.get("brand_image_url")),
            contact_email=cls._sanitize_optional_text(row.get("contact_email")),
            token_id=row.get("token_id"),
            auth_source=str(row.get("auth_source") or "registry"),
            is_internal_fallback=bool(row.get("is_internal_fallback")),
        )

    def ensure_tables(self) -> None:
        if self.__class__._tables_ensured:
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
                   apps.support_url,
                   apps.policy_url,
                   apps.website_url,
                   apps.brand_image_url,
                   apps.contact_email,
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
        entries = [entry for entry in TOOL_CATALOG if entry["name"] in visible_names]

        return {
            "version": "v1",
            "approval_required": False,
            "allowed_tool_groups": list(allowed_groups),
            "compatibility_status": "self_serve_public_beta",
            "recommended_flow": [
                "discover_user_domains",
                "request_consent",
                "check_consent_status",
                "get_encrypted_scoped_export",
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
                        else "internal_only"
                    ),
                }
                for group_name in allowed_groups
            ],
            "notes": [
                "Developers enable access themselves from /developers with Kai sign-in.",
                "User-specific access is determined by dynamic scope discovery plus explicit consent.",
                "Use get_encrypted_scoped_export for all consented reads; Hushh does not return plaintext user data to developer callers.",
                "RIA and marketplace reads stay partner-only unless explicitly granted to the app.",
            ],
        }
