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
from types import SimpleNamespace
from typing import Any, Literal
from uuid import uuid4

from sqlalchemy import text

from db.db_client import DatabaseExecutionError, get_db
from hushh_mcp.runtime_settings import get_core_security_settings

ActionChannel = Literal["typed_chat", "voice", "command"]


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

    def __init__(
        self, *, db: Any | None = None, hmac_key: str | None = None, connection: Any = None
    ):
        self._connection = connection
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
        try:
            if self._connection is not None:
                return SimpleNamespace(
                    data=[
                        dict(row) for row in self._connection.execute(text(sql), params).mappings()
                    ]
                )
            return await asyncio.to_thread(self.db.execute_raw, sql, params)
        except DatabaseExecutionError:
            raise ActionDirectiveAuthorityError(
                "Action authority is temporarily unavailable."
            ) from None

    def _hmac(self, value: Any) -> str:
        return hmac.new(
            self.hmac_key,
            _canonical_json(value).encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

    async def command_outcome(
        self, *, user_id: str, command_id: str, step: int
    ) -> dict[str, Any] | None:
        result = await self._execute(
            """SELECT directive_id,action_id,context_revision,requires_confirmation,state,
               settlement_status,settlement_reason_code,expires_at,operation_id,slots_hmac,step_hmac,resource_binding_hmac,command_effect
               FROM one_action_directive_ledger
               WHERE user_id=:user AND session_id=:command AND command_step=:step AND channel='command'""",
            {"user": user_id, "command": command_id, "step": step},
        )
        return dict(result.data[0]) if result.data else None

    async def issue_command(
        self,
        *,
        user_id: str,
        command_id: str,
        step: int,
        action: dict[str, Any],
        slots: dict[str, Any],
        context_revision: str,
        checkpoint_revision: int,
        plan_digest: str,
        resource_binding: dict[str, Any] | None = None,
        renew: bool = False,
    ) -> dict[str, Any]:
        """Stable logical identity survives renewed authority and lost responses."""
        confirmation = (
            action.get("execution_policy") == "confirm_required"
            or action.get("activation_policy") == "trusted_activation_required"
        )
        operation_id = self._hmac([user_id, command_id, step])
        result = await self._execute(
            """WITH command_fence AS (UPDATE one_adk_sessions SET command_status='admitted'
               WHERE app_name='one.location.commands.v1' AND user_id=:user AND session_id=:command
               AND revision=:checkpoint_revision AND command_status IN ('ready','admitted') AND command_plan_hmac=:plan_digest
               AND created_at > NOW()-INTERVAL '24 hours' RETURNING session_id)
               INSERT INTO one_action_directive_ledger
               (directive_id,user_id,channel,session_id,command_step,operation_id,action_id,
                context_revision,action_contract_digest,slots_hmac,requires_confirmation,
                trusted_activation_required,expires_at,step_hmac,resource_binding_hmac,command_effect)
               SELECT :id,:user,'command',:command,:step,:operation,:action,:revision,:digest,
                       :slots,:confirmation,:confirmation,NOW()+INTERVAL '5 minutes',:step_hmac,:binding,:effect FROM command_fence
               ON CONFLICT (user_id,session_id,command_step) WHERE channel='command'
               DO UPDATE SET command_effect=EXCLUDED.command_effect, directive_id=CASE WHEN (:renew OR one_action_directive_ledger.command_effect <> EXCLUDED.command_effect OR one_action_directive_ledger.expires_at <= NOW() OR one_action_directive_ledger.context_revision <> EXCLUDED.context_revision OR one_action_directive_ledger.resource_binding_hmac IS DISTINCT FROM EXCLUDED.resource_binding_hmac) THEN EXCLUDED.directive_id ELSE one_action_directive_ledger.directive_id END,
                 context_revision=CASE WHEN (:renew OR one_action_directive_ledger.command_effect <> EXCLUDED.command_effect OR one_action_directive_ledger.expires_at <= NOW() OR one_action_directive_ledger.context_revision <> EXCLUDED.context_revision OR one_action_directive_ledger.resource_binding_hmac IS DISTINCT FROM EXCLUDED.resource_binding_hmac) THEN EXCLUDED.context_revision ELSE one_action_directive_ledger.context_revision END,
                 action_contract_digest=CASE WHEN (:renew OR one_action_directive_ledger.command_effect <> EXCLUDED.command_effect OR one_action_directive_ledger.expires_at <= NOW() OR one_action_directive_ledger.context_revision <> EXCLUDED.context_revision OR one_action_directive_ledger.resource_binding_hmac IS DISTINCT FROM EXCLUDED.resource_binding_hmac) THEN EXCLUDED.action_contract_digest ELSE one_action_directive_ledger.action_contract_digest END,
                 requires_confirmation=CASE WHEN (:renew OR one_action_directive_ledger.command_effect <> EXCLUDED.command_effect OR one_action_directive_ledger.expires_at <= NOW() OR one_action_directive_ledger.context_revision <> EXCLUDED.context_revision OR one_action_directive_ledger.resource_binding_hmac IS DISTINCT FROM EXCLUDED.resource_binding_hmac) THEN EXCLUDED.requires_confirmation ELSE one_action_directive_ledger.requires_confirmation END,
                 trusted_activation_required=CASE WHEN (:renew OR one_action_directive_ledger.command_effect <> EXCLUDED.command_effect OR one_action_directive_ledger.expires_at <= NOW() OR one_action_directive_ledger.context_revision <> EXCLUDED.context_revision OR one_action_directive_ledger.resource_binding_hmac IS DISTINCT FROM EXCLUDED.resource_binding_hmac) THEN EXCLUDED.trusted_activation_required ELSE one_action_directive_ledger.trusted_activation_required END,
                 resource_binding_hmac=CASE WHEN (:renew OR one_action_directive_ledger.command_effect <> EXCLUDED.command_effect OR one_action_directive_ledger.expires_at <= NOW() OR one_action_directive_ledger.context_revision <> EXCLUDED.context_revision OR one_action_directive_ledger.resource_binding_hmac IS DISTINCT FROM EXCLUDED.resource_binding_hmac) THEN EXCLUDED.resource_binding_hmac ELSE one_action_directive_ledger.resource_binding_hmac END,
                 state=CASE WHEN (:renew OR one_action_directive_ledger.command_effect <> EXCLUDED.command_effect OR one_action_directive_ledger.expires_at <= NOW() OR one_action_directive_ledger.context_revision <> EXCLUDED.context_revision OR one_action_directive_ledger.resource_binding_hmac IS DISTINCT FROM EXCLUDED.resource_binding_hmac) THEN 'issued' ELSE one_action_directive_ledger.state END,
                 receipt_hash=CASE WHEN (:renew OR one_action_directive_ledger.command_effect <> EXCLUDED.command_effect OR one_action_directive_ledger.expires_at <= NOW() OR one_action_directive_ledger.context_revision <> EXCLUDED.context_revision OR one_action_directive_ledger.resource_binding_hmac IS DISTINCT FROM EXCLUDED.resource_binding_hmac) THEN NULL ELSE one_action_directive_ledger.receipt_hash END,
                 confirmed_at=CASE WHEN (:renew OR one_action_directive_ledger.command_effect <> EXCLUDED.command_effect OR one_action_directive_ledger.expires_at <= NOW() OR one_action_directive_ledger.context_revision <> EXCLUDED.context_revision OR one_action_directive_ledger.resource_binding_hmac IS DISTINCT FROM EXCLUDED.resource_binding_hmac) THEN NULL ELSE one_action_directive_ledger.confirmed_at END,
                 expires_at=CASE WHEN (:renew OR one_action_directive_ledger.command_effect <> EXCLUDED.command_effect OR one_action_directive_ledger.expires_at <= NOW() OR one_action_directive_ledger.context_revision <> EXCLUDED.context_revision OR one_action_directive_ledger.resource_binding_hmac IS DISTINCT FROM EXCLUDED.resource_binding_hmac) THEN EXCLUDED.expires_at ELSE one_action_directive_ledger.expires_at END
               WHERE one_action_directive_ledger.state IN ('issued','confirmed')
                 AND one_action_directive_ledger.action_id=EXCLUDED.action_id
                 AND one_action_directive_ledger.slots_hmac=EXCLUDED.slots_hmac
               RETURNING directive_id""",
            {
                "id": f"dir_{uuid4().hex}",
                "user": user_id,
                "checkpoint_revision": checkpoint_revision,
                "plan_digest": plan_digest,
                "command": command_id,
                "step": step,
                "operation": operation_id,
                "action": action["action_id"],
                "revision": context_revision,
                "digest": self._hmac(action),
                "slots": self._hmac(slots),
                "confirmation": confirmation,
                "step_hmac": self._hmac({"action_id": action["action_id"], "slots": slots}),
                "binding": self._hmac(resource_binding or {}),
                "renew": renew,
                "effect": action.get("_command_effect", "action"),
            },
        )
        if not result.data:
            raise ActionDirectiveAuthorityError("The command changed or was already claimed.")
        outcome = await self.command_outcome(user_id=user_id, command_id=command_id, step=step)
        if outcome is None:
            raise ActionDirectiveAuthorityError("Command authority is unavailable.")
        return outcome

    async def claim_command(
        self,
        *,
        user_id: str,
        command_id: str,
        step: int,
        action: dict[str, Any],
        slots: dict[str, Any],
        context_revision: str,
        checkpoint_revision: int,
        plan_digest: str,
        confirmation_receipt: str | None = None,
        resource_binding: dict[str, Any] | None = None,
    ) -> dict[str, str]:
        """Claim once before client effects. Ambiguous claims are reconciled, never replayed."""
        execution_receipt = secrets.token_urlsafe(32)
        result = await self._execute(
            """WITH command_fence AS (UPDATE one_adk_sessions SET command_status='admitted'
               WHERE app_name='one.location.commands.v1' AND user_id=:user AND session_id=:command
               AND revision=:checkpoint_revision AND command_status IN ('ready','admitted') AND command_plan_hmac=:plan_digest
               AND created_at > NOW()-INTERVAL '24 hours' RETURNING session_id)
               UPDATE one_action_directive_ledger SET state='consumed',consumed_at=NOW(),
               execution_receipt_hash=:execution_hash
               FROM command_fence WHERE user_id=:user AND one_action_directive_ledger.session_id=:command AND command_step=:step AND channel='command'
                 AND action_id=:action AND context_revision=:revision AND action_contract_digest=:digest
                 AND slots_hmac=:slots AND resource_binding_hmac=:binding AND expires_at > NOW()
                 AND ((state='issued' AND requires_confirmation=FALSE)
                   OR (state='confirmed' AND receipt_hash=:confirmation_hash))
               RETURNING directive_id,operation_id""",
            {
                "user": user_id,
                "checkpoint_revision": checkpoint_revision,
                "plan_digest": plan_digest,
                "command": command_id,
                "step": step,
                "action": action["action_id"],
                "revision": context_revision,
                "digest": self._hmac(action),
                "slots": self._hmac(slots),
                "binding": self._hmac(resource_binding or {}),
                "confirmation_hash": hashlib.sha256(
                    (confirmation_receipt or "").encode()
                ).hexdigest(),
                "execution_hash": hashlib.sha256(execution_receipt.encode()).hexdigest(),
            },
        )
        if not result.data:
            raise ActionDirectiveAuthorityError(
                "The operation was already claimed or its authority changed."
            )
        return {**dict(result.data[0]), "execution_receipt": execution_receipt}

    async def settle_command(
        self,
        *,
        user_id: str,
        command_id: str,
        step: int,
        operation_id: str,
        execution_receipt: str,
        status: Literal["succeeded", "failed", "review_required"],
    ) -> dict[str, Any]:
        """Accept only the correlated executor's receipt; never model completion text."""
        receipt_hash = hashlib.sha256(execution_receipt.encode()).hexdigest()
        result = await self._execute(
            """UPDATE one_action_directive_ledger SET state='settled',settlement_status=:status,
               settlement_reason_code='command_executor_result',settled_at=NOW()
               WHERE user_id=:user AND session_id=:command AND command_step=:step AND channel='command'
                 AND operation_id=:operation AND execution_receipt_hash=:receipt
                 AND (state='consumed' OR (state='settled' AND settlement_status=:status))
               RETURNING directive_id""",
            {
                "user": user_id,
                "command": command_id,
                "step": step,
                "operation": operation_id,
                "receipt": receipt_hash,
                "status": status,
            },
        )
        if not result.data:
            raise ActionDirectiveAuthorityError(
                "The operation result is not correlated to this command."
            )
        return await self.command_outcome(user_id=user_id, command_id=command_id, step=step) or {}

    async def cancel_command(self, *, user_id: str, command_id: str) -> None:
        # Consumed effects remain in the ledger for outcome lookup after cancellation.
        await self._execute(
            """UPDATE one_action_directive_ledger SET state='cancelled'
               WHERE user_id=:user AND session_id=:command AND channel='command'
                 AND state IN ('issued','confirmed')""",
            {"user": user_id, "command": command_id},
        )

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
