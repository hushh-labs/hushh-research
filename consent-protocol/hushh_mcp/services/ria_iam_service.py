from __future__ import annotations

import csv
import io
import json
import logging
import os
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

import asyncpg

from db.connection import get_pool
from hushh_mcp.consent.scope_helpers import get_scope_description
from hushh_mcp.services.consent_db import ConsentDBService
from hushh_mcp.services.consent_request_links import (
    build_connection_request_url,
    build_consent_request_url,
)
from hushh_mcp.services.kai_invite_email_service import get_kai_invite_email_service
from hushh_mcp.services.ria_verification import (
    FinraVerificationAdapter,
    VerificationGateway,
    VerificationResult,
)
from hushh_mcp.services.support_email_service import (
    SupportEmailNotConfiguredError,
    SupportEmailSendError,
)
from hushh_mcp.services.symbol_master_service import get_symbol_master_service

logger = logging.getLogger(__name__)

PersonaType = Literal["investor", "ria"]
ActorType = Literal["investor", "ria"]

_ALLOWED_PERSONAS: set[str] = {"investor", "ria"}
_ALLOWED_ACTOR_TYPES: set[str] = {"investor", "ria"}
_DURATION_PRESETS_HOURS: set[int] = {24, 24 * 7, 24 * 30, 24 * 90}
_MAX_DURATION_HOURS = 24 * 365
_ALLOWED_PROFESSIONAL_CAPABILITIES: tuple[str, ...] = ("advisory", "brokerage")
_IAM_REQUIRED_TABLES: tuple[str, ...] = (
    "actor_profiles",
    "ria_profiles",
    "ria_firms",
    "ria_firm_memberships",
    "ria_verification_events",
    "advisor_investor_relationships",
    "ria_client_invites",
    "consent_scope_templates",
    "marketplace_public_profiles",
    "relationship_share_grants",
    "relationship_share_events",
)
_RUNTIME_PERSONA_STATE_TABLE = "runtime_persona_state"
_TABLE_EXISTS_CACHE: dict[str, bool] = {}
_IAM_SCHEMA_READY_CACHE = False
_RELATIONSHIP_SHARE_ACTIVE_PICKS = "ria_active_picks_feed_v1"
_RELATIONSHIP_SHARE_ORIGIN_RELATIONSHIP_IMPLICIT = "relationship_implicit"
_RIA_PICKS_PKM_DOMAIN = "ria"
_RIA_PICKS_PKM_PATH = "advisor_package"
_PERSONA_STATE_CACHE_TTL = timedelta(seconds=30)
_PERSONA_STATE_CACHE: dict[str, tuple[datetime, dict[str, Any]]] = {}
_RIA_SCREENING_SECTION_ORDER: tuple[str, ...] = (
    "investable_requirements",
    "automatic_avoid_triggers",
    "the_math",
)
_RIA_KAI_SPECIALIZED_TEMPLATE_ID = "ria_kai_specialized_v1"
_RIA_KAI_SPECIALIZED_BUNDLE_KEY = "ria_kai_specialized"
_RIA_KAI_SPECIALIZED_LABEL = "Kai specialized access"
_RIA_KAI_SPECIALIZED_DESCRIPTION = (
    "Advisor-side Kai and explorer access for portfolio, profile, analysis history, "
    "and runtime context."
)
_RIA_KAI_SPECIALIZED_PRESENTATIONS: tuple[str, ...] = ("kai", "explorer")
_RIA_KAI_SPECIALIZED_SCOPES: tuple[str, ...] = (
    "attr.financial.portfolio.*",
    "attr.financial.profile.*",
    "attr.financial.analysis_history.*",
    "attr.financial.runtime.*",
)
_RIA_KAI_SPECIALIZED_SCOPE_SET = set(_RIA_KAI_SPECIALIZED_SCOPES)


class RIAIAMPolicyError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


class IAMSchemaNotReadyError(Exception):
    def __init__(
        self,
        message: str = (
            "IAM schema is not ready. Run `python db/migrate.py --iam` and "
            "`python scripts/verify_iam_schema.py`."
        ),
    ):
        super().__init__(message)
        self.code = "IAM_SCHEMA_NOT_READY"


@dataclass(frozen=True)
class ScopeTemplate:
    template_id: str
    requester_actor_type: ActorType
    subject_actor_type: ActorType
    template_name: str
    allowed_scopes: list[str]
    default_duration_hours: int
    max_duration_hours: int


class _PooledAsyncpgConnection:
    """Connection wrapper that keeps existing call sites (`await conn.close()`) unchanged."""

    def __init__(self, pool: asyncpg.Pool, connection: asyncpg.Connection) -> None:
        self._pool = pool
        self._connection = connection
        self._released = False

    async def close(self) -> None:
        if self._released:
            return
        self._released = True
        await self._pool.release(self._connection)

    def __getattr__(self, name: str):
        return getattr(self._connection, name)


