"""Durable, fail-closed authority for private-agent action confirmation.

Postgres is the current shared plane. ``ActionDirectiveStore`` is intentionally
small so Redis can later implement the same compare-and-set contract without a
wire-protocol change.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import uuid4

from db.db_client import get_db
from hushh_mcp.runtime_settings import get_core_security_settings

ActionChannel = Literal["typed_chat", "voice"]


class ActionDirectiveAuthorityError(RuntimeError):
    """A directive could not advance through its one-time authority state."""


@dataclass(frozen=True)
class IssuedActionDirective:
    directive_id: str
    action_id: str
    context_revision: str
    expires_at: datetime


@dataclass(frozen=True)
class ActionConfirmationReceipt:
    directive_id: str
    receipt: str
    expires_at: datetime
    confirmed_at: datetime
    trusted_activation: bool


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


class ActionDirectiveStore:
    """Atomic metadata-only directive state transitions."""

    def __init__(self, *, db: Any | None = None, hmac_key: str | None = None):
        self._db = db
        self._hmac_key = hmac_key

    @property
    def db(self):
        if self._db is None:
            self._db = get_db()
        return self._db

    @property
    def hmac_key(self) -> bytes:
        value = self._hmac_key or get_core_security_settings().app_signing_key
        return value.encode("utf-8")

    async def _execute(self, sql: str, params: dict[str, Any]):
        return await asyncio.to_thread(self.db.execute_raw, sql, params)

    def _hmac(self, value: Any) -> str:
        return hmac.new(
            self.hmac_key,
            _canonical_json(value).encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

    async def issue(
        self,
        *,
        user_id: str,
        channel: ActionChannel,
        action_id: str,
        context_revision: str,
        action_contract: dict[str, Any],
        slots: dict[str, Any],
        conversation_id: str | None = None,
        session_id: str | None = None,
        resource_binding: dict[str, Any] | None = None,
        trusted_activation_required: bool = False,
        ttl_seconds: int = 300,
    ) -> IssuedActionDirective:
        if channel == "typed_chat" and (not conversation_id or session_id):
            raise ValueError("typed_chat directives require only conversation_id")
        if channel == "voice" and (not session_id or conversation_id):
            raise ValueError("voice directives require only session_id")
        directive_id = f"dir_{uuid4().hex}"
        expires_at = datetime.now(UTC) + timedelta(seconds=max(30, min(ttl_seconds, 300)))
        result = await self._execute(
            """
            INSERT INTO one_action_directive_ledger (
              directive_id, user_id, channel, conversation_id, session_id,
              action_id, context_revision, action_contract_digest, slots_hmac,
              resource_binding_hmac, trusted_activation_required, expires_at
            ) VALUES (
              :directive_id, :user_id, :channel, :conversation_id, :session_id,
              :action_id, :context_revision, :action_contract_digest, :slots_hmac,
              :resource_binding_hmac, :trusted_activation_required, :expires_at
            ) RETURNING directive_id
            """,
            {
                "directive_id": directive_id,
                "user_id": user_id,
                "channel": channel,
                "conversation_id": conversation_id,
                "session_id": session_id,
                "action_id": action_id,
                "context_revision": context_revision,
                "action_contract_digest": self._hmac(action_contract),
                "slots_hmac": self._hmac(slots),
                "resource_binding_hmac": (
                    self._hmac(resource_binding) if resource_binding is not None else None
                ),
                "trusted_activation_required": trusted_activation_required,
                "expires_at": expires_at,
            },
        )
        if not (result.data or []):
            raise ActionDirectiveAuthorityError("confirmation authority unavailable")
        return IssuedActionDirective(directive_id, action_id, context_revision, expires_at)

    async def confirm(
        self,
        *,
        directive_id: str,
        user_id: str,
        action_id: str,
        context_revision: str,
        conversation_id: str | None = None,
        session_id: str | None = None,
        trusted_activation: bool = False,
    ) -> ActionConfirmationReceipt:
        receipt = secrets.token_urlsafe(32)
        receipt_hash = hashlib.sha256(receipt.encode("utf-8")).hexdigest()
        result = await self._execute(
            """
            UPDATE one_action_directive_ledger
            SET state = 'confirmed', receipt_hash = :receipt_hash, confirmed_at = NOW()
            WHERE directive_id = :directive_id
              AND user_id = :user_id
              AND action_id = :action_id
              AND context_revision = :context_revision
              AND conversation_id IS NOT DISTINCT FROM :conversation_id
              AND session_id IS NOT DISTINCT FROM :session_id
              AND (trusted_activation_required = FALSE OR :trusted_activation = TRUE)
              AND state = 'issued'
              AND expires_at > NOW()
            RETURNING directive_id, expires_at, confirmed_at
            """,
            {
                "directive_id": directive_id,
                "user_id": user_id,
                "action_id": action_id,
                "context_revision": context_revision,
                "conversation_id": conversation_id,
                "session_id": session_id,
                "trusted_activation": trusted_activation,
                "receipt_hash": receipt_hash,
            },
        )
        rows = result.data or []
        if not rows:
            raise ActionDirectiveAuthorityError("directive is stale, mismatched, or already used")
        return ActionConfirmationReceipt(
            directive_id,
            receipt,
            rows[0]["expires_at"],
            rows[0]["confirmed_at"],
            trusted_activation,
        )

    async def consume(
        self,
        *,
        directive_id: str,
        receipt: str,
        user_id: str,
        action_id: str,
        context_revision: str,
        conversation_id: str | None = None,
        session_id: str | None = None,
    ) -> None:
        result = await self._execute(
            """
            UPDATE one_action_directive_ledger
            SET state = 'consumed', consumed_at = NOW()
            WHERE directive_id = :directive_id
              AND receipt_hash = :receipt_hash
              AND user_id = :user_id
              AND action_id = :action_id
              AND context_revision = :context_revision
              AND conversation_id IS NOT DISTINCT FROM :conversation_id
              AND session_id IS NOT DISTINCT FROM :session_id
              AND state = 'confirmed'
              AND expires_at > NOW()
            RETURNING directive_id
            """,
            {
                "directive_id": directive_id,
                "receipt_hash": hashlib.sha256(receipt.encode("utf-8")).hexdigest(),
                "user_id": user_id,
                "action_id": action_id,
                "context_revision": context_revision,
                "conversation_id": conversation_id,
                "session_id": session_id,
            },
        )
        if not (result.data or []):
            raise ActionDirectiveAuthorityError("confirmation receipt is invalid or already used")

    async def settle(
        self,
        *,
        directive_id: str,
        receipt: str,
        user_id: str,
        action_id: str,
        context_revision: str,
        status: Literal["succeeded", "failed", "cancelled"],
        reason_code: str,
    ) -> None:
        result = await self._execute(
            """
            UPDATE one_action_directive_ledger
            SET state = 'settled', settlement_status = :status,
                settlement_reason_code = :reason_code, settled_at = NOW()
            WHERE directive_id = :directive_id
              AND receipt_hash = :receipt_hash
              AND user_id = :user_id
              AND action_id = :action_id
              AND context_revision = :context_revision
              AND state = 'consumed'
            RETURNING directive_id
            """,
            {
                "directive_id": directive_id,
                "receipt_hash": hashlib.sha256(receipt.encode("utf-8")).hexdigest(),
                "user_id": user_id,
                "action_id": action_id,
                "context_revision": context_revision,
                "status": status,
                "reason_code": reason_code[:64],
            },
        )
        if not (result.data or []):
            raise ActionDirectiveAuthorityError("directive cannot be settled")

    async def settle_direct(
        self,
        *,
        directive_id: str,
        user_id: str,
        action_id: str,
        context_revision: str,
        status: Literal["succeeded", "failed", "cancelled"],
        reason_code: str,
    ) -> None:
        """Close a directive that was issued with no confirmation step.

        ``settle`` above proves a human gesture: it matches the receipt hash
        minted by ``confirm`` and demands state 'consumed'. A directive parked
        as ``needsConfirmation: false`` never raises a card, so it never mints
        a receipt and never leaves 'issued' -- and its settlement was refused
        outright. That silently discarded the outcome of almost every action:
        the browser really ran them, and the relay dropped the only frame that
        could tell One so.

        Authority here is the same binding minus the gesture. The directive id
        was minted by this relay for this socket, and the settling frame must
        still match its user, action and context revision. ``state = 'issued'``
        makes it close exactly once, so a replayed frame finds nothing. What is
        given up is proof that a finger moved -- which is precisely what these
        actions are declared not to require.
        """
        result = await self._execute(
            """
            UPDATE one_action_directive_ledger
            SET state = 'settled', settlement_status = :status,
                settlement_reason_code = :reason_code, settled_at = NOW()
            WHERE directive_id = :directive_id
              AND user_id = :user_id
              AND action_id = :action_id
              AND context_revision = :context_revision
              AND state = 'issued'
            RETURNING directive_id
            """,
            {
                "directive_id": directive_id,
                "user_id": user_id,
                "action_id": action_id,
                "context_revision": context_revision,
                "status": status,
                "reason_code": reason_code[:64],
            },
        )
        if not (result.data or []):
            raise ActionDirectiveAuthorityError("directive cannot be settled")

    async def cancel_open_for_conversation(self, *, user_id: str, conversation_id: str) -> None:
        """Disarm prior proposals when the user starts another chat turn."""
        await self._execute(
            """
            UPDATE one_action_directive_ledger
            SET state = 'cancelled', settlement_status = 'cancelled',
                settlement_reason_code = 'superseded_by_new_turn', settled_at = NOW()
            WHERE user_id = :user_id
              AND conversation_id = :conversation_id
              AND state IN ('issued', 'confirmed', 'consumed')
            """,
            {"user_id": user_id, "conversation_id": conversation_id},
        )

    async def cancel_typed(
        self,
        *,
        directive_id: str,
        user_id: str,
        conversation_id: str,
        action_id: str,
        context_revision: str,
        reason_code: str = "user_cancelled",
    ) -> None:
        """Disarm one exact typed proposal from an explicit cancel tap."""
        result = await self._execute(
            """
            UPDATE one_action_directive_ledger
            SET state = 'cancelled', settlement_status = 'cancelled',
                settlement_reason_code = :reason_code, settled_at = NOW()
            WHERE directive_id = :directive_id
              AND user_id = :user_id
              AND conversation_id = :conversation_id
              AND action_id = :action_id
              AND context_revision = :context_revision
              AND state IN ('issued', 'confirmed', 'consumed')
            RETURNING directive_id
            """,
            {
                "directive_id": directive_id,
                "user_id": user_id,
                "conversation_id": conversation_id,
                "action_id": action_id,
                "context_revision": context_revision,
                "reason_code": reason_code[:64],
            },
        )
        if not (result.data or []):
            raise ActionDirectiveAuthorityError("typed directive cannot be cancelled")

    async def cancel_voice(
        self, *, directive_id: str, user_id: str, session_id: str, action_id: str
    ) -> None:
        result = await self._execute(
            """
            UPDATE one_action_directive_ledger
            SET state = 'cancelled', settlement_status = 'cancelled',
                settlement_reason_code = 'user_cancelled', settled_at = NOW()
            WHERE directive_id = :directive_id
              AND user_id = :user_id
              AND session_id = :session_id
              AND action_id = :action_id
              AND state IN ('issued', 'confirmed', 'consumed')
            RETURNING directive_id
            """,
            {
                "directive_id": directive_id,
                "user_id": user_id,
                "session_id": session_id,
                "action_id": action_id,
            },
        )
        if not (result.data or []):
            raise ActionDirectiveAuthorityError("voice directive cannot be cancelled")


_store: ActionDirectiveStore | None = None


def get_action_directive_store() -> ActionDirectiveStore:
    global _store
    if _store is None:
        _store = ActionDirectiveStore()
    return _store
