"""In-memory doubles for the One Live Voice stores, transport, and provider."""

from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

from hushh_mcp.one_voice.conversations import Conversation
from hushh_mcp.one_voice.live_client import LiveEvent
from hushh_mcp.one_voice.pending_actions import PendingAction, PendingActionConflict


def _now() -> datetime:
    return datetime.now(timezone.utc)


class MemoryPendingStore:
    def __init__(self) -> None:
        self.rows: dict[str, PendingAction] = {}
        self.receipts: dict[str, str] = {}

    async def expire_stale(self, *, user_id: str) -> None:
        for row in self.rows.values():
            if (
                row.status == "pending"
                and row.expires_at
                and datetime.fromisoformat(row.expires_at) < _now()
            ):
                row.status = "expired"

    async def cancel_open(
        self, *, user_id: str, conversation_id: str, except_id: str | None = None
    ) -> int:
        count = 0
        for row in self.rows.values():
            if (
                row.conversation_id == conversation_id
                and row.status == "pending"
                and row.id != except_id
            ):
                row.status = "cancelled"
                count += 1
        return count

    async def create(
        self,
        *,
        user_id,
        conversation_id,
        tool_name,
        gateway_action_id,
        tier,
        args,
        summary,
        ttl_seconds=120,
    ):
        await self.cancel_open(user_id=user_id, conversation_id=conversation_id)
        receipt = secrets.token_urlsafe(24) if tier == "tap" else None
        row = PendingAction(
            id=str(uuid.uuid4()),
            user_id=user_id,
            conversation_id=conversation_id,
            tool_name=tool_name,
            gateway_action_id=gateway_action_id,
            tier=tier,
            args=dict(args),
            summary=summary,
            status="pending",
            created_at=_now().isoformat(),
            expires_at=(_now() + timedelta(seconds=ttl_seconds)).isoformat(),
        )
        self.rows[row.id] = row
        if receipt:
            self.receipts[row.id] = hashlib.sha256(receipt.encode()).hexdigest()
        return row, receipt

    async def get(self, *, user_id, pending_action_id):
        row = self.rows.get(pending_action_id)
        return row if row and row.user_id == user_id else None

    async def list_open(self, *, user_id, conversation_id):
        return [
            r
            for r in self.rows.values()
            if r.user_id == user_id
            and r.conversation_id == conversation_id
            and r.status == "pending"
        ]

    async def mark_shown(self, *, user_id, pending_action_id):
        row = await self.get(user_id=user_id, pending_action_id=pending_action_id)
        if row and row.status == "pending":
            row.shown_at = row.shown_at or _now().isoformat()
        return row

    async def confirm(self, *, user_id, pending_action_id, source, receipt_token=None):
        row = await self.get(user_id=user_id, pending_action_id=pending_action_id)
        if row is None:
            raise PendingActionConflict("pending action not found")
        if row.status != "pending":
            raise PendingActionConflict(f"pending action is {row.status}")
        if source == "voice":
            if row.tier == "tap":
                raise PendingActionConflict("tap_required")
            if row.shown_at is None:
                raise PendingActionConflict("card_not_shown")
        elif row.tier == "tap":
            expected = self.receipts.get(row.id, "")
            if not receipt_token or hashlib.sha256(receipt_token.encode()).hexdigest() != expected:
                raise PendingActionConflict("receipt_invalid")
        row.status = "confirmed"
        row.confirmed_at = _now().isoformat()
        row.confirmation_source = source
        return row

    async def resolve(self, *, user_id, pending_action_id, status, result):
        row = await self.get(user_id=user_id, pending_action_id=pending_action_id)
        if row is None or row.status != "confirmed":
            return None
        row.status = status
        row.result = result
        row.resolved_at = _now().isoformat()
        return row

    async def cancel(self, *, user_id, pending_action_id):
        row = await self.get(user_id=user_id, pending_action_id=pending_action_id)
        if row is None or row.status != "pending":
            return None
        row.status = "cancelled"
        return row