class RIAIAMService:
    def __init__(self) -> None:
        self._verification_gateway = VerificationGateway(FinraVerificationAdapter())

    @staticmethod
    def _runtime_environment() -> str:
        for name in ("APP_ENV", "ENVIRONMENT", "HUSHH_ENV", "ENV"):
            value = str(os.getenv(name, "")).strip().lower()
            if value:
                return value
        return "development"

    @classmethod
    def _is_production_runtime(cls) -> bool:
        return cls._runtime_environment() in {"prod", "production"}

    @staticmethod
    def _search_matches(query: str | None, *values: str | None) -> bool:
        normalized_query = str(query or "").strip().lower()
        if not normalized_query:
            return True
        haystack = " ".join(
            str(value or "").strip().lower() for value in values if str(value or "").strip()
        )
        return normalized_query in haystack

    @staticmethod
    def _read_cached_persona_state(user_id: str) -> dict[str, Any] | None:
        normalized_user_id = str(user_id or "").strip()
        if not normalized_user_id:
            return None
        cached = _PERSONA_STATE_CACHE.get(normalized_user_id)
        if not cached:
            return None
        cached_at, payload = cached
        if datetime.now(timezone.utc) - cached_at > _PERSONA_STATE_CACHE_TTL:
            _PERSONA_STATE_CACHE.pop(normalized_user_id, None)
            return None
        return dict(payload)

    @staticmethod
    def _write_cached_persona_state(user_id: str, payload: dict[str, Any]) -> None:
        normalized_user_id = str(user_id or "").strip()
        if not normalized_user_id:
            return
        _PERSONA_STATE_CACHE[normalized_user_id] = (
            datetime.now(timezone.utc),
            dict(payload),
        )

    @staticmethod
    def _invalidate_cached_persona_state(user_id: str) -> None:
        normalized_user_id = str(user_id or "").strip()
        if normalized_user_id:
            _PERSONA_STATE_CACHE.pop(normalized_user_id, None)

    @staticmethod
    def _env_truthy(name: str, fallback: str = "false") -> bool:
        raw = str(os.getenv(name, fallback)).strip().lower()
        return raw in {"1", "true", "yes", "on"}

    def _is_ria_dev_bypass_enabled(self) -> bool:
        if not self._env_truthy("RIA_DEV_BYPASS_ENABLED"):
            return False
        return self._runtime_environment() not in {"prod", "production"}

    def _is_dev_bypass_allowed(self, user_id: str) -> bool:
        _ = user_id
        return self._is_ria_dev_bypass_enabled()

    @staticmethod
    def _normalize_persona(value: str) -> PersonaType:
        normalized = (value or "").strip().lower()
        if normalized not in _ALLOWED_PERSONAS:
            raise RIAIAMPolicyError("Invalid persona", status_code=400)
        return normalized  # type: ignore[return-value]

    @staticmethod
    def _normalize_actor(value: str) -> ActorType:
        normalized = (value or "").strip().lower()
        if normalized not in _ALLOWED_ACTOR_TYPES:
            raise RIAIAMPolicyError("Invalid actor type", status_code=400)
        return normalized  # type: ignore[return-value]

    @staticmethod
    def _now_ms() -> int:
        return int(datetime.now(tz=timezone.utc).timestamp() * 1000)

    @staticmethod
    def _normalize_search_query(value: str | None) -> str:
        return str(value or "").strip().lower()

    @classmethod
    def _matches_search(cls, item: dict[str, Any], query: str | None) -> bool:
        needle = cls._normalize_search_query(query)
        if not needle:
            return True
        haystacks = [
            item.get("investor_display_name"),
            item.get("investor_email"),
            item.get("investor_secondary_label"),
            item.get("investor_headline"),
            item.get("status"),
            item.get("relationship_status"),
            item.get("next_action"),
        ]
        return any(needle in str(value or "").lower() for value in haystacks)

    @staticmethod
    def _normalize_client_status_filter(value: str | None) -> str | None:
        normalized = str(value or "").strip().lower()
        return normalized or None

    async def _conn(self) -> asyncpg.Connection:
        pool = await get_pool()
        connection = await pool.acquire()
        return _PooledAsyncpgConnection(pool, connection)

    @staticmethod
    async def _table_exists(conn: asyncpg.Connection, table_name: str) -> bool:
        if _TABLE_EXISTS_CACHE.get(table_name):
            return True
        exists = bool(await conn.fetchval("SELECT to_regclass($1)", f"public.{table_name}"))
        if exists:
            _TABLE_EXISTS_CACHE[table_name] = True
        return exists

    async def _investor_identity_projection(
        self,
        conn: asyncpg.Connection,
        *,
        user_id_sql: str,
        marketplace_alias: str = "mp",
    ) -> tuple[str, str]:
        if await self._table_exists(conn, "actor_identity_cache"):
            return (
                f"""
                COALESCE(aic.display_name, {marketplace_alias}.display_name, {user_id_sql}) AS investor_display_name,
                aic.email AS investor_email,
                COALESCE(aic.email, {marketplace_alias}.headline) AS investor_secondary_label,
                {marketplace_alias}.headline AS investor_headline
                """.strip(),
                f"""
                LEFT JOIN actor_identity_cache aic
                  ON aic.user_id = {user_id_sql}
                """.strip(),
            )
        return (
            f"""
            COALESCE({marketplace_alias}.display_name, {user_id_sql}) AS investor_display_name,
            NULL::TEXT AS investor_email,
            {marketplace_alias}.headline AS investor_secondary_label,
            {marketplace_alias}.headline AS investor_headline
            """.strip(),
            "",
        )

    async def _is_iam_schema_ready(self, conn: asyncpg.Connection) -> bool:
        global _IAM_SCHEMA_READY_CACHE
        if _IAM_SCHEMA_READY_CACHE:
            return True
        for table_name in _IAM_REQUIRED_TABLES:
            if not await self._table_exists(conn, table_name):
                return False
        _IAM_SCHEMA_READY_CACHE = True
        return True

    async def _ensure_iam_schema_ready(self, conn: asyncpg.Connection) -> None:
        if not await self._is_iam_schema_ready(conn):
            raise IAMSchemaNotReadyError()

    @staticmethod
    def _persona_response(
        *,
        user_id: str,
        personas: list[str],
        last_active_persona: str,
        investor_marketplace_opt_in: bool,
        iam_schema_ready: bool,
        mode: Literal["full", "compat_investor"],
        dev_ria_bypass_allowed: bool = False,
    ) -> dict[str, Any]:
        safe_personas = [persona for persona in personas if persona in _ALLOWED_PERSONAS]
        if not safe_personas:
            safe_personas = ["investor"]
        ria_switch_available = bool(iam_schema_ready and "ria" in safe_personas)
        ria_setup_available = bool(iam_schema_ready and not ria_switch_available)
        safe_last = last_active_persona if last_active_persona in _ALLOWED_PERSONAS else "investor"
        if safe_last == "ria" and not (ria_switch_available or ria_setup_available):
            safe_last = "investor"
        if safe_last == "investor" and "investor" not in safe_personas:
            safe_last = safe_personas[0]
        return {
            "user_id": user_id,
            "personas": safe_personas,
            "last_active_persona": safe_last,
            "active_persona": safe_last,
            "primary_nav_persona": safe_last,
            "ria_setup_available": ria_setup_available,
            "ria_switch_available": ria_switch_available,
            "dev_ria_bypass_allowed": bool(dev_ria_bypass_allowed and iam_schema_ready),
            "investor_marketplace_opt_in": bool(investor_marketplace_opt_in),
            "iam_schema_ready": iam_schema_ready,
            "mode": mode,
        }

    @staticmethod
    def _resolve_full_mode_last_persona(
        *,
        personas: list[str],
        actor_last_persona: str,
        runtime_last_persona: str,
    ) -> PersonaType:
        safe_personas = [persona for persona in personas if persona in _ALLOWED_PERSONAS]
        if not safe_personas:
            safe_personas = ["investor"]

        # `actor_profiles` is the canonical persisted persona state. The runtime table
        # remains only as transitional compatibility for the "same account, entering
        # RIA setup" path before the actor has earned the real `ria` persona.
        if actor_last_persona in safe_personas:
            if (
                actor_last_persona == "investor"
                and "ria" not in safe_personas
                and runtime_last_persona == "ria"
            ):
                return "ria"
            return actor_last_persona  # type: ignore[return-value]

        if "ria" not in safe_personas and runtime_last_persona == "ria":
            return "ria"

        if "investor" in safe_personas:
            return "investor"
        return safe_personas[0]  # type: ignore[return-value]

    @staticmethod
    def _normalize_optional_text(value: str | None) -> str | None:
        normalized = (value or "").strip()
        return normalized or None

    @staticmethod
    def _normalize_legacy_verification_status(status: str | None) -> str:
        normalized = (status or "").strip().lower()
        if normalized == "finra_verified":
            return "verified"
        if normalized in {"draft", "submitted", "verified", "active", "rejected", "bypassed"}:
            return normalized
        return "draft"

    @staticmethod
    def _is_verified_ria_status(status: str | None) -> bool:
        return RIAIAMService._normalize_legacy_verification_status(status) in {
            "verified",
            "active",
            "bypassed",
        }

    @staticmethod
    def _verification_provider_label(result: VerificationResult) -> str:
        provider = str((result.metadata or {}).get("provider") or "").strip().lower()
        if provider in {"ria_intelligence", "iapd", "dev_allowlist", "advisory_bypass"}:
            return provider
        return "regulatory_verification"

    @staticmethod
    def _prepare_professional_onboarding_inputs(
        *,
        display_name: str,
        requested_capabilities: list[str] | tuple[str, ...],
        individual_legal_name: str | None,
        individual_crd: str | None,
        advisory_firm_legal_name: str | None,
        advisory_firm_iapd_number: str | None,
        broker_firm_legal_name: str | None,
        broker_firm_crd: str | None,
        bio: str | None,
        strategy: str | None,
        disclosures_url: str | None,
        require_regulatory_identity: bool,
    ) -> dict[str, Any]:
        normalized_display_name = (display_name or "").strip()
        if not normalized_display_name:
            raise RIAIAMPolicyError("display_name is required", status_code=400)

        normalized_capabilities: list[str] = []
        for capability in requested_capabilities or []:
            candidate = str(capability or "").strip().lower()
            if not candidate:
                continue
            if candidate not in _ALLOWED_PROFESSIONAL_CAPABILITIES:
                raise RIAIAMPolicyError(
                    "requested_capabilities contains unsupported capability",
                    status_code=400,
                )
            if candidate not in normalized_capabilities:
                normalized_capabilities.append(candidate)

        if not normalized_capabilities:
            raise RIAIAMPolicyError(
                "requested_capabilities must include at least one capability",
                status_code=400,
            )

        normalized_individual_legal_name = RIAIAMService._normalize_optional_text(
            individual_legal_name
        )
        normalized_individual_crd = RIAIAMService._normalize_optional_text(individual_crd)
        normalized_advisory_firm_legal_name = RIAIAMService._normalize_optional_text(
            advisory_firm_legal_name
        )
        normalized_advisory_firm_iapd_number = RIAIAMService._normalize_optional_text(
            advisory_firm_iapd_number
        )
        normalized_broker_firm_legal_name = RIAIAMService._normalize_optional_text(
            broker_firm_legal_name
        )
        normalized_broker_firm_crd = RIAIAMService._normalize_optional_text(broker_firm_crd)

        if require_regulatory_identity:
            if not normalized_individual_legal_name:
                raise RIAIAMPolicyError(
                    "individual_legal_name is required for regulatory verification",
                    status_code=400,
                )
            if not normalized_individual_crd:
                raise RIAIAMPolicyError(
                    "individual_crd is required for regulatory verification",
                    status_code=400,
                )

        if "advisory" in normalized_capabilities:
            if not normalized_advisory_firm_legal_name:
                raise RIAIAMPolicyError(
                    "advisory_firm_legal_name is required when advisory capability is requested",
                    status_code=400,
                )
            if not normalized_advisory_firm_iapd_number:
                raise RIAIAMPolicyError(
                    "advisory_firm_iapd_number is required when advisory capability is requested",
                    status_code=400,
                )

        if "brokerage" in normalized_capabilities:
            if not normalized_broker_firm_legal_name:
                raise RIAIAMPolicyError(
                    "broker_firm_legal_name is required when brokerage capability is requested",
                    status_code=400,
                )
            if not normalized_broker_firm_crd:
                raise RIAIAMPolicyError(
                    "broker_firm_crd is required when brokerage capability is requested",
                    status_code=400,
                )

        return {
            "display_name": normalized_display_name,
            "requested_capabilities": normalized_capabilities,
            "individual_legal_name": normalized_individual_legal_name,
            "individual_crd": normalized_individual_crd,
            "advisory_firm_legal_name": normalized_advisory_firm_legal_name,
            "advisory_firm_iapd_number": normalized_advisory_firm_iapd_number,
            "broker_firm_legal_name": normalized_broker_firm_legal_name,
            "broker_firm_crd": normalized_broker_firm_crd,
            "bio": RIAIAMService._normalize_optional_text(bio),
            "strategy": RIAIAMService._normalize_optional_text(strategy),
            "disclosures_url": RIAIAMService._normalize_optional_text(disclosures_url),
            "require_regulatory_identity": bool(require_regulatory_identity),
        }

    @staticmethod
    def _advisory_status_from_row(row: Any) -> str:
        if isinstance(row, dict):
            status = row.get("verification_status")
        else:
            try:
                status = row["verification_status"]
            except (KeyError, TypeError):
                status = None
        return RIAIAMService._normalize_legacy_verification_status(
            str(status) if status is not None else None
        )

    @staticmethod
    def _brokerage_status_from_row(row: Any) -> str:
        _ = row
        return "draft"

    async def _runtime_persona_table_ready(self, conn: asyncpg.Connection) -> bool:
        return await self._table_exists(conn, _RUNTIME_PERSONA_STATE_TABLE)

    async def _get_runtime_last_persona(
        self,
        conn: asyncpg.Connection,
        user_id: str,
    ) -> str:
        if not await self._runtime_persona_table_ready(conn):
            return "investor"
        row = await conn.fetchrow(
            """
            SELECT last_active_persona
            FROM runtime_persona_state
            WHERE user_id = $1
            """,
            user_id,
        )
        if row is None:
            return "investor"
        candidate = str(row["last_active_persona"] or "").strip().lower()
        return candidate if candidate in _ALLOWED_PERSONAS else "investor"

    async def _set_runtime_last_persona(
        self,
        conn: asyncpg.Connection,
        user_id: str,
        persona: str,
    ) -> None:
        normalized = self._normalize_persona(persona)
        if not await self._runtime_persona_table_ready(conn):
            return
        await conn.execute(
            """
            INSERT INTO runtime_persona_state (user_id, last_active_persona)
            VALUES ($1, $2)
            ON CONFLICT (user_id) DO UPDATE
            SET
              last_active_persona = $2,
              updated_at = NOW()
            """,
            user_id,
            normalized,
        )

    async def _ensure_vault_user_row(self, conn: asyncpg.Connection, user_id: str) -> None:
        now_ms = self._now_ms()
        await conn.execute(
            """
            INSERT INTO vault_keys (
                user_id,
                vault_status,
                vault_key_hash,
                primary_method,
                primary_wrapper_id,
                recovery_encrypted_vault_key,
                recovery_salt,
                recovery_iv,
                first_login_at,
                last_login_at,
                login_count,
                created_at,
                updated_at
            )
            VALUES (
                $1,
                'placeholder',
                NULL,
                'passphrase',
                'default',
                NULL,
                NULL,
                NULL,
                $2,
                $2,
                1,
                $2,
                $2
            )
            ON CONFLICT (user_id) DO NOTHING
            """,
            user_id,
            now_ms,
        )

    async def _ensure_actor_profile_row(
        self,
        conn: asyncpg.Connection,
        user_id: str,
        *,
        include_ria_persona: bool = False,
    ) -> asyncpg.Record:
        personas = ["investor", "ria"] if include_ria_persona else ["investor"]
        last_active_persona = "ria" if include_ria_persona else "investor"
        row = await conn.fetchrow(
            """
            INSERT INTO actor_profiles (
                user_id,
                personas,
                last_active_persona,
                investor_marketplace_opt_in
            )
            VALUES ($1, $2::text[], $3, FALSE)
            ON CONFLICT (user_id) DO UPDATE
            SET
              personas = CASE
                WHEN $4::boolean = TRUE AND NOT ('ria' = ANY(actor_profiles.personas))
                  THEN array_append(actor_profiles.personas, 'ria')
                ELSE actor_profiles.personas
              END,
              last_active_persona = CASE
                WHEN $4::boolean = TRUE THEN 'ria'
                ELSE actor_profiles.last_active_persona
              END,
              updated_at = NOW()
            RETURNING user_id, personas, last_active_persona, investor_marketplace_opt_in
            """,
            user_id,
            personas,
            last_active_persona,
            include_ria_persona,
        )
        if row is None:
            raise RuntimeError("Failed to ensure actor profile row")
        return row

    async def ensure_actor_profile(self, user_id: str) -> dict[str, Any]:
        conn = await self._conn()
        try:
            async with conn.transaction():
                await self._ensure_vault_user_row(conn, user_id)
                await self._ensure_iam_schema_ready(conn)
                row = await self._ensure_actor_profile_row(conn, user_id)
                return dict(row)
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            self._invalidate_cached_persona_state(user_id)
            await conn.close()

    async def get_persona_state(self, user_id: str) -> dict[str, Any]:
        cached = self._read_cached_persona_state(user_id)
        if cached is not None:
            return cached
        conn = await self._conn()
        try:
            async with conn.transaction():
                await self._ensure_vault_user_row(conn, user_id)
                schema_ready = await self._is_iam_schema_ready(conn)
                if not schema_ready:
                    # Compatibility mode: preserve investor continuity while IAM schema is unavailable.
                    last_persona = await self._get_runtime_last_persona(conn, user_id)
                    safe_last = "investor" if last_persona == "ria" else last_persona
                    await self._set_runtime_last_persona(conn, user_id, safe_last)
                    response = self._persona_response(
                        user_id=user_id,
                        personas=["investor"],
                        last_active_persona=safe_last,
                        investor_marketplace_opt_in=False,
                        iam_schema_ready=False,
                        mode="compat_investor",
                        dev_ria_bypass_allowed=False,
                    )
                    self._write_cached_persona_state(user_id, response)
                    return response

                row = await self._ensure_actor_profile_row(conn, user_id)
                actor_last_persona = self._normalize_persona(str(row["last_active_persona"]))
                runtime_last_persona = await self._get_runtime_last_persona(conn, user_id)
                effective_last_persona = self._resolve_full_mode_last_persona(
                    personas=list(row["personas"] or []),
                    actor_last_persona=actor_last_persona,
                    runtime_last_persona=runtime_last_persona,
                )
                await self._set_runtime_last_persona(
                    conn,
                    user_id,
                    effective_last_persona,
                )
                response = self._persona_response(
                    user_id=str(row["user_id"]),
                    personas=list(row["personas"] or []),
                    last_active_persona=effective_last_persona,
                    investor_marketplace_opt_in=bool(row["investor_marketplace_opt_in"]),
                    iam_schema_ready=True,
                    mode="full",
                    dev_ria_bypass_allowed=self._is_dev_bypass_allowed(user_id),
                )
                self._write_cached_persona_state(user_id, response)
                return response
        except asyncpg.exceptions.UndefinedTableError as exc:
            logger.warning("iam.schema_not_ready fallback user_id=%s", user_id)
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()

    async def switch_persona(self, user_id: str, persona: str) -> dict[str, Any]:
        target = self._normalize_persona(persona)
        conn = await self._conn()
        try:
            async with conn.transaction():
                await self._ensure_vault_user_row(conn, user_id)
                schema_ready = await self._is_iam_schema_ready(conn)
                if not schema_ready:
                    if target != "investor":
                        raise IAMSchemaNotReadyError(
                            "RIA persona is unavailable until IAM schema migration is applied."
                        )
                    await self._set_runtime_last_persona(conn, user_id, "investor")
                    response = self._persona_response(
                        user_id=user_id,
                        personas=["investor"],
                        last_active_persona="investor",
                        investor_marketplace_opt_in=False,
                        iam_schema_ready=False,
                        mode="compat_investor",
                        dev_ria_bypass_allowed=False,
                    )
                    self._write_cached_persona_state(user_id, response)
                    return response
                current = await self._ensure_actor_profile_row(conn, user_id)
                current_personas = list(current["personas"] or [])

                if target == "ria" and "ria" not in current_personas:
                    await self._set_runtime_last_persona(conn, user_id, "ria")
                    response = self._persona_response(
                        user_id=str(current["user_id"]),
                        personas=current_personas,
                        last_active_persona="ria",
                        investor_marketplace_opt_in=bool(current["investor_marketplace_opt_in"]),
                        iam_schema_ready=True,
                        mode="full",
                        dev_ria_bypass_allowed=self._is_dev_bypass_allowed(user_id),
                    )
                    self._write_cached_persona_state(user_id, response)
                    return response

                row = await conn.fetchrow(
                    """
                    UPDATE actor_profiles
                    SET
                      last_active_persona = $2,
                      updated_at = NOW()
                    WHERE user_id = $1
                    RETURNING user_id, personas, last_active_persona, investor_marketplace_opt_in
                    """,
                    user_id,
                    target,
                )
                if row is None:
                    raise RuntimeError("Failed to switch persona")
                await self._set_runtime_last_persona(
                    conn,
                    user_id,
                    str(row["last_active_persona"]),
                )
                response = self._persona_response(
                    user_id=str(row["user_id"]),
                    personas=list(row["personas"] or []),
                    last_active_persona=str(row["last_active_persona"]),
                    investor_marketplace_opt_in=bool(row["investor_marketplace_opt_in"]),
                    iam_schema_ready=True,
                    mode="full",
                    dev_ria_bypass_allowed=self._is_dev_bypass_allowed(user_id),
                )
                self._write_cached_persona_state(user_id, response)
                return response
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            self._invalidate_cached_persona_state(user_id)
            await conn.close()

    async def set_marketplace_opt_in(self, user_id: str, enabled: bool) -> dict[str, Any]:
        conn = await self._conn()
        try:
            async with conn.transaction():
                await self._ensure_vault_user_row(conn, user_id)
                await self._ensure_iam_schema_ready(conn)
                profile = await conn.fetchrow(
                    """
                    INSERT INTO actor_profiles (
                        user_id,
                        personas,
                        last_active_persona,
                        investor_marketplace_opt_in
                    )
                    VALUES ($1, ARRAY['investor']::text[], 'investor', $2)
                    ON CONFLICT (user_id) DO UPDATE
                    SET
                      investor_marketplace_opt_in = $2,
                      updated_at = NOW()
                    RETURNING user_id, investor_marketplace_opt_in
                    """,
                    user_id,
                    enabled,
                )
                if profile is None:
                    raise RuntimeError("Failed to update marketplace opt-in")

                await conn.execute(
                    """
                    INSERT INTO marketplace_public_profiles (
                        user_id,
                        profile_type,
                        display_name,
                        is_discoverable,
                        updated_at
                    )
                    VALUES ($1, 'investor', $3, $2, NOW())
                    ON CONFLICT (user_id) DO UPDATE
                    SET
                      profile_type = 'investor',
                      is_discoverable = $2,
                      updated_at = NOW()
                    """,
                    user_id,
                    enabled,
                    f"Investor {user_id[:8]}",
                )
                return {
                    "user_id": profile["user_id"],
                    "investor_marketplace_opt_in": bool(profile["investor_marketplace_opt_in"]),
                }
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            self._invalidate_cached_persona_state(user_id)
            await conn.close()

    async def _load_scope_template(
        self,
        conn: asyncpg.Connection,
        template_id: str,
    ) -> ScopeTemplate:
        if template_id == _RIA_KAI_SPECIALIZED_TEMPLATE_ID:
            return self._kai_specialized_template()
        row = await conn.fetchrow(
            """
            SELECT
              template_id,
              requester_actor_type,
              subject_actor_type,
              template_name,
              allowed_scopes,
              default_duration_hours,
              max_duration_hours
            FROM consent_scope_templates
            WHERE template_id = $1 AND active = TRUE
            """,
            template_id,
        )
        if row is None:
            raise RIAIAMPolicyError("Unknown scope template", status_code=404)
        return ScopeTemplate(
            template_id=str(row["template_id"]),
            requester_actor_type=self._normalize_actor(str(row["requester_actor_type"])),
            subject_actor_type=self._normalize_actor(str(row["subject_actor_type"])),
            template_name=str(row["template_name"]),
            allowed_scopes=self._canonicalize_scope_aliases(list(row["allowed_scopes"] or [])),
            default_duration_hours=int(row["default_duration_hours"]),
            max_duration_hours=int(row["max_duration_hours"]),
        )

    @staticmethod
    def _canonicalize_scope_alias(scope: str | None) -> str:
        normalized = str(scope or "").strip()
        if normalized == "world_model.read":
            return "pkm.read"
        if normalized == "world_model.write":
            return "pkm.write"
        return normalized

    @classmethod
    def _canonicalize_scope_aliases(cls, scopes: list[str] | tuple[str, ...] | None) -> list[str]:
        return [
            canonical
            for canonical in (cls._canonicalize_scope_alias(scope) for scope in list(scopes or []))
            if canonical
        ]

    @staticmethod
    def _parse_metadata(value: Any) -> dict[str, Any]:
        if value is None:
            return {}
        if isinstance(value, dict):
            return value
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                return {}
        return {}

    @staticmethod
    def _merge_metadata(base: Any, patch: dict[str, Any]) -> dict[str, Any]:
        metadata = RIAIAMService._parse_metadata(base)
        metadata.update(patch)
        return metadata

    @staticmethod
    def _parse_string_list(value: Any) -> list[str]:
        if value is None:
            return []
        if isinstance(value, (list, tuple, set)):
            return [str(item).strip() for item in value if str(item).strip()]
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
                if isinstance(parsed, list):
                    return [str(item).strip() for item in parsed if str(item).strip()]
            except Exception:
                pass
            return [part.strip() for part in value.split(",") if part.strip()]
        return []

    @staticmethod
    def _next_action_for_relationship_status(status: str) -> str:
        normalized = (status or "").strip().lower()
        if normalized == "approved":
            return "open_workspace"
        if normalized == "request_pending":
            return "await_consent"
        if normalized in {"revoked", "expired"}:
            return "re_request"
        if normalized == "blocked":
            return "resolve_block"
            return "request_access"

    @staticmethod
    def _relationship_share_descriptor(grant_key: str) -> dict[str, str]:
        normalized = str(grant_key or "").strip()
        if normalized == _RELATIONSHIP_SHARE_ACTIVE_PICKS:
            return {
                "grant_key": normalized,
                "label": "Advisor picks feed",
                "description": (
                    "Included with the advisor relationship so Kai can surface the advisor's "
                    "active picks list to the investor."
                ),
            }
        return {
            "grant_key": normalized,
            "label": normalized.replace("_", " ") or "Relationship share",
            "description": "Relationship-scoped shared content.",
        }

    @classmethod
    def _relationship_share_summary(cls, grant_key: str) -> str:
        descriptor = cls._relationship_share_descriptor(grant_key)
        return descriptor["description"]

    @staticmethod
    def _relationship_share_origin(metadata: Any) -> str:
        parsed = RIAIAMService._parse_metadata(metadata)
        origin = str(
            parsed.get("share_origin") or _RELATIONSHIP_SHARE_ORIGIN_RELATIONSHIP_IMPLICIT
        ).strip()
        return origin or _RELATIONSHIP_SHARE_ORIGIN_RELATIONSHIP_IMPLICIT

    @staticmethod
    def _serialize_datetime_value(value: Any) -> str | None:
        if value is None:
            return None
        if isinstance(value, datetime):
            return value.isoformat()
        normalized = str(value).strip()
        return normalized or None

    @classmethod
    def _serialize_relationship_share(
        cls,
        row: Any,
        *,
        has_active_pick_upload: bool = False,
    ) -> dict[str, Any]:
        if not row:
            return {}
        if isinstance(row, dict):
            payload = row
        else:
            payload = dict(row)
        grant_key = str(payload.get("grant_key") or "").strip()
        descriptor = cls._relationship_share_descriptor(grant_key)
        return {
            **descriptor,
            "status": str(payload.get("status") or "").strip() or "unavailable",
            "share_origin": cls._relationship_share_origin(payload.get("metadata")),
            "granted_at": cls._serialize_datetime_value(payload.get("granted_at")),
            "revoked_at": cls._serialize_datetime_value(payload.get("revoked_at")),
            "has_active_pick_upload": bool(has_active_pick_upload),
        }

    @classmethod
    def _picks_feed_status(
        cls,
        *,
        relationship_status: str,
        share_status: str | None,
        has_active_pick_upload: bool,
    ) -> str:
        normalized_relationship = str(relationship_status or "").strip().lower()
        normalized_share = str(share_status or "").strip().lower()
        if normalized_relationship in {"request_pending", "discovered", "invited"}:
            return "included_on_approval"
        if normalized_relationship != "approved":
            return "unavailable"
        if normalized_share != "active":
            return "unavailable"
        return "ready" if has_active_pick_upload else "pending"

    @classmethod
    def _implicit_picks_relationship_share_metadata(
        cls,
        *,
        source: str,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        merged = dict(metadata or {})
        merged.setdefault("share_origin", _RELATIONSHIP_SHARE_ORIGIN_RELATIONSHIP_IMPLICIT)
        merged["source"] = source
        return merged

    async def _get_relationship_share(
        self,
        conn: asyncpg.Connection,
        *,
        relationship_id: str,
        grant_key: str,
    ) -> asyncpg.Record | None:
        return await conn.fetchrow(
            """
            SELECT
              id,
              relationship_id,
              grant_key,
              provider_user_id,
              receiver_user_id,
              status,
              granted_at,
              revoked_at,
              metadata,
              created_at,
              updated_at
            FROM relationship_share_grants
            WHERE relationship_id = $1::uuid
              AND grant_key = $2
            LIMIT 1
            """,
            relationship_id,
            grant_key,
        )

    async def _insert_relationship_share_event(
        self,
        conn: asyncpg.Connection,
        *,
        share_grant_id: str,
        relationship_id: str,
        grant_key: str,
        event_type: str,
        provider_user_id: str,
        receiver_user_id: str,
        metadata: dict[str, Any] | None = None,
        created_at: datetime | None = None,
    ) -> None:
        await conn.execute(
            """
            INSERT INTO relationship_share_events (
              share_grant_id,
              relationship_id,
              grant_key,
              event_type,
              provider_user_id,
              receiver_user_id,
              metadata,
              created_at
            )
            VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, COALESCE($8, NOW()))
            """,
            share_grant_id,
            relationship_id,
            grant_key,
            event_type,
            provider_user_id,
            receiver_user_id,
            json.dumps(metadata or {}),
            created_at,
        )

    async def _materialize_relationship_share_grant(
        self,
        conn: asyncpg.Connection,
        *,
        relationship_id: str,
        provider_user_id: str,
        receiver_user_id: str,
        grant_key: str,
        metadata: dict[str, Any] | None = None,
        activate_at: datetime | None = None,
    ) -> dict[str, Any]:
        existing = await self._get_relationship_share(
            conn,
            relationship_id=relationship_id,
            grant_key=grant_key,
        )
        merged_metadata = self._implicit_picks_relationship_share_metadata(
            source=str((metadata or {}).get("source") or "relationship_sync"),
            metadata=metadata,
        )
        if existing is None:
            row = await conn.fetchrow(
                """
                INSERT INTO relationship_share_grants (
                  relationship_id,
                  grant_key,
                  provider_user_id,
                  receiver_user_id,
                  status,
                  granted_at,
                  revoked_at,
                  metadata,
                  created_at,
                  updated_at
                )
                VALUES (
                  $1::uuid,
                  $2,
                  $3,
                  $4,
                  'active',
                  COALESCE($5, NOW()),
                  NULL,
                  $6::jsonb,
                  NOW(),
                  NOW()
                )
                RETURNING *
                """,
                relationship_id,
                grant_key,
                provider_user_id,
                receiver_user_id,
                activate_at,
                json.dumps(merged_metadata),
            )
            await self._insert_relationship_share_event(
                conn,
                share_grant_id=str(row["id"]),
                relationship_id=str(row["relationship_id"]),
                grant_key=grant_key,
                event_type="GRANTED",
                provider_user_id=provider_user_id,
                receiver_user_id=receiver_user_id,
                metadata=merged_metadata,
                created_at=row["granted_at"],
            )
            if grant_key == _RELATIONSHIP_SHARE_ACTIVE_PICKS:
                await self._bootstrap_pick_share_artifact(
                    conn,
                    relationship_id=str(row["relationship_id"]),
                    provider_user_id=provider_user_id,
                    receiver_user_id=receiver_user_id,
                )
            return dict(row)

        existing_status = str(existing["status"] or "").strip().lower()
        row = await conn.fetchrow(
            """
            UPDATE relationship_share_grants
            SET
              provider_user_id = $2,
              receiver_user_id = $3,
              status = 'active',
              granted_at = COALESCE(granted_at, $4, NOW()),
              revoked_at = NULL,
              metadata = $5::jsonb,
              updated_at = NOW()
            WHERE id = $1::uuid
            RETURNING *
            """,
            str(existing["id"]),
            provider_user_id,
            receiver_user_id,
            activate_at,
            json.dumps(merged_metadata),
        )
        if existing_status != "active":
            await self._insert_relationship_share_event(
                conn,
                share_grant_id=str(row["id"]),
                relationship_id=str(row["relationship_id"]),
                grant_key=grant_key,
                event_type="GRANTED",
                provider_user_id=provider_user_id,
                receiver_user_id=receiver_user_id,
                metadata=merged_metadata,
                created_at=activate_at or row["updated_at"],
            )
        if grant_key == _RELATIONSHIP_SHARE_ACTIVE_PICKS:
            await self._bootstrap_pick_share_artifact(
                conn,
                relationship_id=str(row["relationship_id"]),
                provider_user_id=provider_user_id,
                receiver_user_id=receiver_user_id,
            )
        return dict(row)

    async def _revoke_relationship_share_grant(
        self,
        conn: asyncpg.Connection,
        *,
        relationship_id: str,
        grant_key: str,
        status: Literal["revoked", "expired"],
        reason: str,
    ) -> None:
        existing = await self._get_relationship_share(
            conn,
            relationship_id=relationship_id,
            grant_key=grant_key,
        )
        if existing is None:
            return

        current_status = str(existing["status"] or "").strip().lower()
        if current_status == status:
            return
        if current_status not in {"active", "revoked", "expired"}:
            return

        next_metadata = self._merge_metadata(
            existing["metadata"],
            {"last_transition_reason": reason},
        )
        row = await conn.fetchrow(
            """
            UPDATE relationship_share_grants
            SET
              status = $2,
              revoked_at = NOW(),
              metadata = $3::jsonb,
              updated_at = NOW()
            WHERE id = $1::uuid
            RETURNING *
            """,
            str(existing["id"]),
            status,
            json.dumps(next_metadata),
        )
        if grant_key == _RELATIONSHIP_SHARE_ACTIVE_PICKS:
            await conn.execute(
                """
                UPDATE ria_pick_share_artifacts
                SET
                  status = $2,
                  updated_at = NOW()
                WHERE relationship_id = $1::uuid
                  AND grant_key = $3
                """,
                relationship_id,
                status,
                grant_key,
            )
        event_type = "EXPIRED" if status == "expired" else "REVOKED"
        await self._insert_relationship_share_event(
            conn,
            share_grant_id=str(row["id"]),
            relationship_id=str(row["relationship_id"]),
            grant_key=grant_key,
            event_type=event_type,
            provider_user_id=str(row["provider_user_id"]),
            receiver_user_id=str(row["receiver_user_id"]),
            metadata={"reason": reason},
            created_at=row["revoked_at"],
        )

    @staticmethod
    def _resolve_duration_hours(
        template: ScopeTemplate,
        *,
        duration_mode: str,
        duration_hours: int | None,
    ) -> tuple[str, int]:
        mode = (duration_mode or "preset").strip().lower()
        resolved_duration_hours: int
        if mode == "preset":
            resolved_duration_hours = int(duration_hours or template.default_duration_hours)
            if resolved_duration_hours not in _DURATION_PRESETS_HOURS:
                raise RIAIAMPolicyError("Invalid preset duration", status_code=400)
        elif mode == "custom":
            if duration_hours is None:
                raise RIAIAMPolicyError(
                    "duration_hours is required for custom mode", status_code=400
                )
            resolved_duration_hours = int(duration_hours)
            if resolved_duration_hours <= 0:
                raise RIAIAMPolicyError("duration_hours must be positive", status_code=400)
            cap = min(template.max_duration_hours, _MAX_DURATION_HOURS)
            if resolved_duration_hours > cap:
                raise RIAIAMPolicyError("duration exceeds allowed cap", status_code=400)
        else:
            raise RIAIAMPolicyError("Invalid duration_mode", status_code=400)
        return mode, resolved_duration_hours

    @staticmethod
    def _scope_metadata(scope: str) -> dict[str, Any]:
        normalized_scope = str(scope or "").strip()
        is_kai_specialized = normalized_scope in _RIA_KAI_SPECIALIZED_SCOPE_SET
        return {
            "scope": normalized_scope,
            "label": get_scope_description(normalized_scope),
            "description": get_scope_description(normalized_scope),
            "kind": "pkm"
            if normalized_scope == "pkm.read"
            else "kai_specialized"
            if is_kai_specialized
            else "portfolio_domain"
            if normalized_scope.startswith("attr.financial.")
            else "profile_domain",
            "summary_only": normalized_scope not in {"pkm.read", *_RIA_KAI_SPECIALIZED_SCOPES},
        }

    @classmethod
    def _build_available_scope_metadata(
        cls,
        *,
        available_domains: list[str],
        total_attributes: int,
    ) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        normalized_domains = sorted(
            {
                str(domain or "").strip()
                for domain in list(available_domains or [])
                if str(domain or "").strip()
            }
        )

        if total_attributes > 0 or normalized_domains:
            items.append(
                {
                    **cls._scope_metadata("pkm.read"),
                    "available": True,
                    "domain_key": None,
                }
            )

        for domain_key in normalized_domains:
            scope = f"attr.{domain_key}.*"
            items.append(
                {
                    **cls._scope_metadata(scope),
                    "available": True,
                    "domain_key": domain_key,
                }
            )
            if domain_key == "financial":
                for specialized_scope in _RIA_KAI_SPECIALIZED_SCOPES:
                    items.append(
                        {
                            **cls._scope_metadata(specialized_scope),
                            "available": True,
                            "domain_key": domain_key,
                            "bundle_key": _RIA_KAI_SPECIALIZED_BUNDLE_KEY,
                            "presentations": list(_RIA_KAI_SPECIALIZED_PRESENTATIONS),
                            "requires_account_selection": True,
                        }
                    )

        return items

    @staticmethod
    def _normalize_account_ids(values: Any) -> list[str]:
        if not isinstance(values, list):
            return []
        out: list[str] = []
        seen: set[str] = set()
        for value in values:
            cleaned = str(value or "").strip()
            if not cleaned or cleaned in seen:
                continue
            seen.add(cleaned)
            out.append(cleaned)
        return out

    @classmethod
    def _kai_specialized_template(cls) -> ScopeTemplate:
        return ScopeTemplate(
            template_id=_RIA_KAI_SPECIALIZED_TEMPLATE_ID,
            requester_actor_type="ria",
            subject_actor_type="investor",
            template_name=_RIA_KAI_SPECIALIZED_LABEL,
            allowed_scopes=list(_RIA_KAI_SPECIALIZED_SCOPES),
            default_duration_hours=24 * 7,
            max_duration_hours=24 * 365,
        )

    @staticmethod
    def _parse_list_of_dicts(value: Any) -> list[dict[str, Any]]:
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
            except Exception:
                return []
            if isinstance(parsed, list):
                return [item for item in parsed if isinstance(item, dict)]
        return []

    async def _list_linked_account_branches(
        self,
        conn: asyncpg.Connection,
        *,
        investor_user_id: str,
    ) -> list[dict[str, Any]]:
        try:
            rows = await conn.fetch(
                """
                SELECT item_id, institution_name, latest_accounts_json
                FROM kai_plaid_items
                WHERE user_id = $1
                  AND COALESCE(status, '') <> 'permission_revoked'
                ORDER BY updated_at DESC
                """,
                investor_user_id,
            )
        except asyncpg.exceptions.UndefinedTableError:
            return []

        out: list[dict[str, Any]] = []
        seen: set[str] = set()
        for row in rows:
            item_id = str(row["item_id"] or "").strip() or None
            institution_name = str(row["institution_name"] or "").strip() or None
            accounts = self._parse_list_of_dicts(row["latest_accounts_json"])
            for account in accounts:
                account_id = str(account.get("account_id") or "").strip()
                persistent_account_id = (
                    str(account.get("persistent_account_id") or "").strip() or None
                )
                branch_id = persistent_account_id or account_id
                if not branch_id or branch_id in seen:
                    continue
                seen.add(branch_id)
                out.append(
                    {
                        "branch_id": branch_id,
                        "account_id": account_id or branch_id,
                        "persistent_account_id": persistent_account_id,
                        "item_id": item_id,
                        "institution_name": institution_name
                        or str(account.get("institution_name") or "").strip()
                        or None,
                        "name": str(
                            account.get("name") or account.get("official_name") or branch_id
                        ).strip(),
                        "official_name": str(account.get("official_name") or "").strip() or None,
                        "mask": str(account.get("mask") or "").strip() or None,
                        "type": str(account.get("type") or "").strip() or None,
                        "subtype": str(account.get("subtype") or "").strip() or None,
                    }
                )

        out.sort(
            key=lambda item: (
                str(item.get("institution_name") or "").lower(),
                str(item.get("name") or "").lower(),
                str(item.get("mask") or "").lower(),
            )
        )
        return out

    @staticmethod
    def _bundle_scope_state(
        scope: str,
        *,
        granted_scope_keys: set[str],
        pending_scope_keys: set[str],
    ) -> str:
        if (
            scope in granted_scope_keys
            or "pkm.read" in granted_scope_keys
            or "attr.financial.*" in granted_scope_keys
        ):
            return "active"
        if (
            scope in pending_scope_keys
            or "pkm.read" in pending_scope_keys
            or "attr.financial.*" in pending_scope_keys
        ):
            return "pending"
        return "available"

    @classmethod
    def _build_kai_specialized_bundle_state(
        cls,
        *,
        account_branches: list[dict[str, Any]],
        granted_payloads: list[dict[str, Any]],
        pending_payloads: list[dict[str, Any]],
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        granted_scope_keys = {
            str(payload.get("scope") or "").strip() for payload in granted_payloads
        }
        pending_scope_keys = {
            str(payload.get("scope") or "").strip() for payload in pending_payloads
        }

        approved_account_ids: list[str] = []
        pending_account_ids: list[str] = []
        legacy_full_access = False

        for payload in granted_payloads:
            scope = str(payload.get("scope") or "").strip()
            metadata = cls._parse_metadata(payload.get("metadata"))
            if scope not in _RIA_KAI_SPECIALIZED_SCOPE_SET and scope not in {
                "attr.financial.*",
                "pkm.read",
            }:
                continue
            selected = cls._normalize_account_ids(metadata.get("selected_account_ids"))
            if selected:
                approved_account_ids.extend(selected)
            elif scope in {"attr.financial.*", "pkm.read"}:
                legacy_full_access = True

        for payload in pending_payloads:
            scope = str(payload.get("scope") or "").strip()
            metadata = cls._parse_metadata(payload.get("metadata"))
            template_id = str(metadata.get("scope_template_id") or "").strip()
            if (
                template_id != _RIA_KAI_SPECIALIZED_TEMPLATE_ID
                and scope not in _RIA_KAI_SPECIALIZED_SCOPE_SET
            ):
                continue
            pending_account_ids.extend(
                cls._normalize_account_ids(metadata.get("selected_account_ids"))
            )

        approved_account_ids = list(dict.fromkeys(approved_account_ids))
        pending_account_ids = list(dict.fromkeys(pending_account_ids))
        if legacy_full_access:
            approved_account_ids = [
                str(item.get("branch_id") or item.get("account_id") or "").strip()
                for item in account_branches
                if str(item.get("branch_id") or item.get("account_id") or "").strip()
            ]

        scoped_account_branches: list[dict[str, Any]] = []
        approved_set = set(approved_account_ids)
        pending_set = set(pending_account_ids)
        for branch in account_branches:
            branch_id = str(branch.get("branch_id") or branch.get("account_id") or "").strip()
            status = (
                "approved"
                if branch_id in approved_set
                else "pending"
                if branch_id in pending_set
                else "approval_required"
            )
            scoped_account_branches.append(
                {
                    **branch,
                    "status": status,
                    "granted_by_bundle_key": _RIA_KAI_SPECIALIZED_BUNDLE_KEY
                    if status == "approved"
                    else None,
                }
            )

        scope_states = [
            {
                **cls._scope_metadata(scope),
                "status": cls._bundle_scope_state(
                    scope,
                    granted_scope_keys=granted_scope_keys,
                    pending_scope_keys=pending_scope_keys,
                ),
            }
            for scope in _RIA_KAI_SPECIALIZED_SCOPES
        ]

        if any(item["status"] == "active" for item in scope_states):
            bundle_status = (
                "partial"
                if scoped_account_branches
                and any(item["status"] != "approved" for item in scoped_account_branches)
                else "active"
            )
        elif any(item["status"] == "pending" for item in scope_states):
            bundle_status = "pending"
        else:
            bundle_status = "available"

        return (
            {
                "bundle_key": _RIA_KAI_SPECIALIZED_BUNDLE_KEY,
                "template_id": _RIA_KAI_SPECIALIZED_TEMPLATE_ID,
                "label": _RIA_KAI_SPECIALIZED_LABEL,
                "description": _RIA_KAI_SPECIALIZED_DESCRIPTION,
                "presentations": list(_RIA_KAI_SPECIALIZED_PRESENTATIONS),
                "requires_account_selection": True,
                "status": bundle_status,
                "approved_account_ids": approved_account_ids,
                "pending_account_ids": pending_account_ids,
                "selected_account_ids": approved_account_ids or pending_account_ids,
                "legacy_grant_compatible": legacy_full_access,
                "scopes": scope_states,
            },
            scoped_account_branches,
        )

    async def list_requestable_scope_templates(self, user_id: str) -> list[dict[str, Any]]:
        conn = await self._conn()
        try:
            await self._ensure_iam_schema_ready(conn)
            ria = await self._get_ria_profile_by_user(conn, user_id)
            if not self._is_verified_ria_status(ria["verification_status"]):
                raise RIAIAMPolicyError(
                    "RIA verification incomplete; cannot request investor scopes",
                    status_code=403,
                )
            rows = await conn.fetch(
                """
                SELECT
                  template_id,
                  template_name,
                  description,
                  allowed_scopes,
                  default_duration_hours,
                  max_duration_hours
                FROM consent_scope_templates
                WHERE requester_actor_type = 'ria'
                  AND subject_actor_type = 'investor'
                  AND active = TRUE
                ORDER BY template_name ASC
                """
            )
            items: list[dict[str, Any]] = []
            for row in rows:
                allowed_scopes = self._canonicalize_scope_aliases(list(row["allowed_scopes"] or []))
                items.append(
                    {
                        "template_id": str(row["template_id"]),
                        "template_name": str(row["template_name"]),
                        "description": row["description"],
                        "default_duration_hours": int(row["default_duration_hours"]),
                        "max_duration_hours": int(row["max_duration_hours"]),
                        "scopes": [self._scope_metadata(scope) for scope in allowed_scopes],
                    }
                )
            if not any(
                str(item.get("template_id") or "").strip() == _RIA_KAI_SPECIALIZED_TEMPLATE_ID
                for item in items
            ):
                template = self._kai_specialized_template()
                items.append(
                    {
                        "template_id": template.template_id,
                        "template_name": template.template_name,
                        "description": _RIA_KAI_SPECIALIZED_DESCRIPTION,
                        "default_duration_hours": template.default_duration_hours,
                        "max_duration_hours": template.max_duration_hours,
                        "bundle_key": _RIA_KAI_SPECIALIZED_BUNDLE_KEY,
                        "presentations": list(_RIA_KAI_SPECIALIZED_PRESENTATIONS),
                        "requires_account_selection": True,
                        "scopes": [
                            {
                                **self._scope_metadata(scope),
                                "bundle_key": _RIA_KAI_SPECIALIZED_BUNDLE_KEY,
                                "presentations": list(_RIA_KAI_SPECIALIZED_PRESENTATIONS),
                                "requires_account_selection": True,
                            }
                            for scope in template.allowed_scopes
                        ],
                    }
                )
            items.sort(key=lambda item: str(item.get("template_name") or "").lower())
            return items
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()

    async def _create_ria_consent_request_record(
        self,
        conn: asyncpg.Connection,
        *,
        ria: asyncpg.Record,
        subject_user_id: str,
        template: ScopeTemplate,
        chosen_scope: str,
        firm_id: str | None,
        reason: str | None,
        invite_id: str | None,
        invite_token: str | None,
        request_origin: str | None,
        bundle_id: str | None,
        bundle_label: str | None,
        bundle_scope_count: int | None,
        selected_account_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        request_id = uuid.uuid4().hex
        now_ms = self._now_ms()
        expires_at_ms = now_ms + (template.default_duration_hours * 60 * 60 * 1000)
        ria_map = dict(ria)
        agent_id = f"ria:{ria_map['id']}"
        request_url = build_consent_request_url(
            request_id=request_id,
            bundle_id=str(bundle_id or "").strip() or None,
        )
        requester_label = (
            str(ria_map.get("display_name") or ria_map.get("legal_name") or "").strip()
            or f"RIA {str(ria_map['id'])[:8]}"
        )
        requester_website_url = str(ria_map.get("disclosures_url") or "").strip() or None
        normalized_account_ids = self._normalize_account_ids(selected_account_ids)
        account_summary = (
            f"{len(normalized_account_ids)} linked account"
            f"{'' if len(normalized_account_ids) == 1 else 's'} pending investor approval"
            if normalized_account_ids
            else None
        )

        metadata = {
            "requester_actor_type": "ria",
            "subject_actor_type": "investor",
            "requester_entity_id": str(ria_map["id"]),
            "requester_label": requester_label,
            "requester_image_url": None,
            "requester_website_url": requester_website_url,
            "firm_id": firm_id,
            "scope_template_id": template.template_id,
            "duration_mode": "investor_decides",
            "duration_hours": None,
            "request_timeout_hours": template.default_duration_hours,
            "approval_timeout_minutes": template.default_duration_hours * 60,
            "approval_timeout_at": expires_at_ms,
            "reason": (reason or "").strip() or None,
            "request_origin": (request_origin or "").strip() or "direct_ria_request",
            "invite_id": invite_id,
            "invite_token": invite_token,
            "bundle_id": bundle_id,
            "bundle_label": bundle_label,
            "bundle_scope_count": bundle_scope_count or 1,
            "request_url": request_url,
            "selected_account_ids": normalized_account_ids,
            "account_branch_mode": "explicit_snapshot" if normalized_account_ids else "unspecified",
            "additional_access_summary": account_summary
            or self._relationship_share_summary(_RELATIONSHIP_SHARE_ACTIVE_PICKS),
            "included_relationship_shares": [
                {
                    **self._relationship_share_descriptor(_RELATIONSHIP_SHARE_ACTIVE_PICKS),
                    "share_origin": _RELATIONSHIP_SHARE_ORIGIN_RELATIONSHIP_IMPLICIT,
                    "status": "included_on_approval",
                }
            ],
        }

        await conn.execute(
            """
            INSERT INTO consent_audit (
              token_id,
              user_id,
              agent_id,
              scope,
              action,
              issued_at,
              expires_at,
              poll_timeout_at,
              request_id,
              scope_description,
              metadata
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              'REQUESTED',
              $5,
              $6,
              $7,
              $8,
              $9,
              $10::jsonb
            )
            """,
            f"req_{request_id}",
            subject_user_id,
            agent_id,
            chosen_scope,
            now_ms,
            expires_at_ms,
            expires_at_ms,
            request_id,
            template.template_name,
            json.dumps(metadata),
        )

        relationship = await conn.fetchrow(
            """
            SELECT id
            FROM advisor_investor_relationships
            WHERE investor_user_id = $1
              AND ria_profile_id = $2
              AND (
                (firm_id IS NULL AND $3::uuid IS NULL)
                OR firm_id = $3::uuid
              )
            LIMIT 1
            """,
            subject_user_id,
            ria["id"],
            firm_id,
        )

        relationship_id: str | None = None
        if relationship is None:
            relationship_row = await conn.fetchrow(
                """
                INSERT INTO advisor_investor_relationships (
                  investor_user_id,
                  ria_profile_id,
                  firm_id,
                  status,
                  last_request_id,
                  granted_scope,
                  created_at,
                  updated_at
                )
                VALUES (
                  $1,
                  $2,
                  $3::uuid,
                  'request_pending',
                  $4,
                  $5,
                  NOW(),
                  NOW()
                )
                RETURNING id
                """,
                subject_user_id,
                ria["id"],
                firm_id,
                request_id,
                chosen_scope,
            )
            relationship_id = (
                str(relationship_row["id"])
                if relationship_row and relationship_row["id"] is not None
                else None
            )
        else:
            await conn.execute(
                """
                UPDATE advisor_investor_relationships
                SET
                  status = 'request_pending',
                  last_request_id = $2,
                  granted_scope = COALESCE(granted_scope, $3),
                  updated_at = NOW()
                WHERE id = $1
                """,
                relationship["id"],
                request_id,
                chosen_scope,
            )
            relationship_id = str(relationship["id"])

        return {
            "request_id": request_id,
            "subject_user_id": subject_user_id,
            "scope": chosen_scope,
            "duration_hours": template.default_duration_hours,
            "duration_mode": "investor_decides",
            "expires_at": expires_at_ms,
            "scope_template_id": template.template_id,
            "requester_entity_id": str(ria["id"]),
            "relationship_id": relationship_id,
            "status": "REQUESTED",
            "metadata": metadata,
        }

    async def create_ria_consent_bundle(
        self,
        user_id: str,
        *,
        subject_user_id: str,
        scope_template_id: str,
        selected_scopes: list[str],
        selected_account_ids: list[str] | None = None,
        firm_id: str | None = None,
        reason: str | None = None,
    ) -> dict[str, Any]:
        conn = await self._conn()
        try:
            async with conn.transaction():
                await self._ensure_vault_user_row(conn, user_id)
                await self._ensure_vault_user_row(conn, subject_user_id)
                await self._ensure_iam_schema_ready(conn)
                await self._ensure_actor_profile_row(conn, user_id, include_ria_persona=True)
                await self._ensure_actor_profile_row(conn, subject_user_id)

                ria = await self._get_ria_profile_by_user(conn, user_id)
                if not self._is_verified_ria_status(ria["verification_status"]):
                    raise RIAIAMPolicyError(
                        "RIA verification incomplete; cannot create consent requests",
                        status_code=403,
                    )

                template = await self._load_scope_template(conn, scope_template_id)
                normalized_scopes = self._canonicalize_scope_aliases(selected_scopes)
                deduped_scopes = list(dict.fromkeys(normalized_scopes))
                if not deduped_scopes:
                    deduped_scopes = list(template.allowed_scopes[:1])
                invalid_scopes = [
                    scope for scope in deduped_scopes if scope not in template.allowed_scopes
                ]
                if invalid_scopes:
                    raise RIAIAMPolicyError(
                        "Selected scope is not allowed for this template", status_code=400
                    )

                normalized_account_ids = self._normalize_account_ids(selected_account_ids)
                if template.template_id == _RIA_KAI_SPECIALIZED_TEMPLATE_ID:
                    account_branches = await self._list_linked_account_branches(
                        conn,
                        investor_user_id=subject_user_id,
                    )
                    available_account_ids = {
                        str(item.get("branch_id") or item.get("account_id") or "").strip()
                        for item in account_branches
                        if str(item.get("branch_id") or item.get("account_id") or "").strip()
                    }
                    if not normalized_account_ids and available_account_ids:
                        normalized_account_ids = sorted(available_account_ids)
                    invalid_account_ids = [
                        account_id
                        for account_id in normalized_account_ids
                        if account_id not in available_account_ids
                    ]
                    if invalid_account_ids:
                        raise RIAIAMPolicyError(
                            "Selected account is not available for this investor workspace",
                            status_code=400,
                        )

                if firm_id:
                    membership = await conn.fetchrow(
                        """
                        SELECT 1
                        FROM ria_firm_memberships
                        WHERE ria_profile_id = $1
                          AND firm_id = $2::uuid
                          AND membership_status = 'active'
                        """,
                        ria["id"],
                        firm_id,
                    )
                    if membership is None:
                        raise RIAIAMPolicyError("Firm membership is not active", status_code=403)

                bundle_id = uuid.uuid4().hex
                bundle_label = template.template_name
                created_requests: list[dict[str, Any]] = []
                for scope in deduped_scopes:
                    created_requests.append(
                        await self._create_ria_consent_request_record(
                            conn,
                            ria=ria,
                            subject_user_id=subject_user_id,
                            template=template,
                            chosen_scope=scope,
                            firm_id=firm_id,
                            reason=reason,
                            invite_id=None,
                            invite_token=None,
                            request_origin="direct_ria_request_bundle",
                            bundle_id=bundle_id,
                            bundle_label=bundle_label,
                            bundle_scope_count=len(deduped_scopes),
                            selected_account_ids=normalized_account_ids,
                        )
                    )

                expires_at = (
                    max(int(item["expires_at"]) for item in created_requests)
                    if created_requests
                    else None
                )
                return {
                    "bundle_id": bundle_id,
                    "bundle_label": bundle_label,
                    "subject_user_id": subject_user_id,
                    "status": "REQUESTED",
                    "request_count": len(created_requests),
                    "requests": created_requests,
                    "request_ids": [item["request_id"] for item in created_requests],
                    "selected_scopes": [item["scope"] for item in created_requests],
                    "selected_account_ids": normalized_account_ids,
                    "expires_at": expires_at,
                }
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()

    async def submit_ria_onboarding(
        self,
        user_id: str,
        *,
        display_name: str,
        requested_capabilities: list[str] | tuple[str, ...] | None = None,
        individual_legal_name: str | None = None,
        individual_crd: str | None = None,
        advisory_firm_legal_name: str | None = None,
        advisory_firm_iapd_number: str | None = None,
        broker_firm_legal_name: str | None = None,
        broker_firm_crd: str | None = None,
        legal_name: str | None = None,
        finra_crd: str | None = None,
        sec_iard: str | None = None,
        bio: str | None = None,
        strategy: str | None = None,
        disclosures_url: str | None = None,
        primary_firm_name: str | None = None,
        primary_firm_role: str | None = None,
        force_live_verification: bool = False,
    ) -> dict[str, Any]:
        if not display_name.strip():
            raise RIAIAMPolicyError("display_name is required", status_code=400)

        normalized_requested_capabilities: list[str] = []
        for capability in requested_capabilities or []:
            candidate = str(capability or "").strip().lower()
            if not candidate:
                continue
            if candidate not in _ALLOWED_PROFESSIONAL_CAPABILITIES:
                raise RIAIAMPolicyError(
                    "requested_capabilities contains unsupported capability",
                    status_code=400,
                )
            if candidate not in normalized_requested_capabilities:
                normalized_requested_capabilities.append(candidate)
        if not normalized_requested_capabilities:
            normalized_requested_capabilities = ["advisory"]

        effective_legal_name = (
            self._normalize_optional_text(individual_legal_name)
            or self._normalize_optional_text(legal_name)
            or display_name.strip()
        )
        effective_finra_crd = self._normalize_optional_text(
            individual_crd
        ) or self._normalize_optional_text(finra_crd)
        effective_sec_iard = self._normalize_optional_text(
            advisory_firm_iapd_number
        ) or self._normalize_optional_text(sec_iard)
        effective_primary_firm_name = self._normalize_optional_text(
            advisory_firm_legal_name
        ) or self._normalize_optional_text(primary_firm_name)
        effective_broker_firm_name = self._normalize_optional_text(broker_firm_legal_name)
        effective_broker_firm_crd = self._normalize_optional_text(broker_firm_crd)

        if not effective_legal_name:
            raise RIAIAMPolicyError(
                "individual_legal_name is required for regulatory verification",
                status_code=400,
            )
        if not effective_finra_crd:
            raise RIAIAMPolicyError(
                "individual_crd is required for regulatory verification",
                status_code=400,
            )
        if "advisory" in normalized_requested_capabilities and not effective_sec_iard:
            raise RIAIAMPolicyError(
                "advisory_firm_iapd_number is required for regulatory verification",
                status_code=400,
            )

        conn = await self._conn()
        try:
            async with conn.transaction():
                await self._ensure_vault_user_row(conn, user_id)
                await self._ensure_iam_schema_ready(conn)
                await conn.execute(
                    """
                    INSERT INTO actor_profiles (
                        user_id,
                        personas,
                        last_active_persona,
                        investor_marketplace_opt_in
                    )
                    VALUES ($1, ARRAY['investor','ria']::text[], 'ria', FALSE)
                    ON CONFLICT (user_id) DO UPDATE
                    SET
                      personas = CASE
                        WHEN 'ria' = ANY(actor_profiles.personas) THEN actor_profiles.personas
                        ELSE array_append(actor_profiles.personas, 'ria')
                      END,
                      last_active_persona = 'ria',
                      updated_at = NOW()
                    """,
                    user_id,
                )
                await self._set_runtime_last_persona(conn, user_id, "ria")

                ria = await conn.fetchrow(
                    """
                    INSERT INTO ria_profiles (
                      user_id,
                      display_name,
                      legal_name,
                      finra_crd,
                      sec_iard,
                      verification_status,
                      verification_provider,
                      bio,
                      strategy,
                      disclosures_url
                    )
                    VALUES (
                      $1,
                      $2,
                      NULLIF($3, ''),
                      NULLIF($4, ''),
                      NULLIF($5, ''),
                      'submitted',
                      'finra',
                      NULLIF($6, ''),
                      NULLIF($7, ''),
                      NULLIF($8, '')
                    )
                    ON CONFLICT (user_id) DO UPDATE
                    SET
                      display_name = EXCLUDED.display_name,
                      legal_name = EXCLUDED.legal_name,
                      finra_crd = EXCLUDED.finra_crd,
                      sec_iard = EXCLUDED.sec_iard,
                      verification_status = 'submitted',
                      verification_provider = 'finra',
                      bio = EXCLUDED.bio,
                      strategy = EXCLUDED.strategy,
                      disclosures_url = EXCLUDED.disclosures_url,
                      updated_at = NOW()
                    RETURNING id, user_id, display_name, legal_name, finra_crd, sec_iard, verification_status
                    """,
                    user_id,
                    display_name.strip(),
                    effective_legal_name,
                    effective_finra_crd,
                    effective_sec_iard or "",
                    (bio or "").strip(),
                    (strategy or "").strip(),
                    (disclosures_url or "").strip(),
                )
                if ria is None:
                    raise RuntimeError("Failed to create RIA profile")

                firm_id: str | None = None
                if effective_primary_firm_name and effective_primary_firm_name.strip():
                    firm_row = await conn.fetchrow(
                        """
                        INSERT INTO ria_firms (legal_name)
                        VALUES ($1)
                        ON CONFLICT (legal_name) DO UPDATE
                        SET updated_at = NOW()
                        RETURNING id
                        """,
                        effective_primary_firm_name.strip(),
                    )
                    if firm_row:
                        firm_id = str(firm_row["id"])
                        await conn.execute(
                            """
                            INSERT INTO ria_firm_memberships (
                              ria_profile_id,
                              firm_id,
                              role_title,
                              membership_status,
                              is_primary
                            )
                            VALUES ($1, $2, NULLIF($3, ''), 'active', TRUE)
                            ON CONFLICT (ria_profile_id, firm_id) DO UPDATE
                            SET
                              role_title = EXCLUDED.role_title,
                              membership_status = 'active',
                              is_primary = TRUE,
                              updated_at = NOW()
                            """,
                            ria["id"],
                            firm_row["id"],
                            (primary_firm_role or "").strip(),
                        )

                verification_result: VerificationResult = await self._verification_gateway.verify(
                    legal_name=effective_legal_name,
                    finra_crd=effective_finra_crd,
                    sec_iard=effective_sec_iard,
                    force_live=force_live_verification,
                )
                verification_provider = self._verification_provider_label(verification_result)

                next_status = "submitted"
                if verification_result.outcome == "bypassed":
                    next_status = "bypassed"
                elif verification_result.verified:
                    next_status = "finra_verified"
                elif verification_result.rejected:
                    next_status = "rejected"

                await conn.execute(
                    """
                    UPDATE ria_profiles
                    SET
                      verification_status = $2,
                      verification_provider = $3,
                      verification_expires_at = $4,
                      updated_at = NOW()
                    WHERE id = $1
                    """,
                    ria["id"],
                    next_status,
                    verification_provider,
                    verification_result.expires_at,
                )

                await conn.execute(
                    """
                    UPDATE marketplace_public_profiles
                    SET
                      verification_badge = CASE
                        WHEN $2 IN ('finra_verified', 'active', 'bypassed') THEN 'verified'
                        ELSE 'pending'
                      END,
                      updated_at = NOW()
                    WHERE user_id = $1
                    """,
                    user_id,
                    next_status,
                )

                await conn.execute(
                    """
                    INSERT INTO ria_verification_events (
                      ria_profile_id,
                      provider,
                      outcome,
                      checked_at,
                      expires_at,
                      reference_metadata
                    )
                    VALUES ($1, $2, $3, NOW(), $4, $5::jsonb)
                    """,
                    ria["id"],
                    verification_provider,
                    verification_result.outcome,
                    verification_result.expires_at,
                    json.dumps(verification_result.metadata),
                )

                await conn.execute(
                    """
                    INSERT INTO marketplace_public_profiles (
                      user_id,
                      profile_type,
                      display_name,
                      headline,
                      strategy_summary,
                      verification_badge,
                      is_discoverable,
                      updated_at
                    )
                    VALUES (
                      $1,
                      'ria',
                      $2,
                      COALESCE(NULLIF($3, ''), NULLIF($4, ''), 'Registered Investment Advisor'),
                      NULLIF($4, ''),
                      CASE WHEN $5 IN ('finra_verified', 'active', 'bypassed') THEN 'verified' ELSE 'pending' END,
                      TRUE,
                      NOW()
                    )
                    ON CONFLICT (user_id) DO UPDATE
                    SET
                      profile_type = 'ria',
                      display_name = EXCLUDED.display_name,
                      headline = EXCLUDED.headline,
                      strategy_summary = EXCLUDED.strategy_summary,
                      verification_badge = EXCLUDED.verification_badge,
                      is_discoverable = TRUE,
                      updated_at = NOW()
                    """,
                    user_id,
                    display_name.strip(),
                    (bio or "").strip(),
                    (strategy or "").strip(),
                    next_status,
                )

                advisory_status = self._normalize_legacy_verification_status(next_status)
                brokerage_status = (
                    "draft" if "brokerage" in normalized_requested_capabilities else "draft"
                )
                professional_access_granted = advisory_status in {"verified", "active", "bypassed"}
                brokerage_outcome = (
                    "not_requested"
                    if "brokerage" not in normalized_requested_capabilities
                    else "unsupported"
                )
                brokerage_message = (
                    "Brokerage capability was not requested."
                    if "brokerage" not in normalized_requested_capabilities
                    else "Brokerage verification is not yet enabled in this onboarding path."
                )

                return {
                    "ria_profile_id": str(ria["id"]),
                    "user_id": str(ria["user_id"]),
                    "display_name": str(ria["display_name"]),
                    "verification_status": next_status,
                    "verification_provider": verification_provider,
                    "advisory_status": advisory_status,
                    "brokerage_status": brokerage_status,
                    "requested_capabilities": normalized_requested_capabilities,
                    "verification_outcome": verification_result.outcome,
                    "verification_message": verification_result.message,
                    "brokerage_outcome": brokerage_outcome,
                    "brokerage_message": brokerage_message,
                    "professional_access_granted": professional_access_granted,
                    "individual_legal_name": effective_legal_name,
                    "individual_crd": effective_finra_crd,
                    "advisory_firm_legal_name": effective_primary_firm_name,
                    "advisory_firm_iapd_number": effective_sec_iard,
                    "broker_firm_legal_name": effective_broker_firm_name,
                    "broker_firm_crd": effective_broker_firm_crd,
                    "firm_id": firm_id,
                }
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()

    async def activate_ria_dev_onboarding(
        self,
        user_id: str,
        *,
        display_name: str,
        requested_capabilities: list[str] | tuple[str, ...] | None = None,
        individual_legal_name: str | None = None,
        individual_crd: str | None = None,
        advisory_firm_legal_name: str | None = None,
        advisory_firm_iapd_number: str | None = None,
        broker_firm_legal_name: str | None = None,
        broker_firm_crd: str | None = None,
        legal_name: str | None = None,
        finra_crd: str | None = None,
        sec_iard: str | None = None,
        bio: str | None = None,
        strategy: str | None = None,
        disclosures_url: str | None = None,
        primary_firm_name: str | None = None,
        primary_firm_role: str | None = None,
    ) -> dict[str, Any]:
        if not self._is_dev_bypass_allowed(user_id):
            raise RIAIAMPolicyError(
                "RIA dev activation is not allowed for this account", status_code=403
            )
        if not display_name.strip():
            raise RIAIAMPolicyError("display_name is required", status_code=400)

        normalized_requested_capabilities: list[str] = []
        for capability in requested_capabilities or []:
            candidate = str(capability or "").strip().lower()
            if not candidate:
                continue
            if candidate not in _ALLOWED_PROFESSIONAL_CAPABILITIES:
                raise RIAIAMPolicyError(
                    "requested_capabilities contains unsupported capability",
                    status_code=400,
                )
            if candidate not in normalized_requested_capabilities:
                normalized_requested_capabilities.append(candidate)
        if not normalized_requested_capabilities:
            normalized_requested_capabilities = ["advisory"]

        effective_legal_name = (
            self._normalize_optional_text(individual_legal_name)
            or self._normalize_optional_text(legal_name)
            or display_name.strip()
        )
        effective_finra_crd = self._normalize_optional_text(
            individual_crd
        ) or self._normalize_optional_text(finra_crd)
        effective_sec_iard = self._normalize_optional_text(
            advisory_firm_iapd_number
        ) or self._normalize_optional_text(sec_iard)
        effective_primary_firm_name = self._normalize_optional_text(
            advisory_firm_legal_name
        ) or self._normalize_optional_text(primary_firm_name)
        effective_broker_firm_name = self._normalize_optional_text(broker_firm_legal_name)
        effective_broker_firm_crd = self._normalize_optional_text(broker_firm_crd)

        conn = await self._conn()
        try:
            async with conn.transaction():
                await self._ensure_vault_user_row(conn, user_id)
                await self._ensure_iam_schema_ready(conn)
                await conn.execute(
                    """
                    INSERT INTO actor_profiles (
                        user_id,
                        personas,
                        last_active_persona,
                        investor_marketplace_opt_in
                    )
                    VALUES ($1, ARRAY['investor','ria']::text[], 'ria', FALSE)
                    ON CONFLICT (user_id) DO UPDATE
                    SET
                      personas = CASE
                        WHEN 'ria' = ANY(actor_profiles.personas) THEN actor_profiles.personas
                        ELSE array_append(actor_profiles.personas, 'ria')
                      END,
                      last_active_persona = 'ria',
                      updated_at = NOW()
                    """,
                    user_id,
                )
                await self._set_runtime_last_persona(conn, user_id, "ria")

                ria = await conn.fetchrow(
                    """
                    INSERT INTO ria_profiles (
                      user_id,
                      display_name,
                      legal_name,
                      finra_crd,
                      sec_iard,
                      verification_status,
                      verification_provider,
                      bio,
                      strategy,
                      disclosures_url
                    )
                    VALUES (
                      $1,
                      $2,
                      NULLIF($3, ''),
                      NULLIF($4, ''),
                      NULLIF($5, ''),
                      'active',
                      'dev_allowlist',
                      NULLIF($6, ''),
                      NULLIF($7, ''),
                      NULLIF($8, '')
                    )
                    ON CONFLICT (user_id) DO UPDATE
                    SET
                      display_name = EXCLUDED.display_name,
                      legal_name = EXCLUDED.legal_name,
                      finra_crd = EXCLUDED.finra_crd,
                      sec_iard = EXCLUDED.sec_iard,
                      verification_status = 'active',
                      verification_provider = 'dev_allowlist',
                      verification_expires_at = NULL,
                      bio = EXCLUDED.bio,
                      strategy = EXCLUDED.strategy,
                      disclosures_url = EXCLUDED.disclosures_url,
                      updated_at = NOW()
                    RETURNING id, user_id, display_name
                    """,
                    user_id,
                    display_name.strip(),
                    effective_legal_name,
                    effective_finra_crd or "",
                    effective_sec_iard or "",
                    (bio or "").strip(),
                    (strategy or "").strip(),
                    (disclosures_url or "").strip(),
                )
                if ria is None:
                    raise RuntimeError("Failed to create RIA profile")

                firm_id: str | None = None
                if effective_primary_firm_name and effective_primary_firm_name.strip():
                    firm_row = await conn.fetchrow(
                        """
                        INSERT INTO ria_firms (legal_name)
                        VALUES ($1)
                        ON CONFLICT (legal_name) DO UPDATE
                        SET updated_at = NOW()
                        RETURNING id
                        """,
                        effective_primary_firm_name.strip(),
                    )
                    if firm_row:
                        firm_id = str(firm_row["id"])
                        await conn.execute(
                            """
                            INSERT INTO ria_firm_memberships (
                              ria_profile_id,
                              firm_id,
                              role_title,
                              membership_status,
                              is_primary
                            )
                            VALUES ($1, $2, NULLIF($3, ''), 'active', TRUE)
                            ON CONFLICT (ria_profile_id, firm_id) DO UPDATE
                            SET
                              role_title = EXCLUDED.role_title,
                              membership_status = 'active',
                              is_primary = TRUE,
                              updated_at = NOW()
                            """,
                            ria["id"],
                            firm_row["id"],
                            (primary_firm_role or "").strip(),
                        )

                await conn.execute(
                    """
                    INSERT INTO ria_verification_events (
                      ria_profile_id,
                      provider,
                      outcome,
                      checked_at,
                      expires_at,
                      reference_metadata
                    )
                    VALUES ($1, 'dev_allowlist', 'dev_allowlist', NOW(), NULL, $2::jsonb)
                    """,
                    ria["id"],
                    json.dumps({"source": "dev_allowlist", "user_id": user_id}),
                )

                await conn.execute(
                    """
                    INSERT INTO marketplace_public_profiles (
                      user_id,
                      profile_type,
                      display_name,
                      headline,
                      strategy_summary,
                      verification_badge,
                      is_discoverable,
                      updated_at
                    )
                    VALUES (
                      $1,
                      'ria',
                      $2,
                      COALESCE(NULLIF($3, ''), NULLIF($4, ''), 'Registered Investment Advisor'),
                      NULLIF($4, ''),
                      'dev_allowlist',
                      TRUE,
                      NOW()
                    )
                    ON CONFLICT (user_id) DO UPDATE
                    SET
                      profile_type = 'ria',
                      display_name = EXCLUDED.display_name,
                      headline = EXCLUDED.headline,
                      strategy_summary = EXCLUDED.strategy_summary,
                      verification_badge = EXCLUDED.verification_badge,
                      is_discoverable = TRUE,
                      updated_at = NOW()
                    """,
                    user_id,
                    display_name.strip(),
                    (bio or "").strip(),
                    (strategy or "").strip(),
                )

                return {
                    "ria_profile_id": str(ria["id"]),
                    "user_id": str(ria["user_id"]),
                    "display_name": str(ria["display_name"]),
                    "verification_status": "active",
                    "advisory_status": "active",
                    "brokerage_status": (
                        "draft" if "brokerage" in normalized_requested_capabilities else "draft"
                    ),
                    "requested_capabilities": normalized_requested_capabilities,
                    "verification_outcome": "dev_allowlist",
                    "verification_message": "RIA activated for an allowlisted development account",
                    "brokerage_outcome": (
                        "not_requested"
                        if "brokerage" not in normalized_requested_capabilities
                        else "unsupported"
                    ),
                    "brokerage_message": (
                        "Brokerage capability was not requested."
                        if "brokerage" not in normalized_requested_capabilities
                        else "Brokerage verification is not yet enabled in this onboarding path."
                    ),
                    "professional_access_granted": True,
                    "individual_legal_name": effective_legal_name,
                    "individual_crd": effective_finra_crd,
                    "advisory_firm_legal_name": effective_primary_firm_name,
                    "advisory_firm_iapd_number": effective_sec_iard,
                    "broker_firm_legal_name": effective_broker_firm_name,
                    "broker_firm_crd": effective_broker_firm_crd,
                    "firm_id": firm_id,
                }
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()

    async def get_ria_onboarding_status(self, user_id: str) -> dict[str, Any]:
        conn = await self._conn()
        try:
            await self._ensure_iam_schema_ready(conn)
            await self._ensure_vault_user_row(conn, user_id)
            await self._ensure_actor_profile_row(conn, user_id)
            used_legacy_capabilities_fallback = False
            try:
                ria = await conn.fetchrow(
                    """
                    SELECT
                      id,
                      user_id,
                      display_name,
                      requested_capabilities,
                      individual_legal_name,
                      individual_crd,
                      advisory_firm_legal_name,
                      advisory_firm_iapd_number,
                      broker_firm_legal_name,
                      broker_firm_crd,
                      advisory_status,
                      brokerage_status,
                      advisory_provider,
                      brokerage_provider,
                      advisory_verification_expires_at,
                      brokerage_verification_expires_at,
                      legal_name,
                      finra_crd,
                      sec_iard,
                      verification_status,
                      verification_provider,
                      verification_expires_at,
                      created_at,
                      updated_at
                    FROM ria_profiles
                    WHERE user_id = $1
                    """,
                    user_id,
                )
            except asyncpg.exceptions.UndefinedColumnError as exc:
                if "requested_capabilities" not in str(exc):
                    raise
                used_legacy_capabilities_fallback = True
                logger.warning(
                    "ria_profiles.requested_capabilities is missing; using legacy fallback defaults"
                )
                ria = await conn.fetchrow(
                    """
                    SELECT
                      id,
                      user_id,
                      display_name,
                      legal_name,
                      finra_crd,
                      sec_iard,
                      verification_status,
                      verification_provider,
                      verification_expires_at,
                      created_at,
                      updated_at
                    FROM ria_profiles
                    WHERE user_id = $1
                    """,
                    user_id,
                )
            if ria is None:
                return {
                    "exists": False,
                    "verification_status": "draft",
                    "dev_ria_bypass_allowed": self._is_dev_bypass_allowed(user_id),
                }

            latest_event = await conn.fetchrow(
                """
                SELECT outcome, checked_at, expires_at, reference_metadata
                FROM ria_verification_events
                WHERE ria_profile_id = $1
                ORDER BY checked_at DESC
                LIMIT 1
                """,
                ria["id"],
            )
            event = dict(latest_event) if latest_event else None
            if event and "reference_metadata" in event:
                event["reference_metadata"] = self._parse_metadata(event["reference_metadata"])

            if used_legacy_capabilities_fallback:
                requested_capabilities = ["advisory"]
                individual_legal_name = ria["legal_name"]
                individual_crd = ria["finra_crd"]
                advisory_firm_legal_name = None
                advisory_firm_iapd_number = None
                broker_firm_legal_name = None
                broker_firm_crd = None
                advisory_status = self._advisory_status_from_row(ria)
                brokerage_status = self._brokerage_status_from_row(ria)
                advisory_provider = ria["verification_provider"]
                brokerage_provider = None
                advisory_verification_expires_at = ria["verification_expires_at"]
                brokerage_verification_expires_at = None
            else:
                requested_capabilities = list(ria["requested_capabilities"] or [])
                individual_legal_name = ria["individual_legal_name"]
                individual_crd = ria["individual_crd"]
                advisory_firm_legal_name = ria["advisory_firm_legal_name"]
                advisory_firm_iapd_number = ria["advisory_firm_iapd_number"]
                broker_firm_legal_name = ria["broker_firm_legal_name"]
                broker_firm_crd = ria["broker_firm_crd"]
                advisory_status = ria["advisory_status"]
                brokerage_status = ria["brokerage_status"]
                advisory_provider = ria["advisory_provider"]
                brokerage_provider = ria["brokerage_provider"]
                advisory_verification_expires_at = ria["advisory_verification_expires_at"]
                brokerage_verification_expires_at = ria["brokerage_verification_expires_at"]

            return {
                "exists": True,
                "ria_profile_id": str(ria["id"]),
                "display_name": ria["display_name"],
                "requested_capabilities": requested_capabilities,
                "individual_legal_name": individual_legal_name,
                "individual_crd": individual_crd,
                "advisory_firm_legal_name": advisory_firm_legal_name,
                "advisory_firm_iapd_number": advisory_firm_iapd_number,
                "broker_firm_legal_name": broker_firm_legal_name,
                "broker_firm_crd": broker_firm_crd,
                "advisory_status": advisory_status,
                "brokerage_status": brokerage_status,
                "advisory_provider": advisory_provider,
                "brokerage_provider": brokerage_provider,
                "advisory_verification_expires_at": advisory_verification_expires_at,
                "brokerage_verification_expires_at": brokerage_verification_expires_at,
                "legal_name": ria["legal_name"],
                "finra_crd": ria["finra_crd"],
                "sec_iard": ria["sec_iard"],
                "verification_status": ria["verification_status"],
                "verification_provider": ria["verification_provider"],
                "verification_expires_at": ria["verification_expires_at"],
                "dev_ria_bypass_allowed": self._is_dev_bypass_allowed(user_id),
                "latest_verification_event": event,
            }
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()

    async def list_ria_firms(self, user_id: str) -> list[dict[str, Any]]:
        conn = await self._conn()
        try:
            await self._ensure_iam_schema_ready(conn)
            rows = await conn.fetch(
                """
                SELECT
                  f.id,
                  f.legal_name,
                  f.finra_firm_crd,
                  f.sec_iard,
                  f.website_url,
                  m.role_title,
                  m.membership_status,
                  m.is_primary
                FROM ria_profiles rp
                JOIN ria_firm_memberships m ON m.ria_profile_id = rp.id
                JOIN ria_firms f ON f.id = m.firm_id
                WHERE rp.user_id = $1
                ORDER BY m.is_primary DESC, f.legal_name ASC
                """,
                user_id,
            )
            return [dict(row) for row in rows]
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()

    async def get_ria_home(self, user_id: str) -> dict[str, Any]:
        onboarding = await self.get_ria_onboarding_status(user_id)
        clients_payload = await self.list_ria_clients(user_id, page=1, limit=100)
        clients = list(clients_payload.get("items") or [])
        pick_bootstrap = await self.get_ria_pick_bootstrap(user_id)
        pick_metadata = pick_bootstrap.get("metadata") if isinstance(pick_bootstrap, dict) else {}
        active_rows = int(
            (pick_metadata.get("top_pick_count") if isinstance(pick_metadata, dict) else 0) or 0
        )

        verification_status = str(
            onboarding.get("advisory_status") or onboarding.get("verification_status") or "draft"
        )

        if verification_status in {"active", "verified", "bypassed"}:
            primary_action = {
                "label": "Open clients",
                "href": "/ria/clients",
                "description": "Relationships and requests are ready to manage.",
            }
        elif verification_status == "submitted":
            primary_action = {
                "label": "Review verification",
                "href": "/ria/onboarding",
                "description": "Verification is still in review before advisor actions fully unlock.",
            }
        else:
            primary_action = {
                "label": "Finish setup",
                "href": "/ria/onboarding",
                "description": "Complete the trust profile before requesting investor data.",
            }

        needs_attention = []
        for item in clients:
            status = str(item.get("status") or "")
            if status not in {"request_pending", "invited", "revoked", "expired", "disconnected"}:
                continue
            client_id = str(item.get("investor_user_id") or "").strip()
            needs_attention.append(
                {
                    "id": str(item.get("id") or client_id or ""),
                    "title": item.get("investor_display_name") or "Investor",
                    "subtitle": item.get("investor_secondary_label")
                    or item.get("investor_email")
                    or item.get("investor_headline")
                    or item.get("next_action")
                    or "",
                    "status": status,
                    "next_action": item.get("next_action"),
                    "href": f"/ria/workspace?clientId={client_id}" if client_id else "/ria/clients",
                }
            )

        return {
            "onboarding": onboarding,
            "verification_status": verification_status,
            "primary_action": primary_action,
            "counts": {
                "active_clients": len(
                    [item for item in clients if str(item.get("status") or "") == "approved"]
                ),
                "needs_attention": len(needs_attention),
                "invites": len(
                    [item for item in clients if str(item.get("status") or "") == "invited"]
                ),
            },
            "needs_attention": needs_attention[:5],
            "active_picks": {
                "status": "ready" if active_rows else "empty",
                "active_rows": active_rows,
            },
        }

    async def list_ria_clients(
        self,
        user_id: str,
        *,
        query: str | None = None,
        status: str | None = None,
        page: int = 1,
        limit: int = 50,
    ) -> dict[str, Any]:
        conn = await self._conn()
        try:
            await self._ensure_iam_schema_ready(conn)
            identity_select_sql, identity_join_sql = await self._investor_identity_projection(
                conn,
                user_id_sql="rel.investor_user_id",
            )
            relationship_query = "\n".join(
                [
                    "SELECT",
                    "  rel.id,",
                    "  rel.investor_user_id,",
                    "  rel.status,",
                    "  rel.granted_scope,",
                    "  rel.last_request_id,",
                    "  rel.consent_granted_at,",
                    "  rel.revoked_at,",
                    f"  {identity_select_sql},",
                    "  invite.id AS invite_id,",
                    "  invite.invite_token,",
                    "  invite.source AS acquisition_source,",
                    "  invite.status AS invite_status,",
                    "  invite.delivery_channel,",
                    "  consent.expires_at AS consent_expires_at,",
                    "  picks_share.id AS picks_share_id,",
                    "  picks_share.status AS picks_share_status,",
                    "  picks_share.granted_at AS picks_share_granted_at,",
                    "  picks_share.revoked_at AS picks_share_revoked_at,",
                    "  picks_share.metadata AS picks_share_metadata,",
                    "  (active_upload.id IS NOT NULL) AS has_active_pick_upload",
                    "FROM ria_profiles rp",
                    "JOIN advisor_investor_relationships rel ON rel.ria_profile_id = rp.id",
                    identity_join_sql,
                    "LEFT JOIN marketplace_public_profiles mp",
                    "  ON mp.user_id = rel.investor_user_id AND mp.profile_type = 'investor'",
                    "LEFT JOIN LATERAL (",
                    "  SELECT",
                    "    i.id,",
                    "    i.invite_token,",
                    "    i.source,",
                    "    i.status,",
                    "    i.delivery_channel",
                    "  FROM ria_client_invites i",
                    "  WHERE i.ria_profile_id = rp.id",
                    "    AND (",
                    "      i.accepted_by_user_id = rel.investor_user_id",
                    "      OR (",
                    "        i.target_investor_user_id IS NOT NULL",
                    "        AND i.target_investor_user_id = rel.investor_user_id",
                    "      )",
                    "    )",
                    "  ORDER BY i.accepted_at DESC NULLS LAST, i.created_at DESC",
                    "  LIMIT 1",
                    ") invite ON TRUE",
                    "LEFT JOIN LATERAL (",
                    "  SELECT expires_at",
                    "  FROM consent_audit",
                    "  WHERE user_id = rel.investor_user_id",
                    "    AND agent_id = ('ria:' || rp.id::text)",
                    "    AND scope = rel.granted_scope",
                    "    AND action = 'CONSENT_GRANTED'",
                    "  ORDER BY issued_at DESC",
                    "  LIMIT 1",
                    ") consent ON TRUE",
                    "LEFT JOIN relationship_share_grants picks_share",
                    "  ON picks_share.relationship_id = rel.id",
                    "  AND picks_share.grant_key = $2",
                    "LEFT JOIN LATERAL (",
                    "  SELECT id",
                    "  FROM ria_pick_share_artifacts",
                    "  WHERE relationship_id = rel.id",
                    "    AND grant_key = $2",
                    "    AND status = 'active'",
                    "  ORDER BY updated_at DESC",
                    "  LIMIT 1",
                    ") active_upload ON TRUE",
                    "WHERE rp.user_id = $1",
                    "ORDER BY rel.updated_at DESC",
                ]
            )
            relationship_rows = await conn.fetch(
                relationship_query,
                user_id,
                _RELATIONSHIP_SHARE_ACTIVE_PICKS,
            )
            invite_rows = await conn.fetch(
                """
                SELECT
                  i.id,
                  i.invite_token,
                  i.target_investor_user_id,
                  i.target_display_name,
                  i.target_email,
                  i.target_phone,
                  i.source,
                  i.status,
                  i.delivery_channel,
                  i.scope_template_id,
                  i.expires_at,
                  i.created_at,
                  (active_upload.id IS NOT NULL) AS has_active_pick_upload
                FROM ria_profiles rp
                JOIN ria_client_invites i ON i.ria_profile_id = rp.id
                LEFT JOIN advisor_investor_relationships rel
                  ON rel.ria_profile_id = rp.id
                  AND rel.investor_user_id = COALESCE(i.accepted_by_user_id, i.target_investor_user_id)
                LEFT JOIN LATERAL (
                  SELECT 1 AS id
                  FROM pkm_blobs
                  WHERE user_id = rp.user_id
                    AND domain = $2
                    AND segment_id = 'root'
                  LIMIT 1
                ) active_upload ON TRUE
                WHERE rp.user_id = $1
                  AND i.status = 'sent'
                  AND i.expires_at > NOW()
                  AND rel.id IS NULL
                ORDER BY i.created_at DESC
                """,
                user_id,
                _RIA_PICKS_PKM_DOMAIN,
            )

            items: list[dict[str, Any]] = []
            for row in relationship_rows:
                payload = dict(row)
                has_active_pick_upload = bool(payload.get("has_active_pick_upload"))
                relationship_shares: list[dict[str, Any]] = []
                if payload.get("picks_share_id"):
                    relationship_shares.append(
                        self._serialize_relationship_share(
                            {
                                "grant_key": _RELATIONSHIP_SHARE_ACTIVE_PICKS,
                                "status": payload.get("picks_share_status"),
                                "granted_at": payload.get("picks_share_granted_at"),
                                "revoked_at": payload.get("picks_share_revoked_at"),
                                "metadata": payload.get("picks_share_metadata"),
                            },
                            has_active_pick_upload=has_active_pick_upload,
                        )
                    )
                payload["acquisition_source"] = payload.get("acquisition_source") or (
                    "marketplace" if payload.get("investor_display_name") else "manual"
                )
                payload["relationship_status"] = payload.get("status")
                payload["next_action"] = self._next_action_for_relationship_status(
                    str(payload.get("status") or "")
                )
                payload["relationship_shares"] = relationship_shares
                payload["picks_feed_status"] = self._picks_feed_status(
                    relationship_status=str(payload.get("status") or ""),
                    share_status=str(payload.get("picks_share_status") or ""),
                    has_active_pick_upload=has_active_pick_upload,
                )
                payload["picks_feed_granted_at"] = payload.get("picks_share_granted_at")
                payload["has_active_pick_upload"] = has_active_pick_upload
                payload["is_invite_only"] = False
                payload["disconnect_allowed"] = bool(payload.get("investor_user_id"))
                payload["is_self_relationship"] = (
                    str(payload.get("investor_user_id") or "") == user_id
                )
                items.append(payload)

            for row in invite_rows:
                payload = dict(row)
                headline = (
                    payload.get("target_email") or payload.get("target_phone") or "Invite pending"
                )
                items.append(
                    {
                        "id": f"invite:{payload['id']}",
                        "invite_id": str(payload["id"]),
                        "invite_token": payload["invite_token"],
                        "investor_user_id": payload.get("target_investor_user_id"),
                        "status": "invited",
                        "granted_scope": None,
                        "last_request_id": None,
                        "consent_granted_at": None,
                        "revoked_at": None,
                        "investor_display_name": payload.get("target_display_name")
                        or payload.get("target_email")
                        or payload.get("target_phone")
                        or "Invited investor",
                        "investor_headline": headline,
                        "acquisition_source": payload.get("source") or "manual",
                        "invite_status": payload.get("status"),
                        "delivery_channel": payload.get("delivery_channel"),
                        "consent_expires_at": None,
                        "invite_expires_at": payload.get("expires_at"),
                        "next_action": "await_acceptance",
                        "scope_template_id": payload.get("scope_template_id"),
                        "is_invite_only": True,
                        "relationship_status": "invited",
                        "investor_email": payload.get("target_email"),
                        "investor_secondary_label": payload.get("target_email")
                        or payload.get("target_phone")
                        or "Invite pending",
                        "relationship_shares": [],
                        "picks_feed_status": self._picks_feed_status(
                            relationship_status="invited",
                            share_status=None,
                            has_active_pick_upload=bool(payload.get("has_active_pick_upload")),
                        ),
                        "picks_feed_granted_at": None,
                        "has_active_pick_upload": bool(payload.get("has_active_pick_upload")),
                        "disconnect_allowed": False,
                        "is_self_relationship": str(payload.get("target_investor_user_id") or "")
                        == user_id,
                    }
                )
            normalized_status = self._normalize_client_status_filter(status)
            filtered = [
                item
                for item in items
                if self._matches_search(item, query)
                and (
                    normalized_status is None
                    or str(item.get("status") or "").strip().lower() == normalized_status
                )
            ]
            filtered.sort(
                key=lambda item: str(
                    item.get("consent_granted_at")
                    or item.get("invite_expires_at")
                    or item.get("id")
                    or ""
                ),
                reverse=True,
            )
            safe_limit = max(1, min(int(limit or 50), 100))
            safe_page = max(1, int(page or 1))
            start = (safe_page - 1) * safe_limit
            end = start + safe_limit

            return {
                "items": filtered[start:end],
                "total": len(filtered),
                "page": safe_page,
                "limit": safe_limit,
                "has_more": end < len(filtered),
            }
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()

    async def get_ria_client_detail(
        self,
        user_id: str,
        investor_user_id: str,
    ) -> dict[str, Any]:
        conn = await self._conn()
        try:
            await self._ensure_iam_schema_ready(conn)
            ria = await self._get_ria_profile_by_user(conn, user_id)
            identity_select_sql, identity_join_sql = await self._investor_identity_projection(
                conn,
                user_id_sql="rel.investor_user_id",
            )
            relationship_query = "\n".join(
                [
                    "SELECT",
                    "  rel.id,",
                    "  rel.investor_user_id,",
                    "  rel.status,",
                    "  rel.granted_scope,",
                    "  rel.last_request_id,",
                    "  rel.consent_granted_at,",
                    "  rel.revoked_at,",
                    "  rel.created_at,",
                    "  rel.updated_at,",
                    f"  {identity_select_sql},",
                    "  picks_share.id AS picks_share_id,",
                    "  picks_share.status AS picks_share_status,",
                    "  picks_share.granted_at AS picks_share_granted_at,",
                    "  picks_share.revoked_at AS picks_share_revoked_at,",
                    "  picks_share.metadata AS picks_share_metadata,",
                    "  (active_upload.id IS NOT NULL) AS has_active_pick_upload",
                    "FROM advisor_investor_relationships rel",
                    identity_join_sql,
                    "LEFT JOIN marketplace_public_profiles mp",
                    "  ON mp.user_id = rel.investor_user_id",
                    "  AND mp.profile_type = 'investor'",
                    "LEFT JOIN relationship_share_grants picks_share",
                    "  ON picks_share.relationship_id = rel.id",
                    "  AND picks_share.grant_key = $3",
                    "LEFT JOIN LATERAL (",
                    "  SELECT id",
                    "  FROM ria_pick_share_artifacts",
                    "  WHERE relationship_id = rel.id",
                    "    AND grant_key = $3",
                    "    AND status = 'active'",
                    "  ORDER BY updated_at DESC",
                    "  LIMIT 1",
                    ") active_upload ON TRUE",
                    "WHERE rel.investor_user_id = $1",
                    "  AND rel.ria_profile_id = $2",
                    "ORDER BY rel.updated_at DESC",
                    "LIMIT 1",
                ]
            )
            relationship = await conn.fetchrow(
                relationship_query,
                investor_user_id,
                ria["id"],
                _RELATIONSHIP_SHARE_ACTIVE_PICKS,
            )
            if relationship is None:
                raise RIAIAMPolicyError("Relationship not found", status_code=404)
            relationship_payload = dict(relationship)

            agent_id = f"ria:{ria['id']}"
            consent_rows = await conn.fetch(
                """
                SELECT request_id, scope, action, expires_at, issued_at, metadata
                FROM consent_audit
                WHERE user_id = $1
                  AND agent_id = $2
                  AND action IN ('REQUESTED', 'CONSENT_GRANTED', 'CONSENT_DENIED', 'CANCELLED', 'REVOKED', 'TIMEOUT')
                ORDER BY issued_at DESC
                """,
                investor_user_id,
                agent_id,
            )
            latest_by_scope: dict[str, dict[str, Any]] = {}
            latest_by_request: dict[str, dict[str, Any]] = {}
            for row in consent_rows:
                payload = dict(row)
                payload["metadata"] = self._parse_metadata(payload.get("metadata"))
                scope_key = str(payload.get("scope") or "").strip()
                request_key = str(payload.get("request_id") or "").strip()
                if scope_key and scope_key not in latest_by_scope:
                    latest_by_scope[scope_key] = payload
                if request_key and request_key not in latest_by_request:
                    latest_by_request[request_key] = payload

            now_ms = self._now_ms()
            granted_scopes = [
                {
                    "scope": scope,
                    "label": get_scope_description(scope),
                    "expires_at": payload.get("expires_at"),
                    "issued_at": payload.get("issued_at"),
                }
                for scope, payload in latest_by_scope.items()
                if payload.get("action") == "CONSENT_GRANTED"
                and (payload.get("expires_at") is None or int(payload["expires_at"]) > now_ms)
            ]

            request_history = sorted(
                [
                    {
                        "request_id": payload.get("request_id"),
                        "scope": payload.get("scope"),
                        "action": payload.get("action"),
                        "issued_at": payload.get("issued_at"),
                        "expires_at": payload.get("expires_at"),
                        "bundle_id": payload.get("metadata", {}).get("bundle_id"),
                        "bundle_label": payload.get("metadata", {}).get("bundle_label"),
                        "scope_metadata": self._scope_metadata(str(payload.get("scope") or "")),
                    }
                    for payload in latest_by_request.values()
                ],
                key=lambda item: int(item.get("issued_at") or 0),
                reverse=True,
            )

            invite_rows = await conn.fetch(
                """
                SELECT
                  id,
                  invite_token,
                  status,
                  delivery_channel,
                  scope_template_id,
                  target_display_name,
                  target_email,
                  expires_at,
                  created_at,
                  accepted_at
                FROM ria_client_invites
                WHERE ria_profile_id = $1
                  AND (
                    accepted_by_user_id = $2
                    OR (
                      target_investor_user_id IS NOT NULL
                      AND target_investor_user_id = $2
                    )
                  )
                ORDER BY created_at DESC
                LIMIT 5
                """,
                ria["id"],
                investor_user_id,
            )

            metadata_row = await conn.fetchrow(
                """
                SELECT
                  available_domains,
                  domain_summaries,
                  total_attributes,
                  updated_at
                FROM pkm_index
                WHERE user_id = $1
                """,
                investor_user_id,
            )

            available_domains = (
                self._parse_string_list(metadata_row["available_domains"]) if metadata_row else []
            )
            raw_domain_summaries = (
                self._parse_metadata(metadata_row["domain_summaries"]) if metadata_row else {}
            )
            total_attributes = int(metadata_row["total_attributes"] or 0) if metadata_row else 0
            updated_at = metadata_row["updated_at"] if metadata_row else None
            available_scope_metadata = self._build_available_scope_metadata(
                available_domains=available_domains,
                total_attributes=total_attributes,
            )
            granted_payloads = [
                payload
                for payload in latest_by_scope.values()
                if payload.get("action") == "CONSENT_GRANTED"
                and (payload.get("expires_at") is None or int(payload["expires_at"]) > now_ms)
            ]
            pending_payloads = [
                payload
                for payload in latest_by_request.values()
                if payload.get("action") == "REQUESTED"
            ]
            account_branches = await self._list_linked_account_branches(
                conn,
                investor_user_id=investor_user_id,
            )
            kai_specialized_bundle, scoped_account_branches = (
                self._build_kai_specialized_bundle_state(
                    account_branches=account_branches,
                    granted_payloads=granted_payloads,
                    pending_payloads=pending_payloads,
                )
            )
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()

        try:
            requestable_scope_templates = await self.list_requestable_scope_templates(user_id)
        except RIAIAMPolicyError:
            requestable_scope_templates = []

        consent_expires_at = max(
            (item["expires_at"] for item in granted_scopes if item.get("expires_at")),
            default=None,
        )
        relationship_status = str(relationship_payload["status"] or "")
        reveal_workspace_metadata = bool(granted_scopes) and relationship_status == "approved"
        has_active_pick_upload = bool(relationship_payload.get("has_active_pick_upload"))
        relationship_shares: list[dict[str, Any]] = []
        if relationship_payload.get("picks_share_id"):
            relationship_shares.append(
                self._serialize_relationship_share(
                    {
                        "grant_key": _RELATIONSHIP_SHARE_ACTIVE_PICKS,
                        "status": relationship_payload.get("picks_share_status"),
                        "granted_at": relationship_payload.get("picks_share_granted_at"),
                        "revoked_at": relationship_payload.get("picks_share_revoked_at"),
                        "metadata": relationship_payload.get("picks_share_metadata"),
                    },
                    has_active_pick_upload=has_active_pick_upload,
                )
            )

        return {
            "investor_user_id": investor_user_id,
            "investor_display_name": relationship_payload["investor_display_name"],
            "investor_email": relationship_payload.get("investor_email"),
            "investor_secondary_label": relationship_payload.get("investor_secondary_label"),
            "investor_headline": relationship_payload["investor_headline"],
            "relationship_status": relationship_status,
            "granted_scope": relationship_payload["granted_scope"],
            "last_request_id": relationship_payload["last_request_id"],
            "consent_granted_at": self._serialize_datetime_value(
                relationship_payload["consent_granted_at"]
            ),
            "consent_expires_at": consent_expires_at,
            "revoked_at": self._serialize_datetime_value(relationship_payload["revoked_at"]),
            "created_at": self._serialize_datetime_value(relationship_payload["created_at"]),
            "updated_at": self._serialize_datetime_value(relationship_payload["updated_at"]),
            "disconnect_allowed": True,
            "is_self_relationship": investor_user_id == user_id,
            "next_action": self._next_action_for_relationship_status(
                str(relationship_payload["status"] or "")
            ),
            "relationship_shares": relationship_shares,
            "picks_feed_status": self._picks_feed_status(
                relationship_status=relationship_status,
                share_status=str(relationship_payload.get("picks_share_status") or ""),
                has_active_pick_upload=has_active_pick_upload,
            ),
            "picks_feed_granted_at": self._serialize_datetime_value(
                relationship_payload.get("picks_share_granted_at")
            ),
            "has_active_pick_upload": has_active_pick_upload,
            "granted_scopes": granted_scopes,
            "request_history": request_history[:8],
            "invite_history": [
                {
                    "invite_id": str(item["id"]),
                    "invite_token": item["invite_token"],
                    "status": item["status"],
                    "delivery_channel": item["delivery_channel"],
                    "scope_template_id": item["scope_template_id"],
                    "target_display_name": item["target_display_name"],
                    "target_email": item["target_email"],
                    "expires_at": item["expires_at"],
                    "created_at": item["created_at"],
                    "accepted_at": item["accepted_at"],
                }
                for item in invite_rows
            ],
            "requestable_scope_templates": requestable_scope_templates,
            "available_scope_metadata": available_scope_metadata,
            "kai_specialized_bundle": kai_specialized_bundle,
            "account_branches": scoped_account_branches,
            "available_domains": available_domains,
            # Relationship detail only exposes metadata-level availability before consent.
            "domain_summaries": raw_domain_summaries if reveal_workspace_metadata else {},
            "total_attributes": total_attributes,
            "workspace_ready": bool(granted_scopes) and total_attributes > 0,
            "pkm_updated_at": self._serialize_datetime_value(updated_at),
        }

    async def disconnect_relationship(
        self,
        auth_user_id: str,
        *,
        investor_user_id: str | None = None,
        ria_profile_id: str | None = None,
    ) -> dict[str, Any]:
        resolved_investor_user_id = str(investor_user_id or "").strip() or None
        resolved_ria_profile_id = str(ria_profile_id or "").strip() or None
        initiated_by = "investor"

        conn = await self._conn()
        try:
            async with conn.transaction():
                await self._ensure_iam_schema_ready(conn)

                if resolved_investor_user_id:
                    ria = await self._get_ria_profile_by_user(conn, auth_user_id)
                    resolved_ria_profile_id = str(ria["id"])
                    initiated_by = "ria"
                elif resolved_ria_profile_id:
                    resolved_investor_user_id = auth_user_id
                    initiated_by = "investor"
                else:
                    raise RIAIAMPolicyError(
                        "Relationship disconnect requires an investor or RIA identifier",
                        status_code=400,
                    )

                relationship = await conn.fetchrow(
                    """
                    SELECT id, investor_user_id, ria_profile_id, status, last_request_id
                    FROM advisor_investor_relationships
                    WHERE investor_user_id = $1
                      AND ria_profile_id = $2::uuid
                    ORDER BY updated_at DESC
                    LIMIT 1
                    """,
                    resolved_investor_user_id,
                    resolved_ria_profile_id,
                )
                if relationship is None:
                    raise RIAIAMPolicyError("Relationship not found", status_code=404)

                agent_id = f"ria:{resolved_ria_profile_id}"
                consent_rows = await conn.fetch(
                    """
                    SELECT scope, action, expires_at, issued_at
                    FROM consent_audit
                    WHERE user_id = $1
                      AND agent_id = $2
                      AND action IN ('CONSENT_GRANTED', 'REVOKED')
                    ORDER BY issued_at DESC
                    """,
                    resolved_investor_user_id,
                    agent_id,
                )
                latest_by_scope: dict[str, asyncpg.Record] = {}
                for row in consent_rows:
                    scope_key = str(row["scope"] or "").strip()
                    if not scope_key or scope_key in latest_by_scope:
                        continue
                    latest_by_scope[scope_key] = row

                active_scopes = [
                    scope
                    for scope, row in latest_by_scope.items()
                    if row["action"] == "CONSENT_GRANTED"
                    and (row["expires_at"] is None or int(row["expires_at"]) > self._now_ms())
                ]

                issued_at = self._now_ms()
                for scope in active_scopes:
                    await conn.execute(
                        """
                        INSERT INTO consent_audit (
                          token_id,
                          user_id,
                          agent_id,
                          scope,
                          action,
                          request_id,
                          scope_description,
                          issued_at,
                          metadata
                        )
                        VALUES ($1, $2, $3, $4, 'REVOKED', $5, $6, $7, $8::jsonb)
                        """,
                        f"evt_disconnect_{issued_at}_{scope}",
                        resolved_investor_user_id,
                        agent_id,
                        scope,
                        relationship["last_request_id"],
                        get_scope_description(scope),
                        issued_at,
                        json.dumps(
                            {
                                "disconnect_origin": initiated_by,
                                "relationship_disconnect": True,
                            }
                        ),
                    )

                await conn.execute(
                    """
                    UPDATE advisor_investor_relationships
                    SET
                      status = 'disconnected',
                      revoked_at = NOW(),
                      updated_at = NOW()
                    WHERE id = $1
                    """,
                    relationship["id"],
                )
                await self._revoke_relationship_share_grant(
                    conn,
                    relationship_id=str(relationship["id"]),
                    grant_key=_RELATIONSHIP_SHARE_ACTIVE_PICKS,
                    status="revoked",
                    reason=f"relationship_disconnect:{initiated_by}",
                )

                return {
                    "investor_user_id": resolved_investor_user_id,
                    "ria_profile_id": resolved_ria_profile_id,
                    "relationship_status": "disconnected",
                    "revoked_scopes": active_scopes,
                    "initiated_by": initiated_by,
                }
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()

    async def list_ria_requests(self, user_id: str) -> list[dict[str, Any]]:
        conn = await self._conn()
        try:
            await self._ensure_iam_schema_ready(conn)
            ria = await conn.fetchrow(
                "SELECT id FROM ria_profiles WHERE user_id = $1",
                user_id,
            )
            if ria is None:
                return []

            agent_id = f"ria:{ria['id']}"
            rows = await conn.fetch(
                """
                SELECT
                  audit.request_id,
                  audit.user_id,
                  audit.scope,
                  audit.action,
                  audit.issued_at,
                  audit.expires_at,
                  audit.metadata,
                  mp.display_name AS subject_display_name,
                  mp.headline AS subject_headline
                FROM consent_audit audit
                LEFT JOIN marketplace_public_profiles mp
                  ON mp.user_id = audit.user_id
                  AND mp.profile_type = 'investor'
                WHERE audit.agent_id = $1
                  AND audit.request_id IS NOT NULL
                  AND audit.action IN (
                    'REQUESTED',
                    'CONSENT_GRANTED',
                    'CONSENT_DENIED',
                    'CANCELLED',
                    'REVOKED',
                    'TIMEOUT'
                  )
                ORDER BY audit.issued_at DESC
                """,
                agent_id,
            )

            latest_by_request: dict[str, dict[str, Any]] = {}
            for row in rows:
                request_id = row["request_id"]
                if not request_id:
                    continue
                if request_id in latest_by_request:
                    continue
                payload = dict(row)
                payload["metadata"] = self._parse_metadata(payload.get("metadata"))
                latest_by_request[str(request_id)] = payload

            return list(latest_by_request.values())
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()

    async def list_ria_request_bundles(self, user_id: str) -> list[dict[str, Any]]:
        requests = await self.list_ria_requests(user_id)
        bundles: dict[str, dict[str, Any]] = {}
        for item in requests:
            metadata = self._parse_metadata(item.get("metadata"))
            bundle_id = str(metadata.get("bundle_id") or item.get("request_id") or uuid.uuid4().hex)
            bundle = bundles.setdefault(
                bundle_id,
                {
                    "bundle_id": bundle_id,
                    "bundle_label": metadata.get("bundle_label") or "Portfolio access request",
                    "subject_user_id": item.get("user_id"),
                    "subject_display_name": item.get("subject_display_name"),
                    "subject_headline": item.get("subject_headline"),
                    "status": item.get("action"),
                    "issued_at": item.get("issued_at"),
                    "expires_at": item.get("expires_at"),
                    "request_count": 0,
                    "requests": [],
                },
            )
            bundle["request_count"] += 1
            bundle["requests"].append(
                {
                    "request_id": item.get("request_id"),
                    "scope": item.get("scope"),
                    "action": item.get("action"),
                    "issued_at": item.get("issued_at"),
                    "expires_at": item.get("expires_at"),
                    "scope_metadata": self._scope_metadata(str(item.get("scope") or "")),
                }
            )
            if str(item.get("action") or "").upper() == "REQUESTED":
                bundle["status"] = "REQUESTED"
            if not bundle.get("subject_display_name") and item.get("subject_display_name"):
                bundle["subject_display_name"] = item.get("subject_display_name")
            if not bundle.get("subject_headline") and item.get("subject_headline"):
                bundle["subject_headline"] = item.get("subject_headline")

        bundle_list = list(bundles.values())
        bundle_list.sort(key=lambda item: int(item.get("issued_at") or 0), reverse=True)
        return bundle_list

    async def list_ria_invites(self, user_id: str) -> list[dict[str, Any]]:
        conn = await self._conn()
        try:
            await self._ensure_iam_schema_ready(conn)
            rows = await conn.fetch(
                """
                SELECT
                  i.id,
                  i.invite_token,
                  i.target_display_name,
                  i.target_email,
                  i.target_phone,
                  i.target_investor_user_id,
                  i.source,
                  i.delivery_channel,
                  i.status,
                  i.scope_template_id,
                  i.duration_mode,
                  i.duration_hours,
                  i.reason,
                  i.metadata,
                  i.accepted_by_user_id,
                  i.accepted_request_id,
                  i.expires_at,
                  i.accepted_at,
                  i.created_at
                FROM ria_profiles rp
                JOIN ria_client_invites i ON i.ria_profile_id = rp.id
                WHERE rp.user_id = $1
                ORDER BY i.created_at DESC
                """,
                user_id,
            )
            items: list[dict[str, Any]] = []
            for row in rows:
                payload = dict(row)
                metadata = self._parse_metadata(payload.get("metadata"))
                delivery = self._parse_metadata(metadata.get("invite_email_delivery"))
                payload.pop("metadata", None)
                if delivery:
                    payload["delivery_status"] = delivery.get("status")
                    payload["delivery_message"] = delivery.get("error") or delivery.get("recipient")
                    payload["delivery_message_id"] = delivery.get("message_id")
                items.append(payload)
            return items
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()

    @staticmethod
    def _parse_pick_csv(content: str) -> list[dict[str, Any]]:
        reader = csv.DictReader(io.StringIO(content))
        if not reader.fieldnames:
            raise RIAIAMPolicyError("Uploaded CSV is missing a header row", status_code=400)

        normalized_headers = {str(name or "").strip().lower() for name in reader.fieldnames}
        required_headers = {"ticker", "company_name", "sector", "tier", "investment_thesis"}
        missing_headers = sorted(required_headers - normalized_headers)
        if missing_headers:
            raise RIAIAMPolicyError(
                f"Uploaded CSV is missing required columns: {', '.join(missing_headers)}",
                status_code=400,
            )

        symbol_master = get_symbol_master_service()
        rows: list[dict[str, Any]] = []
        row_errors: list[str] = []
        seen_tickers: set[str] = set()
        for csv_row_number, row in enumerate(reader, start=2):
            normalized_row = {key: str(value or "").strip() for key, value in row.items()}
            if not any(normalized_row.values()):
                continue

            ticker = symbol_master.normalize(normalized_row.get("ticker"))
            if not ticker:
                row_errors.append(f"Row {csv_row_number}: ticker is required")
                continue

            if ticker in seen_tickers:
                row_errors.append(f"Row {csv_row_number}: duplicate ticker {ticker}")
                continue

            metadata = symbol_master.get_ticker_metadata(ticker)
            if not metadata:
                row_errors.append(
                    f"Row {csv_row_number}: ticker {ticker} is not in the SEC-backed ticker list"
                )
                continue

            if metadata.get("tradable") is False:
                row_errors.append(
                    f"Row {csv_row_number}: ticker {ticker} is not an active tradable symbol"
                )
                continue

            company_name = (
                normalized_row.get("company_name")
                or str(metadata.get("title") or "").strip()
                or None
            )
            sector = (
                normalized_row.get("sector")
                or str(metadata.get("sector_primary") or metadata.get("sector") or "").strip()
                or None
            )
            tier = (normalized_row.get("tier") or "").upper() or None
            investment_thesis = normalized_row.get("investment_thesis") or None

            missing_values = [
                field
                for field, value in (
                    ("company_name", company_name),
                    ("sector", sector),
                    ("tier", tier),
                    ("investment_thesis", investment_thesis),
                )
                if not value
            ]
            if missing_values:
                row_errors.append(
                    f"Row {csv_row_number}: missing required values for {', '.join(missing_values)}"
                )
                continue

            rows.append(
                {
                    "sort_order": len(rows) + 1,
                    "ticker": ticker,
                    "company_name": company_name,
                    "sector": sector,
                    "tier": tier,
                    "tier_rank": int(normalized_row["tier_rank"])
                    if normalized_row.get("tier_rank", "").isdigit()
                    else None,
                    "conviction_weight": float(normalized_row["conviction_weight"])
                    if normalized_row.get("conviction_weight")
                    else None,
                    "recommendation_bias": normalized_row.get("recommendation_bias") or None,
                    "investment_thesis": investment_thesis,
                    "fcf_billions": float(normalized_row["fcf_billions"])
                    if normalized_row.get("fcf_billions")
                    else None,
                }
            )
            seen_tickers.add(ticker)

        if row_errors:
            raise RIAIAMPolicyError("; ".join(row_errors[:8]), status_code=400)
        if not rows:
            raise RIAIAMPolicyError("Uploaded CSV did not contain any valid rows", status_code=400)
        return rows

    @staticmethod
    def _coerce_package_rows(rows: Any) -> list[dict[str, Any]]:
        if not isinstance(rows, list):
            return []
        return [dict(row) for row in rows if isinstance(row, dict)]

    def _normalize_top_pick_rows(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        symbol_master = get_symbol_master_service()
        normalized_rows: list[dict[str, Any]] = []
        row_errors: list[str] = []
        seen_tickers: set[str] = set()
        for index, row in enumerate(rows, start=1):
            ticker = symbol_master.normalize(row.get("ticker"))
            if not ticker:
                row_errors.append(f"Top picks row {index}: ticker is required")
                continue
            if ticker in seen_tickers:
                row_errors.append(f"Top picks row {index}: duplicate ticker {ticker}")
                continue
            metadata = symbol_master.get_ticker_metadata(ticker)
            if not metadata or metadata.get("tradable") is False:
                row_errors.append(
                    f"Top picks row {index}: ticker {ticker} must be an SEC-backed tradable symbol"
                )
                continue
            tier = str(row.get("tier") or "").strip().upper()
            thesis = str(row.get("investment_thesis") or "").strip()
            if not tier:
                row_errors.append(f"Top picks row {index}: tier is required")
                continue
            if not thesis:
                row_errors.append(f"Top picks row {index}: investment_thesis is required")
                continue
            normalized_rows.append(
                {
                    "sort_order": len(normalized_rows) + 1,
                    "ticker": ticker,
                    "company_name": str(metadata.get("title") or "").strip() or None,
                    "sector": str(
                        metadata.get("sector_primary") or metadata.get("sector") or ""
                    ).strip()
                    or None,
                    "tier": tier,
                    "tier_rank": row.get("tier_rank"),
                    "conviction_weight": row.get("conviction_weight"),
                    "recommendation_bias": row.get("recommendation_bias"),
                    "investment_thesis": thesis,
                    "fcf_billions": row.get("fcf_billions"),
                }
            )
            seen_tickers.add(ticker)
        if row_errors:
            raise RIAIAMPolicyError("; ".join(row_errors[:8]), status_code=400)
        return normalized_rows

    def _normalize_avoid_rows(
        self,
        rows: list[dict[str, Any]],
        *,
        top_pick_tickers: set[str],
    ) -> list[dict[str, Any]]:
        symbol_master = get_symbol_master_service()
        normalized_rows: list[dict[str, Any]] = []
        row_errors: list[str] = []
        seen_tickers: set[str] = set()
        for index, row in enumerate(rows, start=1):
            ticker = symbol_master.normalize(row.get("ticker"))
            if not ticker:
                row_errors.append(f"Avoid row {index}: ticker is required")
                continue
            if ticker in seen_tickers:
                row_errors.append(f"Avoid row {index}: duplicate ticker {ticker}")
                continue
            if ticker in top_pick_tickers:
                row_errors.append(
                    f"Avoid row {index}: ticker {ticker} cannot appear in both Top picks and Avoid"
                )
                continue
            metadata = symbol_master.get_ticker_metadata(ticker)
            if not metadata or metadata.get("tradable") is False:
                row_errors.append(
                    f"Avoid row {index}: ticker {ticker} must be an SEC-backed tradable symbol"
                )
                continue
            reason = str(
                row.get("why_avoid") or row.get("reason") or row.get("detail") or ""
            ).strip()
            if not reason:
                row_errors.append(f"Avoid row {index}: reason is required")
                continue
            normalized_rows.append(
                {
                    "sort_order": len(normalized_rows) + 1,
                    "ticker": ticker,
                    "company_name": str(metadata.get("title") or "").strip() or None,
                    "sector": str(
                        metadata.get("sector_primary") or metadata.get("sector") or ""
                    ).strip()
                    or None,
                    "category": str(row.get("category") or "").strip() or None,
                    "why_avoid": reason,
                    "note": str(row.get("note") or "").strip() or None,
                }
            )
            seen_tickers.add(ticker)
        if row_errors:
            raise RIAIAMPolicyError("; ".join(row_errors[:8]), status_code=400)
        return normalized_rows

    def _normalize_screening_sections(self, sections: list[dict[str, Any]]) -> list[dict[str, Any]]:
        raw_by_key = {
            str(section.get("section") or section.get("key") or "").strip(): section
            for section in sections
            if isinstance(section, dict)
        }
        normalized_sections: list[dict[str, Any]] = []
        row_errors: list[str] = []
        for section_key in _RIA_SCREENING_SECTION_ORDER:
            raw_section = raw_by_key.get(section_key) or {}
            raw_rows = raw_section.get("rows")
            if not isinstance(raw_rows, list):
                raw_rows = []
            seen_math_signatures: set[str] = set()
            normalized_rows: list[dict[str, Any]] = []
            for index, row in enumerate(raw_rows, start=1):
                if not isinstance(row, dict):
                    continue
                title = str(row.get("title") or "").strip()
                detail = str(row.get("detail") or "").strip()
                value_text = str(row.get("value_text") or "").strip() or None
                if not title or not detail:
                    row_errors.append(
                        f"Screening row {section_key}:{index}: title and detail are required"
                    )
                    continue
                signature = f"{section_key}|{title.lower()}|{detail.lower()}|{str(value_text or '').lower()}"
                if section_key == "the_math":
                    if signature in seen_math_signatures:
                        continue
                    seen_math_signatures.add(signature)
                normalized_rows.append(
                    {
                        "rule_index": len(normalized_rows) + 1,
                        "title": title,
                        "detail": detail,
                        "value_text": value_text,
                    }
                )
            normalized_sections.append({"section": section_key, "rows": normalized_rows})
        if row_errors:
            raise RIAIAMPolicyError("; ".join(row_errors[:8]), status_code=400)
        return normalized_sections

    def _build_pick_package_metadata(
        self,
        *,
        avoid_rows: list[dict[str, Any]],
        screening_sections: list[dict[str, Any]],
        package_note: str | None,
    ) -> dict[str, Any]:
        return {
            "package_version": 1,
            "package_note": str(package_note or "").strip() or None,
            "avoid_rows": avoid_rows,
            "screening_sections": screening_sections,
        }

    @staticmethod
    def _empty_pick_package_response() -> dict[str, Any]:
        return {
            "top_picks": [],
            "avoid_rows": [],
            "screening_sections": [
                {"section": section_key, "rows": []} for section_key in _RIA_SCREENING_SECTION_ORDER
            ],
            "package_note": None,
        }

    def _normalize_pick_package(
        self,
        *,
        top_picks: list[dict[str, Any]],
        avoid_rows: list[dict[str, Any]],
        screening_sections: list[dict[str, Any]],
        package_note: str | None,
    ) -> dict[str, Any]:
        normalized_top_picks = self._normalize_top_pick_rows(top_picks)
        normalized_avoid_rows = self._normalize_avoid_rows(
            avoid_rows,
            top_pick_tickers={row["ticker"] for row in normalized_top_picks},
        )
        normalized_screening_sections = self._normalize_screening_sections(screening_sections)
        return {
            "top_picks": normalized_top_picks,
            "avoid_rows": normalized_avoid_rows,
            "screening_sections": normalized_screening_sections,
            "package_metadata": self._build_pick_package_metadata(
                avoid_rows=normalized_avoid_rows,
                screening_sections=normalized_screening_sections,
                package_note=package_note,
            ),
        }

    @staticmethod
    def _normalize_pick_package_response(
        top_picks: list[dict[str, Any]],
        package_metadata: dict[str, Any] | None,
    ) -> dict[str, Any]:
        metadata = package_metadata if isinstance(package_metadata, dict) else {}
        raw_avoid_rows = metadata.get("avoid_rows")
        raw_screening_sections = metadata.get("screening_sections")
        avoid_rows = raw_avoid_rows if isinstance(raw_avoid_rows, list) else []
        screening_sections = (
            raw_screening_sections if isinstance(raw_screening_sections, list) else []
        )
        package_note = str(metadata.get("package_note") or "").strip() or None
        normalized_sections = [
            {
                "section": str(section.get("section") or section.get("key") or "").strip(),
                "rows": [
                    dict(row)
                    for row in (section.get("rows") if isinstance(section, dict) else [])
                    if isinstance(row, dict)
                ],
            }
            for section in screening_sections
            if isinstance(section, dict)
        ]
        if not normalized_sections:
            normalized_sections = [
                {"section": section_key, "rows": []} for section_key in _RIA_SCREENING_SECTION_ORDER
            ]
        return {
            "top_picks": top_picks,
            "avoid_rows": [dict(row) for row in avoid_rows if isinstance(row, dict)],
            "screening_sections": normalized_sections,
            "package_note": package_note,
        }

    @staticmethod
    def _count_screening_rows(screening_sections: list[dict[str, Any]] | None) -> int:
        if not isinstance(screening_sections, list):
            return 0
        total = 0
        for section in screening_sections:
            if not isinstance(section, dict):
                continue
            rows = section.get("rows")
            if isinstance(rows, list):
                total += len(rows)
        return total

    def _pick_package_has_material_content(self, package: dict[str, Any] | None) -> bool:
        if not isinstance(package, dict):
            return False
        top_picks = package.get("top_picks")
        avoid_rows = package.get("avoid_rows")
        screening_sections = package.get("screening_sections")
        package_note = str(package.get("package_note") or "").strip()
        return bool(
            (isinstance(top_picks, list) and len(top_picks) > 0)
            or (isinstance(avoid_rows, list) and len(avoid_rows) > 0)
            or self._count_screening_rows(screening_sections) > 0
            or package_note
        )

    def _build_pick_package_projection(self, package: dict[str, Any]) -> dict[str, Any]:
        normalized = self._normalize_pick_package(
            top_picks=self._coerce_package_rows(package.get("top_picks")),
            avoid_rows=self._coerce_package_rows(package.get("avoid_rows")),
            screening_sections=self._coerce_package_rows(package.get("screening_sections")),
            package_note=str(package.get("package_note") or "").strip() or None,
        )
        return self._normalize_pick_package_response(
            normalized["top_picks"],
            normalized["package_metadata"],
        )

    def _build_pick_package_summary(
        self,
        *,
        package: dict[str, Any],
        storage_source: str,
        revision: int | None,
        updated_at: str | None,
        active_share_count: int = 0,
        has_package: bool = True,
    ) -> dict[str, Any]:
        top_picks = package.get("top_picks") if isinstance(package, dict) else []
        avoid_rows = package.get("avoid_rows") if isinstance(package, dict) else []
        screening_sections = package.get("screening_sections") if isinstance(package, dict) else []
        return {
            "has_package": bool(has_package),
            "storage_source": storage_source,
            "package_revision": int(revision or 0),
            "top_pick_count": len(top_picks) if isinstance(top_picks, list) else 0,
            "avoid_count": len(avoid_rows) if isinstance(avoid_rows, list) else 0,
            "screening_row_count": self._count_screening_rows(screening_sections),
            "last_updated": updated_at,
            "active_share_count": max(0, int(active_share_count or 0)),
            "path": _RIA_PICKS_PKM_PATH,
        }

    async def _count_active_pick_shares(
        self,
        conn: asyncpg.Connection,
        *,
        ria_profile_id: str,
    ) -> int:
        count = await conn.fetchval(
            """
            SELECT COUNT(*)
            FROM advisor_investor_relationships rel
            JOIN relationship_share_grants share
              ON share.relationship_id = rel.id
             AND share.grant_key = $2
             AND share.status = 'active'
            WHERE rel.ria_profile_id = $1::uuid
              AND rel.status = 'approved'
            """,
            ria_profile_id,
            _RELATIONSHIP_SHARE_ACTIVE_PICKS,
        )
        return int(count or 0)

    async def _get_ria_pick_pkm_state(
        self,
        conn: asyncpg.Connection,
        *,
        user_id: str,
    ) -> dict[str, Any] | None:
        row = await conn.fetchrow(
            """
            SELECT
              blob.content_revision,
              blob.manifest_revision,
              blob.updated_at,
              idx.domain_summaries -> $2 AS domain_summary
            FROM pkm_blobs blob
            LEFT JOIN pkm_index idx
              ON idx.user_id = blob.user_id
            WHERE blob.user_id = $1
              AND blob.domain = $2
              AND blob.segment_id = 'root'
            ORDER BY blob.updated_at DESC
            LIMIT 1
            """,
            user_id,
            _RIA_PICKS_PKM_DOMAIN,
        )
        if row is None:
            return None
        payload = dict(row)
        payload["updated_at"] = self._serialize_datetime_value(payload.get("updated_at"))
        return payload

    async def _upsert_pick_share_artifact(
        self,
        conn: asyncpg.Connection,
        *,
        relationship_id: str,
        ria_profile_id: str,
        provider_user_id: str,
        receiver_user_id: str,
        package_projection: dict[str, Any],
        source_data_version: int | None,
        source_manifest_revision: int | None,
        label: str | None,
        package_note: str | None,
    ) -> dict[str, Any]:
        artifact_metadata = {
            "label": str(label or "").strip() or "Active advisor package",
            "package_note": str(package_note or "").strip() or None,
            "top_pick_count": len(package_projection.get("top_picks") or []),
            "avoid_count": len(package_projection.get("avoid_rows") or []),
            "screening_row_count": self._count_screening_rows(
                package_projection.get("screening_sections")
            ),
            "source_data_version": int(source_data_version or 0) or None,
            "source_manifest_revision": int(source_manifest_revision or 0) or None,
            "source_domain": _RIA_PICKS_PKM_DOMAIN,
            "source_path": _RIA_PICKS_PKM_PATH,
        }
        return dict(
            await conn.fetchrow(
                """
                INSERT INTO ria_pick_share_artifacts (
                  relationship_id,
                  ria_profile_id,
                  provider_user_id,
                  receiver_user_id,
                  grant_key,
                  status,
                  source_domain,
                  source_path,
                  source_data_version,
                  source_manifest_revision,
                  artifact_projection,
                  artifact_metadata,
                  created_at,
                  updated_at
                )
                VALUES (
                  $1::uuid,
                  $2::uuid,
                  $3,
                  $4,
                  $5,
                  'active',
                  $6,
                  $7,
                  $8,
                  $9,
                  $10::jsonb,
                  $11::jsonb,
                  NOW(),
                  NOW()
                )
                ON CONFLICT (relationship_id, grant_key) DO UPDATE
                SET
                  ria_profile_id = EXCLUDED.ria_profile_id,
                  provider_user_id = EXCLUDED.provider_user_id,
                  receiver_user_id = EXCLUDED.receiver_user_id,
                  status = 'active',
                  source_domain = EXCLUDED.source_domain,
                  source_path = EXCLUDED.source_path,
                  source_data_version = EXCLUDED.source_data_version,
                  source_manifest_revision = EXCLUDED.source_manifest_revision,
                  artifact_projection = EXCLUDED.artifact_projection,
                  artifact_metadata = EXCLUDED.artifact_metadata,
                  updated_at = NOW()
                RETURNING *
                """,
                relationship_id,
                ria_profile_id,
                provider_user_id,
                receiver_user_id,
                _RELATIONSHIP_SHARE_ACTIVE_PICKS,
                _RIA_PICKS_PKM_DOMAIN,
                _RIA_PICKS_PKM_PATH,
                source_data_version,
                source_manifest_revision,
                json.dumps(package_projection),
                json.dumps(artifact_metadata),
            )
        )

    async def _bootstrap_pick_share_artifact(
        self,
        conn: asyncpg.Connection,
        *,
        relationship_id: str,
        provider_user_id: str,
        receiver_user_id: str,
    ) -> None:
        relationship = await conn.fetchrow(
            """
            SELECT rel.ria_profile_id
            FROM advisor_investor_relationships rel
            WHERE rel.id = $1::uuid
            LIMIT 1
            """,
            relationship_id,
        )
        if relationship is None:
            return
        ria_profile_id = str(relationship["ria_profile_id"])
        prior_artifact = await conn.fetchrow(
            """
            SELECT artifact_projection, artifact_metadata, source_data_version, source_manifest_revision
            FROM ria_pick_share_artifacts
            WHERE ria_profile_id = $1::uuid
              AND grant_key = $2
              AND status = 'active'
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            ria_profile_id,
            _RELATIONSHIP_SHARE_ACTIVE_PICKS,
        )
        if prior_artifact:
            prior_artifact_payload = dict(prior_artifact)
        else:
            prior_artifact_payload = None
        if prior_artifact_payload and isinstance(
            self._parse_metadata(prior_artifact_payload.get("artifact_projection")), dict
        ):
            artifact_projection = self._parse_metadata(
                prior_artifact_payload.get("artifact_projection")
            )
            package_projection = self._build_pick_package_projection(artifact_projection)
            artifact_metadata = self._parse_metadata(
                prior_artifact_payload.get("artifact_metadata")
            )
            await self._upsert_pick_share_artifact(
                conn,
                relationship_id=relationship_id,
                ria_profile_id=ria_profile_id,
                provider_user_id=provider_user_id,
                receiver_user_id=receiver_user_id,
                package_projection=package_projection,
                source_data_version=prior_artifact_payload.get("source_data_version"),
                source_manifest_revision=prior_artifact_payload.get("source_manifest_revision"),
                label=str(artifact_metadata.get("label") or "").strip() or None,
                package_note=str(artifact_metadata.get("package_note") or "").strip() or None,
            )
            return

        legacy_package = await self._get_pick_package_for_source_legacy(
            conn,
            ria_profile_id=ria_profile_id,
        )
        if not self._pick_package_has_material_content(legacy_package):
            return
        await self._upsert_pick_share_artifact(
            conn,
            relationship_id=relationship_id,
            ria_profile_id=ria_profile_id,
            provider_user_id=provider_user_id,
            receiver_user_id=receiver_user_id,
            package_projection=legacy_package,
            source_data_version=None,
            source_manifest_revision=None,
            label="Active advisor package",
            package_note=str(legacy_package.get("package_note") or "").strip() or None,
        )

    async def _retire_legacy_pick_uploads(
        self,
        conn: asyncpg.Connection,
        *,
        ria_profile_id: str,
    ) -> None:
        await conn.execute(
            """
            DELETE FROM ria_pick_upload_rows
            WHERE upload_id IN (
              SELECT id
              FROM ria_pick_uploads
              WHERE ria_profile_id = $1::uuid
            )
            """,
            ria_profile_id,
        )
        await conn.execute(
            """
            DELETE FROM ria_pick_uploads
            WHERE ria_profile_id = $1::uuid
            """,
            ria_profile_id,
        )

    async def _get_pick_package_for_source_legacy(
        self,
        conn: asyncpg.Connection,
        *,
        ria_profile_id: str,
    ) -> dict[str, Any]:
        upload = await conn.fetchrow(
            """
            SELECT id, package_metadata
            FROM ria_pick_uploads
            WHERE ria_profile_id = $1::uuid
              AND status = 'active'
            ORDER BY activated_at DESC NULLS LAST, created_at DESC
            LIMIT 1
            """,
            ria_profile_id,
        )
        if upload is None:
            return self._empty_pick_package_response()
        rows = await conn.fetch(
            """
            SELECT
              r.ticker,
              r.company_name,
              r.sector,
              r.tier,
              r.tier_rank,
              r.conviction_weight,
              r.recommendation_bias,
              r.investment_thesis,
              r.fcf_billions
            FROM ria_pick_upload_rows r
            WHERE r.upload_id = $1
            ORDER BY r.sort_order ASC
            """,
            upload["id"],
        )
        top_picks = [dict(row) for row in rows]
        return self._normalize_pick_package_response(
            top_picks,
            self._parse_metadata(upload.get("package_metadata")),
        )

    async def get_ria_pick_bootstrap(self, user_id: str) -> dict[str, Any]:
        conn = await self._conn()
        try:
            await self._ensure_iam_schema_ready(conn)
            ria = await self._get_ria_profile_by_user(conn, user_id)
            pkm_state = await self._get_ria_pick_pkm_state(conn, user_id=user_id)
            active_share_count = await self._count_active_pick_shares(
                conn,
                ria_profile_id=str(ria["id"]),
            )
            if pkm_state is not None:
                summary = (
                    pkm_state.get("domain_summary")
                    if isinstance(pkm_state.get("domain_summary"), dict)
                    else {}
                )
                empty_package = self._empty_pick_package_response()
                metadata = self._build_pick_package_summary(
                    package=empty_package,
                    storage_source="pkm",
                    revision=int(pkm_state.get("content_revision") or 0),
                    updated_at=self._serialize_datetime_value(pkm_state.get("updated_at")),
                    active_share_count=active_share_count,
                    has_package=True,
                )
                if isinstance(summary, dict):
                    metadata["top_pick_count"] = int(summary.get("top_pick_count") or 0)
                    metadata["avoid_count"] = int(summary.get("avoid_count") or 0)
                    metadata["screening_row_count"] = int(summary.get("screening_row_count") or 0)
                    metadata["last_updated"] = (
                        str(summary.get("last_updated") or "").strip() or metadata["last_updated"]
                    )
                return {"package": empty_package, "metadata": metadata}

            legacy_package = await self._get_pick_package_for_source_legacy(
                conn,
                ria_profile_id=str(ria["id"]),
            )
            has_legacy_package = self._pick_package_has_material_content(legacy_package)
            metadata = self._build_pick_package_summary(
                package=legacy_package,
                storage_source="legacy" if has_legacy_package else "empty",
                revision=0,
                updated_at=None,
                active_share_count=active_share_count,
                has_package=has_legacy_package,
            )
            return {"package": legacy_package, "metadata": metadata}
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()

    async def sync_ria_pick_share_artifacts(
        self,
        user_id: str,
        *,
        label: str | None,
        package_note: str | None,
        top_picks: list[dict[str, Any]] | None,
        avoid_rows: list[dict[str, Any]] | None,
        screening_sections: list[dict[str, Any]] | None,
        source_data_version: int | None = None,
        source_manifest_revision: int | None = None,
        retire_legacy: bool = True,
    ) -> dict[str, Any]:
        package_projection = self._build_pick_package_projection(
            {
                "top_picks": self._coerce_package_rows(top_picks),
                "avoid_rows": self._coerce_package_rows(avoid_rows),
                "screening_sections": self._coerce_package_rows(screening_sections),
                "package_note": package_note,
            }
        )
        conn = await self._conn()
        try:
            async with conn.transaction():
                await self._ensure_iam_schema_ready(conn)
                ria = await self._get_ria_profile_by_user(conn, user_id)
                relationships = await conn.fetch(
                    """
                    SELECT rel.id, rel.investor_user_id
                    FROM advisor_investor_relationships rel
                    JOIN relationship_share_grants share
                      ON share.relationship_id = rel.id
                     AND share.grant_key = $2
                     AND share.status = 'active'
                    WHERE rel.ria_profile_id = $1
                      AND rel.status = 'approved'
                    """,
                    ria["id"],
                    _RELATIONSHIP_SHARE_ACTIVE_PICKS,
                )
                updated_relationship_ids: list[str] = []
                for relationship in relationships:
                    artifact = await self._upsert_pick_share_artifact(
                        conn,
                        relationship_id=str(relationship["id"]),
                        ria_profile_id=str(ria["id"]),
                        provider_user_id=user_id,
                        receiver_user_id=str(relationship["investor_user_id"]),
                        package_projection=package_projection,
                        source_data_version=source_data_version,
                        source_manifest_revision=source_manifest_revision,
                        label=label,
                        package_note=package_note,
                    )
                    updated_relationship_ids.append(str(artifact["relationship_id"]))

                if retire_legacy:
                    await self._retire_legacy_pick_uploads(
                        conn,
                        ria_profile_id=str(ria["id"]),
                    )

                metadata = self._build_pick_package_summary(
                    package=package_projection,
                    storage_source="pkm",
                    revision=source_data_version,
                    updated_at=datetime.now(timezone.utc).isoformat(),
                    active_share_count=len(updated_relationship_ids),
                    has_package=True,
                )
                return {
                    "status": "synced",
                    "share_artifacts_updated": len(updated_relationship_ids),
                    "retired_legacy": bool(retire_legacy),
                    "package": package_projection,
                    "metadata": metadata,
                    "relationship_ids": updated_relationship_ids,
                }
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()

    async def upload_ria_pick_list(
        self,
        user_id: str,
        *,
        csv_content: str | None,
        source_filename: str | None,
        label: str | None,
        package_note: str | None = None,
        top_picks: list[dict[str, Any]] | None = None,
        avoid_rows: list[dict[str, Any]] | None = None,
        screening_sections: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        if csv_content and str(csv_content).strip():
            package = self._normalize_pick_package(
                top_picks=self._parse_pick_csv(csv_content),
                avoid_rows=self._coerce_package_rows(avoid_rows),
                screening_sections=self._coerce_package_rows(screening_sections),
                package_note=package_note,
            )
        else:
            package = self._normalize_pick_package(
                top_picks=self._coerce_package_rows(top_picks),
                avoid_rows=self._coerce_package_rows(avoid_rows),
                screening_sections=self._coerce_package_rows(screening_sections),
                package_note=package_note,
            )
        rows = package["top_picks"]
        conn = await self._conn()
        try:
            async with conn.transaction():
                await self._ensure_iam_schema_ready(conn)
                ria = await self._get_ria_profile_by_user(conn, user_id)
                existing_upload = await conn.fetchrow(
                    """
                    SELECT id
                    FROM ria_pick_uploads
                    WHERE ria_profile_id = $1
                    ORDER BY
                      CASE WHEN status = 'active' THEN 0 ELSE 1 END ASC,
                      COALESCE(activated_at, updated_at, created_at) DESC,
                      created_at DESC
                    LIMIT 1
                    """,
                    ria["id"],
                )
                if existing_upload is None:
                    upload = await conn.fetchrow(
                        """
                        INSERT INTO ria_pick_uploads (
                          ria_profile_id,
                          uploaded_by_user_id,
                          label,
                          status,
                          source_filename,
                          row_count,
                          template_version,
                          package_metadata,
                          activated_at,
                          updated_at
                        )
                        VALUES ($1, $2, $3, 'active', $4, $5, 1, $6::jsonb, NOW(), NOW())
                        RETURNING id, created_at, activated_at
                        """,
                        ria["id"],
                        user_id,
                        (label or "").strip() or "Active advisor package",
                        (source_filename or "").strip() or None,
                        len(rows),
                        json.dumps(package["package_metadata"]),
                    )
                else:
                    upload = await conn.fetchrow(
                        """
                        UPDATE ria_pick_uploads
                        SET
                          uploaded_by_user_id = $2,
                          label = $3,
                          status = 'active',
                          source_filename = $4,
                          row_count = $5,
                          template_version = 1,
                          package_metadata = $6::jsonb,
                          activated_at = NOW(),
                          updated_at = NOW()
                        WHERE id = $1
                        RETURNING id, created_at, activated_at
                        """,
                        existing_upload["id"],
                        user_id,
                        (label or "").strip() or "Active advisor package",
                        (source_filename or "").strip() or None,
                        len(rows),
                        json.dumps(package["package_metadata"]),
                    )
                    await conn.execute(
                        """
                        DELETE FROM ria_pick_upload_rows
                        WHERE upload_id = $1
                        """,
                        existing_upload["id"],
                    )
                    await conn.execute(
                        """
                        DELETE FROM ria_pick_uploads
                        WHERE ria_profile_id = $1
                          AND id <> $2
                        """,
                        ria["id"],
                        existing_upload["id"],
                    )
                if upload is None:
                    raise RIAIAMPolicyError("Failed to create RIA picks upload", status_code=500)

                for row in rows:
                    await conn.execute(
                        """
                        INSERT INTO ria_pick_upload_rows (
                          upload_id,
                          sort_order,
                          ticker,
                          company_name,
                          sector,
                          tier,
                          tier_rank,
                          conviction_weight,
                          recommendation_bias,
                          investment_thesis,
                          fcf_billions
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                        """,
                        upload["id"],
                        row["sort_order"],
                        row["ticker"],
                        row["company_name"],
                        row["sector"],
                        row["tier"],
                        row["tier_rank"],
                        row["conviction_weight"],
                        row["recommendation_bias"],
                        row["investment_thesis"],
                        row["fcf_billions"],
                    )

                return {
                    "upload_id": str(upload["id"]),
                    "label": (label or "").strip() or "Active advisor package",
                    "row_count": len(rows),
                    "status": "active",
                    "created_at": upload["created_at"],
                    "activated_at": upload["activated_at"],
                    "package": self._normalize_pick_package_response(
                        rows,
                        package["package_metadata"],
                    ),
                }
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()

    async def parse_ria_pick_csv(
        self,
        *,
        csv_content: str,
        package_note: str | None = None,
        avoid_rows: list[dict[str, Any]] | None = None,
        screening_sections: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        package = self._normalize_pick_package(
            top_picks=self._parse_pick_csv(csv_content),
            avoid_rows=self._coerce_package_rows(avoid_rows),
            screening_sections=self._coerce_package_rows(screening_sections),
            package_note=package_note,
        )
        return self._normalize_pick_package_response(
            package["top_picks"],
            package["package_metadata"],
        )

    async def list_ria_pick_uploads(self, user_id: str) -> list[dict[str, Any]]:
        conn = await self._conn()
        try:
            await self._ensure_iam_schema_ready(conn)
            ria = await self._get_ria_profile_by_user(conn, user_id)
            rows = await conn.fetch(
                """
                SELECT
                  id,
                  label,
                  status,
                  source_filename,
                  row_count,
                  package_metadata,
                  activated_at,
                  created_at,
                  updated_at
                FROM ria_pick_uploads
                WHERE ria_profile_id = $1
                  AND status = 'active'
                ORDER BY COALESCE(activated_at, updated_at, created_at) DESC
                LIMIT 1
                """,
                ria["id"],
            )
            return [
                {
                    "upload_id": str(row["id"]),
                    "label": row["label"],
                    "status": row["status"],
                    "source_filename": row["source_filename"],
                    "row_count": int(row["row_count"] or 0),
                    "package_note": (
                        row["package_metadata"].get("package_note")
                        if isinstance(row["package_metadata"], dict)
                        else None
                    ),
                    "activated_at": row["activated_at"],
                    "created_at": row["created_at"],
                    "updated_at": row["updated_at"],
                }
                for row in rows
            ]
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()

    async def get_active_ria_pick_rows(self, user_id: str) -> list[dict[str, Any]]:
        bootstrap = await self.get_active_ria_pick_package(user_id)
        package = bootstrap.get("package") if isinstance(bootstrap, dict) else {}
        return list(package.get("top_picks") or [])

    async def get_active_ria_pick_package(self, user_id: str) -> dict[str, Any]:
        return await self.get_ria_pick_bootstrap(user_id)

    async def list_investor_pick_sources(self, investor_user_id: str) -> list[dict[str, Any]]:
        conn = await self._conn()
        try:
            await self._ensure_iam_schema_ready(conn)
            rows = await conn.fetch(
                """
                SELECT
                  rel.ria_profile_id,
                  rp.user_id AS ria_user_id,
                  COALESCE(mp.display_name, rp.display_name) AS label,
                  artifact.id AS artifact_id,
                  artifact.updated_at AS artifact_updated_at,
                  artifact.source_data_version AS source_data_version,
                  picks_share.status AS share_status,
                  picks_share.granted_at AS share_granted_at,
                  picks_share.metadata AS share_metadata
                FROM advisor_investor_relationships rel
                JOIN ria_profiles rp ON rp.id = rel.ria_profile_id
                LEFT JOIN marketplace_public_profiles mp
                  ON mp.user_id = rp.user_id
                  AND mp.profile_type = 'ria'
                JOIN relationship_share_grants picks_share
                  ON picks_share.relationship_id = rel.id
                  AND picks_share.grant_key = $2
                  AND picks_share.status = 'active'
                LEFT JOIN ria_pick_share_artifacts artifact
                  ON artifact.relationship_id = rel.id
                 AND artifact.grant_key = $2
                 AND artifact.status = 'active'
                WHERE rel.investor_user_id = $1
                  AND rel.status = 'approved'
                ORDER BY COALESCE(mp.display_name, rp.display_name) ASC
                """,
                investor_user_id,
                _RELATIONSHIP_SHARE_ACTIVE_PICKS,
            )
            return [
                {
                    "id": f"ria:{row['ria_profile_id']}",
                    "label": row["label"] or "Linked RIA picks",
                    "kind": "ria",
                    "state": "ready" if row.get("artifact_id") else "pending",
                    "is_default": False,
                    "ria_user_id": row["ria_user_id"],
                    "ria_profile_id": str(row["ria_profile_id"]),
                    "artifact_id": str(row.get("artifact_id")) if row.get("artifact_id") else None,
                    "artifact_updated_at": self._serialize_datetime_value(
                        row.get("artifact_updated_at")
                    ),
                    "source_data_version": (
                        int(row["source_data_version"])
                        if row.get("source_data_version") is not None
                        else None
                    ),
                    "share_status": row["share_status"],
                    "share_origin": self._relationship_share_origin(row["share_metadata"]),
                    "share_granted_at": self._serialize_datetime_value(row["share_granted_at"]),
                }
                for row in rows
            ]
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()

    async def get_pick_rows_for_source(
        self,
        investor_user_id: str,
        source_id: str,
    ) -> list[dict[str, Any]]:
        package = await self.get_pick_package_for_source(investor_user_id, source_id)
        return list(package.get("top_picks") or [])

    async def get_pick_package_for_source(
        self,
        investor_user_id: str,
        source_id: str,
    ) -> dict[str, Any]:
        normalized_source = str(source_id or "").strip()
        if not normalized_source.startswith("ria:"):
            return self._empty_pick_package_response()
        ria_profile_id = normalized_source.split(":", 1)[1]
        conn = await self._conn()
        try:
            await self._ensure_iam_schema_ready(conn)
            relationship = await conn.fetchrow(
                """
                SELECT 1
                FROM advisor_investor_relationships rel
                JOIN relationship_share_grants share
                  ON share.relationship_id = rel.id
                  AND share.grant_key = $3
                  AND share.status = 'active'
                WHERE rel.investor_user_id = $1
                  AND rel.ria_profile_id = $2::uuid
                  AND rel.status = 'approved'
                """,
                investor_user_id,
                ria_profile_id,
                _RELATIONSHIP_SHARE_ACTIVE_PICKS,
            )
            if relationship is None:
                return self._empty_pick_package_response()
            artifact = await conn.fetchrow(
                """
                SELECT artifact.artifact_projection
                FROM advisor_investor_relationships rel
                JOIN relationship_share_grants share
                  ON share.relationship_id = rel.id
                  AND share.grant_key = $3
                  AND share.status = 'active'
                JOIN ria_pick_share_artifacts artifact
                  ON artifact.relationship_id = rel.id
                  AND artifact.grant_key = $3
                  AND artifact.status = 'active'
                WHERE rel.investor_user_id = $1
                  AND rel.ria_profile_id = $2::uuid
                  AND rel.status = 'approved'
                ORDER BY
                  COALESCE(artifact.updated_at, share.granted_at, rel.updated_at, rel.created_at)
                  DESC
                LIMIT 1
                """,
                investor_user_id,
                ria_profile_id,
                _RELATIONSHIP_SHARE_ACTIVE_PICKS,
            )
            if artifact is not None:
                artifact_payload = dict(artifact)
                artifact_projection = self._parse_metadata(
                    artifact_payload.get("artifact_projection")
                )
                if artifact_projection:
                    return self._build_pick_package_projection(artifact_projection)

            legacy_package = await self._get_pick_package_for_source_legacy(
                conn,
                ria_profile_id=ria_profile_id,
            )
            return legacy_package
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()

    async def create_ria_invites(
        self,
        user_id: str,
        *,
        scope_template_id: str,
        duration_mode: str,
        duration_hours: int | None,
        firm_id: str | None,
        reason: str | None,
        targets: list[dict[str, Any]],
    ) -> dict[str, Any]:
        if not targets:
            raise RIAIAMPolicyError("At least one invite target is required", status_code=400)

        conn = await self._conn()
        created_items: list[dict[str, Any]] = []
        pending_email_deliveries: list[dict[str, Any]] = []
        try:
            async with conn.transaction():
                await self._ensure_vault_user_row(conn, user_id)
                await self._ensure_iam_schema_ready(conn)
                await self._ensure_actor_profile_row(conn, user_id, include_ria_persona=True)

                ria = await self._get_ria_profile_by_user(conn, user_id)
                if not self._is_verified_ria_status(ria["verification_status"]):
                    raise RIAIAMPolicyError(
                        "RIA verification incomplete; cannot send invites",
                        status_code=403,
                    )

                template = await self._load_scope_template(conn, scope_template_id)
                if (
                    template.requester_actor_type != "ria"
                    or template.subject_actor_type != "investor"
                ):
                    raise RIAIAMPolicyError(
                        "Scope template actor direction mismatch",
                        status_code=400,
                    )

                mode, resolved_duration_hours = self._resolve_duration_hours(
                    template,
                    duration_mode=duration_mode,
                    duration_hours=duration_hours,
                )

                if firm_id:
                    membership = await conn.fetchrow(
                        """
                        SELECT 1
                        FROM ria_firm_memberships
                        WHERE ria_profile_id = $1
                          AND firm_id = $2::uuid
                          AND membership_status = 'active'
                        """,
                        ria["id"],
                        firm_id,
                    )
                    if membership is None:
                        raise RIAIAMPolicyError("Firm membership is not active", status_code=403)

                firm_row = await conn.fetchrow(
                    """
                    SELECT f.legal_name
                    FROM ria_firm_memberships m
                    JOIN ria_firms f ON f.id = m.firm_id
                    WHERE m.ria_profile_id = $1
                      AND m.membership_status = 'active'
                      AND ($2::uuid IS NULL OR m.firm_id = $2::uuid)
                    ORDER BY
                      CASE WHEN $2::uuid IS NOT NULL AND m.firm_id = $2::uuid THEN 0 ELSE 1 END,
                      m.is_primary DESC,
                      f.legal_name ASC
                    LIMIT 1
                    """,
                    ria["id"],
                    firm_id,
                )
                advisor_name = (
                    str(ria.get("display_name") or ria.get("legal_name") or "").strip()
                    or "Your advisor"
                )
                firm_name = (
                    str(firm_row["legal_name"]).strip()
                    if firm_row and firm_row["legal_name"]
                    else None
                )
                expires_at = datetime.now(tz=timezone.utc) + timedelta(
                    hours=resolved_duration_hours
                )

                for raw_target in targets:
                    display_name = str(raw_target.get("display_name") or "").strip() or None
                    email = str(raw_target.get("email") or "").strip().lower() or None
                    phone = str(raw_target.get("phone") or "").strip() or None
                    investor_user_id = str(raw_target.get("investor_user_id") or "").strip() or None
                    source = str(raw_target.get("source") or "manual").strip().lower() or "manual"
                    delivery_channel = (
                        str(raw_target.get("delivery_channel") or "share_link").strip().lower()
                        or "share_link"
                    )
                    if source not in {"manual", "marketplace", "csv"}:
                        raise RIAIAMPolicyError("Invalid invite source", status_code=400)
                    if delivery_channel not in {"share_link", "email", "sms"}:
                        raise RIAIAMPolicyError("Invalid invite delivery channel", status_code=400)
                    if not any([display_name, email, phone, investor_user_id]):
                        raise RIAIAMPolicyError(
                            "Invite target requires a name, contact, or investor user id",
                            status_code=400,
                        )

                    if investor_user_id:
                        await self._ensure_vault_user_row(conn, investor_user_id)
                        await self._ensure_actor_profile_row(conn, investor_user_id)

                    invite_token = uuid.uuid4().hex
                    invite_row = await conn.fetchrow(
                        """
                        INSERT INTO ria_client_invites (
                          invite_token,
                          ria_profile_id,
                          firm_id,
                          target_display_name,
                          target_email,
                          target_phone,
                          target_investor_user_id,
                          source,
                          delivery_channel,
                          status,
                          scope_template_id,
                          duration_mode,
                          duration_hours,
                          reason,
                          expires_at,
                          metadata
                        )
                        VALUES (
                          $1,
                          $2,
                          $3::uuid,
                          NULLIF($4, ''),
                          NULLIF($5, ''),
                          NULLIF($6, ''),
                          $7,
                          $8,
                          $9,
                          'sent',
                          $10,
                          $11,
                          $12,
                          NULLIF($13, ''),
                          $14,
                          $15::jsonb
                        )
                        RETURNING id, invite_token, status, expires_at
                        """,
                        invite_token,
                        ria["id"],
                        firm_id,
                        display_name or "",
                        email or "",
                        phone or "",
                        investor_user_id,
                        source,
                        delivery_channel,
                        template.template_id,
                        mode,
                        resolved_duration_hours,
                        (reason or "").strip(),
                        expires_at,
                        json.dumps(
                            {
                                "template_name": template.template_name,
                                "requester_actor_type": "ria",
                                "subject_actor_type": "investor",
                            }
                        ),
                    )
                    if invite_row is None:
                        raise RuntimeError("Failed to create invite")

                    created_item = {
                        "invite_id": str(invite_row["id"]),
                        "invite_token": invite_row["invite_token"],
                        "invite_path": f"/kai/onboarding?invite={invite_row['invite_token']}",
                        "status": invite_row["status"],
                        "expires_at": invite_row["expires_at"],
                        "scope_template_id": template.template_id,
                        "duration_mode": mode,
                        "duration_hours": resolved_duration_hours,
                        "source": source,
                        "delivery_channel": delivery_channel,
                        "target_display_name": display_name,
                        "target_email": email,
                        "target_phone": phone,
                        "target_investor_user_id": investor_user_id,
                    }
                    created_items.append(created_item)

                    if delivery_channel == "email":
                        if email:
                            pending_email_deliveries.append(
                                {
                                    "invite_id": str(invite_row["id"]),
                                    "invite_token": invite_row["invite_token"],
                                    "invite_path": created_item["invite_path"],
                                    "target_email": email,
                                    "target_display_name": display_name,
                                    "advisor_name": advisor_name,
                                    "firm_name": firm_name,
                                    "expires_at": invite_row["expires_at"],
                                    "reason": (reason or "").strip() or None,
                                    "created_item": created_item,
                                }
                            )
                            created_item["delivery_status"] = "pending"
                        else:
                            created_item["delivery_status"] = "skipped"
                            created_item["delivery_message"] = (
                                "Email delivery requires a target email address."
                            )

            if pending_email_deliveries:
                invite_email_service = get_kai_invite_email_service()
                for delivery in pending_email_deliveries:
                    delivery_patch: dict[str, Any]
                    try:
                        result = invite_email_service.send_ria_invite(
                            target_email=str(delivery["target_email"]),
                            target_display_name=delivery.get("target_display_name"),
                            advisor_name=str(delivery["advisor_name"]),
                            firm_name=delivery.get("firm_name"),
                            invite_token=str(delivery["invite_token"]),
                            invite_path=str(delivery["invite_path"]),
                            expires_at=delivery.get("expires_at"),
                            reason=delivery.get("reason"),
                        )
                        delivery["created_item"]["delivery_status"] = "sent"
                        delivery["created_item"]["delivery_message"] = (
                            f"Email sent to {result.recipient}."
                        )
                        delivery["created_item"]["delivery_message_id"] = result.message_id
                        delivery_patch = {
                            "invite_email_delivery": {
                                "status": "sent",
                                "message_id": result.message_id,
                                "recipient": result.recipient,
                                "intended_recipient": result.intended_recipient,
                                "delivery_mode": result.delivery_mode,
                                "from_email": result.from_email,
                                "delivered_at": datetime.now(tz=timezone.utc)
                                .isoformat()
                                .replace("+00:00", "Z"),
                            }
                        }
                    except (SupportEmailNotConfiguredError, SupportEmailSendError) as exc:
                        logger.warning(
                            "ria.invite_email.failed invite_id=%s reason=%s",
                            delivery["invite_id"],
                            str(exc),
                        )
                        delivery["created_item"]["delivery_status"] = "failed"
                        delivery["created_item"]["delivery_message"] = str(exc)
                        delivery_patch = {
                            "invite_email_delivery": {
                                "status": "failed",
                                "error": str(exc),
                                "attempted_at": datetime.now(tz=timezone.utc)
                                .isoformat()
                                .replace("+00:00", "Z"),
                            }
                        }
                    except Exception as exc:  # noqa: BLE001
                        logger.exception(
                            "ria.invite_email.unexpected_failure invite_id=%s",
                            delivery["invite_id"],
                        )
                        delivery["created_item"]["delivery_status"] = "failed"
                        delivery["created_item"]["delivery_message"] = str(exc)
                        delivery_patch = {
                            "invite_email_delivery": {
                                "status": "failed",
                                "error": str(exc),
                                "attempted_at": datetime.now(tz=timezone.utc)
                                .isoformat()
                                .replace("+00:00", "Z"),
                            }
                        }

                    await conn.execute(
                        """
                        UPDATE ria_client_invites
                        SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
                        WHERE id = $1::uuid
                        """,
                        delivery["invite_id"],
                        json.dumps(delivery_patch),
                    )

            return {"items": created_items}
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()

    async def set_ria_marketplace_discoverability(
        self,
        user_id: str,
        *,
        enabled: bool,
        headline: str | None = None,
        strategy_summary: str | None = None,
    ) -> dict[str, Any]:
        conn = await self._conn()
        try:
            async with conn.transaction():
                await self._ensure_iam_schema_ready(conn)
                await self._ensure_vault_user_row(conn, user_id)
                await self._ensure_actor_profile_row(conn, user_id, include_ria_persona=True)

                ria = await conn.fetchrow(
                    """
                    SELECT id, display_name, verification_status, strategy
                    FROM ria_profiles
                    WHERE user_id = $1
                    """,
                    user_id,
                )
                if ria is None:
                    raise RIAIAMPolicyError("RIA profile not found", status_code=404)
                verification_status = str(ria["verification_status"] or "")
                if enabled and not self._is_verified_ria_status(verification_status):
                    raise RIAIAMPolicyError(
                        "RIA verification must be complete before the profile can become discoverable.",
                        status_code=403,
                    )

                await conn.execute(
                    """
                    INSERT INTO marketplace_public_profiles (
                      user_id,
                      profile_type,
                      display_name,
                      headline,
                      strategy_summary,
                      verification_badge,
                      metadata,
                      is_discoverable
                    )
                    VALUES (
                      $1,
                      'ria',
                      $2,
                      NULLIF($3, ''),
                      NULLIF($4, ''),
                      $5,
                      '{}'::jsonb,
                      $6
                    )
                    ON CONFLICT (user_id) DO UPDATE
                    SET
                      display_name = EXCLUDED.display_name,
                      headline = COALESCE(EXCLUDED.headline, marketplace_public_profiles.headline),
                      strategy_summary = COALESCE(
                        EXCLUDED.strategy_summary,
                        marketplace_public_profiles.strategy_summary
                      ),
                      verification_badge = EXCLUDED.verification_badge,
                      is_discoverable = EXCLUDED.is_discoverable,
                      updated_at = NOW()
                    """,
                    user_id,
                    ria["display_name"],
                    (headline or "").strip(),
                    (strategy_summary or str(ria["strategy"] or "")).strip(),
                    "verified" if self._is_verified_ria_status(verification_status) else "pending",
                    bool(enabled),
                )

                return {
                    "user_id": user_id,
                    "is_discoverable": bool(enabled),
                    "verification_status": verification_status,
                }
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()

    async def get_ria_invite(self, invite_token: str) -> dict[str, Any]:
        conn = await self._conn()
        try:
            await self._ensure_iam_schema_ready(conn)
            row = await conn.fetchrow(
                """
                SELECT
                  i.id,
                  i.invite_token,
                  i.status,
                  i.firm_id,
                  i.scope_template_id,
                  i.duration_mode,
                  i.duration_hours,
                  i.reason,
                  i.expires_at,
                  i.target_display_name,
                  i.target_email,
                  i.target_phone,
                  i.accepted_by_user_id,
                  i.accepted_request_id,
                  rp.id AS ria_profile_id,
                  rp.user_id AS ria_user_id,
                  rp.display_name AS ria_display_name,
                  rp.verification_status,
                  rp.bio,
                  rp.strategy,
                  mp.headline,
                  mp.strategy_summary,
                  COALESCE(
                    json_agg(
                      DISTINCT jsonb_build_object(
                        'firm_id', f.id,
                        'legal_name', f.legal_name,
                        'role_title', m.role_title,
                        'is_primary', m.is_primary
                      )
                    ) FILTER (WHERE f.id IS NOT NULL),
                    '[]'::json
                  ) AS firms
                FROM ria_client_invites i
                JOIN ria_profiles rp ON rp.id = i.ria_profile_id
                LEFT JOIN marketplace_public_profiles mp
                  ON mp.user_id = rp.user_id
                  AND mp.profile_type = 'ria'
                LEFT JOIN ria_firm_memberships m
                  ON m.ria_profile_id = rp.id
                  AND m.membership_status = 'active'
                LEFT JOIN ria_firms f ON f.id = m.firm_id
                WHERE i.invite_token = $1
                GROUP BY
                  i.id,
                  i.invite_token,
                  i.status,
                  i.firm_id,
                  i.scope_template_id,
                  i.duration_mode,
                  i.duration_hours,
                  i.reason,
                  i.expires_at,
                  i.target_display_name,
                  i.target_email,
                  i.target_phone,
                  i.accepted_by_user_id,
                  i.accepted_request_id,
                  rp.id,
                  rp.user_id,
                  rp.display_name,
                  rp.verification_status,
                  rp.bio,
                  rp.strategy,
                  mp.headline,
                  mp.strategy_summary
                """,
                invite_token,
            )
            if row is None:
                raise RIAIAMPolicyError("Invite not found", status_code=404)

            payload = dict(row)
            if payload["status"] == "cancelled":
                raise RIAIAMPolicyError("Invite is no longer available", status_code=410)
            if payload["status"] == "sent" and payload["expires_at"] <= datetime.now(
                tz=timezone.utc
            ):
                await conn.execute(
                    """
                    UPDATE ria_client_invites
                    SET status = 'expired', updated_at = NOW()
                    WHERE id = $1
                    """,
                    payload["id"],
                )
                payload["status"] = "expired"
            if payload["status"] == "expired":
                raise RIAIAMPolicyError("Invite has expired", status_code=410)

            return {
                "invite_id": str(payload["id"]),
                "invite_token": payload["invite_token"],
                "status": payload["status"],
                "firm_id": str(payload["firm_id"]) if payload.get("firm_id") else None,
                "scope_template_id": payload["scope_template_id"],
                "duration_mode": payload["duration_mode"],
                "duration_hours": payload["duration_hours"],
                "reason": payload["reason"],
                "expires_at": payload["expires_at"],
                "target_display_name": payload["target_display_name"],
                "target_email": payload["target_email"],
                "target_phone": payload["target_phone"],
                "accepted_by_user_id": payload["accepted_by_user_id"],
                "accepted_request_id": payload["accepted_request_id"],
                "ria": {
                    "id": str(payload["ria_profile_id"]),
                    "user_id": payload["ria_user_id"],
                    "display_name": payload["ria_display_name"],
                    "verification_status": payload["verification_status"],
                    "headline": payload["headline"],
                    "strategy_summary": payload["strategy_summary"] or payload["strategy"],
                    "bio": payload["bio"],
                    "firms": payload["firms"] or [],
                },
            }
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()

    async def accept_ria_invite(self, invite_token: str, user_id: str) -> dict[str, Any]:
        invite = await self.get_ria_invite(invite_token)
        if invite["status"] == "accepted":
            if invite.get("accepted_by_user_id") == user_id and invite.get("accepted_request_id"):
                return {
                    "invite_token": invite_token,
                    "request_id": invite["accepted_request_id"],
                    "status": "accepted",
                    "ria": invite["ria"],
                }
            raise RIAIAMPolicyError("Invite has already been accepted", status_code=409)
        ria_user_id = str(invite["ria"]["user_id"])
        request = await self.create_ria_consent_request(
            ria_user_id,
            subject_user_id=user_id,
            requester_actor_type="ria",
            subject_actor_type="investor",
            scope_template_id=str(invite["scope_template_id"]),
            selected_scope=None,
            duration_mode=str(invite["duration_mode"]),
            duration_hours=int(invite["duration_hours"]) if invite["duration_hours"] else None,
            firm_id=invite.get("firm_id"),
            reason=str(invite.get("reason") or "") or None,
            invite_id=str(invite["invite_id"]),
            invite_token=invite_token,
            request_origin="invite_acceptance",
        )

        conn = await self._conn()
        try:
            async with conn.transaction():
                await self._ensure_iam_schema_ready(conn)
                updated = await conn.execute(
                    """
                    UPDATE ria_client_invites
                    SET
                      status = 'accepted',
                      accepted_by_user_id = $2,
                      accepted_request_id = $3,
                      accepted_at = NOW(),
                      updated_at = NOW()
                    WHERE invite_token = $1
                      AND status = 'sent'
                    """,
                    invite_token,
                    user_id,
                    request["request_id"],
                )
                relationship_id = str(request.get("relationship_id") or "").strip()
                if relationship_id:
                    await self._materialize_relationship_share_grant(
                        conn,
                        relationship_id=relationship_id,
                        provider_user_id=ria_user_id,
                        receiver_user_id=user_id,
                        grant_key=_RELATIONSHIP_SHARE_ACTIVE_PICKS,
                        metadata=self._implicit_picks_relationship_share_metadata(
                            source="invite_acceptance",
                            metadata={
                                "request_id": request["request_id"],
                                "invite_token": invite_token,
                            },
                        ),
                    )
            if updated.endswith("0"):
                logger.warning("RIA invite accept race detected for token=%s", invite_token)
            return {
                "invite_token": invite_token,
                "request_id": request["request_id"],
                "status": "accepted",
                "scope": request["scope"],
                "expires_at": request["expires_at"],
                "ria": invite["ria"],
            }
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()

    async def _get_ria_profile_by_user(
        self, conn: asyncpg.Connection, user_id: str
    ) -> asyncpg.Record:
        row = await conn.fetchrow(
            """
            SELECT id, user_id, verification_status, display_name, legal_name, disclosures_url
            FROM ria_profiles
            WHERE user_id = $1
            """,
            user_id,
        )
        if row is None:
            raise RIAIAMPolicyError("RIA profile not found", status_code=404)
        return row

    async def create_ria_consent_request(
        self,
        user_id: str,
        *,
        subject_user_id: str,
        requester_actor_type: str,
        subject_actor_type: str,
        scope_template_id: str,
        selected_scope: str | None,
        duration_mode: str,
        duration_hours: int | None,
        firm_id: str | None,
        reason: str | None,
        invite_id: str | None = None,
        invite_token: str | None = None,
        request_origin: str | None = None,
    ) -> dict[str, Any]:
        requester = self._normalize_actor(requester_actor_type)
        subject = self._normalize_actor(subject_actor_type)
        if (requester, subject) not in {("ria", "investor"), ("investor", "ria")}:
            raise RIAIAMPolicyError(
                "Only investor <-> ria connection requests are allowed in this phase"
            )

        conn = await self._conn()
        try:
            async with conn.transaction():
                await self._ensure_vault_user_row(conn, user_id)
                await self._ensure_vault_user_row(conn, subject_user_id)
                await self._ensure_iam_schema_ready(conn)
                if requester == "ria":
                    await self._ensure_actor_profile_row(conn, user_id, include_ria_persona=True)
                    await self._ensure_actor_profile_row(conn, subject_user_id)
                    ria = await self._get_ria_profile_by_user(conn, user_id)
                    investor_user_id = subject_user_id
                    request_subject_user_id = subject_user_id
                    request_agent_id = f"ria:{ria['id']}"
                    request_origin_value = request_origin or "direct_ria_request"
                    requester_label = (
                        str(ria["display_name"] or ria["legal_name"] or "").strip()
                        or f"RIA {str(ria['id'])[:8]}"
                    )
                    additional_access_summary = self._relationship_share_summary(
                        _RELATIONSHIP_SHARE_ACTIVE_PICKS
                    )
                    included_relationship_shares = [
                        {
                            **self._relationship_share_descriptor(_RELATIONSHIP_SHARE_ACTIVE_PICKS),
                            "share_origin": _RELATIONSHIP_SHARE_ORIGIN_RELATIONSHIP_IMPLICIT,
                            "status": "included_on_approval",
                        }
                    ]
                else:
                    await self._ensure_actor_profile_row(conn, user_id)
                    await self._ensure_actor_profile_row(
                        conn, subject_user_id, include_ria_persona=True
                    )
                    ria = await self._get_ria_profile_by_user(conn, subject_user_id)
                    investor_user_id = user_id
                    request_subject_user_id = subject_user_id
                    request_agent_id = f"investor:{user_id}"
                    request_origin_value = request_origin or "marketplace_investor_connect"
                    requester_label = user_id
                    additional_access_summary = (
                        "Connection request to view the advisor's disclosure and strategy surface."
                    )
                    included_relationship_shares = []

                if not self._is_verified_ria_status(ria["verification_status"]):
                    raise RIAIAMPolicyError(
                        "RIA verification incomplete; cannot create connection requests",
                        status_code=403,
                    )

                template = await self._load_scope_template(conn, scope_template_id)
                if (
                    template.requester_actor_type != requester
                    or template.subject_actor_type != subject
                ):
                    raise RIAIAMPolicyError(
                        "Scope template actor direction mismatch", status_code=400
                    )

                chosen_scope = (selected_scope or "").strip() or (
                    template.allowed_scopes[0] if template.allowed_scopes else ""
                )
                if not chosen_scope:
                    raise RIAIAMPolicyError("No scope available for template", status_code=400)
                if chosen_scope not in template.allowed_scopes:
                    raise RIAIAMPolicyError(
                        "Selected scope is not allowed for this template", status_code=400
                    )

                if firm_id:
                    membership = await conn.fetchrow(
                        """
                        SELECT 1
                        FROM ria_firm_memberships
                        WHERE ria_profile_id = $1
                          AND firm_id = $2::uuid
                          AND membership_status = 'active'
                        """,
                        ria["id"],
                        firm_id,
                    )
                    if membership is None:
                        raise RIAIAMPolicyError("Firm membership is not active", status_code=403)

                request_id = uuid.uuid4().hex
                now_ms = self._now_ms()
                expires_at_ms = now_ms + (template.default_duration_hours * 60 * 60 * 1000)
                connection_selected = str(ria["user_id"] if requester == "ria" else user_id)
                request_url = build_connection_request_url(
                    selected=connection_selected,
                    tab="pending",
                )
                requester_website_url = (
                    str(ria["disclosures_url"] or "").strip() or None
                    if requester == "ria"
                    else None
                )
                metadata = {
                    "requester_actor_type": requester,
                    "subject_actor_type": subject,
                    "requester_entity_id": str(ria["id"]) if requester == "ria" else user_id,
                    "subject_entity_id": str(ria["id"]) if subject == "ria" else None,
                    "requester_label": requester_label,
                    "requester_image_url": None,
                    "requester_website_url": requester_website_url,
                    "firm_id": firm_id,
                    "scope_template_id": template.template_id,
                    "duration_mode": "investor_decides",
                    "duration_hours": None,
                    "request_timeout_hours": template.default_duration_hours,
                    "approval_timeout_minutes": template.default_duration_hours * 60,
                    "approval_timeout_at": expires_at_ms,
                    "reason": (reason or "").strip() or None,
                    "request_origin": request_origin_value,
                    "invite_id": invite_id,
                    "invite_token": invite_token,
                    "bundle_id": None,
                    "bundle_label": None,
                    "bundle_scope_count": 1,
                    "request_url": request_url,
                    "additional_access_summary": additional_access_summary,
                    "included_relationship_shares": included_relationship_shares,
                }

                await conn.execute(
                    """
                    INSERT INTO consent_audit (
                      token_id,
                      user_id,
                      agent_id,
                      scope,
                      action,
                      issued_at,
                      expires_at,
                      poll_timeout_at,
                      request_id,
                      scope_description,
                      metadata
                    )
                    VALUES (
                      $1,
                      $2,
                      $3,
                      $4,
                      'REQUESTED',
                      $5,
                      $6,
                      $7,
                      $8,
                      $9,
                      $10::jsonb
                    )
                    """,
                    f"req_{request_id}",
                    request_subject_user_id,
                    request_agent_id,
                    chosen_scope,
                    now_ms,
                    expires_at_ms,
                    expires_at_ms,
                    request_id,
                    template.template_name,
                    json.dumps(metadata),
                )

                relationship = await conn.fetchrow(
                    """
                    SELECT id
                    FROM advisor_investor_relationships
                    WHERE investor_user_id = $1
                      AND ria_profile_id = $2
                      AND (
                        (firm_id IS NULL AND $3::uuid IS NULL)
                        OR firm_id = $3::uuid
                      )
                    LIMIT 1
                    """,
                    investor_user_id,
                    ria["id"],
                    firm_id,
                )
                relationship_id: str | None = None
                if relationship is None:
                    relationship_row = await conn.fetchrow(
                        """
                        INSERT INTO advisor_investor_relationships (
                          investor_user_id,
                          ria_profile_id,
                          firm_id,
                          status,
                          last_request_id,
                          granted_scope,
                          created_at,
                          updated_at
                        )
                        VALUES (
                          $1,
                          $2,
                          $3::uuid,
                          'request_pending',
                          $4,
                          $5,
                          NOW(),
                          NOW()
                        )
                        RETURNING id
                        """,
                        investor_user_id,
                        ria["id"],
                        firm_id,
                        request_id,
                        chosen_scope,
                    )
                    relationship_id = (
                        str(relationship_row["id"])
                        if relationship_row and relationship_row["id"] is not None
                        else None
                    )
                else:
                    await conn.execute(
                        """
                        UPDATE advisor_investor_relationships
                        SET
                          status = 'request_pending',
                          last_request_id = $2,
                          granted_scope = COALESCE(granted_scope, $3),
                          updated_at = NOW()
                        WHERE id = $1
                        """,
                        relationship["id"],
                        request_id,
                        chosen_scope,
                    )
                    relationship_id = str(relationship["id"])

                created = {
                    "request_id": request_id,
                    "subject_user_id": request_subject_user_id,
                    "scope": chosen_scope,
                    "duration_hours": template.default_duration_hours,
                    "duration_mode": "investor_decides",
                    "expires_at": expires_at_ms,
                    "scope_template_id": template.template_id,
                    "requester_entity_id": str(ria["id"]) if requester == "ria" else user_id,
                    "relationship_id": relationship_id,
                    "status": "REQUESTED",
                    "metadata": metadata,
                }
                if duration_mode or duration_hours:
                    created["requested_duration_mode"] = (duration_mode or "").strip() or "preset"
                    created["requested_duration_hours"] = duration_hours
                return created
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()

    async def get_ria_workspace(self, user_id: str, investor_user_id: str) -> dict[str, Any]:
        conn = await self._conn()
        try:
            await self._ensure_iam_schema_ready(conn)
            ria = await self._get_ria_profile_by_user(conn, user_id)
            identity_select_sql, identity_join_sql = await self._investor_identity_projection(
                conn,
                user_id_sql="rel.investor_user_id",
            )
            relationship_query = "\n".join(
                [
                    "SELECT",
                    "  rel.id,",
                    "  rel.status,",
                    "  rel.granted_scope,",
                    "  rel.last_request_id,",
                    "  rel.consent_granted_at,",
                    "  rel.revoked_at,",
                    f"  {identity_select_sql},",
                    "  picks_share.id AS picks_share_id,",
                    "  picks_share.status AS picks_share_status,",
                    "  picks_share.granted_at AS picks_share_granted_at,",
                    "  picks_share.revoked_at AS picks_share_revoked_at,",
                    "  picks_share.metadata AS picks_share_metadata,",
                    "  (active_upload.id IS NOT NULL) AS has_active_pick_upload",
                    "FROM advisor_investor_relationships rel",
                    identity_join_sql,
                    "LEFT JOIN marketplace_public_profiles mp",
                    "  ON mp.user_id = rel.investor_user_id",
                    "  AND mp.profile_type = 'investor'",
                    "LEFT JOIN relationship_share_grants picks_share",
                    "  ON picks_share.relationship_id = rel.id",
                    "  AND picks_share.grant_key = $3",
                    "LEFT JOIN LATERAL (",
                    "  SELECT id",
                    "  FROM ria_pick_share_artifacts",
                    "  WHERE relationship_id = rel.id",
                    "    AND grant_key = $3",
                    "    AND status = 'active'",
                    "  ORDER BY updated_at DESC",
                    "  LIMIT 1",
                    ") active_upload ON TRUE",
                    "WHERE rel.investor_user_id = $1",
                    "  AND rel.ria_profile_id = $2",
                    "ORDER BY rel.updated_at DESC",
                    "LIMIT 1",
                ]
            )
            relationship = await conn.fetchrow(
                relationship_query,
                investor_user_id,
                ria["id"],
                _RELATIONSHIP_SHARE_ACTIVE_PICKS,
            )
            if relationship is None:
                raise RIAIAMPolicyError(
                    "No approved relationship for investor workspace", status_code=403
                )
            relationship_payload = dict(relationship)

            agent_id = f"ria:{ria['id']}"
            consent_rows = await conn.fetch(
                """
                SELECT scope, action, expires_at, issued_at, metadata
                FROM consent_audit
                WHERE user_id = $1
                  AND agent_id = $2
                  AND action IN ('CONSENT_GRANTED', 'REVOKED', 'CONSENT_DENIED', 'CANCELLED', 'TIMEOUT')
                ORDER BY issued_at DESC
                """,
                investor_user_id,
                agent_id,
            )
            latest_by_scope: dict[str, dict[str, Any]] = {}
            for row in consent_rows:
                scope = str(row["scope"] or "").strip()
                if not scope or scope in latest_by_scope:
                    continue
                payload = dict(row)
                payload["metadata"] = self._parse_metadata(payload.get("metadata"))
                latest_by_scope[scope] = payload

            now_ms = self._now_ms()
            granted_scopes = [
                {
                    "scope": scope,
                    "label": get_scope_description(scope),
                    "expires_at": payload.get("expires_at"),
                    "issued_at": payload.get("issued_at"),
                }
                for scope, payload in latest_by_scope.items()
                if payload.get("action") == "CONSENT_GRANTED"
                and (payload.get("expires_at") is None or int(payload["expires_at"]) > now_ms)
            ]
            if not granted_scopes:
                raise RIAIAMPolicyError("Consent is not active for this workspace", status_code=403)

            has_active_pick_upload = bool(relationship_payload.get("has_active_pick_upload"))
            relationship_shares: list[dict[str, Any]] = []
            if relationship_payload.get("picks_share_id"):
                relationship_shares.append(
                    self._serialize_relationship_share(
                        {
                            "grant_key": _RELATIONSHIP_SHARE_ACTIVE_PICKS,
                            "status": relationship_payload.get("picks_share_status"),
                            "granted_at": relationship_payload.get("picks_share_granted_at"),
                            "revoked_at": relationship_payload.get("picks_share_revoked_at"),
                            "metadata": relationship_payload.get("picks_share_metadata"),
                        },
                        has_active_pick_upload=has_active_pick_upload,
                    )
                )

            metadata = await conn.fetchrow(
                """
                SELECT
                  user_id,
                  available_domains,
                  domain_summaries,
                  total_attributes,
                  updated_at
                FROM pkm_index
                WHERE user_id = $1
                """,
                investor_user_id,
            )
            granted_scope_keys = {str(item["scope"]) for item in granted_scopes}
            if metadata is None:
                account_branches = await self._list_linked_account_branches(
                    conn,
                    investor_user_id=investor_user_id,
                )
                granted_payloads = [
                    payload
                    for payload in latest_by_scope.values()
                    if payload.get("action") == "CONSENT_GRANTED"
                    and (payload.get("expires_at") is None or int(payload["expires_at"]) > now_ms)
                ]
                kai_specialized_bundle, scoped_account_branches = (
                    self._build_kai_specialized_bundle_state(
                        account_branches=account_branches,
                        granted_payloads=granted_payloads,
                        pending_payloads=[],
                    )
                )
                return {
                    "investor_user_id": investor_user_id,
                    "workspace_ready": False,
                    "available_domains": [],
                    "domain_summaries": {},
                    "total_attributes": 0,
                    "investor_display_name": relationship_payload["investor_display_name"],
                    "investor_email": relationship_payload.get("investor_email"),
                    "investor_secondary_label": relationship_payload.get(
                        "investor_secondary_label"
                    ),
                    "investor_headline": relationship_payload["investor_headline"],
                    "relationship_status": relationship_payload["status"],
                    "scope": granted_scopes[0]["scope"],
                    "granted_scopes": granted_scopes,
                    "relationship_shares": relationship_shares,
                    "picks_feed_status": self._picks_feed_status(
                        relationship_status=str(relationship_payload["status"] or ""),
                        share_status=str(relationship_payload.get("picks_share_status") or ""),
                        has_active_pick_upload=has_active_pick_upload,
                    ),
                    "picks_feed_granted_at": relationship_payload.get("picks_share_granted_at"),
                    "has_active_pick_upload": has_active_pick_upload,
                    "consent_expires_at": max(
                        (item["expires_at"] for item in granted_scopes if item.get("expires_at")),
                        default=None,
                    ),
                    "kai_specialized_bundle": kai_specialized_bundle,
                    "account_branches": scoped_account_branches,
                }

            available_domains = self._parse_string_list(metadata["available_domains"])
            domain_summaries = self._parse_metadata(metadata["domain_summaries"])
            if "pkm.read" not in granted_scope_keys:
                financial_only = any(
                    scope.startswith("attr.financial.") for scope in granted_scope_keys
                )
                if financial_only:
                    available_domains = [
                        domain for domain in available_domains if domain == "financial"
                    ]
                    domain_summaries = (
                        {"financial": domain_summaries.get("financial", {})}
                        if "financial" in domain_summaries
                        else {}
                    )
                else:
                    available_domains = []
                    domain_summaries = {}

            account_branches = await self._list_linked_account_branches(
                conn,
                investor_user_id=investor_user_id,
            )
            granted_payloads = [
                payload
                for payload in latest_by_scope.values()
                if payload.get("action") == "CONSENT_GRANTED"
                and (payload.get("expires_at") is None or int(payload["expires_at"]) > now_ms)
            ]
            kai_specialized_bundle, scoped_account_branches = (
                self._build_kai_specialized_bundle_state(
                    account_branches=account_branches,
                    granted_payloads=granted_payloads,
                    pending_payloads=[],
                )
            )

            return {
                "investor_user_id": investor_user_id,
                "investor_display_name": relationship_payload["investor_display_name"],
                "investor_email": relationship_payload.get("investor_email"),
                "investor_secondary_label": relationship_payload.get("investor_secondary_label"),
                "investor_headline": relationship_payload["investor_headline"],
                "workspace_ready": True,
                "available_domains": available_domains,
                "domain_summaries": domain_summaries,
                "total_attributes": int(metadata["total_attributes"] or 0),
                "updated_at": metadata["updated_at"],
                "relationship_status": relationship_payload["status"],
                "scope": granted_scopes[0]["scope"],
                "granted_scopes": granted_scopes,
                "relationship_shares": relationship_shares,
                "picks_feed_status": self._picks_feed_status(
                    relationship_status=str(relationship_payload["status"] or ""),
                    share_status=str(relationship_payload.get("picks_share_status") or ""),
                    has_active_pick_upload=has_active_pick_upload,
                ),
                "picks_feed_granted_at": relationship_payload.get("picks_share_granted_at"),
                "has_active_pick_upload": has_active_pick_upload,
                "consent_expires_at": max(
                    (item["expires_at"] for item in granted_scopes if item.get("expires_at")),
                    default=None,
                ),
                "kai_specialized_bundle": kai_specialized_bundle,
                "account_branches": scoped_account_branches,
            }
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()

    async def set_ria_pick_share_state(
        self,
        user_id: str,
        *,
        investor_user_id: str,
        enabled: bool,
    ) -> dict[str, Any]:
        conn = await self._conn()
        try:
            async with conn.transaction():
                await self._ensure_iam_schema_ready(conn)
                ria = await self._get_ria_profile_by_user(conn, user_id)
                relationship = await conn.fetchrow(
                    """
                    SELECT id, status
                    FROM advisor_investor_relationships
                    WHERE ria_profile_id = $1
                      AND investor_user_id = $2
                    ORDER BY updated_at DESC
                    LIMIT 1
                    """,
                    ria["id"],
                    investor_user_id,
                )
                if relationship is None:
                    raise RIAIAMPolicyError("Relationship not found", status_code=404)
                if str(relationship["status"] or "").strip().lower() != "approved":
                    raise RIAIAMPolicyError(
                        "Only approved relationships can manage the picks share",
                        status_code=409,
                    )
                if enabled:
                    row = await self._materialize_relationship_share_grant(
                        conn,
                        relationship_id=str(relationship["id"]),
                        provider_user_id=user_id,
                        receiver_user_id=investor_user_id,
                        grant_key=_RELATIONSHIP_SHARE_ACTIVE_PICKS,
                        metadata=self._implicit_picks_relationship_share_metadata(
                            source="ria_pick_share_toggle",
                            metadata={"enabled": True},
                        ),
                    )
                    return {
                        "enabled": True,
                        "status": str(row["status"] or "active"),
                        "grant_key": _RELATIONSHIP_SHARE_ACTIVE_PICKS,
                    }
                await self._revoke_relationship_share_grant(
                    conn,
                    relationship_id=str(relationship["id"]),
                    grant_key=_RELATIONSHIP_SHARE_ACTIVE_PICKS,
                    status="revoked",
                    reason="ria_pick_share_toggle:disabled",
                )
                return {
                    "enabled": False,
                    "status": "revoked",
                    "grant_key": _RELATIONSHIP_SHARE_ACTIVE_PICKS,
                }
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()

    async def sync_relationship_from_consent_action(
        self,
        *,
        user_id: str,
        request_id: str | None,
        action: str,
        agent_id: str | None = None,
        scope: str | None = None,
    ) -> None:
        if action not in {"CONSENT_GRANTED", "CONSENT_DENIED", "CANCELLED", "REVOKED", "TIMEOUT"}:
            return

        conn = await self._conn()
        try:
            async with conn.transaction():
                if not await self._is_iam_schema_ready(conn):
                    return
                row: asyncpg.Record | None = None
                if request_id:
                    row = await conn.fetchrow(
                        """
                        SELECT request_id, user_id, agent_id, scope, metadata
                        FROM consent_audit
                        WHERE request_id = $1
                          AND action = 'REQUESTED'
                        ORDER BY issued_at DESC
                        LIMIT 1
                        """,
                        request_id,
                    )
                if row is None and action == "REVOKED" and agent_id and scope:
                    row = await conn.fetchrow(
                        """
                        SELECT request_id, user_id, agent_id, scope, metadata
                        FROM consent_audit
                        WHERE user_id = $1
                          AND agent_id = $2
                          AND scope = $3
                          AND action = 'REQUESTED'
                        ORDER BY issued_at DESC
                        LIMIT 1
                        """,
                        user_id,
                        agent_id,
                        scope,
                    )

                if row is None:
                    return

                metadata = self._parse_metadata(row["metadata"])
                requester_actor_type = self._normalize_actor(
                    str(metadata.get("requester_actor_type") or "ria")
                )
                subject_actor_type = self._normalize_actor(
                    str(metadata.get("subject_actor_type") or "investor")
                )
                if (requester_actor_type, subject_actor_type) not in {
                    ("ria", "investor"),
                    ("investor", "ria"),
                }:
                    return

                if requester_actor_type == "ria":
                    investor_user_id = str(row["user_id"] or "").strip()
                    requester_entity_id = metadata.get("requester_entity_id")
                    if not requester_entity_id:
                        return
                    ria_profile_id = str(requester_entity_id).strip()
                else:
                    investor_user_id = str(metadata.get("requester_entity_id") or "").strip()
                    ria_profile_id = str(metadata.get("subject_entity_id") or "").strip()
                    if not investor_user_id or not ria_profile_id:
                        return

                relationship = await conn.fetchrow(
                    """
                    SELECT rel.id, rp.user_id AS ria_user_id
                    FROM advisor_investor_relationships rel
                    JOIN ria_profiles rp ON rp.id = rel.ria_profile_id
                    WHERE rel.investor_user_id = $1
                      AND rel.ria_profile_id = $2::uuid
                      AND (
                        rel.last_request_id = $3
                        OR ($3 IS NULL AND rel.granted_scope = $4)
                      )
                    ORDER BY rel.updated_at DESC
                    LIMIT 1
                    """,
                    investor_user_id,
                    ria_profile_id,
                    row["request_id"],
                    row["scope"],
                )
                if relationship is None:
                    return

                all_rows = await conn.fetch(
                    """
                    SELECT scope, action, expires_at, issued_at
                    FROM consent_audit
                    WHERE user_id = $1
                      AND agent_id = $2
                    ORDER BY issued_at DESC
                    """,
                    user_id,
                    row["agent_id"],
                )
                latest_by_scope: dict[str, asyncpg.Record] = {}
                for audit_row in all_rows:
                    scope_key = str(audit_row["scope"] or "").strip()
                    if not scope_key or scope_key in latest_by_scope:
                        continue
                    latest_by_scope[scope_key] = audit_row

                active_tokens = await ConsentDBService().get_active_tokens(
                    str(row["user_id"] or user_id),
                    agent_id=row["agent_id"],
                )
                has_active_grant = bool(active_tokens)
                has_pending_request = any(
                    str(audit_row["action"] or "") == "REQUESTED"
                    for audit_row in latest_by_scope.values()
                )

                next_status = "discovered"
                if has_active_grant:
                    next_status = "approved"
                elif has_pending_request:
                    next_status = "request_pending"
                elif action == "REVOKED":
                    next_status = "revoked"
                elif action == "TIMEOUT":
                    next_status = "expired"

                await conn.execute(
                    """
                    UPDATE advisor_investor_relationships
                    SET
                      status = $2,
                      consent_granted_at = CASE
                        WHEN $2 = 'approved' THEN NOW()
                        ELSE consent_granted_at
                      END,
                      revoked_at = CASE
                        WHEN $2 = 'approved' THEN NULL
                        WHEN $2 = 'revoked' THEN NOW()
                        ELSE revoked_at
                      END,
                      updated_at = NOW()
                    WHERE id = $1
                    """,
                    relationship["id"],
                    next_status,
                )

                relationship_id = str(relationship["id"])
                provider_user_id = str(relationship["ria_user_id"])
                if action == "CONSENT_GRANTED" and requester_actor_type == "ria":
                    await self._materialize_relationship_share_grant(
                        conn,
                        relationship_id=relationship_id,
                        provider_user_id=provider_user_id,
                        receiver_user_id=investor_user_id,
                        grant_key=_RELATIONSHIP_SHARE_ACTIVE_PICKS,
                        metadata=self._implicit_picks_relationship_share_metadata(
                            source="relationship_sync",
                            metadata={
                                "request_id": row["request_id"],
                                "action": action,
                            },
                        ),
                    )
                elif (
                    action in {"CONSENT_DENIED", "CANCELLED", "REVOKED"}
                    and requester_actor_type == "ria"
                ):
                    await self._revoke_relationship_share_grant(
                        conn,
                        relationship_id=relationship_id,
                        grant_key=_RELATIONSHIP_SHARE_ACTIVE_PICKS,
                        status="revoked",
                        reason=f"consent_action:{action.lower()}",
                    )
                elif action == "TIMEOUT" and requester_actor_type == "ria":
                    await self._revoke_relationship_share_grant(
                        conn,
                        relationship_id=relationship_id,
                        grant_key=_RELATIONSHIP_SHARE_ACTIVE_PICKS,
                        status="expired",
                        reason="consent_action:timeout",
                    )
        except asyncpg.exceptions.UndefinedTableError:
            # Non-blocking path: consent lifecycle should not fail for investor flows.
            return
        finally:
            await conn.close()

    async def search_marketplace_rias(
        self,
        *,
        query: str | None,
        limit: int,
        firm: str | None,
        verification_status: str | None,
    ) -> list[dict[str, Any]]:
        conn = await self._conn()
        try:
            await self._ensure_iam_schema_ready(conn)
            limit_safe = max(1, min(limit, 50))
            rows = await conn.fetch(
                """
                SELECT
                  rp.id,
                  rp.user_id,
                  mp.display_name,
                  mp.headline,
                  mp.strategy_summary,
                  rp.verification_status,
                  CASE
                    WHEN jsonb_typeof(mp.metadata -> 'is_test_profile') = 'boolean'
                    THEN (mp.metadata ->> 'is_test_profile')::boolean
                    ELSE FALSE
                  END AS is_test_profile,
                  COALESCE(
                    json_agg(
                      DISTINCT jsonb_build_object(
                        'firm_id', f.id,
                        'legal_name', f.legal_name,
                        'role_title', m.role_title,
                        'is_primary', m.is_primary
                      )
                    ) FILTER (WHERE f.id IS NOT NULL),
                    '[]'::json
                  ) AS firms
                FROM ria_profiles rp
                JOIN marketplace_public_profiles mp
                  ON mp.user_id = rp.user_id
                  AND mp.profile_type = 'ria'
                  AND mp.is_discoverable = TRUE
                LEFT JOIN ria_firm_memberships m
                  ON m.ria_profile_id = rp.id
                  AND m.membership_status = 'active'
                LEFT JOIN ria_firms f
                  ON f.id = m.firm_id
                WHERE
                  ($1::text IS NULL OR mp.display_name ILIKE ('%' || $1 || '%'))
                  AND ($2::text IS NULL OR rp.verification_status = $2)
                  AND COALESCE((mp.metadata ->> 'is_test_profile')::boolean, FALSE) = FALSE
                  AND (
                    $3::text IS NULL
                    OR EXISTS (
                      SELECT 1
                      FROM ria_firm_memberships m2
                      JOIN ria_firms f2 ON f2.id = m2.firm_id
                      WHERE m2.ria_profile_id = rp.id
                        AND m2.membership_status = 'active'
                        AND f2.legal_name ILIKE ('%' || $3 || '%')
                    )
                  )
                GROUP BY
                  rp.id,
                  rp.user_id,
                  mp.display_name,
                  mp.headline,
                  mp.strategy_summary,
                  mp.metadata,
                  rp.verification_status
                ORDER BY
                  CASE WHEN rp.verification_status IN ('active', 'finra_verified') THEN 0 ELSE 1 END,
                  mp.display_name ASC
                LIMIT $4
                """,
                (query or "").strip() or None,
                (verification_status or "").strip() or None,
                (firm or "").strip() or None,
                limit_safe,
            )
            return [dict(row) for row in rows]
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()

    async def get_marketplace_ria_profile(self, ria_id: str) -> dict[str, Any] | None:
        conn = await self._conn()
        try:
            await self._ensure_iam_schema_ready(conn)
            row = await conn.fetchrow(
                """
                SELECT
                  rp.id,
                  rp.user_id,
                  mp.display_name,
                  mp.headline,
                  mp.strategy_summary,
                  rp.verification_status,
                  CASE
                    WHEN jsonb_typeof(mp.metadata -> 'is_test_profile') = 'boolean'
                    THEN (mp.metadata ->> 'is_test_profile')::boolean
                    ELSE FALSE
                  END AS is_test_profile,
                  rp.bio,
                  rp.strategy,
                  rp.disclosures_url,
                  COALESCE(
                    json_agg(
                      DISTINCT jsonb_build_object(
                        'firm_id', f.id,
                        'legal_name', f.legal_name,
                        'role_title', m.role_title,
                        'is_primary', m.is_primary
                      )
                    ) FILTER (WHERE f.id IS NOT NULL),
                    '[]'::json
                  ) AS firms
                FROM ria_profiles rp
                JOIN marketplace_public_profiles mp
                  ON mp.user_id = rp.user_id
                  AND mp.profile_type = 'ria'
                  AND mp.is_discoverable = TRUE
                LEFT JOIN ria_firm_memberships m
                  ON m.ria_profile_id = rp.id
                  AND m.membership_status = 'active'
                LEFT JOIN ria_firms f
                  ON f.id = m.firm_id
                WHERE rp.id = $1::uuid
                  AND COALESCE((mp.metadata ->> 'is_test_profile')::boolean, FALSE) = FALSE
                GROUP BY rp.id, rp.user_id, mp.display_name, mp.headline, mp.strategy_summary, rp.verification_status, rp.bio, rp.strategy, rp.disclosures_url, is_test_profile
                """,
                ria_id,
            )
            return dict(row) if row else None
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()

    async def search_marketplace_investors(
        self,
        *,
        query: str | None,
        limit: int,
    ) -> list[dict[str, Any]]:
        conn = await self._conn()
        try:
            await self._ensure_iam_schema_ready(conn)
            limit_safe = max(1, min(limit, 50))
            rows = await conn.fetch(
                """
                SELECT
                  ap.user_id,
                  mp.display_name,
                  mp.headline,
                  mp.location_hint,
                  mp.strategy_summary,
                  CASE
                    WHEN jsonb_typeof(mp.metadata -> 'is_test_profile') = 'boolean'
                    THEN (mp.metadata ->> 'is_test_profile')::boolean
                    ELSE FALSE
                  END AS is_test_profile
                FROM actor_profiles ap
                JOIN marketplace_public_profiles mp
                  ON mp.user_id = ap.user_id
                  AND mp.profile_type = 'investor'
                  AND mp.is_discoverable = TRUE
                WHERE
                  ap.investor_marketplace_opt_in = TRUE
                  AND ($1::text IS NULL OR mp.display_name ILIKE ('%' || $1 || '%'))
                  AND COALESCE((mp.metadata ->> 'is_test_profile')::boolean, FALSE) = FALSE
                ORDER BY mp.display_name ASC
                LIMIT $2
                """,
                (query or "").strip() or None,
                limit_safe,
            )
            return [dict(row) for row in rows]
        except asyncpg.exceptions.UndefinedTableError as exc:
            raise IAMSchemaNotReadyError() from exc
        finally:
            await conn.close()
