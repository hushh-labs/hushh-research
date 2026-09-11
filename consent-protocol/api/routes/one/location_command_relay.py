"""Transcript-first Location command relay.

This is intentionally a narrow, non-conversational transport.  It accepts a
single authenticated command turn, streams 16 kHz PCM to managed Vertex
Gemini Live Transcribe, and invokes the server-owned Location command runtime
only after Gemini has supplied both a final input transcription and its
``turn_complete`` boundary.

It does not import or extend the legacy ADK conversation relay.  That keeps
the command surface free of model speech, tool calls, conversational context,
and BYOK credentials.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import importlib
import json
import logging
import os
import re
from contextlib import suppress
from dataclasses import dataclass
from typing import Any, Callable, Mapping

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from api.routes.one.relay_auth import consume_relay_ticket_shared, one_voice_enabled
from hushh_mcp.runtime_providers import (
    build_managed_gemini_live_client,
    get_managed_gemini_live_capacity_pool,
)
from hushh_mcp.runtime_providers.dependency_health import classify_provider_error

logger = logging.getLogger(__name__)

# Kept under the existing authenticated ADK relay namespace so current clients
# need only swap the websocket suffix from ``/live`` to
# ``/location-command/live`` while retaining their ticket-minting flow.
router = APIRouter(prefix="/api/one/adk/location-command", tags=["One Location command"])

# This is deliberately a route-owned wire literal.  The command runtime also
# exposes it; ``_load_location_command_dependencies`` compares the two before
# accepting a connection, preventing a partially deployed graph/runtime from
# silently speaking a different protocol.
LOCATION_COMMAND_PROTOCOL_VERSION = "one_command_v2"
LOCATION_COMMAND_TRANSCRIBE_MODEL = "gemini-3.5-transcribe-live-preview"
LOCATION_COMMAND_RUNTIME_ENABLED_ENV = "HUSHH_LOCATION_COMMAND_RUNTIME_ENABLED"

_BOOTSTRAP_TIMEOUT_SECONDS = 6.0
_MAX_BROWSER_FRAME_CHARS = 1_000_000
_MAX_PCM_BYTES = 512 * 1024
_MAX_PCM_BASE64_CHARS = ((_MAX_PCM_BYTES + 2) // 3) * 4
_FINAL_TRANSCRIPT_GRACE_SECONDS = 0.25
_PLANNING_TIMEOUT_SECONDS = 3.0
_TURN_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,96}$")
_CONTEXT_REVISION_RE = re.compile(r"^[A-Za-z0-9_.:-]{0,191}$")
_TRUE_VALUES = frozenset({"1", "true", "yes", "on"})
_INPUT_MIME = "audio/pcm;rate=16000"


@dataclass(frozen=True)
class _CommandRuntimeDependencies:
    """Lazy import seam for the graph-backed command runtime.

    The capability graph may be generated and deployed independently of this
    route.  Keeping this import lazy lets the API process start safely while a
    mismatched or missing command runtime fails closed at the endpoint rather
    than breaking unrelated One routes at import time.
    """

    runtime_factory: Callable[[], Any]
    turn_gate_factory: Callable[[], Any]
    runtime_enabled: Callable[[], bool]
    transcribe_model: Callable[[], str]
    protocol_version: str


def _load_location_command_dependencies() -> _CommandRuntimeDependencies | None:
    """Load the separately-owned Location brain runtime without widening this route.

    Do not catch and re-emit import details: generated-artifact, binding, and
    registry failures are server diagnostics, not browser information.
    """

    try:
        module = importlib.import_module("hushh_mcp.services.location_command_runtime")
        runtime_factory = module.get_location_command_runtime
        turn_gate_factory = module.LocationCommandTurnGate
        runtime_enabled = module.location_command_runtime_enabled
        transcribe_model = module.location_command_transcribe_model_id
        protocol_version = str(module.LOCATION_COMMAND_PROTOCOL_VERSION or "")
    except Exception:  # noqa: BLE001 - this endpoint must fail closed
        return None
    if not all(
        callable(value)
        for value in (runtime_factory, turn_gate_factory, runtime_enabled, transcribe_model)
    ):
        return None
    if protocol_version != LOCATION_COMMAND_PROTOCOL_VERSION:
        return None
    return _CommandRuntimeDependencies(
        runtime_factory=runtime_factory,
        turn_gate_factory=turn_gate_factory,
        runtime_enabled=runtime_enabled,
        transcribe_model=transcribe_model,
        protocol_version=protocol_version,
    )


def _command_rollout_enabled(dependencies: _CommandRuntimeDependencies | None) -> bool:
    """Require both the UAT rollout switch and the runtime's own safety gate."""

    if (os.getenv("ENVIRONMENT") or "").strip().lower() != "uat":
        return False
    if (os.getenv(LOCATION_COMMAND_RUNTIME_ENABLED_ENV) or "").strip().lower() not in _TRUE_VALUES:
        return False
    if dependencies is None:
        return False
    try:
        return dependencies.runtime_enabled() is True
    except Exception:  # noqa: BLE001 - deployment/runtime mismatch fails closed
        return False


