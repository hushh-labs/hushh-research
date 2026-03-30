from __future__ import annotations

import asyncio
import logging
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

    async def _get_many_fallback(self, user_ids: list[str]) -> dict[str, dict[str, Any]]:
        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT
                  ap.user_id,
                  COALESCE(mpp.display_name, rp.display_name, ap.user_id) AS display_name,
                  NULL::TEXT AS email,
                  NULL::TEXT AS photo_url,
                  FALSE AS email_verified,
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

    @staticmethod
    def _normalize_row(row: Any) -> dict[str, Any]:
        if not row:
            return {}
        payload = dict(row)
        return {
            "user_id": str(payload.get("user_id") or "").strip(),
            "display_name": str(payload.get("display_name") or "").strip() or None,
            "email": str(payload.get("email") or "").strip() or None,
            "photo_url": str(payload.get("photo_url") or "").strip() or None,
            "email_verified": bool(payload.get("email_verified")),
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
                      photo_url,
                      email_verified,
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
        photo_url: str | None = None,
        email_verified: bool | None = None,
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
                      photo_url,
                      email_verified,
                      source,
                      last_synced_at,
                      created_at,
                      updated_at
                    )
                    VALUES ($1, $2, $3, $4, COALESCE($5, FALSE), $6, NOW(), NOW(), NOW())
                    ON CONFLICT (user_id) DO UPDATE SET
                      display_name = COALESCE(EXCLUDED.display_name, actor_identity_cache.display_name),
                      email = COALESCE(EXCLUDED.email, actor_identity_cache.email),
                      photo_url = COALESCE(EXCLUDED.photo_url, actor_identity_cache.photo_url),
                      email_verified = COALESCE(EXCLUDED.email_verified, actor_identity_cache.email_verified),
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
                      photo_url,
                      email_verified,
                      source,
                      last_synced_at,
                      created_at,
                      updated_at
                    """,
                    normalized_user_id,
                    str(display_name or "").strip() or None,
                    str(email or "").strip().lower() or None,
                    str(photo_url or "").strip() or None,
                    email_verified,
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
            photo_url=getattr(user_record, "photo_url", None),
            email_verified=getattr(user_record, "email_verified", None),
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
