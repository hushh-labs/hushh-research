"""Specialist conversation projection over the pod's existing sealed commit log.

No session database or provider memory is introduced. Each message is one durable
log event; replay reconstructs conversation history. Failed/lost acknowledgements
are not retry-deduplicated. The existing log owns encryption and append fencing.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from hushh_mcp.services.agent_chat_service import (
    AgentChatMessage,
    PreparedAgentChatTurn,
    load_one_agent_runtime_manifest,
)
from hushh_mcp.services.pod_commit_log import PodCommitLog, PodLogFenced

_EVENT_KIND = "pod_agent_chat.message.v1"
_MAX_RECORDS = 10000
_MAX_PAYLOAD_BYTES = 262144


class PodAgentChatStoreError(RuntimeError):
    """Value-free conversation authority or persistence failure."""


class PodAgentChatStore:
    """A turn-bound owner adapter implementing the specialist chat-store port."""

    def __init__(
        self,
        *,
        owner_user_id: str,
        hushh_id: str,
        log: PodCommitLog,
        require_access: Callable[[], Awaitable[None]],
        agent_id: str,
        model: str | None = None,
    ) -> None:
        if (
            not isinstance(owner_user_id, str)
            or not owner_user_id.strip()
            or not isinstance(hushh_id, str)
            or not hushh_id.strip()
            or getattr(log, "_owner_id", None) != hushh_id
            or not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", agent_id)
        ):
            raise PodAgentChatStoreError("Pod chat owner binding invalid")
        self._owner_user_id = owner_user_id
        self._hushh_id = hushh_id
        self._log = log
        self._require_access = require_access
        self._agent_id = agent_id
        self.model = model or load_one_agent_runtime_manifest().model.name
        if not isinstance(self.model, str) or not self.model.strip():
            raise PodAgentChatStoreError("Pod chat model unavailable")
        self._lock = asyncio.Lock()

    async def _admit(self, user_id: str) -> None:
        # Check caller identity before callback, hydration, or any object-store I/O.
        if (
            user_id != self._owner_user_id
            or getattr(self._log, "_owner_id", None) != self._hushh_id
        ):
            raise PodAgentChatStoreError("Pod chat owner mismatch")
        await self._require_access()
        await self._log.require_open()

    def _decode(self, payload: Any) -> tuple[str, AgentChatMessage]:
        try:
            if (
                not isinstance(payload, dict)
                or set(payload)
                != {"version", "ownerUserId", "hushhId", "agentId", "message", "errorCode"}
                or type(payload["version"]) is not int
                or payload["version"] != 1
                or payload["ownerUserId"] != self._owner_user_id
                or payload["hushhId"] != self._hushh_id
                or not isinstance(payload["agentId"], str)
                or not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", payload["agentId"])
            ):
                raise ValueError
            message = AgentChatMessage(**payload["message"])
            if (
                message.user_id != self._owner_user_id
                or not isinstance(message.id, str)
                or not message.id
                or not isinstance(message.conversation_id, str)
                or not message.conversation_id
                or message.role not in {"user", "assistant", "system", "tool"}
                or message.status not in {"complete", "interrupted", "error"}
                or not isinstance(message.content, str)
                or (message.metadata is not None and not isinstance(message.metadata, dict))
                or (message.model is not None and not isinstance(message.model, str))
                or not isinstance(message.created_at, str)
                or (message.completed_at is not None and not isinstance(message.completed_at, str))
                or (payload["errorCode"] is not None and not isinstance(payload["errorCode"], str))
            ):
                raise ValueError
            if len(json.dumps(payload, allow_nan=False).encode()) > _MAX_PAYLOAD_BYTES:
                raise ValueError
            return payload["agentId"], message
        except (TypeError, ValueError, KeyError):
            raise PodAgentChatStoreError("Pod chat record invalid") from None

    async def _replay(self, user_id: str) -> list[tuple[int, str, AgentChatMessage]]:
        await self._admit(user_id)
        records = await self._log.replay()
        # The existing replay API reads the chain as a whole. This bounds the
        # projection, not the underlying replay I/O; no history is silently cut.
        if len(records) > _MAX_RECORDS:
            raise PodAgentChatStoreError("Pod chat replay limit exceeded")
        messages = []
        ids = set()
        for record in records:
            if record.get("kind") != _EVENT_KIND:
                continue
            agent, message = self._decode(record.get("payload"))
            if message.id in ids:
                raise PodAgentChatStoreError("Pod chat record identity duplicated")
            ids.add(message.id)
            messages.append((record["seq"], agent, message))
        await self._admit(user_id)
        return messages

    async def _append(
        self,
        *,
        user_id: str,
        conversation_id: str,
        role: str,
        content: str,
        status: str,
        model: str | None = None,
        error_code: str | None = None,
        metadata: dict | None = None,
    ) -> tuple[int, AgentChatMessage]:
        now = datetime.now(timezone.utc).isoformat()
        message = AgentChatMessage(
            id=str(uuid4()),
            conversation_id=conversation_id,
            user_id=user_id,
            role=role,
            status=status,
            content=content,
            model=model or self.model,
            created_at=now,
            completed_at=now if status == "complete" else None,
            metadata=metadata,
        )
        payload = {
            "version": 1,
            "ownerUserId": user_id,
            "hushhId": self._hushh_id,
            "agentId": self._agent_id,
            "message": asdict(message),
            "errorCode": error_code,
        }
        self._decode(payload)
        # Detach mutable caller metadata before the first awaited operation.
        payload = json.loads(json.dumps(payload, allow_nan=False))
        await self._admit(user_id)
        try:
            record = await self._log.append(_EVENT_KIND, payload)
        except PodLogFenced:
            raise
        except Exception:
            raise PodAgentChatStoreError("Pod chat append unavailable") from None
        await self._admit(user_id)
        return record["seq"], self._decode(payload)[1]

    async def prepare_turn(
        self,
        *,
        user_id: str,
        message: str,
        conversation_id: str | None = None,
    ) -> PreparedAgentChatTurn:
        async with self._lock:
            await self._replay(user_id)
            # The hub/browser keeps its root conversation id across pod turns.
            # A specialist-local generated id is not couriered back as that root
            # id, so replacing an unknown supplied id would lose every follow-up.
            # (agent_id, conversation_id) is the namespace; history never crosses it.
            selected_id = conversation_id if conversation_id is not None else str(uuid4())
            seq, current = await self._append(
                user_id=user_id,
                conversation_id=selected_id,
                role="user",
                content=message,
                status="complete",
            )
            # Use durable append sequence, rather than the earlier read snapshot,
            # to include messages that another process committed before this turn.
            committed = await self._replay(user_id)
            history = [
                item
                for number, agent, item in committed
                if number < seq and agent == self._agent_id and item.conversation_id == selected_id
            ][-20:]
            return PreparedAgentChatTurn(selected_id, current.id, history, self.model)

    async def add_message(
        self,
        *,
        conversation_id: str,
        user_id: str,
        role: str,
        content: str,
        status: str,
        model: str | None = None,
        error_code: str | None = None,
        metadata: dict | None = None,
    ) -> AgentChatMessage:
        async with self._lock:
            records = await self._replay(user_id)
            matching = [
                entry
                for entry in records
                if entry[1] == self._agent_id and entry[2].conversation_id == conversation_id
            ]
            if not matching:
                raise PodAgentChatStoreError("Pod chat conversation unavailable")
            _, message = await self._append(
                user_id=user_id,
                conversation_id=conversation_id,
                role=role,
                content=content,
                status=status,
                model=model,
                error_code=error_code,
                metadata=metadata,
            )
            return message

    async def get_recent_messages(
        self,
        conversation_id: str,
        *,
        user_id: str,
        limit: int = 20,
    ) -> list[AgentChatMessage]:
        async with self._lock:
            records = await self._replay(user_id)
            matching = [
                entry
                for entry in records
                if entry[1] == self._agent_id and entry[2].conversation_id == conversation_id
            ]
            return [message for _, _, message in matching][-max(1, min(int(limit), 100)) :]