def _safe_json(payload: Mapping[str, Any]) -> str:
    """Serialize only server-shaped protocol data."""

    return json.dumps(payload, separators=(",", ":"), default=str)


async def _close_quietly(
    websocket: WebSocket,
    *,
    code: int = 1000,
    reason: str = "",
) -> None:
    """Close without turning a disconnected browser into an application error."""

    with suppress(Exception):  # a peer may already have disconnected
        await websocket.close(code=code, reason=reason)


def _bounded_string(value: Any, *, cap: int) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())[:cap]


def _decode_pcm(value: Any) -> bytes | None:
    if not isinstance(value, str) or not value or len(value) > _MAX_PCM_BASE64_CHARS:
        return None
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        return None
    return decoded if len(decoded) <= _MAX_PCM_BYTES else None


async def _receive_bootstrap(websocket: WebSocket) -> None:
    """Accept the command-only bootstrap and categorically reject BYOK.

    The generic relay ticket authenticates the socket.  This frame only
    selects the wire protocol; no credential, model, endpoint, or capability
    choice may cross it.
    """

    try:
        raw = await asyncio.wait_for(websocket.receive_text(), _BOOTSTRAP_TIMEOUT_SECONDS)
    except (asyncio.TimeoutError, WebSocketDisconnect):
        raise ValueError("bootstrap_required") from None
    if len(raw) > _MAX_BROWSER_FRAME_CHARS:
        raise ValueError("bootstrap_invalid")
    try:
        message = json.loads(raw)
    except (TypeError, ValueError):
        raise ValueError("bootstrap_invalid") from None
    if not isinstance(message, Mapping) or message.get("type") != "runtime_bootstrap":
        raise ValueError("bootstrap_required")
    if message.get("location_command_protocol") != LOCATION_COMMAND_PROTOCOL_VERSION:
        raise ValueError("protocol_mismatch")
    if message.get("runtime_credential_mode") != "hushh_managed_vertex":
        raise ValueError("managed_runtime_required")
    # Credentials and client-selected Vertex routing are forbidden on this
    # transport.  The capacity pool uses only organization-approved targets.
    # Current clients include their generic managed transport label
    # (``developer_api``) in every bootstrap.  It is accepted only as a
    # compatibility no-op; this route always obtains a selected Vertex ADC
    # client from the server capacity pool below.
    if message.get("runtime_credential_transport") not in (None, "", "developer_api"):
        raise ValueError("bootstrap_invalid")
    if any(
        message.get(key) not in (None, "")
        for key in (
            "runtime_credential",
            "runtime_vertex_project",
            "runtime_vertex_location",
        )
    ):
        raise ValueError("bootstrap_invalid")


def _location_command_live_config(genai_types: Any) -> Any:
    """Use text-only Live Transcribe with provider-owned speech endpointing."""

    return genai_types.LiveConnectConfig(
        response_modalities=[genai_types.Modality.TEXT],
        input_audio_transcription=genai_types.AudioTranscriptionConfig(),
        realtime_input_config=genai_types.RealtimeInputConfig(
            automatic_activity_detection=genai_types.AutomaticActivityDetection(disabled=False)
        ),
    )


def _provider_setup_observed(session: Any) -> bool:
    """Do not admit PCM merely because a client object was constructed."""

    return getattr(session, "setup_complete", None) is not None


async def _send_state(
    websocket: WebSocket,
    *,
    turn_id: str | None,
    state: str,
    reason_code: str | None = None,
) -> None:
    payload: dict[str, Any] = {
        "protocolVersion": LOCATION_COMMAND_PROTOCOL_VERSION,
        "state": state,
    }
    if turn_id:
        payload["turnId"] = turn_id
    if reason_code:
        payload["reasonCode"] = reason_code
    await websocket.send_text(_safe_json({"locationCommandState": payload}))


