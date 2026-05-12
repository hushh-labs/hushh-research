from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

import asyncpg

from api.utils.firebase_admin import get_firebase_auth_app
from db.connection import get_pool

logger = logging.getLogger(__name__)

_IDENTITY_STALE_AFTER = timedelta(hours=24)
_IDENTITY_SYNC_COOLDOWN = timedelta(minutes=5)
_IDENTITY_SYNC_TASKS: dict[str, asyncio.Task[dict[str, Any] | None]] = {}
_IDENTITY_SYNC_COOLDOWN_UNTIL: dict[str, datetime] = {}
_ALIAS_CODE_PATTERN = re.compile(r"\s+")


class ActorIdentityAliasError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        code: str = "ACTOR_IDENTITY_ALIAS_ERROR",
        status_code: int = 400,
    ) -> None:
        self.code = code
        self.status_code = status_code
        super().__init__(message)


class ActorIdentityService:
    def schedule_sync_from_firebase(
        self,
        user_id: str,
        *,
        force: bool = False,
    ) -> bool:
        normalized_user_id = str(user_id or "").strip()
        if not normalized_user_id or not self._looks_like_firebase_uid(normalized_user_id):
            return False

        existing = _IDENTITY_SYNC_TASKS.get(normalized_user_id)
        if existing and not existing.done():
            return False

        now = datetime.now(timezone.utc)
        cooldown_until = _IDENTITY_SYNC_COOLDOWN_UNTIL.get(normalized_user_id)
        if not force and cooldown_until and cooldown_until > now:
            return False

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return False

        _IDENTITY_SYNC_COOLDOWN_UNTIL[normalized_user_id] = now + _IDENTITY_SYNC_COOLDOWN
        task = loop.create_task(self.sync_from_firebase(normalized_user_id, force=force))
        _IDENTITY_SYNC_TASKS[normalized_user_id] = task

        def _cleanup(completed: asyncio.Task[dict[str, Any] | None]) -> None:
            if _IDENTITY_SYNC_TASKS.get(normalized_user_id) is completed:
                _IDENTITY_SYNC_TASKS.pop(normalized_user_id, None)
            try:
                completed.result()
            except Exception as exc:
                logger.debug(
                    "actor_identity_cache background sync skipped for %s: %s",
                    normalized_user_id,
                    exc,
                )

        task.add_done_callback(_cleanup)
        return True

    async def _known_actor_ids(self, user_ids: Iterable[str]) -> set[str]:
        normalized_ids = [str(user_id or "").strip() for user_id in user_ids]
        normalized_ids = [user_id for user_id in normalized_ids if user_id]
        if not normalized_ids:
            return set()

        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT user_id
                FROM actor_profiles
                WHERE user_id = ANY($1::text[])
                """,
                normalized_ids,
            )
        return {
            str(row["user_id"] or "").strip() for row in rows if str(row["user_id"] or "").strip()
        }

    @staticmethod
    def _looks_like_firebase_uid(value: str) -> bool:
        candidate = str(value or "").strip()
        if not candidate:
            return False
        if "@" in candidate or ":" in candidate or "/" in candidate or " " in candidate:
            return False
        lowered = candidate.lower()
        if lowered.startswith(("ria_", "ria-", "dev_", "dev-", "app_", "app-", "agent_", "agent-")):
            return False
        return len(candidate) >= 20

    @staticmethod
    def _normalize_email_alias(value: str | None) -> str:
        email = str(value or "").strip().lower()
        if not email or len(email) > 320 or email.count("@") != 1:
            raise ActorIdentityAliasError(
                "A valid email alias is required.",
                code="EMAIL_ALIAS_INVALID",
                status_code=422,
            )
        local, domain = email.rsplit("@", 1)
        if not local or not domain or "." not in domain or any(char.isspace() for char in email):
            raise ActorIdentityAliasError(
                "A valid email alias is required.",
                code="EMAIL_ALIAS_INVALID",
                status_code=422,
            )
        return email

    @staticmethod
    def _runtime_environment() -> str:
        return (
            str(
                os.getenv("ENVIRONMENT")
                or os.getenv("HUSHH_DEPLOY_ENV")
                or os.getenv("APP_ENV")
                or "development"
            )
            .strip()
            .lower()
        )

    @staticmethod
    def _env_truthy(name: str) -> bool:
        return str(os.getenv(name) or "").strip().lower() in {"1", "true", "yes", "on"}

    @classmethod
    def _may_return_review_alias_code(cls) -> bool:
        environment = cls._runtime_environment()
        if environment in {"prod", "production"}:
            return False
        return cls._env_truthy("APP_REVIEW_MODE") or environment in {
            "dev",
            "development",
            "local",
            "test",
            "testing",
            "uat",
        }

    @staticmethod
    def _alias_verification_secret() -> str:
        return (
            os.getenv("ACCOUNT_EMAIL_ALIAS_VERIFICATION_SECRET")
            or os.getenv("HUSHH_EMAIL_ALIAS_VERIFICATION_SECRET")
            or "hushh-dev-uat-email-alias-verification"
        )

    @classmethod
    def _hash_alias_verification_code(
        cls,
        *,
        user_id: str,
        email_normalized: str,
        verification_code: str,
    ) -> str:
        normalized_code = _ALIAS_CODE_PATTERN.sub("", str(verification_code or "")).lower()
        if not normalized_code:
            raise ActorIdentityAliasError(
                "Verification code is required.",
                code="EMAIL_ALIAS_CODE_REQUIRED",
                status_code=422,
            )
        material = (
            f"{cls._alias_verification_secret()}:{user_id}:{email_normalized}:{normalized_code}"
        )
        return hashlib.sha256(material.encode("utf-8")).hexdigest()

    @staticmethod
    def _normalize_alias_row(row: Any) -> dict[str, Any]:
        payload = dict(row or {})
        return {
            "alias_id": str(payload.get("alias_id") or "").strip(),
            "user_id": str(payload.get("user_id") or "").strip(),
            "email": str(payload.get("email") or "").strip(),
            "email_normalized": str(payload.get("email_normalized") or "").strip(),
            "verification_status": str(payload.get("verification_status") or "").strip(),
            "verification_source": str(payload.get("verification_source") or "").strip(),
            "source_ref": payload.get("source_ref"),
            "verification_requested_at": payload.get("verification_requested_at"),
            "verified_at": payload.get("verified_at"),
            "revoked_at": payload.get("revoked_at"),
            "last_matched_at": payload.get("last_matched_at"),
            "created_at": payload.get("created_at"),
            "updated_at": payload.get("updated_at"),
        }

    async def _get_many_fallback(self, user_ids: list[str]) -> dict[str, dict[str, Any]]:
        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT
                  ap.user_id,
                  COALESCE(mpp.display_name, rp.display_name, ap.user_id) AS display_name,
                  NULL::TEXT AS email,
                  NULL::TEXT AS phone_number,
                  NULL::TEXT AS photo_url,
                  FALSE AS email_verified,
                  FALSE AS phone_verified,
                  'legacy_fallback'::TEXT AS source,
                  NOW() AS last_synced_at,
                  NOW() AS created_at,
                  NOW() AS updated_at
                FROM actor_profiles ap
                LEFT JOIN marketplace_public_profiles mpp
                  ON mpp.user_id = ap.user_id
                LEFT JOIN ria_profiles rp
                  ON rp.user_id = ap.user_id
                WHERE ap.user_id = ANY($1::text[])
                """,
                user_ids,
            )
        return {
            str(row["user_id"]): self._normalize_row(row)
            for row in rows
            if str(row.get("user_id") or "").strip()
        }

    async def _get_many_without_phone_shadow(
        self, user_ids: list[str]
    ) -> dict[str, dict[str, Any]]:
        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT
                  user_id,
                  display_name,
                  email,
                  NULL::TEXT AS phone_number,
                  photo_url,
                  email_verified,
                  FALSE AS phone_verified,
                  source,
                  last_synced_at,
                  created_at,
                  updated_at
                FROM actor_identity_cache
                WHERE user_id = ANY($1::text[])
                """,
                user_ids,
            )
        return {
            str(row["user_id"]): self._normalize_row(row)
            for row in rows
            if str(row.get("user_id") or "").strip()
        }

    @staticmethod
    def _normalize_row(row: Any) -> dict[str, Any]:
        if not row:
            return {}
        payload = dict(row)
        return {
            "user_id": str(payload.get("user_id") or "").strip(),
            "display_name": str(payload.get("display_name") or "").strip() or None,
            "email": str(payload.get("email") or "").strip() or None,
            "phone_number": str(payload.get("phone_number") or "").strip() or None,
            "photo_url": str(payload.get("photo_url") or "").strip() or None,
            "email_verified": bool(payload.get("email_verified")),
            "phone_verified": bool(payload.get("phone_verified")),
            "source": str(payload.get("source") or "").strip() or "unknown",
            "last_synced_at": payload.get("last_synced_at"),
            "created_at": payload.get("created_at"),
            "updated_at": payload.get("updated_at"),
        }

    @staticmethod
    def _is_stale(identity: dict[str, Any] | None) -> bool:
        if not identity:
            return True
        value = identity.get("last_synced_at")
        if not value:
            return True
        if isinstance(value, datetime):
            timestamp = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        else:
            try:
                timestamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            except Exception:
                return True
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) - timestamp >= _IDENTITY_STALE_AFTER

    async def get_many(self, user_ids: Iterable[str]) -> dict[str, dict[str, Any]]:
        normalized_ids = [str(user_id or "").strip() for user_id in user_ids]
        normalized_ids = [user_id for user_id in normalized_ids if user_id]
        if not normalized_ids:
            return {}

        pool = await get_pool()
        try:
            async with pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT
                      user_id,
                      display_name,
                      email,
                      phone_number,
                      photo_url,
                      email_verified,
                      phone_verified,
                      source,
                      last_synced_at,
                      created_at,
                      updated_at
                    FROM actor_identity_cache
                    WHERE user_id = ANY($1::text[])
                    """,
                    normalized_ids,
                )
        except asyncpg.UndefinedTableError:
            logger.debug("actor_identity_cache missing; using legacy identity fallback")
            return await self._get_many_fallback(normalized_ids)
        except asyncpg.UndefinedColumnError as exc:
            if "phone_number" not in str(exc) and "phone_verified" not in str(exc):
                raise
            logger.debug("actor_identity_cache phone shadow missing; using pre-047 projection")
            return await self._get_many_without_phone_shadow(normalized_ids)
        return {
            str(row["user_id"]): self._normalize_row(row)
            for row in rows
            if str(row.get("user_id") or "").strip()
        }

    async def upsert_identity(
        self,
        *,
        user_id: str,
        display_name: str | None = None,
        email: str | None = None,
        phone_number: str | None = None,
        photo_url: str | None = None,
        email_verified: bool | None = None,
        phone_verified: bool | None = None,
        source: str = "unknown",
    ) -> dict[str, Any] | None:
        normalized_user_id = str(user_id or "").strip()
        if not normalized_user_id:
            return None

        pool = await get_pool()
        try:
            async with pool.acquire() as conn:
                row = await conn.fetchrow(
                    """
                    INSERT INTO actor_identity_cache (
                      user_id,
                      display_name,
                      email,
                      phone_number,
                      photo_url,
                      email_verified,
                      phone_verified,
                      source,
                      last_synced_at,
                      created_at,
                      updated_at
                    )
                    VALUES (
                      $1,
                      $2,
                      $3,
                      $4,
                      $5,
                      COALESCE($6, FALSE),
                      COALESCE($7, FALSE),
                      $8,
                      NOW(),
                      NOW(),
                      NOW()
                    )
                    ON CONFLICT (user_id) DO UPDATE SET
                      display_name = COALESCE(EXCLUDED.display_name, actor_identity_cache.display_name),
                      email = COALESCE(EXCLUDED.email, actor_identity_cache.email),
                      phone_number = COALESCE(EXCLUDED.phone_number, actor_identity_cache.phone_number),
                      photo_url = COALESCE(EXCLUDED.photo_url, actor_identity_cache.photo_url),
                      email_verified = COALESCE(EXCLUDED.email_verified, actor_identity_cache.email_verified),
                      phone_verified = COALESCE(EXCLUDED.phone_verified, actor_identity_cache.phone_verified),
                      source = CASE
                        WHEN EXCLUDED.source IS NULL OR EXCLUDED.source = '' THEN actor_identity_cache.source
                        ELSE EXCLUDED.source
                      END,
                      last_synced_at = NOW(),
                      updated_at = NOW()
                    RETURNING
                      user_id,
                      display_name,
                      email,
                      phone_number,
                      photo_url,
                      email_verified,
                      phone_verified,
                      source,
                      last_synced_at,
                      created_at,
                      updated_at
                    """,
                    normalized_user_id,
                    str(display_name or "").strip() or None,
                    str(email or "").strip().lower() or None,
                    str(phone_number or "").strip() or None,
                    str(photo_url or "").strip() or None,
                    email_verified,
                    phone_verified,
                    str(source or "").strip() or "unknown",
                )
        except Exception as exc:
            logger.debug(
                "actor_identity_cache upsert skipped for %s: %s",
                normalized_user_id,
                exc,
            )
            return None

        return self._normalize_row(row)

    async def list_verified_email_aliases(self, user_id: str) -> list[dict[str, Any]]:
        normalized_user_id = str(user_id or "").strip()
        if not normalized_user_id:
            return []

        pool = await get_pool()
        try:
            async with pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT
                      alias_id,
                      user_id,
                      email,
                      email_normalized,
                      verification_status,
                      verification_source,
                      source_ref,
                      verification_requested_at,
                      verified_at,
                      revoked_at,
                      last_matched_at,
                      created_at,
                      updated_at
                    FROM actor_verified_email_aliases
                    WHERE user_id = $1
                    ORDER BY
                      CASE verification_status
                        WHEN 'verified' THEN 0
                        WHEN 'pending' THEN 1
                        ELSE 2
                      END,
                      COALESCE(verified_at, verification_requested_at, created_at) DESC
                    """,
                    normalized_user_id,
                )
        except asyncpg.UndefinedTableError:
            logger.debug("actor_verified_email_aliases missing; alias list empty")
            return []
        return [self._normalize_alias_row(row) for row in rows]

    async def request_email_alias_verification(
        self,
        *,
        user_id: str,
        email: str,
        verification_source: str = "user_verified",
        source_ref: str | None = None,
    ) -> dict[str, Any]:
        normalized_user_id = str(user_id or "").strip()
        if not normalized_user_id:
            raise ActorIdentityAliasError(
                "User id is required.",
                code="EMAIL_ALIAS_USER_REQUIRED",
                status_code=422,
            )
        email_normalized = self._normalize_email_alias(email)
        source = str(verification_source or "user_verified").strip() or "user_verified"
        if source not in {"user_verified", "firebase_auth", "admin_seed", "review_seed"}:
            source = "user_verified"

        pool = await get_pool()
        async with pool.acquire() as conn:
            verified_owner = await conn.fetchrow(
                """
                SELECT user_id
                FROM actor_verified_email_aliases
                WHERE email_normalized = $1
                  AND verification_status = 'verified'
                  AND revoked_at IS NULL
                  AND user_id <> $2
                LIMIT 1
                """,
                email_normalized,
                normalized_user_id,
            )
            if verified_owner:
                raise ActorIdentityAliasError(
                    "This email alias is already verified for another account.",
                    code="EMAIL_ALIAS_ALREADY_VERIFIED",
                    status_code=409,
                )

            existing = await conn.fetchrow(
                """
                SELECT
                  alias_id,
                  user_id,
                  email,
                  email_normalized,
                  verification_status,
                  verification_source,
                  source_ref,
                  verification_requested_at,
                  verified_at,
                  revoked_at,
                  last_matched_at,
                  created_at,
                  updated_at
                FROM actor_verified_email_aliases
                WHERE user_id = $1
                  AND email_normalized = $2
                """,
                normalized_user_id,
                email_normalized,
            )
            if (
                existing
                and existing["verification_status"] == "verified"
                and existing["revoked_at"] is None
            ):
                return {
                    "alias": self._normalize_alias_row(existing),
                    "already_verified": True,
                    "review_verification_code": None,
                }

            verification_code = f"{secrets.randbelow(1_000_000):06d}"
            code_hash = self._hash_alias_verification_code(
                user_id=normalized_user_id,
                email_normalized=email_normalized,
                verification_code=verification_code,
            )
            row = await conn.fetchrow(
                """
                INSERT INTO actor_verified_email_aliases (
                  user_id,
                  email,
                  email_normalized,
                  verification_status,
                  verification_source,
                  source_ref,
                  verification_code_hash,
                  verification_requested_at,
                  verified_at,
                  revoked_at,
                  created_at,
                  updated_at
                )
                VALUES (
                  $1,
                  $2,
                  $3,
                  'pending',
                  $4,
                  $5,
                  $6,
                  NOW(),
                  NULL,
                  NULL,
                  NOW(),
                  NOW()
                )
                ON CONFLICT (user_id, email_normalized) DO UPDATE SET
                  email = EXCLUDED.email,
                  verification_status = 'pending',
                  verification_source = EXCLUDED.verification_source,
                  source_ref = EXCLUDED.source_ref,
                  verification_code_hash = EXCLUDED.verification_code_hash,
                  verification_requested_at = NOW(),
                  verified_at = NULL,
                  revoked_at = NULL,
                  updated_at = NOW()
                RETURNING
                  alias_id,
                  user_id,
                  email,
                  email_normalized,
                  verification_status,
                  verification_source,
                  source_ref,
                  verification_requested_at,
                  verified_at,
                  revoked_at,
                  last_matched_at,
                  created_at,
                  updated_at
                """,
                normalized_user_id,
                email_normalized,
                email_normalized,
                source,
                str(source_ref or "").strip() or None,
                code_hash,
            )

        return {
            "alias": self._normalize_alias_row(row),
            "already_verified": False,
            "review_verification_code": (
                verification_code if self._may_return_review_alias_code() else None
            ),
        }

    async def confirm_email_alias_verification(
        self,
        *,
        user_id: str,
        email: str,
        verification_code: str,
    ) -> dict[str, Any]:
        normalized_user_id = str(user_id or "").strip()
        if not normalized_user_id:
            raise ActorIdentityAliasError(
                "User id is required.",
                code="EMAIL_ALIAS_USER_REQUIRED",
                status_code=422,
            )
        email_normalized = self._normalize_email_alias(email)
        expected_hash = self._hash_alias_verification_code(
            user_id=normalized_user_id,
            email_normalized=email_normalized,
            verification_code=verification_code,
        )

        pool = await get_pool()
        try:
            async with pool.acquire() as conn:
                row = await conn.fetchrow(
                    """
                    SELECT
                      alias_id,
                      user_id,
                      email,
                      email_normalized,
                      verification_status,
                      verification_source,
                      source_ref,
                      verification_requested_at,
                      verified_at,
                      revoked_at,
                      last_matched_at,
                      created_at,
                      updated_at,
                      verification_code_hash
                    FROM actor_verified_email_aliases
                    WHERE user_id = $1
                      AND email_normalized = $2
                    """,
                    normalized_user_id,
                    email_normalized,
                )
                if not row:
                    raise ActorIdentityAliasError(
                        "Email alias verification has not been requested.",
                        code="EMAIL_ALIAS_VERIFICATION_NOT_FOUND",
                        status_code=404,
                    )
                if row["verification_status"] == "verified" and row["revoked_at"] is None:
                    return self._normalize_alias_row(row)
                if row["verification_code_hash"] != expected_hash:
                    raise ActorIdentityAliasError(
                        "Email alias verification code is invalid.",
                        code="EMAIL_ALIAS_CODE_INVALID",
                        status_code=400,
                    )

                verified_owner = await conn.fetchrow(
                    """
                    SELECT user_id
                    FROM actor_verified_email_aliases
                    WHERE email_normalized = $1
                      AND verification_status = 'verified'
                      AND revoked_at IS NULL
                      AND user_id <> $2
                    LIMIT 1
                    """,
                    email_normalized,
                    normalized_user_id,
                )
                if verified_owner:
                    raise ActorIdentityAliasError(
                        "This email alias is already verified for another account.",
                        code="EMAIL_ALIAS_ALREADY_VERIFIED",
                        status_code=409,
                    )

                verified = await conn.fetchrow(
                    """
                    UPDATE actor_verified_email_aliases
                    SET
                      verification_status = 'verified',
                      verified_at = NOW(),
                      revoked_at = NULL,
                      verification_code_hash = NULL,
                      updated_at = NOW()
                    WHERE user_id = $1
                      AND email_normalized = $2
                    RETURNING
                      alias_id,
                      user_id,
                      email,
                      email_normalized,
                      verification_status,
                      verification_source,
                      source_ref,
                      verification_requested_at,
                      verified_at,
                      revoked_at,
                      last_matched_at,
                      created_at,
                      updated_at
                    """,
                    normalized_user_id,
                    email_normalized,
                )
        except asyncpg.UniqueViolationError as exc:
            raise ActorIdentityAliasError(
                "This email alias is already verified for another account.",
                code="EMAIL_ALIAS_ALREADY_VERIFIED",
                status_code=409,
            ) from exc
        return self._normalize_alias_row(verified)

    async def sync_from_firebase(
        self,
        user_id: str,
        *,
        force: bool = False,
    ) -> dict[str, Any] | None:
        normalized_user_id = str(user_id or "").strip()
        if not normalized_user_id:
            return None
        if not self._looks_like_firebase_uid(normalized_user_id):
            return None

        cached = (await self.get_many([normalized_user_id])).get(normalized_user_id)
        if cached and not force and not self._is_stale(cached):
            return cached

        firebase_app = get_firebase_auth_app()
        if firebase_app is None:
            return cached

        try:
            from firebase_admin import auth as firebase_auth

            user_record = firebase_auth.get_user(normalized_user_id, app=firebase_app)
        except Exception as exc:
            logger.debug(
                "actor_identity_cache firebase sync skipped for %s: %s",
                normalized_user_id,
                exc,
            )
            return cached

        updated = await self.upsert_identity(
            user_id=normalized_user_id,
            display_name=getattr(user_record, "display_name", None),
            email=getattr(user_record, "email", None),
            phone_number=getattr(user_record, "phone_number", None),
            photo_url=getattr(user_record, "photo_url", None),
            email_verified=getattr(user_record, "email_verified", None),
            phone_verified=bool(getattr(user_record, "phone_number", None)),
            source="firebase_auth",
        )
        return updated or cached

    async def ensure_many(self, user_ids: Iterable[str]) -> dict[str, dict[str, Any]]:
        normalized_ids = [str(user_id or "").strip() for user_id in user_ids]
        normalized_ids = [user_id for user_id in normalized_ids if user_id]
        if not normalized_ids:
            return {}

        identities = await self.get_many(normalized_ids)
        missing_or_stale = [
            user_id
            for user_id in normalized_ids
            if self._is_stale(identities.get(user_id))
            or not (
                identities.get(user_id, {}).get("display_name")
                or identities.get(user_id, {}).get("email")
            )
        ]

        known_actor_ids = await self._known_actor_ids(missing_or_stale)

        for user_id in missing_or_stale:
            if user_id not in known_actor_ids:
                continue
            refreshed = await self.sync_from_firebase(user_id)
            if refreshed:
                identities[user_id] = refreshed

        return identities
