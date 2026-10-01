"""One Live Voice session: the relay between the app socket and Gemini Live.

Three concurrent pumps under one ``TaskGroup``: client frames → provider,
provider events → client, and a watchdog for idle/max-duration. Tool calls
are dispatched through :class:`ToolExecutor`; the session never chooses a
tool, never rewrites arguments, and never narrates. Every action the model
can talk about produces one typed payload that goes to the client as a frame
and back to the model as a tool response or an ``[ONE_EVENT]`` turn, so UI
and speech derive from the same data.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
import uuid
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from hushh_mcp.one_voice import protocol
from hushh_mcp.one_voice.config import OneVoiceLiveConfig
from hushh_mcp.one_voice.conversations import Conversation, ConversationNotOwned, ConversationStore
from hushh_mcp.one_voice.live_client import LiveEvent, LiveSessionPort
from hushh_mcp.one_voice.pending_actions import (
    PendingAction,
    PendingActionConflict,
    PendingActionStore,
)
from hushh_mcp.one_voice.tickets import TicketClaims
from hushh_mcp.one_voice.tools import registry
from hushh_mcp.one_voice.tools.base import (
    EntityContext,
    ScreenContext,
    ToolContext,
    ToolResult,
    ToolSpec,
    restore_context,
)
from hushh_mcp.one_voice.tools.executor import ToolCallOutcome, ToolExecutor
from hushh_mcp.one_voice.tools.session import OPENABLE_SCREENS

logger = logging.getLogger(__name__)


AUTH_TIMEOUT_SECONDS = 5.0
CLIENT_STEP_TIMEOUT_SECONDS = 25
# Slack past the advertised timeout before a device report is treated as stale.
CLIENT_STEP_GRACE_SECONDS = 5
# A question accepted behind a stalled provider turn must not wait until the
# session's general idle close and disappear without an answer.
QUEUED_TEXT_MAX_WAIT_SECONDS = 30.0
PCM16_16K_BYTES_PER_SECOND = 32_000
_NOT_SUCCESS = {
    "rejected",
    "unsupported",
    "confirmation_required",
    "tap_required",
    "card_not_shown",
    "firebase_proof_required",
}
# A client-executed step is still outstanding: neither a receipt nor a
# rejection. It never counts as ok (so the turn cannot read "complete") and
# never bumps the rejected counter; the settled result does one or the other.
# ``scope_review_required`` is the same shape for a confirmed accept: the
# review screen is open and nothing has been accepted yet.
_AWAITING_DEVICE = frozenset(
    {
        protocol.LOCATION_UPDATES_PENDING,
        "scope_review_required",
        protocol.SOS_GRANTS_CREATED,
        protocol.RESET_STEP_ISSUED,
        protocol.DELETE_STEP_ISSUED,
    }
)


class Transport(Protocol):
    """The socket as the session sees it (FastAPI WebSocket or a test fake)."""

    async def receive(self) -> str: ...

    async def send(self, frame: dict[str, Any]) -> None: ...

    async def close(self, code: int, reason: str) -> None: ...


class SessionClosed(Exception):
    def __init__(self, code: int, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


@dataclass
class AuthResult:
    user_id: str
    vault_owner_token: str
    firebase_id_token: str | None
    display_name: str | None = None


AuthVerifier = Callable[[protocol.AuthFrame, TicketClaims], Awaitable[AuthResult]]
LiveFactory = Callable[[str, dict[str, Any]], AbstractAsyncContextManager[LiveSessionPort]]


@dataclass
class TurnState:
    turn_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    tool_calls: int = 0
    ok_results: int = 0
    not_ok_results: int = 0
    output_text: list[str] = field(default_factory=list)
    audio_chunks: int = 0
    input_seen: bool = False
    input_transcript_completed: bool = False

    def reset(self) -> None:
        self.turn_id = uuid.uuid4().hex[:12]
        self.tool_calls = 0
        self.ok_results = 0
        self.not_ok_results = 0
        self.output_text = []
        self.audio_chunks = 0
        self.input_seen = False
        self.input_transcript_completed = False


class VoiceSession:
    def __init__(
        self,
        *,
        transport: Transport,
        config: OneVoiceLiveConfig,
        claims: TicketClaims,
        verify_auth: AuthVerifier,
        live_factory: LiveFactory,
        executor: ToolExecutor | None = None,
        conversations: ConversationStore | None = None,
        pending: PendingActionStore | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.transport = transport
        self.config = config
        self.claims = claims
        self.verify_auth = verify_auth
        self.live_factory = live_factory
        self.pending = pending or PendingActionStore()
        self.executor = executor or ToolExecutor(pending_store=self.pending)
        self.conversations = conversations or ConversationStore()
        self.clock = clock
        self.session_id = claims.session_id
        self._conversation: Conversation | None = None
        self._ctx: ToolContext | None = None
        self._live: LiveSessionPort | None = None
        self.turn = TurnState()
        # Typed inputs accepted while a provider turn or tool is in flight wait
        # for that turn's completion. Text is never replayed or deduplicated.
        self._queued_texts: deque[tuple[str, str, float]] = deque()
        self._superseded_turn_ids: set[str] = set()
        self._input_segment_id: str | None = None
        self._pending_voice_turn_id: str | None = None
        self._pending_turn_ids: dict[str, str] = {}
        self._latest_input_turn_id: str | None = None
        self._directive_turn_ids: dict[str, str | None] = {}
        # A tool call can end its provider turn before Live speaks its reply.
        # Keep narration ownership through that continuation until new input
        # actually reaches Live.
        self._narration_owns_response = False
        self._narration_origin_turn_id: str | None = None
        # Set from the auth frame before any tool runs; UTC until then.
        self._client_timezone = "UTC"
        self.started_at = clock()
        self.last_activity = clock()
        self.audio_in_bytes = 0
        self.audio_out_chunks = 0
        self.dropped_audio_frames = 0
        self.client_steps: dict[str, dict[str, Any]] = {}
        self.pending_receipts: dict[str, str] = {}
        self._last_turn_ok = False
        self.close_code: int | None = None
        self.close_reason: str = ""
        self._closed = False
        self._counters: dict[str, int] = {}
        self._send_lock = asyncio.Lock()

    # -- state guards (raise instead of assert; the relay must never run
    #    a frame before auth or a provider before the socket is ready) --------

    @property
    def conversation(self) -> Conversation:
        if self._conversation is None:
            raise SessionClosed(protocol.CLOSE_PROTOCOL, "conversation_not_open")
        return self._conversation

    @conversation.setter
    def conversation(self, value: Conversation | None) -> None:
        self._conversation = value

    @property
    def ctx(self) -> ToolContext:
        if self._ctx is None:
            raise SessionClosed(protocol.CLOSE_AUTH, "not_authenticated")
        return self._ctx

    @ctx.setter
    def ctx(self, value: ToolContext | None) -> None:
        self._ctx = value

    @property
    def live(self) -> LiveSessionPort:
        if self._live is None:
            raise SessionClosed(protocol.CLOSE_PROTOCOL, "provider_not_ready")
        return self._live

    @live.setter
    def live(self, value: LiveSessionPort | None) -> None:
        self._live = value

    # -- helpers -------------------------------------------------------------

    async def _send(self, frame: dict[str, Any]) -> None:
        async with self._send_lock:
            await self.transport.send(frame)

    def _touch(self) -> None:
        self.last_activity = self.clock()

    def _bump(self, **counters: int) -> None:
        for name, value in counters.items():
            self._counters[name] = self._counters.get(name, 0) + value

    async def _close(self, code: int, reason: str) -> None:
        if self._closed:
            return
        self._closed = True
        self.close_code = code
        self.close_reason = reason
        try:
            await self.transport.close(code, reason)
        except Exception:  # noqa: BLE001 - already closing
            pass

    async def _fail(self, code: int, error_code: str, message: str) -> None:
        try:
            await self._send(protocol.error(error_code, message))
        except Exception:  # noqa: BLE001
            pass
        await self._close(code, error_code)
        raise SessionClosed(code, error_code)

    # -- lifecycle -----------------------------------------------------------

    async def run(self) -> None:
        try:
            auth = await self._authenticate()
            await self._open_conversation(auth)
            await self._run_live()
        except SessionClosed:
            pass
        except ConversationNotOwned:
            await self._close(protocol.CLOSE_AUTH, "conversation_not_owned")
        except Exception as exc:  # noqa: BLE001 - classified, never reflected
            from hushh_mcp.runtime_providers.dependency_health import classify_provider_error

            reason = classify_provider_error(exc)
            logger.warning("one_voice.session.failed class=%s error=%s", reason, type(exc).__name__)
            try:
                await self._send(
                    protocol.error("voice_unavailable", "Voice is unavailable right now.")
                )
            except Exception:  # noqa: BLE001
                pass
            await self._close(protocol.CLOSE_PROVIDER_UNAVAILABLE, reason)
        finally:
            await self._record_close()

    async def _authenticate(self) -> AuthResult:
        try:
            raw = await asyncio.wait_for(self.transport.receive(), timeout=AUTH_TIMEOUT_SECONDS)
            frame = protocol.parse_client_frame(raw)
        except (asyncio.TimeoutError, protocol.FrameError):
            await self._fail(protocol.CLOSE_AUTH, "auth_required", "Send the auth frame first.")
        if not isinstance(frame, protocol.AuthFrame):
            await self._fail(protocol.CLOSE_AUTH, "auth_required", "Send the auth frame first.")
        if frame.conversation_id != self.claims.conversation_id:
            await self._fail(protocol.CLOSE_AUTH, "auth_mismatch", "Ticket and auth do not match.")
        try:
            auth = await self.verify_auth(frame, self.claims)
        except PermissionError as exc:
            await self._fail(protocol.CLOSE_AUTH, "auth_invalid", str(exc) or "Not authorized.")
        if auth.user_id != self.claims.user_id:
            await self._fail(protocol.CLOSE_AUTH, "auth_mismatch", "Ticket and auth do not match.")
        # A hint for resolving relative dates, not authority. AuthResult is the
        # route's authority object and stays untouched.
        self._client_timezone = frame.timezone or "UTC"
        return auth

    async def _open_conversation(self, auth: AuthResult) -> None:
        self.conversation = await self.conversations.open(
            user_id=auth.user_id,
            conversation_id=self.claims.conversation_id,
            model_id=self.config.model_id,
            model_location=self.config.location,
        )
        entities = restore_context(EntityContext, self.conversation.entity_context)
        entities.prune()
        screen = restore_context(ScreenContext, self.conversation.screen_context)
        self.ctx = ToolContext(
            user_id=auth.user_id,
            conversation_id=self.claims.conversation_id,
            entities=entities,
            screen=screen,
            vault_owner_token=auth.vault_owner_token,
            firebase_id_token=auth.firebase_id_token,
            timezone=self._client_timezone,
        )
        self._display_name = auth.display_name
        open_rows = await self.pending.list_open(
            user_id=auth.user_id, conversation_id=self.claims.conversation_id
        )
        await self._send(
            protocol.session_ready(
                session_id=self.session_id,
                conversation_id=self.claims.conversation_id,
                model=self.config.model_id,
                resumed=self.conversation.session_count > 1,
                idle_timeout_ms=self.config.idle_close_seconds * 1000,
                session_max_ms=self.config.session_max_seconds * 1000,
                pending_actions=[row.public() for row in open_rows],
            )
        )

    async def _run_live(self) -> None:
        from hushh_mcp.one_voice.instruction import build_instruction

        declarations = registry.declarations()
        # Nothing else observes this list. It is assembled here and handed to the
        # provider; no endpoint returns it and no client frame carries it, so
        # without this line a running deployment cannot be asked which
        # capabilities a session was actually given -- only which ones its image
        # ought to contain, which is an inference and reads identical when the
        # catalog is wrong. Names only, and mail is named explicitly because a
        # release that claims mail is live is exactly the claim worth checking.
        mail_tools = sorted(
            name
            for name in (str(item.get("name") or "") for item in declarations)
            if "mail" in name
        )
        logger.info(
            "one_voice.session.tools count=%d mail=%s",
            len(declarations),
            ",".join(mail_tools) or "none",
        )
        instruction = build_instruction(
            tool_declarations=declarations,
            screen_ids=list(OPENABLE_SCREENS),
            screen_id=self.ctx.screen.screen_id,
            display_name=self._display_name,
            resumed=self.conversation.session_count > 1,
        )
        live_config = {
            "system_instruction": instruction,
            "tool_declarations": declarations,
            "resumption_handle": self.conversation.live_resumption_handle,
        }
        async with self.live_factory(self.config.model_id, live_config) as live:
            self.live = live
            await self._send(protocol.voice_state("listening"))
            try:
                async with asyncio.TaskGroup() as group:
                    group.create_task(self._pump_client())
                    group.create_task(self._pump_live())
                    group.create_task(self._watchdog())
            except* SessionClosed:
                pass

    async def _record_close(self) -> None:
        if self._conversation is None or self._ctx is None:
            return
        try:
            await self.conversations.bump(
                user_id=self.ctx.user_id,
                conversation_id=self.ctx.conversation_id,
                audio_in_seconds=self.audio_in_bytes // PCM16_16K_BYTES_PER_SECOND,
                **self._counters,
            )
            await self.conversations.save_entity_context(
                user_id=self.ctx.user_id,
                conversation_id=self.ctx.conversation_id,
                context=self.ctx.entities.model_dump(mode="json"),
            )
            await self.conversations.close(
                user_id=self.ctx.user_id,
                conversation_id=self.ctx.conversation_id,
                close_code=self.close_code,
                reason_class=self.close_reason,
                ended=self.close_code == protocol.CLOSE_ENDED,
            )
        except Exception:  # noqa: BLE001 - ledger writes are best effort at close
            logger.warning("one_voice.session.close_record_failed")

    # -- watchdog ------------------------------------------------------------

    async def _watchdog(self) -> None:
        warned = False
        while not self._closed:
            await asyncio.sleep(1.0)
            now = self.clock()
            elapsed = now - self.started_at
            if (
                self._queued_texts
                and now - self._queued_texts[0][2] >= QUEUED_TEXT_MAX_WAIT_SECONDS
            ):
                await self._send(
                    protocol.error(
                        "turn_timeout", "One couldn't finish the previous answer. Please try again."
                    )
                )
                await self._close(protocol.CLOSE_PROVIDER_UNAVAILABLE, "queued_turn_timeout")
                raise SessionClosed(protocol.CLOSE_PROVIDER_UNAVAILABLE, "queued_turn_timeout")
            if (
                not warned
                and elapsed >= self.config.session_max_seconds - 60
                and self.live is not None
            ):
                warned = True
                await self._inject_event({"kind": "session_ending_soon", "seconds_left": 60})
            if elapsed >= self.config.session_max_seconds:
                await self._send(protocol.reconnect_required("max_duration"))
                await self._close(protocol.CLOSE_MAX_DURATION, "max_duration")
                raise SessionClosed(protocol.CLOSE_MAX_DURATION, "max_duration")
            if now - self.last_activity >= self.config.idle_close_seconds:
                await self._close(protocol.CLOSE_IDLE, "idle")
                raise SessionClosed(protocol.CLOSE_IDLE, "idle")

    # -- client → provider ---------------------------------------------------

    async def _pump_client(self) -> None:
        while not self._closed:
            try:
                raw = await self.transport.receive()
            except SessionClosed:
                raise
            except Exception:  # noqa: BLE001 - socket gone
                await self._close(protocol.CLOSE_ENDED, "client_disconnected")
                raise SessionClosed(protocol.CLOSE_ENDED, "client_disconnected")
            try:
                frame = protocol.parse_client_frame(raw)
            except protocol.FrameError as exc:
                await self._send(protocol.error("protocol", str(exc)))
                continue
            await self._handle_client_frame(frame)

    async def _handle_client_frame(self, frame: Any) -> None:
        if isinstance(frame, protocol.AudioFrame):
            size = len(frame.data) * 3 // 4
            if size > protocol.MAX_AUDIO_FRAME_BYTES:
                self.dropped_audio_frames += 1
                return
            self._touch()
            self.audio_in_bytes += size
            await self.live.send_audio(frame.data)
            return
        if isinstance(frame, protocol.PingFrame):
            await self._send(protocol.pong())
            return
        self._touch()
        if isinstance(frame, protocol.TextFrame):
            if self.turn.input_seen:
                if len(self._queued_texts) >= 8:
                    await self._send(protocol.error("turn_busy", "Too many questions are waiting."))
                    return
                input_id = uuid.uuid4().hex[:12]
                self._queued_texts.append((input_id, frame.text, self.clock()))
                self._superseded_turn_ids.add(self.turn.turn_id)
                await self._send(protocol.turn("interrupted", turn_id=self.turn.turn_id))
            else:
                input_id = self.turn.turn_id
                self.turn.input_seen = True
            self._latest_input_turn_id = input_id
            await self._send(
                protocol.transcript(
                    "input",
                    frame.text,
                    final=True,
                    turn_id=input_id,
                    request_id=frame.request_id,
                )
            )
            if input_id == self.turn.turn_id:
                self._narration_owns_response = False
                self._narration_origin_turn_id = None
                await self.live.send_text(frame.text)
        elif isinstance(frame, protocol.AppContextFrame):
            await self._update_screen(frame)
        elif isinstance(frame, protocol.PendingShownFrame):
            await self.pending.mark_shown(
                user_id=self.ctx.user_id, pending_action_id=frame.pending_action_id
            )
        elif isinstance(frame, protocol.ConfirmActionFrame):
            await self._confirm_by_tap(frame)
        elif isinstance(frame, protocol.CancelActionFrame):
            await self._cancel(frame)
        elif isinstance(frame, protocol.CandidateChooseFrame):
            await self._inject_event(
                {
                    "kind": "candidate_chosen",
                    "entity": frame.kind,
                    "id": frame.id,
                    "none": frame.none,
                }
            )
        elif isinstance(frame, protocol.ClientStepResultFrame):
            await self._client_step_result(frame)
        elif isinstance(frame, protocol.UiSettledFrame):
            origin_turn_id = self._directive_turn_ids.pop(frame.directive_id, None)
            if origin_turn_id is not None and not self._origin_is_stale(origin_turn_id):
                await self._inject_event(
                    {
                        "kind": "ui_settled",
                        "directive_id": frame.directive_id,
                        "status": frame.status,
                    }
                )
        elif isinstance(frame, protocol.InterruptFrame):
            await self._send(protocol.turn("interrupted", turn_id=self.turn.turn_id))
        elif isinstance(frame, protocol.EndFrame):
            await self._close(protocol.CLOSE_ENDED, "ended")
            raise SessionClosed(protocol.CLOSE_ENDED, "ended")
        elif isinstance(frame, protocol.AuthFrame):
            await self._send(protocol.error("protocol", "already_authenticated"))

    async def _update_screen(self, frame: protocol.AppContextFrame) -> None:
        from api.routes.one.agent_context import sanitize_agent_context

        payload = frame.model_dump(mode="json", exclude={"type"})
        if len(json.dumps(payload)) > protocol.MAX_CONTEXT_JSON_CHARS:
            await self._send(protocol.error("protocol", "context_too_large"))
            return
        sanitized = sanitize_agent_context({"screen_state": payload.get("screen_state") or {}})
        self.ctx.screen = ScreenContext(
            screen_id=frame.screen_id,
            route=frame.route,
            available_action_ids=list(frame.available_action_ids)[:200],
            screen_state=dict(sanitized.get("screen_state") or {}),
            os_location_permission=frame.os_location_permission,
            active_circle_id=frame.active_circle_id,
        )
        await self.conversations.save_screen_context(
            user_id=self.ctx.user_id,
            conversation_id=self.ctx.conversation_id,
            context=self.ctx.screen.model_dump(mode="json"),
        )

    async def _inject_event(self, event: dict[str, Any]) -> None:
        if self._live is None:
            return
        await self.live.send_event(
            "[ONE_EVENT] " + json.dumps(event, separators=(",", ":"), sort_keys=True)
        )

    def _origin_is_stale(self, origin_turn_id: str | None) -> bool:
        return bool(
            origin_turn_id
            and (
                origin_turn_id in self._superseded_turn_ids
                or (
                    self._latest_input_turn_id is not None
                    and origin_turn_id != self._latest_input_turn_id
                )
            )
        )

    def _remember_directive(self, origin_turn_id: str | None) -> str:
        directive_id = uuid.uuid4().hex[:12]
        if len(self._directive_turn_ids) >= 128:
            self._directive_turn_ids.pop(next(iter(self._directive_turn_ids)))
        self._directive_turn_ids[directive_id] = (
            origin_turn_id or self._latest_input_turn_id or self.turn.turn_id
        )
        return directive_id

    # -- confirmations -------------------------------------------------------

    async def _confirm_by_tap(self, frame: protocol.ConfirmActionFrame) -> None:
        spec = None
        row = await self.pending.get(
            user_id=self.ctx.user_id, pending_action_id=frame.pending_action_id
        )
        if row is not None:
            spec = registry.get_tool(row.tool_name)
        if spec is not None and spec.firebase_plane:
            # The tap's proof is verified here, not merely present: signature,
            # expiry, revocation, and that it names this session's user. The
            # row stays pending on refusal so the client can tap again with a
            # fresh proof.
            proof = await self.executor._actor_proof(frame.firebase_id_token, self.ctx.user_id)
            if proof != "ok":
                await self._send(
                    protocol.error(
                        "firebase_proof_required"
                        if proof == "missing"
                        else "firebase_proof_invalid",
                        "Sign-in proof is required for this action."
                        if proof == "missing"
                        else "Sign-in proof is invalid or names another account.",
                    )
                )
                return
        if frame.firebase_id_token:
            self.ctx.firebase_id_token = frame.firebase_id_token
        try:
            confirmed = await self.pending.confirm(
                user_id=self.ctx.user_id,
                pending_action_id=frame.pending_action_id,
                source="tap",
                receipt_token=frame.receipt_token,
            )
        except PendingActionConflict as exc:
            await self._send(
                protocol.pending_resolved(
                    pending_action_id=frame.pending_action_id,
                    status="not_pending",
                    result_public={"reason_code": str(exc)},
                )
            )
            return
        await self._send(
            protocol.voice_state(
                "executing", turn_id=self._pending_turn_ids.get(frame.pending_action_id)
            )
        )
        outcome = await self.executor.execute_pending(self.ctx, confirmed)
        await self._after_execution(outcome, source="tap")

    async def _cancel(self, frame: protocol.CancelActionFrame) -> None:
        if frame.scope == "session":
            await self._close(protocol.CLOSE_ENDED, "ended")
            raise SessionClosed(protocol.CLOSE_ENDED, "ended")
        cancelled: list[str] = []
        if frame.pending_action_id:
            row = await self.pending.cancel(
                user_id=self.ctx.user_id, pending_action_id=frame.pending_action_id
            )
            if row is not None:
                cancelled.append(row.id)
        else:
            for row in await self.pending.list_open(
                user_id=self.ctx.user_id, conversation_id=self.ctx.conversation_id
            ):
                if await self.pending.cancel(user_id=self.ctx.user_id, pending_action_id=row.id):
                    cancelled.append(row.id)
        for pending_id in cancelled:
            self.pending_receipts.pop(pending_id, None)
            self._pending_turn_ids.pop(pending_id, None)
            await self._send(
                protocol.pending_resolved(
                    pending_action_id=pending_id, status="cancelled", result_public=None
                )
            )
            self._bump(pending_cancelled=1)
        if frame.scope == "turn":
            await self._send(protocol.turn("interrupted", turn_id=self.turn.turn_id))
        await self._inject_event(
            {"kind": "cancelled", "pending_action_ids": cancelled, "scope": frame.scope}
        )
        await self._send(protocol.voice_state("listening"))

    async def _after_execution(
        self,
        outcome: ToolCallOutcome,
        *,
        source: str,
        ok: bool | None = None,
        call_id: str | None = None,
        origin_turn_id: str | None = None,
    ) -> None:
        """Mirror a confirmed action's real outcome to the client and the model.

        Also the settle path for a device-executed step: ``ok`` is then decided
        by the settlement allowlist and ``call_id`` names the originating call
        so the client can replace its pending entry.
        """
        public = outcome.result.public()
        pending_id = outcome.pending.id if outcome.pending else None
        origin_turn_id = origin_turn_id or (
            self._pending_turn_ids.get(pending_id) if pending_id else None
        )
        awaiting = outcome.result.status in _AWAITING_DEVICE
        executed = ok if ok is not None else outcome.result.status not in _NOT_SUCCESS
        # An outstanding client step: the confirmed action ran (the card is
        # settled), but the outcome is not in yet, so it is neither ok nor a
        # rejection until the step reports back.
        status = "executed" if (executed or awaiting) else "failed"
        if pending_id:
            self.pending_receipts.pop(pending_id, None)
            await self._send(
                protocol.pending_resolved(
                    pending_action_id=pending_id, status=status, result_public=public
                )
            )
        await self._send(
            protocol.tool_result(
                call_id=call_id,
                pending_action_id=pending_id,
                tool=outcome.spec.name if outcome.spec else "",
                result_public=public,
                ok=False if awaiting else ok,
                turn_id=origin_turn_id,
            )
        )
        if pending_id and not awaiting:
            self._pending_turn_ids.pop(pending_id, None)
        if not awaiting:
            self._bump(
                tool_results_ok=1 if status == "executed" else 0,
                tool_results_rejected=0 if status == "executed" else 1,
            )
        await self._emit_side_effects(outcome, origin_turn_id=origin_turn_id)
        await self._persist_entities()
        if not self._origin_is_stale(origin_turn_id):
            await self._inject_event(
                {
                    "kind": "tool_result",
                    "tool": outcome.spec.name if outcome.spec else None,
                    "pending_action_id": pending_id,
                    "confirmation_source": source,
                    # Injected into the model's own context, so it takes the model
                    # projection for the same reason as the handback above.
                    "result": outcome.result.model_public(),
                }
            )
        # An awaiting step settles the card but not the turn: "complete" only
        # once the device outcome is in and verified.
        await self._send(
            protocol.voice_state(
                "complete" if status == "executed" and not awaiting else "listening",
                turn_id=origin_turn_id,
            )
        )

    # -- client steps --------------------------------------------------------

    async def _client_step_result(self, frame: protocol.ClientStepResultFrame) -> None:
        step = self.client_steps.pop(frame.step_id, None)
        if step is None:
            await self._send(protocol.error("protocol", "unknown_client_step"))
            return
        if step.get("kind") == "set_location_updates":
            # Settled server-side from the typed report; the raw claim is never
            # handed to the model as a client_step event.
            await self._settle_location_updates_step(step, frame)
            return
        if step.get("kind") == "open_request_review":
            await self._settle_request_review_step(step, frame)
            return
        if step.get("purpose") == "sos" and step.get("kind") == "publish_location_envelopes":
            await self._settle_sos_publish_step(step, frame)
            return
        if step.get("kind") == "account_lifecycle":
            await self._settle_account_lifecycle_step(step, frame)
            return
        event: dict[str, Any] = {
            "kind": "client_step",
            "step": step.get("kind"),
            "step_id": frame.step_id,
            "status": frame.status,
            "payload": frame.payload,
        }
        if step.get("kind") == "publish_location_envelopes":
            event["verification"] = await self._verify_grants_published(
                list(step.get("grant_ids") or [])
            )
        if not self._origin_is_stale(str(step.get("origin_turn_id") or "") or None):
            await self._inject_event(event)

    async def _settle_sos_publish_step(
        self, step: dict[str, Any], frame: protocol.ClientStepResultFrame
    ) -> None:
        """Final outcome of a Save My Soul alert this session armed.

        The device only says whether its publish step ran; whether anyone was
        reached is decided by ``report_save_my_soul_delivery`` from the stored
        envelopes on the exact grant set the trigger armed (the step record
        carries it, so the model cannot narrow it). The raw client payload
        never reaches the model. A late or failed report still verifies: an
        envelope may have been stored even though the device's reply was lost.
        The trigger card resolves a second time with the verified report so
        the client can replace "armed" with the real outcome.
        """
        grant_ids = [str(gid) for gid in (step.get("grant_ids") or []) if gid]
        outcome = await self.executor.call(
            self.ctx, "report_save_my_soul_delivery", {"grant_ids": grant_ids}
        )
        report = outcome.result
        public = report.public()
        public["device_step"] = {
            "status": frame.status,
            "late": self.clock() > float(step.get("expires_at") or 0),
        }
        report = report.model_copy(update={"device_step": public["device_step"]})
        pending = step.get("pending")
        settled = ToolCallOutcome(
            result=report,
            spec=outcome.spec,
            pending=pending if isinstance(pending, PendingAction) else None,
        )
        ok = report.status in {"sos_sent", "sos_partial"}
        await self._after_execution(
            settled,
            source="device",
            ok=ok,
            call_id=str(step.get("call_id") or "") or None,
            origin_turn_id=str(step.get("origin_turn_id") or "") or None,
        )
        if ok and not self._origin_is_stale(str(step.get("origin_turn_id") or "") or None):
            self.turn.ok_results += 1
            self._last_turn_ok = True

    async def _settle_account_lifecycle_step(
        self, step: dict[str, Any], frame: protocol.ClientStepResultFrame
    ) -> None:
        """Final outcome of a reset or deletion this session armed.

        The device only says what its lifecycle flow reported; whether the
        account was reset or deleted is decided by ``report_account_lifecycle``
        from the server (the ``vault_keys`` stamp, or the tombstone). The raw
        client payload never reaches the model, and the step record -- not the
        frame -- names the operation and the owner, so a report cannot be
        redirected. The card resolves a second time with the verified outcome
        so the client can replace "resetting"/"deleting" with what happened.
        """
        payload = frame.payload if isinstance(frame.payload, dict) else {}
        client_status = str(payload.get("outcome") or "").strip().lower()
        if frame.status != "ok" and client_status in {"", "reset", "deleted"}:
            client_status = "unknown"
        if client_status not in {
            "reset",
            "not_reset",
            "deleted",
            "needs_unlock",
            "auth_failed",
            "blocked_external",
            "failed",
            "unknown",
        }:
            client_status = "unknown"
        outcome = await self.executor.call(
            self.ctx,
            "report_account_lifecycle",
            {
                "operation": str(step.get("operation") or ""),
                "client_status": client_status,
                "issued_at_ms": int(step.get("issued_at_ms") or 0),
            },
        )
        report = outcome.result
        public = report.public()
        public["device_step"] = {
            "status": frame.status,
            "late": self.clock() > float(step.get("expires_at") or 0),
        }
        report = report.model_copy(update={"device_step": public["device_step"]})
        pending = step.get("pending")
        settled = ToolCallOutcome(
            result=report,
            spec=outcome.spec,
            pending=pending if isinstance(pending, PendingAction) else None,
        )
        ok = report.status in {"account_reset", "account_deleted"}
        await self._after_execution(
            settled,
            source="device",
            ok=ok,
            call_id=str(step.get("call_id") or "") or None,
            origin_turn_id=str(step.get("origin_turn_id") or "") or None,
        )
        if ok and not self._origin_is_stale(str(step.get("origin_turn_id") or "") or None):
            self.turn.ok_results += 1
            self._last_turn_ok = True

    async def _settle_location_updates_step(
        self, step: dict[str, Any], frame: protocol.ClientStepResultFrame
    ) -> None:
        """Final result for this device's Location updates switch.

        The step record binds the outcome to this session (the record exists only
        here), the originating tool and call, the gateway action, the desired
        state, and a deadline; the pure settlement refuses anything that does not
        match. Success is an allowlist, so nothing interim or contradictory is
        ever narrated as "on" or "off".
        """
        from hushh_mcp.one_voice.tools.location_state import (
            LOCATION_UPDATES_SETTLED_OK,
            settle_location_updates_step,
        )

        result = settle_location_updates_step(
            step, status=frame.status, payload=frame.payload, now=self.clock()
        )
        ok = result.status in LOCATION_UPDATES_SETTLED_OK
        spec = step.get("spec")
        outcome = ToolCallOutcome(result=result, spec=spec if isinstance(spec, ToolSpec) else None)
        await self._after_execution(
            outcome,
            source="device",
            ok=ok,
            call_id=str(step.get("call_id") or "") or None,
            origin_turn_id=str(step.get("origin_turn_id") or "") or None,
        )
        if ok and not self._origin_is_stale(str(step.get("origin_turn_id") or "") or None):
            # The narration turn that follows must read as a receipt even if a
            # turn_complete landed between the tool call and the device report.
            self.turn.ok_results += 1
            self._last_turn_ok = True

    async def _settle_request_review_step(
        self, step: dict[str, Any], frame: protocol.ClientStepResultFrame
    ) -> None:
        """Final result for a connection request that needed an on-screen scope
        review. The client only says the screen closed (or that it never
        opened); the request and the relationship are re-read here and that
        re-read is what the model and the card get."""
        from hushh_mcp.one_voice.tools.people import settle_request_review

        request_id = str(step.get("request_id") or "")
        user_id = str(step.get("user_id") or "")
        known = self.ctx.entities.person(user_id) if user_id else None
        display_name = (
            str(step.get("display_name") or "")
            or (known.display_name if known else "")
            or "that person"
        )
        result = await settle_request_review(
            self.ctx, request_id=request_id, user_id=user_id, display_name=display_name
        )
        result = result.model_copy(
            update={
                "review_reported": frame.status,
                "review_payload": {
                    k: v for k, v in dict(frame.payload or {}).items() if k in {"outcome", "reason"}
                },
            }
        )
        spec = step.get("spec")
        if isinstance(spec, ToolSpec) and result.status == "accepted":
            result.ui_refresh = sorted(set(result.ui_refresh) | set(spec.ui_refresh))
        outcome = ToolCallOutcome(result=result, spec=spec if isinstance(spec, ToolSpec) else None)
        # A review that reached a real decision is a settled result even when
        # the decision was "no": only an open or unreadable request is not.
        ok = result.status in {"accepted", "declined", "withdrawn"}
        await self._after_execution(
            outcome,
            source="review",
            ok=ok,
            call_id=str(step.get("call_id") or "") or None,
            origin_turn_id=str(step.get("origin_turn_id") or "") or None,
        )
        if ok and not self._origin_is_stale(str(step.get("origin_turn_id") or "") or None):
            self.turn.ok_results += 1
            self._last_turn_ok = True

    async def _verify_grants_published(self, grant_ids: list[str]) -> dict[str, Any]:
        """Server-side check that each grant now has a first envelope."""
        try:
            from hushh_mcp.services.one_location_agent_service import OneLocationAgentService

            service = self.ctx.service("location", OneLocationAgentService)
            state = await asyncio.to_thread(service.list_state, self.ctx.user_id)
        except Exception:  # noqa: BLE001 - verification unavailable is not success
            return {"status": "unverified", "published": [], "unpublished": grant_ids}
        owner_grants = {str(g.get("id")): g for g in (state.get("ownerGrants") or [])}
        published = [gid for gid in grant_ids if owner_grants.get(gid, {}).get("latestEnvelopeId")]
        unpublished = [gid for gid in grant_ids if gid not in published]
        status = (
            "published"
            if published and not unpublished
            else ("partial" if published else "not_published")
        )
        return {"status": status, "published": published, "unpublished": unpublished}

    # -- provider → client ---------------------------------------------------

    async def _pump_live(self) -> None:
        events: AsyncIterator[LiveEvent] = self.live.events()
        async for event in events:
            if self._closed:
                break
            await self._handle_live_event(event)
        if not self._closed:
            await self._close(protocol.CLOSE_PROVIDER_UNAVAILABLE, "provider_closed")
            raise SessionClosed(protocol.CLOSE_PROVIDER_UNAVAILABLE, "provider_closed")

    async def _handle_live_event(self, event: LiveEvent) -> None:
        kind = event.kind
        if kind == "audio" and event.audio_b64:
            self._touch()
            if self._narration_owns_response or self.turn.turn_id in self._superseded_turn_ids:
                return
            self.turn.input_seen = True
            if self.turn.audio_chunks == 0:
                await self._send(protocol.turn("model_start", turn_id=self.turn.turn_id))
                await self._send(
                    protocol.voice_state(self._speaking_state(), turn_id=self.turn.turn_id)
                )
            self.turn.audio_chunks += 1
            self.audio_out_chunks += 1
            await self._send(
                protocol.audio_out(
                    event.audio_b64,
                    turn_id=self.turn.turn_id,
                    origin_turn_id=self.turn.turn_id,
                )
            )
        elif kind == "input_transcript" and event.text:
            self._touch()
            if self._input_segment_id is None:
                self._input_segment_id = (
                    self.turn.turn_id
                    if not self.turn.input_transcript_completed
                    else uuid.uuid4().hex[:12]
                )
                if self._input_segment_id != self.turn.turn_id:
                    self._superseded_turn_ids.add(self.turn.turn_id)
                    self._pending_voice_turn_id = self._input_segment_id
            self._latest_input_turn_id = self._input_segment_id
            if self._input_segment_id != self._narration_origin_turn_id:
                self._narration_owns_response = False
                self._narration_origin_turn_id = None
            self.turn.input_seen = True
            await self._send(
                protocol.transcript(
                    "input", event.text, final=bool(event.finished), turn_id=self._input_segment_id
                )
            )
            if event.finished:
                self.turn.input_transcript_completed = True
                self._input_segment_id = None
                await self._send(protocol.voice_state("understanding", turn_id=self.turn.turn_id))
        elif kind == "output_transcript" and event.text:
            if self._narration_owns_response or self.turn.turn_id in self._superseded_turn_ids:
                return
            self.turn.input_seen = True
            self.turn.output_text.append(event.text)
            await self._send(
                protocol.transcript(
                    "output", event.text, final=bool(event.finished), turn_id=self.turn.turn_id
                )
            )
        elif kind == "interrupted":
            await self._send(protocol.turn("interrupted", turn_id=self.turn.turn_id))
            await self._advance_turn()
            await self._send(protocol.voice_state("listening"))
        elif kind == "turn_complete":
            await self._send(protocol.turn("model_end", turn_id=self.turn.turn_id))
            self._narration_guard()
            self._last_turn_ok = (
                bool(self.turn.ok_results)
                if self.turn.turn_id not in self._superseded_turn_ids
                else False
            )
            await self._advance_turn()
            await self._send(protocol.voice_state("listening"))
        elif kind == "tool_call":
            self._touch()
            self.turn.input_seen = True
            for call in event.function_calls:
                await self._dispatch_tool_call(call)
        elif kind == "tool_cancel":
            pass
        elif kind == "resumption" and event.resumption_handle:
            await self.conversations.save_resumption_handle(
                user_id=self.ctx.user_id,
                conversation_id=self.ctx.conversation_id,
                handle=event.resumption_handle,
            )
        elif kind == "go_away":
            await self._send(protocol.reconnect_required("go_away"))
            await self._close(protocol.CLOSE_ENDED, "go_away")
            raise SessionClosed(protocol.CLOSE_ENDED, "go_away")

    def _speaking_state(self) -> Literal["asking", "confirming", "complete"]:
        if self.pending_receipts:
            return "confirming"
        # The provider ends the tool-call turn before it speaks about the result,
        # so a spoken turn with no calls of its own inherits the previous turn's
        # outcome: speech right after a successful tool reads as "complete".
        if self.turn.ok_results or (not self.turn.tool_calls and self._last_turn_ok):
            return "complete"
        return "asking"

    async def _advance_turn(self) -> None:
        finished_id = self.turn.turn_id
        self._superseded_turn_ids.discard(finished_id)
        # Voice was already streamed to Live. Finish or fence that turn before
        # forwarding any typed question, otherwise its answer is mislabeled as
        # the typed question's answer.
        if self._pending_voice_turn_id:
            self.turn = TurnState(turn_id=self._pending_voice_turn_id, input_seen=True)
            self._pending_voice_turn_id = None
            if self._queued_texts:
                self._superseded_turn_ids.add(self.turn.turn_id)
        elif self._queued_texts:
            turn_id, text, _queued_at = self._queued_texts.popleft()
            self.turn = TurnState(turn_id=turn_id, input_seen=True)
            if self._queued_texts:
                self._superseded_turn_ids.add(turn_id)
            self._narration_owns_response = False
            self._narration_origin_turn_id = None
            await self.live.send_text(text)
        else:
            self.turn = TurnState()

    def _narration_guard(self) -> None:
        """Structural, not lexical: a turn that attempted a mutation which was
        rejected or left pending, and produced no successful result, is
        recorded. Nothing is muted or rewritten (AGENTS.md:109)."""
        if (
            self.turn.tool_calls
            and self.turn.not_ok_results
            and not self.turn.ok_results
            and self.turn.output_text
        ):
            self._bump(narration_without_receipt=1)
            logger.info("one_voice.narration_without_receipt session=%s", self.session_id)

    async def _dispatch_tool_call(self, call: dict[str, Any]) -> None:
        name = str(call.get("name") or "")
        call_id = call.get("id")
        args = dict(call.get("args") or {})
        origin_turn_id = self.turn.turn_id
        logger.info(
            "one_voice.tool.selected session=%s turn=%s call=%s tool=%s",
            self.session_id,
            origin_turn_id,
            str(call_id or "")[:64],
            name[:80],
        )
        self.turn.tool_calls += 1
        self._bump(tool_calls=1)
        await self._send(
            protocol.tool_started(
                call_id=str(call_id or ""),
                tool=name,
                args_public=_public_args(args),
                turn_id=origin_turn_id,
            )
        )
        await self._send(protocol.voice_state("executing", turn_id=self.turn.turn_id))
        outcome = await self.executor.call(self.ctx, name, args)
        public = outcome.result.public()
        if outcome.result.status == "rejected" and outcome.result.reason_code == "unknown_tool":
            self._bump(unknown_tool_calls=1)
        for stale in outcome.superseded:
            # A card the client is still showing no longer means anything: a
            # newer proposal replaced it, or a fresh lookup made its target
            # stale. Say so to both sides rather than letting it expire quietly.
            self.pending_receipts.pop(stale.id, None)
            self._pending_turn_ids.pop(stale.id, None)
            await self._send(
                protocol.pending_resolved(
                    pending_action_id=stale.id, status="cancelled", result_public=None
                )
            )
            self._bump(pending_cancelled=1)
        if outcome.superseded:
            public = dict(public, superseded_pending_action_ids=[s.id for s in outcome.superseded])
        if self._origin_is_stale(origin_turn_id):
            # A newer question arrived while this call was running. Never leave
            # an unseen confirmation in storage for session.ready to resurrect.
            if outcome.pending is not None:
                cancelled = await self.pending.cancel(
                    user_id=self.ctx.user_id,
                    pending_action_id=outcome.pending.id,
                )
                if cancelled is not None:
                    self._bump(pending_cancelled=1)
            superseded_result = {"status": "superseded", "reason_code": "newer_question"}
            await self._send(
                protocol.tool_result(
                    call_id=str(call_id or "") or None,
                    tool=name,
                    result_public=superseded_result,
                    ok=False,
                    turn_id=origin_turn_id,
                )
            )
            await self.live.send_tool_response(
                call_id=call_id,
                name=name,
                response={**superseded_result, "spoken_facts": []},
            )
            return
        if outcome.pending is not None:
            self._pending_turn_ids[outcome.pending.id] = origin_turn_id
            if outcome.receipt_token:
                self.pending_receipts[outcome.pending.id] = outcome.receipt_token
            await self._send(
                protocol.pending_action(
                    row=outcome.pending.public(),
                    receipt_token=outcome.receipt_token,
                    entities=self._entities_for(outcome),
                    risk_level="high" if outcome.pending.tier == "tap" else "medium",
                    turn_id=origin_turn_id,
                )
            )
            await self._send(protocol.voice_state("confirming", turn_id=self.turn.turn_id))
            self._bump(pending_created=1)
        else:
            await self._emit_side_effects(
                outcome,
                call_id=str(call_id or "") or None,
                origin_turn_id=origin_turn_id,
            )
        ok = outcome.result.status not in _NOT_SUCCESS
        if outcome.pending is None:
            if outcome.result.status in _AWAITING_DEVICE:
                # Outstanding device step: no receipt yet, not a rejection.
                self.turn.not_ok_results += 1
            elif ok:
                self.turn.ok_results += 1
                self._bump(tool_results_ok=1)
            else:
                self.turn.not_ok_results += 1
                self._bump(tool_results_rejected=1)
        else:
            self.turn.not_ok_results += 1
        # A read_mail result makes its Open button actionable immediately. Save
        # the offered message IDs before publishing that result so a fast tap's
        # HTTP resolver observes the same list the person just saw.
        await self._persist_entities()
        await self._send(
            protocol.tool_result(
                call_id=str(call_id or "") or None,
                tool=name,
                result_public=public,
                turn_id=origin_turn_id,
            )
        )
        # The client frame above carries the full result. The model gets its own
        # projection, which for an external-content read is a receipt rather
        # than the mail itself.
        # Spoken before the model is told anything, so the model cannot start
        # talking over it. A narration IS the answer, so its cost is the model's
        # acknowledgement arriving a few seconds later -- and that acknowledgement
        # is counts-only, so there is little to delay.
        narrated = (
            await self._narrate(outcome.result, origin_turn_id=origin_turn_id)
            if origin_turn_id not in self._superseded_turn_ids
            else False
        )
        response = outcome.result.model_public()
        if narrated:
            # The digest has been said. Leaving the count sentence in would have
            # One announce the same turn twice, in two different voices of its own.
            response = {**response, "spoken_facts": []}
        await self.live.send_tool_response(call_id=call_id, name=name, response=response)

    async def _narrate(self, result: ToolResult, *, origin_turn_id: str) -> bool:
        """Speak a result's own short digest, if it has one and narration is on.

        The digest never reaches the operational model: it is rendered by a
        separate provider context with no tools and no history, and arrives at the
        client as ordinary audio frames marked `narration`, which close the
        microphone while they play. See ``services.voice_narration``.

        Returns whether anything was spoken. A failure is silent by design -- the
        visible result is already on screen, and the screen and the speaker are
        separate outcomes.
        """
        from hushh_mcp.one_voice.config import voice_mail_narration_enabled

        if not voice_mail_narration_enabled():
            return False
        digest = ""
        try:
            digest = result.narratable_digest()
        except Exception:  # noqa: BLE001 - a tool that cannot say it says nothing
            return False
        if not digest.strip():
            return False
        if self.turn.audio_chunks or self._narration_owns_response:
            # The model is already speaking this turn. A narration would be a
            # second voice over the first, and its unseen turn id would outrank
            # the model's in the player's fence.
            return False

        from hushh_mcp.one_voice.instruction import voice_name
        from hushh_mcp.services.voice_narration import (
            NarrationUnavailable,
            narrate_digest_stream,
        )

        # Its own turn id: the player schedules per turn, and a narration is not
        # part of the model's turn.
        turn_id = uuid.uuid4().hex[:12]
        spoken = False
        try:
            async for chunk in narrate_digest_stream(digest, voice_name=voice_name()):
                if origin_turn_id in self._superseded_turn_ids:
                    break
                await self._send(
                    protocol.audio_out(
                        base64.b64encode(chunk.audio).decode("ascii"),
                        turn_id=turn_id,
                        narration=True,
                        origin_turn_id=origin_turn_id,
                    )
                )
                spoken = True
                self._narration_owns_response = True
                self._narration_origin_turn_id = origin_turn_id
                self._touch()
        except NarrationUnavailable as exc:
            # Named, not detailed: a provider message can echo the digest.
            logger.info("Narration unavailable: %s", exc.reason)
            return spoken
        return spoken

    async def _emit_side_effects(
        self,
        outcome: ToolCallOutcome,
        *,
        call_id: str | None = None,
        origin_turn_id: str | None = None,
    ) -> None:
        """Turn typed result fields into client directives/steps and entity cards."""
        public = outcome.result.public()
        if public.get("status") == "navigation_dispatched" and public.get("gateway_action_id"):
            await self._send(
                protocol.ui_directive(
                    directive_id=self._remember_directive(origin_turn_id),
                    kind="navigate",
                    turn_id=origin_turn_id,
                    payload={
                        "gateway_action_id": public["gateway_action_id"],
                        "screen": public.get("screen"),
                        "circle_id": public.get("circle_id"),
                        "user_id": public.get("user_id"),
                    },
                )
            )
        if public.get("status") == protocol.MAIL_OPEN_DISPATCHED:
            # The surface opens the row through its own authenticated resolver.
            # Nothing about the message passes through the relay or the model; this
            # carries only which row, from which offer, in which conversation.
            await self._send(
                protocol.ui_directive(
                    directive_id=self._remember_directive(origin_turn_id),
                    kind="open_mail",
                    turn_id=origin_turn_id,
                    payload={
                        "ordinal": public.get("ordinal"),
                        "offer_revision": public.get("offer_revision"),
                        "conversation_id": public.get("conversation_id"),
                    },
                )
            )
        step = public.get("client_step")
        if isinstance(step, dict) and step.get("kind"):
            step_id = uuid.uuid4().hex[:12]
            payload = {k: v for k, v in step.items() if k != "kind"}
            timeout_s = int(step.get("timeout_s") or CLIENT_STEP_TIMEOUT_SECONDS)
            requested_at = self.clock()
            self.client_steps[step_id] = {
                "kind": step["kind"],
                "purpose": step.get("purpose"),
                "grant_ids": step.get("grant_ids") or [],
                **payload,
                # Binding for a settled step: the originating tool and call, and
                # a deadline (monotonic) after which a report is stale.
                "tool": outcome.spec.name if outcome.spec else None,
                "spec": outcome.spec,
                "call_id": call_id,
                "origin_turn_id": origin_turn_id,
                # The card this step belongs to, so its settlement can resolve
                # the same card again with the verified outcome.
                "pending": outcome.pending,
                "requested_at": requested_at,
                "expires_at": requested_at + timeout_s + CLIENT_STEP_GRACE_SECONDS,
            }
            await self._send(
                protocol.client_step_request(
                    step_id=step_id,
                    kind=str(step["kind"]),
                    payload=payload,
                    timeout_s=timeout_s,
                    turn_id=origin_turn_id,
                )
            )
        candidates = public.get("candidates")
        if isinstance(candidates, list) and public.get("status") in {
            "multiple",
            "single_likely",
            "low_confidence",
            "truncated",
        }:
            kind: Literal["person", "circle"] = (
                "circle" if outcome.spec and "circle" in outcome.spec.name else "person"
            )
            await self._send(
                protocol.candidate_picker(
                    kind=kind,
                    turn_id=origin_turn_id,
                    question="Which one do you mean?"
                    if public.get("status") in {"multiple", "truncated"}
                    else "Is this who you mean?",
                    candidates=[c for c in candidates if isinstance(c, dict)][:5],
                )
            )
        if public.get("status") == "confirmed" and outcome.spec:
            for card in self._entities_for(outcome):
                card_kind: Literal["person", "circle"] = (
                    "circle" if card.get("kind") == "circle" else "person"
                )
                await self._send(
                    protocol.entity_card(kind=card_kind, payload=card, turn_id=origin_turn_id)
                )

    def _entities_for(self, outcome: ToolCallOutcome) -> list[dict[str, Any]]:
        cards: list[dict[str, Any]] = []
        parsed = outcome.parsed
        spec = outcome.spec
        if parsed is None or spec is None:
            if outcome.result.status == "confirmed":
                last = self.ctx.entities.last_person_user_id
                person = self.ctx.entities.person(last) if last else None
                if person:
                    cards.append({"kind": "person", **person.model_dump(mode="json")})
            return cards
        for arg in spec.person_args:
            ref = getattr(parsed, arg, None)
            person = self.ctx.entities.person(str(getattr(ref, "user_id", ""))) if ref else None
            if person:
                cards.append({"kind": "person", **person.model_dump(mode="json")})
        for arg in spec.circle_args:
            ref = getattr(parsed, arg, None)
            circle = self.ctx.entities.circle(str(getattr(ref, "circle_id", ""))) if ref else None
            if circle:
                cards.append({"kind": "circle", **circle.model_dump(mode="json")})
        if outcome.result.status == "confirmed" and not cards:
            if "circle" in spec.name and self.ctx.entities.last_circle_id:
                circle = self.ctx.entities.circle(self.ctx.entities.last_circle_id)
                if circle:
                    cards.append({"kind": "circle", **circle.model_dump(mode="json")})
            elif self.ctx.entities.last_person_user_id:
                person = self.ctx.entities.person(self.ctx.entities.last_person_user_id)
                if person:
                    cards.append({"kind": "person", **person.model_dump(mode="json")})
        return cards

    async def _persist_entities(self) -> None:
        await self.conversations.save_entity_context(
            user_id=self.ctx.user_id,
            conversation_id=self.ctx.conversation_id,
            context=self.ctx.entities.model_dump(mode="json"),
        )


def _public_args(args: dict[str, Any]) -> dict[str, Any]:
    """Arguments are canonical ids and short strings; still bound the size."""
    out: dict[str, Any] = {}
    for key, value in list(args.items())[:12]:
        if isinstance(value, (str, int, float, bool)) or value is None:
            out[key] = value if not isinstance(value, str) else value[:120]
        elif isinstance(value, dict):
            out[key] = {
                k: (v[:120] if isinstance(v, str) else v) for k, v in list(value.items())[:8]
            }
        else:
            out[key] = str(type(value).__name__)
    return out


def b64_len_bytes(data_b64: str) -> int:
    return len(base64.b64decode(data_b64, validate=False)) if data_b64 else 0