async def _send_failed_result(
    websocket: WebSocket,
    *,
    turn_id: str,
    reason_code: str,
) -> None:
    await websocket.send_text(
        _safe_json(
            {
                "locationCommandResult": {
                    "protocolVersion": LOCATION_COMMAND_PROTOCOL_VERSION,
                    "turnId": turn_id,
                    "outcome": "failed",
                    "reasonCode": reason_code,
                }
            }
        )
    )


def _result_wire_payload(result: Any, *, turn_id: str) -> dict[str, Any] | None:
    """Validate the runtime's typed result before it reaches a browser.

    The relay never projects arbitrary runtime objects or exception strings.
    A malformed result is a retryable failure rather than a permissive card,
    navigation, or action settlement.
    """

    try:
        raw = result.wire_payload()
    except Exception:  # noqa: BLE001 - malformed runtime output fails closed
        return None
    if not isinstance(raw, Mapping):
        return None
    payload = dict(raw)
    if (
        payload.get("protocolVersion") != LOCATION_COMMAND_PROTOCOL_VERSION
        or payload.get("turnId") != turn_id
        or payload.get("outcome")
        not in {"execute_started", "interaction_required", "navigate", "ask", "blocked", "failed"}
    ):
        return None
    return payload


async def _select_managed_transcribe_client(
    *,
    uid: str,
    relay_ticket: str,
) -> tuple[Any, Any, Any] | None:
    """Pin a single organization-approved Vertex target before any PCM.

    The live capacity pool is the only selection authority.  It owns target
    affinity and breaker state; this route cannot silently fall back to a
    consumer account, an API key, or another model after audio starts.
    """

    pool = get_managed_gemini_live_capacity_pool()
    if pool is None:
        return None
    selection = await pool.select(
        requested_model=LOCATION_COMMAND_TRANSCRIBE_MODEL,
        affinity_key=uid or relay_ticket,
    )
    if (
        selection is None
        or selection.model != LOCATION_COMMAND_TRANSCRIBE_MODEL
        or selection.target.transport != "vertex"
    ):
        return None
    return build_managed_gemini_live_client(selection), selection, pool