class MemoryConversationStore:
    def __init__(self) -> None:
        self.rows: dict[str, Conversation] = {}
        self.entity_saves: list[dict[str, Any]] = []
        self.handles: list[str | None] = []
        self.closes: list[tuple[int | None, str | None, bool]] = []
        self.counters: dict[str, int] = {}

    async def open(self, *, user_id, conversation_id, model_id, model_location):
        row = self.rows.get(conversation_id)
        if row is None:
            row = Conversation(
                id=conversation_id,
                user_id=user_id,
                status="active",
                model_id=model_id,
                model_location=model_location,
                session_count=1,
            )
            self.rows[conversation_id] = row
        else:
            row.session_count += 1
        return row

    async def get(self, *, user_id, conversation_id):
        return self.rows.get(conversation_id)

    async def save_entity_context(self, *, user_id, conversation_id, context):
        self.entity_saves.append(context)
        if conversation_id in self.rows:
            self.rows[conversation_id].entity_context = context

    async def save_screen_context(self, *, user_id, conversation_id, context):
        if conversation_id in self.rows:
            self.rows[conversation_id].screen_context = context

    async def save_resumption_handle(self, *, user_id, conversation_id, handle):
        self.handles.append(handle)

    async def bump(self, *, user_id, conversation_id, **counters):
        for k, v in counters.items():
            self.counters[k] = self.counters.get(k, 0) + int(v)

    async def close(self, *, user_id, conversation_id, close_code, reason_class, ended=False):
        self.closes.append((close_code, reason_class, ended))

    async def daily_audio_seconds(self, *, user_id):
        return 0


class FakeTransport:
    """Scripted client: frames are queued in; every server frame is recorded."""

    def __init__(self, frames: list[dict[str, Any] | str] | None = None) -> None:
        self.inbound: asyncio.Queue[str] = asyncio.Queue()
        self.sent: list[dict[str, Any]] = []
        self.closed: tuple[int, str] | None = None
        for frame in frames or []:
            self.push(frame)

    def push(self, frame: dict[str, Any] | str) -> None:
        self.inbound.put_nowait(frame if isinstance(frame, str) else json.dumps(frame))

    async def receive(self) -> str:
        if self.closed:
            raise RuntimeError("closed")
        return await self.inbound.get()

    async def send(self, frame: dict[str, Any]) -> None:
        self.sent.append(frame)

    async def close(self, code: int, reason: str) -> None:
        self.closed = (code, reason)
        # unblock a pending receive
        self.inbound.put_nowait("__closed__")

    def frames(self, kind: str) -> list[dict[str, Any]]:
        return [f for f in self.sent if f.get("type") == kind]


class FakeLive:
    """Scripted provider session. ``script`` events are emitted in order; a
    ``None`` entry waits for a tool response before continuing."""

    def __init__(self, script: list[LiveEvent | None]) -> None:
        self.script = list(script)
        self.audio_in: list[str] = []
        self.texts: list[str] = []
        self.events_sent: list[str] = []
        self.tool_responses: list[dict[str, Any]] = []
        self._tool_response_event = asyncio.Event()
        self.stream_ends = 0

    async def send_audio(self, pcm16_b64: str) -> None:
        self.audio_in.append(pcm16_b64)

    async def send_text(self, text: str) -> None:
        self.texts.append(text)

    async def send_event(self, text: str) -> None:
        self.events_sent.append(text)

    async def send_tool_response(self, *, call_id, name, response) -> None:
        self.tool_responses.append({"id": call_id, "name": name, "response": response})
        self._tool_response_event.set()

    async def send_audio_stream_end(self) -> None:
        self.stream_ends += 1

    async def events(self) -> AsyncIterator[LiveEvent]:
        for item in self.script:
            if item is None:
                await self._tool_response_event.wait()
                self._tool_response_event.clear()
                continue
            yield item
            await asyncio.sleep(0)
        # keep the provider "open" until the session closes
        await asyncio.sleep(30)


def live_factory_for(fake: FakeLive):
    @asynccontextmanager
    async def _factory(model: str, live_config: dict[str, Any]):
        fake.live_config = live_config
        yield fake

    return _factory
