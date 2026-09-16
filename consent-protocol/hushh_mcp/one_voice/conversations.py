"""Conversation ledger for One Live Voice (migration 222).

Holds the canonical entity context (ids plus the display names the server
itself returned), the provider resumption handle, and per-conversation
counters. No audio, no transcripts, no tokens. Same executor pattern as
:mod:`hushh_mcp.services.command_checkpoints` so the offline CI database and
the schema-per-test Postgres suite both work.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from db.db_client import DatabaseExecutionError, get_db

_COLUMNS = """
    id, user_id, status, entity_context, screen_context, live_resumption_handle, model_id,
    model_location, session_count, audio_in_seconds, audio_out_seconds, tool_calls,
    tool_results_ok, tool_results_rejected, narration_without_receipt, unknown_tool_calls,
    last_close_code, last_close_reason_class, created_at, last_seen_at, expires_at
"""

COUNTERS = (
    "audio_in_seconds",
    "audio_out_seconds",
    "tool_calls",
    "tool_results_ok",
    "tool_results_rejected",
    "narration_without_receipt",
    "unknown_tool_calls",
)


class ConversationStorageError(RuntimeError):
    pass


class ConversationNotOwned(PermissionError):
    pass


def _json(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, (str, bytes)):
        try:
            return json.loads(value)
        except ValueError:
            return {}
    return {}


def _iso(value: Any) -> str | None:
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value) if value else None


@dataclass
class Conversation:
    id: str
    user_id: str
    status: str
    entity_context: dict[str, Any] = field(default_factory=dict)
    screen_context: dict[str, Any] = field(default_factory=dict)
    live_resumption_handle: str | None = None
    model_id: str = ""
    model_location: str = ""
    session_count: int = 0
    counters: dict[str, int] = field(default_factory=dict)
    last_close_code: int | None = None
    last_close_reason_class: str | None = None
    created_at: str | None = None
    last_seen_at: str | None = None
    expires_at: str | None = None

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> Conversation:
        return cls(
            id=str(row["id"]),
            user_id=str(row["user_id"]),
            status=str(row.get("status") or "active"),
            entity_context=_json(row.get("entity_context")),
            screen_context=_json(row.get("screen_context")),
            live_resumption_handle=row.get("live_resumption_handle") or None,
            model_id=str(row.get("model_id") or ""),
            model_location=str(row.get("model_location") or ""),
            session_count=int(row.get("session_count") or 0),
            counters={name: int(row.get(name) or 0) for name in COUNTERS},
            last_close_code=row.get("last_close_code"),
            last_close_reason_class=row.get("last_close_reason_class") or None,
            created_at=_iso(row.get("created_at")),
            last_seen_at=_iso(row.get("last_seen_at")),
            expires_at=_iso(row.get("expires_at")),
        )


class ConversationStore:
    def __init__(self, *, db: Any = None) -> None:
        self._db = db

    @property
    def db(self):
        if self._db is None:
            self._db = get_db()
        return self._db

    async def _execute(self, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        try:
            result = await asyncio.to_thread(self.db.execute_raw, sql, params)
        except DatabaseExecutionError:
            raise ConversationStorageError("Voice storage is temporarily unavailable.") from None
        return list(result.data or [])

    async def _one(self, sql: str, params: dict[str, Any]) -> dict[str, Any] | None:
        rows = await self._execute(sql, params)
        return rows[0] if rows else None

    async def open(
        self,
        *,
        user_id: str,
        conversation_id: str,
        model_id: str,
        model_location: str,
    ) -> Conversation:
        """Create or resume the owner's conversation, bumping the session count.

        A conversation id supplied by a different user is refused rather than
        silently re-homed.
        """
        try:
            cid = str(uuid.UUID(str(conversation_id)))
        except ValueError:
            raise ValueError("conversation_id must be a UUID") from None
        existing = await self._one(
            f"SELECT {_COLUMNS} FROM one_voice_conversations WHERE id = CAST(:id AS UUID)",  # nosec B608 - static column/assignment fragments; every value is a bound parameter.
            {"id": cid},
        )
        if existing is not None:
            if str(existing["user_id"]) != user_id:
                raise ConversationNotOwned("conversation belongs to another user")
            row = await self._one(
                f"""
                UPDATE one_voice_conversations
                SET session_count = session_count + 1,
                    status = 'active',
                    last_seen_at = NOW(),
                    expires_at = NOW() + interval '2 hours'
                WHERE id = CAST(:id AS UUID)
                RETURNING {_COLUMNS}
                """,  # nosec B608 - static column/assignment fragments; every value is a bound parameter.
                {"id": cid},
            )
            return Conversation.from_row(row or existing)
        row = await self._one(
            f"""
            INSERT INTO one_voice_conversations (id, user_id, model_id, model_location, session_count)
            VALUES (CAST(:id AS UUID), :user_id, :model_id, :model_location, 1)
            RETURNING {_COLUMNS}
            """,  # nosec B608 - static column/assignment fragments; every value is a bound parameter.
            {"id": cid, "user_id": user_id, "model_id": model_id, "model_location": model_location},
        )
        if row is None:
            raise ConversationStorageError("Voice conversation could not be created.")
        return Conversation.from_row(row)

    async def get(self, *, user_id: str, conversation_id: str) -> Conversation | None:
        row = await self._one(
            f"""
            SELECT {_COLUMNS} FROM one_voice_conversations
            WHERE id = CAST(:id AS UUID) AND user_id = :user_id
            """,  # nosec B608 - static column/assignment fragments; every value is a bound parameter.
            {"id": str(conversation_id), "user_id": user_id},
        )
        return Conversation.from_row(row) if row else None

    async def save_entity_context(
        self, *, user_id: str, conversation_id: str, context: dict[str, Any]
    ) -> None:
        await self._execute(
            """
            UPDATE one_voice_conversations
            SET entity_context = CAST(:context AS JSONB), last_seen_at = NOW()
            WHERE id = CAST(:id AS UUID) AND user_id = :user_id
            """,
            {
                "id": str(conversation_id),
                "user_id": user_id,
                "context": json.dumps(context, separators=(",", ":")),
            },
        )

    async def save_screen_context(
        self, *, user_id: str, conversation_id: str, context: dict[str, Any]
    ) -> None:
        await self._execute(
            """
            UPDATE one_voice_conversations
            SET screen_context = CAST(:context AS JSONB), last_seen_at = NOW()
            WHERE id = CAST(:id AS UUID) AND user_id = :user_id
            """,
            {
                "id": str(conversation_id),
                "user_id": user_id,
                "context": json.dumps(context, separators=(",", ":")),
            },
        )

    async def save_resumption_handle(
        self, *, user_id: str, conversation_id: str, handle: str | None
    ) -> None:
        await self._execute(
            """
            UPDATE one_voice_conversations
            SET live_resumption_handle = :handle, last_seen_at = NOW()
            WHERE id = CAST(:id AS UUID) AND user_id = :user_id
            """,
            {"id": str(conversation_id), "user_id": user_id, "handle": handle},
        )

    async def bump(self, *, user_id: str, conversation_id: str, **counters: int) -> None:
        """Increment session counters. Unknown names are ignored on purpose."""
        assignments = [f"{name} = {name} + :{name}" for name in counters if name in COUNTERS]
        if not assignments:
            return
        params = {name: int(value) for name, value in counters.items() if name in COUNTERS}
        await self._execute(
            f"""
            UPDATE one_voice_conversations
            SET {", ".join(assignments)}, last_seen_at = NOW()
            WHERE id = CAST(:id AS UUID) AND user_id = :user_id
            """,  # nosec B608 - static column/assignment fragments; every value is a bound parameter.
            {"id": str(conversation_id), "user_id": user_id, **params},
        )

    async def close(
        self,
        *,
        user_id: str,
        conversation_id: str,
        close_code: int | None,
        reason_class: str | None,
        ended: bool = False,
    ) -> None:
        await self._execute(
            """
            UPDATE one_voice_conversations
            SET last_close_code = :code,
                last_close_reason_class = :reason,
                status = CASE WHEN :ended THEN 'ended' ELSE status END,
                last_seen_at = NOW()
            WHERE id = CAST(:id AS UUID) AND user_id = :user_id
            """,
            {
                "id": str(conversation_id),
                "user_id": user_id,
                "code": close_code,
                "reason": (reason_class or "")[:80] or None,
                "ended": bool(ended),
            },
        )

    async def daily_audio_seconds(self, *, user_id: str) -> int:
        row = await self._one(
            """
            SELECT COALESCE(SUM(audio_in_seconds), 0) AS seconds
            FROM one_voice_conversations
            WHERE user_id = :user_id AND created_at >= NOW() - interval '24 hours'
            """,
            {"user_id": user_id},
        )
        return int((row or {}).get("seconds") or 0)