async def _run_location_command_relay(
    websocket: WebSocket,
    *,
    uid: str,
    client: Any,
    model: str,
    dependencies: _CommandRuntimeDependencies,
) -> None:
    """Run exactly one provider-endpointed command on one Live session.

    A provider Live event has no application turn id.  Ending this socket
    after a terminal command result is therefore intentional: it prevents a
    late event from an old utterance ever being attached to a future tap.
    """

    from google.genai import types as genai_types

    provider_ready = asyncio.Event()
    context_ready = asyncio.Event()
    closing = asyncio.Event()
    terminal_lock = asyncio.Lock()
    turn_gate = dependencies.turn_gate_factory()
    runtime = dependencies.runtime_factory()
    consent_token = ""
    context_revision = ""
    terminal_sent = False
    ready_announced = False
    missing_transcript_task: asyncio.Task[None] | None = None

    async def _send_ready_if_possible() -> None:
        """Publish the three-fact readiness barrier exactly once."""

        nonlocal ready_announced
        if ready_announced or not provider_ready.is_set() or not context_ready.is_set():
            return
        ready_announced = True
        await websocket.send_text(
            _safe_json(
                {
                    "locationCommandReady": {
                        "protocolVersion": LOCATION_COMMAND_PROTOCOL_VERSION,
                        "relayAccepted": True,
                        "providerReady": True,
                        "contextAccepted": True,
                    }
                }
            )
        )

    async def _finish_session(reason: str) -> None:
        closing.set()
        with suppress(Exception):
            await websocket.send_text(
                _safe_json({"sessionEnded": {"reason": reason, "resumable": True}})
            )

    async def _send_terminal_locked(
        *,
        turn_id: str,
        payload: dict[str, Any] | None = None,
        reason_code: str | None = None,
        session_reason: str = "location_command_boundary_rollover",
    ) -> None:
        """Emit one terminal result while ``terminal_lock`` is held."""

        nonlocal terminal_sent
        if terminal_sent:
            return
        terminal_sent = True
        try:
            turn_gate.mark_result_settled(turn_id=turn_id)
        except Exception:  # noqa: BLE001 - result still fails closed below
            pass
        if payload is None:
            await _send_state(
                websocket,
                turn_id=turn_id,
                state="failed",
                reason_code=reason_code or "command_failed",
            )
            await _send_failed_result(
                websocket,
                turn_id=turn_id,
                reason_code=reason_code or "command_failed",
            )
        else:
            await websocket.send_text(_safe_json({"locationCommandResult": payload}))
        await _finish_session(session_reason)

    async def _fail_active_turn(reason_code: str, *, session_reason: str = "input_failed") -> None:
        """Fail an incomplete turn before any command runtime can act."""

        async with terminal_lock:
            if terminal_sent:
                return
            try:
                turn_id = turn_gate.fail()
            except Exception:  # noqa: BLE001 - no active command to report
                turn_id = None
            if not isinstance(turn_id, str) or not turn_id:
                return
            await _send_terminal_locked(
                turn_id=turn_id,
                reason_code=reason_code,
                session_reason=session_reason,
            )

    async def _fail_resolved_turn(
        turn_id: str,
        reason_code: str,
        *,
        session_reason: str,
    ) -> None:
        """Return a terminal retry after a claimed plan/adapter fails.

        A durable adapter is claimed before it starts so a later transport
        fault cannot retract a real server mutation.  That same claim means
        ``turn_gate.fail()`` correctly refuses to overwrite the turn; emit the
        typed failure through the still-owned resolved turn instead.
        """

        async with terminal_lock:
            if terminal_sent:
                return
            try:
                may_emit = turn_gate.may_emit_resolution_result(turn_id=turn_id)
            except Exception:  # noqa: BLE001 - no ownership proof
                may_emit = False
            if may_emit:
                await _send_terminal_locked(
                    turn_id=turn_id,
                    reason_code=reason_code,
                    session_reason=session_reason,
                )
                return
        await _fail_active_turn(reason_code, session_reason=session_reason)

    async def _emit_resolution_if_ready() -> None:
        """Route only after final provider transcript and provider turn complete."""

        async with terminal_lock:
            if terminal_sent:
                return
            try:
                ready = turn_gate.take_resolution()
            except Exception:  # noqa: BLE001 - runtime gate details stay private
                ready = None
            if not (
                isinstance(ready, tuple)
                and len(ready) == 2
                and isinstance(ready[0], str)
                and isinstance(ready[1], str)
            ):
                return
            turn_id, transcript = ready

        # The transcript remains local to this coroutine.  It is never logged,
        # echoed to the client, sent in telemetry, or retained after plan().
        await _send_state(websocket, turn_id=turn_id, state="routing")
        await websocket.send_text(_safe_json({"serverContent": {"turnComplete": True}}))
        # Do not use ``asyncio.wait_for`` here. A model/selector adapter that
        # delays cancellation acknowledgement would make ``wait_for`` wait
        # indefinitely after the deadline, stranding the command surface.
        # Planning is explicitly side-effect-free; once the deadline passes,
        # detach its late result and close the command boundary. ``advance``
        # is never reached for that task.
        planning_task = asyncio.create_task(
            runtime.plan(turn_id=turn_id, transcript=transcript, user_id=uid),
            name=f"location-command-plan-{turn_id}",
        )
        done, _pending = await asyncio.wait({planning_task}, timeout=_PLANNING_TIMEOUT_SECONDS)
        if not done:
            planning_task.cancel()

            def _consume_late_planning_result(task: asyncio.Task[Any]) -> None:
                with suppress(asyncio.CancelledError, Exception):
                    task.result()

            planning_task.add_done_callback(_consume_late_planning_result)
            await _fail_resolved_turn(
                turn_id,
                "resolution_timeout",
                session_reason="resolution_failed",
            )
            return
        try:
            plan = planning_task.result()
        except Exception:  # noqa: BLE001 - semantic/model detail stays server-side
            await _fail_resolved_turn(
                turn_id,
                "resolution_unavailable",
                session_reason="resolution_failed",
            )
            return

        if str(getattr(plan, "turn_id", "")) != turn_id:
            await _fail_resolved_turn(
                turn_id,
                "plan_unavailable",
                session_reason="resolution_failed",
            )
            return

        requires_durable_advance = getattr(plan, "requires_durable_advance", False) is True
        async with terminal_lock:
            if terminal_sent:
                return
            try:
                may_emit = turn_gate.may_emit_resolution_result(turn_id=turn_id)
                claimed = (
                    turn_gate.claim_durable_advance(turn_id=turn_id)
                    if requires_durable_advance
                    else may_emit
                )
            except Exception:  # noqa: BLE001 - stale gate cannot authorize work
                claimed = False
            if not claimed:
                return

        if requires_durable_advance:
            await _send_state(websocket, turn_id=turn_id, state="working")
        try:
            result = await runtime.advance(
                plan,
                user_id=uid,
                consent_token=consent_token,
                context_revision=context_revision,
            )
        except Exception:  # noqa: BLE001 - adapter details remain server-only
            await _fail_resolved_turn(
                turn_id,
                "advance_unavailable",
                session_reason="advance_failed",
            )
            return
        payload = _result_wire_payload(result, turn_id=turn_id)
        async with terminal_lock:
            if terminal_sent:
                return
            try:
                may_emit = turn_gate.may_emit_resolution_result(turn_id=turn_id)
            except Exception:  # noqa: BLE001 - stale gate cannot publish a result
                may_emit = False
            if not may_emit:
                return
            if payload is None:
                await _send_terminal_locked(
                    turn_id=turn_id,
                    reason_code="result_unavailable",
                    session_reason="runtime_result_invalid",
                )
                return
            await _send_terminal_locked(turn_id=turn_id, payload=payload)

    async def _finish_missing_transcript_after_grace(turn_id: str) -> None:
        await asyncio.sleep(_FINAL_TRANSCRIPT_GRACE_SECONDS)
        async with terminal_lock:
            if terminal_sent:
                return
            try:
                missing = turn_gate.missing_final_transcript_after_completion(turn_id=turn_id)
            except Exception:  # noqa: BLE001 - invalid gate cannot route
                missing = None
            if isinstance(missing, str) and missing:
                await websocket.send_text(_safe_json({"serverContent": {"turnComplete": True}}))
                await _send_terminal_locked(
                    turn_id=missing,
                    reason_code="final_transcript_missing",
                    session_reason="input_failed",
                )

    async def _accept_context(message: Mapping[str, Any]) -> None:
        nonlocal consent_token, context_revision
        raw_context = message.get("appContext")
        context = raw_context if isinstance(raw_context, Mapping) else {}
        # These client values are presentation/continuation hints only.  The
        # Location runtime obtains identity, authorization, workflow state,
        # entity state, and settlement evidence from server-owned stores.
        consent_token = _bounded_string(context.get("consent_token"), cap=4096)
        candidate_revision = _bounded_string(
            context.get("context_revision") or message.get("contextRevision"), cap=192
        )
        context_revision = (
            candidate_revision if _CONTEXT_REVISION_RE.fullmatch(candidate_revision) else ""
        )
        context_ready.set()
        await websocket.send_text(
            _safe_json(
                {
                    "contextAccepted": {
                        "protocolVersion": LOCATION_COMMAND_PROTOCOL_VERSION,
                    }
                }
            )
        )
        await _send_ready_if_possible()

    async def _pump_browser(session: Any) -> None:
        while not closing.is_set():
            raw = await websocket.receive_text()
            if len(raw) > _MAX_BROWSER_FRAME_CHARS:
                await _fail_active_turn("frame_too_large")
                return
            try:
                message = json.loads(raw)
            except (TypeError, ValueError):
                await _fail_active_turn("invalid_frame")
                return
            if not isinstance(message, Mapping):
                await _fail_active_turn("invalid_frame")
                return
            if message.get("type") == "app_context" or "appContext" in message:
                await _accept_context(message)
                continue
            if message.get("type") == "location_command_begin":
                try:
                    turn, error = turn_gate.begin(
                        message,
                        provider_ready=provider_ready.is_set(),
                        context_ready=context_ready.is_set(),
                    )
                except Exception:  # noqa: BLE001 - malformed gate input fails closed
                    turn, error = None, "invalid_begin"
                if error is not None or turn is None:
                    candidate_turn_id = _bounded_string(message.get("turnId"), cap=96)
                    await _send_state(
                        websocket,
                        turn_id=candidate_turn_id or None,
                        state="failed",
                        reason_code=error or "invalid_begin",
                    )
                    continue
                await _send_state(websocket, turn_id=str(turn.turn_id), state="listening")
                continue
            if message.get("type") in {"location_command_cancel", "location_command_end"}:
                if message.get("type") == "location_command_end":
                    await _fail_active_turn("client_end_not_supported")
                    return
                current = getattr(turn_gate, "turn", None)
                cancel_frame = dict(message)
                cancel_frame["cancelled"] = True
                cancel_frame["finalSequence"] = getattr(current, "last_sequence", 0)
                try:
                    turn, error = turn_gate.end(cancel_frame)
                except Exception:  # noqa: BLE001 - stale cancellation fails closed
                    turn, error = None, "turn_not_started"
                if error is not None or turn is None:
                    await _fail_active_turn(error or "turn_not_started")
                    return
                async with terminal_lock:
                    await _send_terminal_locked(
                        turn_id=str(turn.turn_id),
                        reason_code="cancelled",
                        session_reason="cancelled",
                    )
                return

            realtime_input = message.get("realtimeInput")
            if not isinstance(realtime_input, Mapping):
                await _fail_active_turn("invalid_frame")
                return
            audio = realtime_input.get("audio")
            metadata = realtime_input.get("locationCommand")
            if not isinstance(audio, Mapping):
                await _fail_active_turn("invalid_audio")
                return
            try:
                sequence_error = turn_gate.accept_audio(metadata)
            except Exception:  # noqa: BLE001 - malformed transport metadata fails closed
                sequence_error = "sequence_invalid"
            if sequence_error == "post_endpoint_ignored":
                # A packet queued just before provider speech-end never opens a
                # second untagged provider turn.
                continue
            if sequence_error is not None:
                await _fail_active_turn(sequence_error)
                return
            if audio.get("mimeType") != _INPUT_MIME:
                await _fail_active_turn("invalid_audio")
                return
            pcm = _decode_pcm(audio.get("data"))
            if pcm is None:
                await _fail_active_turn("invalid_audio")
                return
            await session.send_realtime_input(
                audio=genai_types.Blob(data=pcm, mime_type=_INPUT_MIME)
            )

    async def _pump_provider(session: Any) -> None:
        nonlocal missing_transcript_task
        async for message in session.receive():
            content = getattr(message, "server_content", None)
            if content is None:
                continue
            transcription = getattr(content, "input_transcription", None)
            final_text = getattr(transcription, "text", None)
            if isinstance(final_text, str) and final_text.strip():
                try:
                    final_error = turn_gate.receive_final_transcript(final_text)
                except Exception:  # noqa: BLE001 - provider input must not route on error
                    final_error = "final_transcript_invalid"
                if final_error is not None:
                    await _fail_active_turn(final_error)
                    return
                await _emit_resolution_if_ready()
            if getattr(content, "interrupted", False):
                await _fail_active_turn(
                    "provider_interrupted", session_reason="provider_unavailable"
                )
                return
            if getattr(content, "turn_complete", False):
                try:
                    completed = turn_gate.mark_provider_turn_complete()
                except Exception:  # noqa: BLE001 - no safe current turn
                    completed = False
                if not completed:
                    await _fail_active_turn("provider_turn_complete_before_audio")
                    return
                current = getattr(turn_gate, "turn", None)
                turn_id = getattr(current, "turn_id", None)
                if isinstance(turn_id, str) and turn_id:
                    await _send_state(websocket, turn_id=turn_id, state="speech_ended")
                    await _emit_resolution_if_ready()
                    if missing_transcript_task is not None:
                        missing_transcript_task.cancel()
                    missing_transcript_task = asyncio.create_task(
                        _finish_missing_transcript_after_grace(turn_id),
                        name=f"location-command-final-transcript-{turn_id}",
                    )

    await websocket.send_text(
        _safe_json({"relayAccepted": {"protocolVersion": LOCATION_COMMAND_PROTOCOL_VERSION}})
    )
    config = _location_command_live_config(genai_types)
    # These tasks deliberately have different result types (browser/provider
    # pumps versus the close event), but share one shutdown path.
    browser_task: asyncio.Task[Any] | None = None
    provider_task: asyncio.Task[Any] | None = None
    closing_task: asyncio.Task[Any] | None = None
    try:
        async with client.aio.live.connect(model=model, config=config) as session:
            if not _provider_setup_observed(session):
                raise RuntimeError("provider_setup_incomplete")
            provider_ready.set()
            await websocket.send_text(_safe_json({"providerReady": {}}))
            await _send_ready_if_possible()
            browser_task = asyncio.create_task(
                _pump_browser(session), name="location-command-browser"
            )
            provider_task = asyncio.create_task(
                _pump_provider(session), name="location-command-provider"
            )
            closing_task = asyncio.create_task(closing.wait(), name="location-command-close")
            done, pending = await asyncio.wait(
                {browser_task, provider_task, closing_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if provider_task in done and not closing.is_set():
                await _fail_active_turn(
                    "provider_unavailable", session_reason="provider_unavailable"
                )
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            for task in done:
                if task is closing_task:
                    continue
                with suppress(asyncio.CancelledError):
                    error = task.exception()
                    if error is not None:
                        raise error
    except WebSocketDisconnect:
        return
    except Exception as error:  # noqa: BLE001 - raw provider details remain server-only
        logger.info(
            "location_command_relay_provider_failure classification=%s",
            classify_provider_error(error),
        )
        await _fail_active_turn("provider_unavailable", session_reason="provider_unavailable")
    finally:
        if missing_transcript_task is not None:
            missing_transcript_task.cancel()
            with suppress(asyncio.CancelledError):
                await missing_transcript_task
        for shutdown_task in (browser_task, provider_task, closing_task):
            if shutdown_task is not None and not shutdown_task.done():
                shutdown_task.cancel()
        await asyncio.gather(
            *(task for task in (browser_task, provider_task, closing_task) if task is not None),
            return_exceptions=True,
        )


@router.websocket("/live")
async def location_command_live_relay(websocket: WebSocket) -> None:
    """Authenticated managed-Vertex Location command socket.

    The existing short-lived relay ticket is intentionally reused: it is
    signed, expires quickly, and is consumed once across instances.  This
    route adds no client credential or provider selection authority; its
    exact protocol bootstrap scopes the ticket to this command session.
    """

    await websocket.accept()
    dependencies = _load_location_command_dependencies()
    if not one_voice_enabled() or not _command_rollout_enabled(dependencies):
        await _close_quietly(websocket, code=1013, reason="Location commands are unavailable.")
        return
    try:
        await _receive_bootstrap(websocket)
    except ValueError:
        await _close_quietly(
            websocket, code=1008, reason="Location command setup was not accepted."
        )
        return

    relay_ticket = websocket.query_params.get("relay_ticket") or ""
    accepted, uid, _tier = await consume_relay_ticket_shared(relay_ticket)
    if not accepted or not uid:
        await _close_quietly(
            websocket, code=1008, reason="Location command authentication is required."
        )
        return
    if dependencies is None:  # defensive: rollout gate above already rejects this case
        await _close_quietly(websocket, code=1013, reason="Location commands are unavailable.")
        return
    try:
        configured_model = dependencies.transcribe_model()
    except Exception:  # noqa: BLE001 - runtime deployment mismatch
        configured_model = ""
    if configured_model != LOCATION_COMMAND_TRANSCRIBE_MODEL:
        await _close_quietly(websocket, code=1013, reason="Location commands are unavailable.")
        return
    try:
        selected = await _select_managed_transcribe_client(uid=uid, relay_ticket=relay_ticket)
    except Exception:  # noqa: BLE001 - capacity configuration remains server-only
        selected = None
    if selected is None:
        await _close_quietly(websocket, code=1013, reason="Location commands are unavailable.")
        return
    client, selection, pool = selected
    try:
        await _run_location_command_relay(
            websocket,
            uid=uid,
            client=client,
            model=selection.model,
            dependencies=dependencies,
        )
    except Exception as error:  # noqa: BLE001 - breaker only sees setup class
        with suppress(Exception):
            await pool.record_setup_failure(selection, error)
        raise
    else:
        # The provider setup was observed inside the relay.  A later socket
        # boundary is not a capacity-selection failure for a future session.
        with suppress(Exception):
            await pool.record_setup_success(selection)


__all__ = [
    "LOCATION_COMMAND_PROTOCOL_VERSION",
    "LOCATION_COMMAND_TRANSCRIBE_MODEL",
    "_CommandRuntimeDependencies",
    "_command_rollout_enabled",
    "_location_command_live_config",
    "_run_location_command_relay",
    "_select_managed_transcribe_client",
    "router",
]
