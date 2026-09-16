"""Confirmation-gated voice mutations (migration 222).

A mutation tool with a ``confirm_*`` policy never executes on the model's
say-so. It creates a pending row; the client renders a card; the row is
executed only after the person confirms -- by voice (only after the card was
shown) or by tap (a hashed single-use receipt token). One open pending action
per conversation; a newer one cancels the older. Args hold canonical ids only.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import secrets
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from db.db_client import DatabaseExecutionError, get_db

PENDING_TTL_SECONDS = 120
TIERS = ("voice", "tap")

_COLUMNS = """
    id, user_id, conversation_id, tool_name, gateway_action_id, tier, args, summary,
    receipt_token_hash, status, shown_at, confirmed_at, resolved_at, confirmation_source,
    result, created_at, expires_at
"""


class PendingActionStorageError(RuntimeError):
    pass


class PendingActionConflict(RuntimeError):
    """The pending action is not in a state that allows this transition."""


def _hash_receipt(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


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
class PendingAction:
    id: str
    user_id: str
    conversation_id: str
    tool_name: str
    gateway_action_id: str
    tier: str
    args: dict[str, Any] = field(default_factory=dict)
    summary: str = ""
    status: str = "pending"
    shown_at: str | None = None
    confirmed_at: str | None = None
    resolved_at: str | None = None
    confirmation_source: str | None = None
    result: dict[str, Any] | None = None
    created_at: str | None = None
    expires_at: str | None = None

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> PendingAction:
        return cls(
            id=str(row["id"]),
            user_id=str(row["user_id"]),
            conversation_id=str(row["conversation_id"]),
            tool_name=str(row["tool_name"]),
            gateway_action_id=str(row["gateway_action_id"]),
            tier=str(row["tier"]),
            args=_json(row.get("args")),
            summary=str(row.get("summary") or ""),
            status=str(row.get("status") or "pending"),
            shown_at=_iso(row.get("shown_at")),
            confirmed_at=_iso(row.get("confirmed_at")),
            resolved_at=_iso(row.get("resolved_at")),
            confirmation_source=row.get("confirmation_source") or None,
            result=_json(row.get("result")) if row.get("result") is not None else None,
            created_at=_iso(row.get("created_at")),
            expires_at=_iso(row.get("expires_at")),
        )

    def public(self) -> dict[str, Any]:
        """What the client may see. Never the receipt hash."""
        return {
            "pending_action_id": self.id,
            "tool": self.tool_name,
            "gateway_action_id": self.gateway_action_id,
            "tier": self.tier,
            "summary": self.summary,
            "args": self.args,
            "status": self.status,
            "shown_at": self.shown_at,
            "expires_at": self.expires_at,
            "result": self.result,
        }


class PendingActionStore:
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
            raise PendingActionStorageError("Voice storage is temporarily unavailable.") from None
        return list(result.data or [])

    async def _one(self, sql: str, params: dict[str, Any]) -> dict[str, Any] | None:
        rows = await self._execute(sql, params)
        return rows[0] if rows else None

    async def expire_stale(self, *, user_id: str) -> None:
        await self._execute(
            """
            UPDATE one_voice_pending_actions
            SET status = 'expired', resolved_at = NOW()
            WHERE user_id = :user_id AND status = 'pending' AND expires_at < NOW()
            """,
            {"user_id": user_id},
        )

    async def cancel_open(
        self, *, user_id: str, conversation_id: str, except_id: str | None = None
    ) -> int:
        rows = await self._execute(
            """
            UPDATE one_voice_pending_actions
            SET status = 'cancelled', resolved_at = NOW()
            WHERE user_id = :user_id
              AND conversation_id = CAST(:conversation_id AS UUID)
              AND status = 'pending'
              AND (CAST(:except_id AS TEXT) IS NULL OR id <> CAST(:except_id AS UUID))
            RETURNING id
            """,
            {"user_id": user_id, "conversation_id": conversation_id, "except_id": except_id},
        )
        return len(rows)

    async def create(
        self,
        *,
        user_id: str,
        conversation_id: str,
        tool_name: str,
        gateway_action_id: str,
        tier: str,
        args: dict[str, Any],
        summary: str,
        ttl_seconds: int = PENDING_TTL_SECONDS,
    ) -> tuple[PendingAction, str | None]:
        """Create the one open pending action. Returns (row, receipt_token).

        The receipt token is returned exactly once (tap tier only); only its
        hash is stored.
        """
        if tier not in TIERS:
            raise ValueError("tier must be voice or tap")
        await self.expire_stale(user_id=user_id)
        await self.cancel_open(user_id=user_id, conversation_id=conversation_id)
        receipt = secrets.token_urlsafe(24) if tier == "tap" else None
        row = await self._one(
            """
            INSERT INTO one_voice_pending_actions (
              user_id, conversation_id, tool_name, gateway_action_id, tier, args, summary,
              receipt_token_hash, status, created_at, expires_at
            ) VALUES (
              :user_id, CAST(:conversation_id AS UUID), :tool_name, :gateway_action_id, :tier,
              CAST(:args AS JSONB), :summary, :receipt_hash, 'pending', NOW(),
              NOW() + make_interval(secs => :ttl)
            )
            RETURNING """
            + _COLUMNS,  # nosec B608 - static column/assignment fragments; every value is a bound parameter.
            {
                "user_id": user_id,
                "conversation_id": conversation_id,
                "tool_name": tool_name,
                "gateway_action_id": gateway_action_id,
                "tier": tier,
                "args": json.dumps(args, separators=(",", ":")),
                "summary": summary[:400],
                "receipt_hash": _hash_receipt(receipt) if receipt else None,
                "ttl": int(ttl_seconds),
            },
        )
        if row is None:
            raise PendingActionStorageError("Pending action could not be created.")
        return PendingAction.from_row(row), receipt

    async def get(self, *, user_id: str, pending_action_id: str) -> PendingAction | None:
        row = await self._one(
            f"""
            SELECT {_COLUMNS} FROM one_voice_pending_actions
            WHERE id = CAST(:id AS UUID) AND user_id = :user_id
            """,  # nosec B608 - static column/assignment fragments; every value is a bound parameter.
            {"id": pending_action_id, "user_id": user_id},
        )
        return PendingAction.from_row(row) if row else None

    async def list_open(self, *, user_id: str, conversation_id: str) -> list[PendingAction]:
        await self.expire_stale(user_id=user_id)
        rows = await self._execute(
            f"""
            SELECT {_COLUMNS} FROM one_voice_pending_actions
            WHERE user_id = :user_id
              AND conversation_id = CAST(:conversation_id AS UUID)
              AND status = 'pending'
            ORDER BY created_at DESC
            """,  # nosec B608 - static column/assignment fragments; every value is a bound parameter.
            {"user_id": user_id, "conversation_id": conversation_id},
        )
        return [PendingAction.from_row(row) for row in rows]

    async def mark_shown(self, *, user_id: str, pending_action_id: str) -> PendingAction | None:
        row = await self._one(
            f"""
            UPDATE one_voice_pending_actions
            SET shown_at = COALESCE(shown_at, NOW())
            WHERE id = CAST(:id AS UUID) AND user_id = :user_id AND status = 'pending'
            RETURNING {_COLUMNS}
            """,  # nosec B608 - static column/assignment fragments; every value is a bound parameter.
            {"id": pending_action_id, "user_id": user_id},
        )
        return PendingAction.from_row(row) if row else None

    async def confirm(
        self,
        *,
        user_id: str,
        pending_action_id: str,
        source: str,
        receipt_token: str | None = None,
    ) -> PendingAction:
        """Single-row compare-and-set from ``pending`` to ``confirmed``.

        Voice confirmations require the card to have been shown and are refused
        for the tap tier. Tap/http confirmations require the receipt token.
        """
        if source not in {"voice", "tap", "http"}:
            raise ValueError("source must be voice, tap, or http")
        current = await self.get(user_id=user_id, pending_action_id=pending_action_id)
        if current is None:
            raise PendingActionConflict("pending action not found")
        if current.status != "pending":
            raise PendingActionConflict(f"pending action is {current.status}")
        if source == "voice":
            if current.tier == "tap":
                raise PendingActionConflict("tap_required")
            if current.shown_at is None:
                raise PendingActionConflict("card_not_shown")
        else:
            if current.tier == "tap":
                row = await self._one(
                    "SELECT receipt_token_hash FROM one_voice_pending_actions WHERE id = CAST(:id AS UUID)",
                    {"id": pending_action_id},
                )
                expected = str((row or {}).get("receipt_token_hash") or "")
                if not receipt_token or not hmac.compare_digest(
                    _hash_receipt(receipt_token), expected
                ):
                    raise PendingActionConflict("receipt_invalid")
        # Expiry is decided by the database clock inside the same CAS.
        updated = await self._one(
            f"""
            UPDATE one_voice_pending_actions
            SET status = 'confirmed', confirmed_at = NOW(), confirmation_source = :source
            WHERE id = CAST(:id AS UUID) AND user_id = :user_id
              AND status = 'pending' AND expires_at > NOW()
            RETURNING {_COLUMNS}
            """,  # nosec B608 - static column/assignment fragments; every value is a bound parameter.
            {"id": pending_action_id, "user_id": user_id, "source": source},
        )
        if updated is None:
            await self.expire_stale(user_id=user_id)
            raise PendingActionConflict("pending action expired or changed concurrently")
        return PendingAction.from_row(updated)

    async def resolve(
        self,
        *,
        user_id: str,
        pending_action_id: str,
        status: str,
        result: dict[str, Any] | None,
    ) -> PendingAction | None:
        if status not in {"executed", "failed"}:
            raise ValueError("status must be executed or failed")
        row = await self._one(
            f"""
            UPDATE one_voice_pending_actions
            SET status = :status, resolved_at = NOW(), result = CAST(:result AS JSONB)
            WHERE id = CAST(:id AS UUID) AND user_id = :user_id AND status = 'confirmed'
            RETURNING {_COLUMNS}
            """,  # nosec B608 - static column/assignment fragments; every value is a bound parameter.
            {
                "id": pending_action_id,
                "user_id": user_id,
                "status": status,
                "result": json.dumps(result or {}, separators=(",", ":")),
            },
        )
        return PendingAction.from_row(row) if row else None

    async def cancel(self, *, user_id: str, pending_action_id: str) -> PendingAction | None:
        row = await self._one(
            f"""
            UPDATE one_voice_pending_actions
            SET status = 'cancelled', resolved_at = NOW()
            WHERE id = CAST(:id AS UUID) AND user_id = :user_id AND status = 'pending'
            RETURNING {_COLUMNS}
            """,  # nosec B608 - static column/assignment fragments; every value is a bound parameter.
            {"id": pending_action_id, "user_id": user_id},
        )
        return PendingAction.from_row(row) if row else None
