"""Personal World Model (PWM) store.

The owner-keyed preference document behind ``/api/pwm`` — the server-side home
of the cross-device "your private agent already knows you" loop for the PCHP
RFC-002 Preference Subscription Fabric.

Trust contract:
- One row per verified Firebase uid (the caller's own uid, taken from the
  verified token, never from a request body).
- The document is the owner's own plaintext preference doc, returned only to
  them. This is NOT vault/ciphertext content and never another party's data.
- Merge is section-level last-writer-wins by ``updatedAt``; the store is fully
  wipeable (a DELETE, or an empty PUT).

The store deliberately uses the lightweight async pool idiom (mirrors
``market_cache_store``) rather than the encrypted vault path: a PWM document is
small, owner-only preference metadata, not vault-protected content.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from db.connection import get_pool

logger = logging.getLogger(__name__)

# Defensive bounds (CWE-400 / DoS). A PWM document is small preference
# metadata, not a data lake — reject anything that tries to make it one.
PWM_MAX_TOP_LEVEL_KEYS = 64
PWM_MAX_SERIALIZED_BYTES = 64 * 1024


class PwmDocumentTooLargeError(ValueError):
    """Raised when a merged PWM document exceeds the size/complexity bound."""


class PwmService:
    def __init__(self) -> None:
        self._table_ready = False
        self._init_lock = asyncio.Lock()

    async def ensure_table(self) -> None:
        """Create the ``pwm_documents`` table if the migration has not run yet.

        Migration ``118_preference_world_model.sql`` is authoritative; this
        idempotent safety-net mirrors the established belt-and-suspenders idiom
        (see ``market_cache_store`` / ``DeveloperRegistryService.ensure_tables``)
        so a fresh environment cannot 500 before the migration lands.
        """
        if self._table_ready:
            return
        async with self._init_lock:
            if self._table_ready:
                return
            pool = await get_pool()
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS pwm_documents (
                        user_id TEXT PRIMARY KEY,
                        doc JSONB NOT NULL DEFAULT '{}'::jsonb,
                        revision BIGINT NOT NULL DEFAULT 1,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )
                    """
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_pwm_documents_updated_at "
                    "ON pwm_documents (updated_at DESC)"
                )
            self._table_ready = True

    @staticmethod
    def _as_obj(value: Any) -> dict[str, Any]:
        """Coerce a JSONB column value (dict or JSON string) into a dict."""
        if isinstance(value, dict):
            return value
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
            except (ValueError, TypeError):
                return {}
            return parsed if isinstance(parsed, dict) else {}
        return {}

    @staticmethod
    def _section_updated_at(section: Any) -> float | None:
        """Return a section's numeric ``updatedAt`` (ms epoch), or None."""
        if isinstance(section, dict):
            raw = section.get("updatedAt")
            # bool is an int subclass — exclude it explicitly.
            if isinstance(raw, (int, float)) and not isinstance(raw, bool):
                return float(raw)
        return None

    @classmethod
    def merge(cls, stored: dict[str, Any], partial: dict[str, Any]) -> dict[str, Any]:
        """Section-level last-writer-wins merge by ``updatedAt``.

        For each top-level key in ``partial``: if both the stored and incoming
        sections carry a numeric ``updatedAt`` and the stored one is strictly
        newer, the stored section is kept (a stale write is rejected).
        Otherwise the incoming section replaces the stored one. Top-level keys
        absent from ``partial`` are left untouched. This matches the fabric's
        ``{ "connect": { ..., "updatedAt": <ms> } }`` document shape, where each
        top-level section carries its own last-write timestamp.
        """
        merged = dict(stored)
        for key, incoming in partial.items():
            incoming_ts = cls._section_updated_at(incoming)
            existing_ts = cls._section_updated_at(merged.get(key))
            if incoming_ts is not None and existing_ts is not None and existing_ts > incoming_ts:
                # Stored section is strictly newer — reject the stale write.
                continue
            merged[key] = incoming
        return merged

    @classmethod
    def _serialize_guarded(cls, doc: dict[str, Any]) -> str:
        if len(doc) > PWM_MAX_TOP_LEVEL_KEYS:
            raise PwmDocumentTooLargeError(
                f"PWM document exceeds {PWM_MAX_TOP_LEVEL_KEYS} top-level keys."
            )
        serialized = json.dumps(doc, separators=(",", ":"), ensure_ascii=False)
        if len(serialized.encode("utf-8")) > PWM_MAX_SERIALIZED_BYTES:
            raise PwmDocumentTooLargeError("PWM document exceeds the size limit.")
        return serialized

    async def get_document(self, user_id: str) -> dict[str, Any] | None:
        """Return the caller's stored document, or None if none exists."""
        await self.ensure_table()
        pool = await get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT doc FROM pwm_documents WHERE user_id = $1",
                user_id,
            )
        if row is None:
            return None
        return self._as_obj(row["doc"])

    async def merge_document(self, user_id: str, partial: dict[str, Any]) -> dict[str, Any]:
        """Merge ``partial`` into the caller's document and return the result.

        Read-modify-write under a row lock so concurrent multi-device writes
        resolve deterministically by ``updatedAt`` instead of clobbering.
        """
        await self.ensure_table()
        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    "SELECT doc FROM pwm_documents WHERE user_id = $1 FOR UPDATE",
                    user_id,
                )
                stored = self._as_obj(row["doc"]) if row is not None else {}
                merged = self.merge(stored, partial)
                serialized = self._serialize_guarded(merged)
                await conn.execute(
                    """
                    INSERT INTO pwm_documents (user_id, doc, revision, created_at, updated_at)
                    VALUES ($1, $2::jsonb, 1, now(), now())
                    ON CONFLICT (user_id) DO UPDATE SET
                        doc = EXCLUDED.doc,
                        revision = pwm_documents.revision + 1,
                        updated_at = now()
                    """,
                    user_id,
                    serialized,
                )
        return merged

    async def delete_document(self, user_id: str) -> bool:
        """Wipe the caller's document. Returns True if a row existed."""
        await self.ensure_table()
        pool = await get_pool()
        async with pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM pwm_documents WHERE user_id = $1",
                user_id,
            )
        # asyncpg returns a command tag such as "DELETE 1".
        try:
            return int(str(result).split()[-1]) > 0
        except (ValueError, IndexError):
            return False


_pwm_service: PwmService | None = None


def get_pwm_service() -> PwmService:
    """Return the process-wide PwmService singleton."""
    global _pwm_service
    if _pwm_service is None:
        _pwm_service = PwmService()
    return _pwm_service
