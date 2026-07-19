"""One ADK live relay: the Runner-driven voice endpoint.

Replaces the hand-rolled google-genai Live pump with ADK's ``Runner.run_live``.
Why this fixes the "random commands" class of bugs by construction:

- ONE decision-maker: One's root ``LlmAgent`` decides conversation vs tool
  call inside ADK's own flow. There is no client-side lexical re-ranker and
  no separately-timed action-proposal frame to race the transcript.
- Turn correlation: ``run_live`` yields a single ordered ``Event`` stream per
  invocation; audio, transcriptions, and function calls share the same
  ordered channel instead of arriving as uncorrelated WebSocket frames.
- Real interruption: interrupted turns surface as ``event.interrupted`` from
  the provider, not a locally-echoed acknowledgement.

Wire protocol (browser-facing) preserves the established relay envelope after
one new authenticated bootstrap frame. The frame selects managed or BYOK
runtime mode before the runner/session exists; it never becomes model context:

  browser -> server: {"type": "runtime_bootstrap", "runtime_credential_mode": ...}
                     {"realtimeInput": {"audio": {"data": b64, "mimeType"}}}
                     {"type": "app_context", "appContext": {...}}   (context)
                     {"type": "action_settled", "actionSettlement": {...}}
                     {"type": "app_speech", "text": ...}            (say this)
                     {"type": "interrupt"}                          (stop talking)
  server -> browser: {"setupComplete": {}}
                     {"serverContent": {"modelTurn": {"parts": [...]}}}
                     {"serverContent": {"interrupted": true}}
                     {"serverContent": {"turnComplete": true}}
                     {"inputTranscription": {"text": ...}}
                     {"outputTranscription": {"text": ...}}

Auth mirrors the legacy relay: a short-lived signed relay ticket minted over
HTTPS (POST /api/one/adk/relay-session), consumed once by the WebSocket.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
import secrets
import uuid
from typing import Any, Literal, Optional

from fastapi import (
    APIRouter,
    Header,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from pydantic import BaseModel, Field

from api.middlewares.rate_limit import RateLimits, limiter
from api.routes.one.live_context import (
    bounded_text,
    compose_route_context_note,
    sanitize_action_settlement,
    sanitize_live_context,
)
from api.routes.one.relay_auth import (
    consume_relay_ticket_shared,
    issue_relay_ticket,
    one_voice_enabled,
    resolve_optional_uid,
    resolve_persona_tier,
)
from hushh_mcp.one_adk.agent_tree import (
    ONE_APP_NAME,
    STATE_CONSENT_TOKEN,
    STATE_PENDING_DIRECTIVE,
    STATE_SCREEN,
    STATE_TIMEZONE,
    STATE_USER_ID,
    STATE_VOICE_CONTEXT,
    build_one_live_runner,
)

logger = logging.getLogger(__name__)

# Back-compat aliases for the extracted trust boundary (live_context.py).
_bounded_text = bounded_text
_compose_route_context_note = compose_route_context_note
_sanitize_action_settlement = sanitize_action_settlement
_sanitize_live_context = sanitize_live_context

router = APIRouter(prefix="/api/one/adk", tags=["One ADK"])

# Screens where a person is actively moving through account setup. On these
# screens a screen change is a hand-off moment (they just landed somewhere
# new mid-flow), so the injected note instructs a concrete spoken next-step
# question instead of staying silent - the rest of the app gets the neutral
# silent note so One does not narrate ordinary browsing.
_ONBOARDING_SCREENS = frozenset(
    {
        "getting_started",
        "one_intro",
        "login",
        "register_phone",
        "one_setup",
        "one_setup_hub",
        "kai_setup_wizard",
    }
)

_INPUT_MIME_DEFAULT = "audio/pcm;rate=16000"
_OUTPUT_MIME = "audio/pcm;rate=24000"
_INITIAL_GREETING_IDLE_SECONDS = 1.5
# Bounded wait for the first app_context frame before run_live opens. Audio
# is buffered by LiveRequestQueue during the wait; raising this trades a few
# hundred ms of first-response latency on slow clients for a correct action
# inventory on the first turn (the 1.0s original lost the race on cold
# connects and produced blanket action_unavailable refusals).
_INITIAL_CONTEXT_WAIT_SECONDS = 2.5
_RUNTIME_BOOTSTRAP_WAIT_SECONDS = 6.0
_RUNTIME_BOOTSTRAP_CREDENTIAL_CAP = 12_000
_VERTEX_PROJECT_RE = re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$")
_VERTEX_LOCATION_RE = re.compile(r"^(?:global|[a-z]+-[a-z]+[0-9]+)$")


async def _receive_runtime_bootstrap(
    websocket: WebSocket,
    *,
    uid: str | None,
) -> tuple[
    Literal["hushh_managed_vertex", "byok"],
    str | None,
    Literal["developer_api", "vertex_api_key"],
    str | None,
    str | None,
]:
    """Read the one non-model-visible startup frame.

    A raw BYOK credential crosses TLS only in this first WebSocket message. It
    is not added to session state, context, queues, tickets, telemetry, or
    errors. The caller must discard its local reference after runner creation.
    """
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), _RUNTIME_BOOTSTRAP_WAIT_SECONDS)
        message = json.loads(raw)
    except (asyncio.TimeoutError, WebSocketDisconnect, TypeError, ValueError):
        raise ValueError("runtime_bootstrap_required") from None
    if not isinstance(message, dict) or message.get("type") != "runtime_bootstrap":
        raise ValueError("runtime_bootstrap_required")
    mode = message.get("runtime_credential_mode")
    if mode == "hushh_managed_vertex":
        # Never accept a credential in managed mode, even if a buggy client
        # supplied one. This keeps the startup contract unambiguous.
        if message.get("runtime_credential") not in (None, ""):
            raise ValueError("runtime_bootstrap_invalid")
        return "hushh_managed_vertex", None, "developer_api", None, None
    if mode != "byok" or not uid:
        raise ValueError("runtime_bootstrap_invalid")
    credential = message.get("runtime_credential")
    if not isinstance(credential, str):
        raise ValueError("runtime_bootstrap_invalid")
    credential = credential.strip()
    if not credential or len(credential) > _RUNTIME_BOOTSTRAP_CREDENTIAL_CAP:
        raise ValueError("runtime_bootstrap_invalid")
    transport = message.get("runtime_credential_transport")
    if transport not in {"developer_api", "vertex_api_key"}:
        raise ValueError("runtime_bootstrap_invalid")
    project = str(message.get("runtime_vertex_project") or "").strip()
    location = str(message.get("runtime_vertex_location") or "").strip()
    if transport == "vertex_api_key":
        if not _VERTEX_PROJECT_RE.fullmatch(project) or not _VERTEX_LOCATION_RE.fullmatch(location):
            raise ValueError("runtime_bootstrap_invalid")
        return "byok", credential, "vertex_api_key", project, location
    if project or location:
        raise ValueError("runtime_bootstrap_invalid")
    return "byok", credential, "developer_api", None, None


class _InitialGreetingGate:
    """Own one initial cue without allowing it to overtake visitor speech.

    The browser sends ``voice_activity_start`` only after local speech activity
    crosses its bounded threshold. That explicit, transcript-free signal lets
    the relay cancel an idle cue without guessing from continuous microphone
    frames (which include silence). The epoch makes a delayed task harmless if
    cancellation races with its timer.
    """

    def __init__(self) -> None:
        self._epoch = 0
        self._visitor_activity_seen = False
        self._greeting_sent = False

    def schedule(self) -> int | None:
        if self._visitor_activity_seen or self._greeting_sent:
            return None
        self._epoch += 1
        return self._epoch

    def cancel_for_visitor_activity(self) -> None:
        self._visitor_activity_seen = True
        self._epoch += 1

    def may_send(self, epoch: int) -> bool:
        return not self._visitor_activity_seen and not self._greeting_sent and epoch == self._epoch

    def mark_sent(self, epoch: int) -> bool:
        if not self.may_send(epoch):
            return False
        self._greeting_sent = True
        return True


class OneAdkRelaySessionResponse(BaseModel):
    relay_ticket: str = Field(..., max_length=4096)
    expires_at: int = Field(..., ge=0)
    model: str = Field(default="adk", max_length=128)
    tier: str = Field(..., max_length=16)


@router.post("/relay-session", response_model=OneAdkRelaySessionResponse)
@limiter.limit(RateLimits.AGENT_CHAT)
async def create_one_adk_relay_session(
    request: Request,
    authorization: Optional[str] = Header(default=None),
) -> OneAdkRelaySessionResponse:
    """Mint a short-lived relay ticket for the One ADK live WebSocket."""
    if not one_voice_enabled():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="One voice is not enabled.",
        )
    uid = await resolve_optional_uid(authorization)
    persona_tier = resolve_persona_tier(uid, None)
    ticket, expires_at = issue_relay_ticket(uid, persona_tier)
    return OneAdkRelaySessionResponse(
        relay_ticket=ticket,
        expires_at=expires_at,
        tier="full" if uid else "intro",
    )


def _event_audio_parts(event: Any) -> list[dict[str, Any]]:
    """Extract browser-envelope parts (audio inline data + text) from an event."""
    parts: list[dict[str, Any]] = []
    content = getattr(event, "content", None)
    if content is None or not getattr(content, "parts", None):
        return parts
    for part in content.parts:
        inline = getattr(part, "inline_data", None)
        if inline is not None and getattr(inline, "data", None):
            parts.append(
                {
                    "inlineData": {
                        "mimeType": getattr(inline, "mime_type", None) or _OUTPUT_MIME,
                        "data": base64.b64encode(inline.data).decode("ascii"),
                    }
                }
            )
        elif getattr(part, "text", None):
            parts.append({"text": part.text})
    return parts


@router.websocket("/live")
async def one_adk_live_relay(websocket: WebSocket) -> None:
    """Bridge the browser wire protocol onto Runner.run_live."""
    from google.adk.agents.live_request_queue import LiveRequestQueue
    from google.adk.agents.run_config import RunConfig, StreamingMode
    from google.adk.events import Event as AdkEvent
    from google.adk.events import EventActions
    from google.genai import types as genai_types

    await websocket.accept()

    if not one_voice_enabled():
        await websocket.close(code=1011, reason="One voice is not enabled.")
        return

    relay_ticket = websocket.query_params.get("relay_ticket")
    # Shared consumer: nonce single-use holds across workers and instances
    # (Postgres registry, migration 084; Redis swap seam documented there).
    accepted, uid, _persona_tier = await consume_relay_ticket_shared(relay_ticket)
    if not accepted:
        await websocket.close(code=1008, reason="Voice relay ticket is expired.")
        return

    try:
        (
            runtime_mode,
            runtime_credential,
            runtime_credential_transport,
            runtime_vertex_project,
            runtime_vertex_location,
        ) = await _receive_runtime_bootstrap(websocket, uid=uid)
        runner = build_one_live_runner(
            runtime_mode=runtime_mode,
            runtime_credential=runtime_credential,
            runtime_credential_transport=runtime_credential_transport,
            runtime_vertex_project=runtime_vertex_project,
            runtime_vertex_location=runtime_vertex_location,
        )
    except ValueError as exc:
        # Safe class-only close reasons. Never reflect the credential or a raw
        # provider response to the browser, logger, telemetry, or websocket.
        reason = str(exc)
        if reason == "byok_live_unsupported":
            await websocket.close(code=1008, reason="BYOK Live is unavailable. Use managed Gemini.")
        else:
            await websocket.close(code=1008, reason="Voice session configuration was not accepted.")
        return
    finally:
        # Keep the raw key alive only through connection-local runner creation.
        runtime_credential = None
        runtime_vertex_project = None
        runtime_vertex_location = None
    # Ephemeral per-connection session; durable records live in app stores.
    session_user = uid or f"anon_{secrets.token_hex(8)}"
    session_id = f"voice_{uuid.uuid4().hex}"
    session = await runner.session_service.create_session(
        app_name=ONE_APP_NAME,
        user_id=session_user,
        session_id=session_id,
        state={
            STATE_USER_ID: uid or "",
            # Consent tokens arrive via the first app_context frame (they are
            # never placed in URLs); tools fail closed until then.
            STATE_CONSENT_TOKEN: "",
            STATE_TIMEZONE: "",
            # Live sessions start with an explicit pending marker so action
            # tools can distinguish "browser context not yet arrived" (report
            # context_not_ready, recoverable) from a non-live caller with no
            # voice context at all (compat-permissive). The first app_context
            # frame replaces this marker with the sanitized context.
            STATE_VOICE_CONTEXT: {"context_pending": True},
        },
    )

    queue = LiveRequestQueue()
    run_config = RunConfig(
        streaming_mode=StreamingMode.BIDI,
        response_modalities=[genai_types.Modality.AUDIO],
        input_audio_transcription=genai_types.AudioTranscriptionConfig(),
        output_audio_transcription=genai_types.AudioTranscriptionConfig(),
    )

    await websocket.send_text(json.dumps({"setupComplete": {}}))

    # A signed-in uid means a known/returning person; no uid is a fresh,
    # not-yet-authenticated visitor who is (or is about to be) in onboarding.
    is_fresh_visitor = not uid

    # The initial cue is screen-aware and idle-only. It is deliberately not
    # enqueued synchronously with the first app_context because the browser's
    # microphone follows that frame; doing so placed a visitor command behind
    # One's greeting in LiveRequestQueue. A redacted transport activity frame
    # now cancels the cue before it reaches the model.
    greeting_gate = _InitialGreetingGate()
    greeting_task: Optional[asyncio.Task[None]] = None

    def _compose_greeting_prompt(screen: str, playbook: dict[str, Any] | None) -> str:
        entry_cue = _bounded_text(playbook.get("entry_cue"), 240) if playbook else ""
        proactive = bool(playbook and playbook.get("proactivity") == "on_entry" and entry_cue)
        onboarding = (screen in _ONBOARDING_SCREENS) or is_fresh_visitor
        if onboarding:
            return (
                "[Session start - not user speech] This is a NEW visitor who is "
                "just arriving to get set up. You are One, their private agent: "
                "the relationship layer where they own their context, grant "
                "consent, and summon specialists (like Kai for finance) to get "
                "things done. Greet them warmly in one short sentence, welcome "
                "them in for the first time, and gently invite them to begin "
                "getting set up. Do NOT greet them as if they were returning (no "
                "'welcome back', no 'back again'). If a screen is known, call "
                "list_app_actions for the current screen first and name the one "
                "next thing they can do here; ask for what you need in the same "
                "breath. Do not list capabilities and do not ask more than one "
                "light question. If their next reply is a short challenge or "
                "follow-up such as 'so what?' or 'why?', answer the value "
                "question directly before mentioning setup. "
                + (
                    f"The checked-in route cue is: {entry_cue} Use that active-screen "
                    "guidance instead of an identity-only greeting."
                    if proactive
                    else ""
                )
            )
        return (
            "[Session start - not user speech] Greet the user right now in one "
            "short, warm sentence as One. Vary your greeting naturally between "
            "sessions; do not repeat a stock phrase, do not list capabilities, "
            "and do not ask more than one light question."
        )

    def _send_greeting(screen: str, playbook: dict[str, Any] | None, epoch: int) -> None:
        if not greeting_gate.mark_sent(epoch):
            return
        queue.send_content(
            genai_types.Content(
                role="user",
                parts=[genai_types.Part(text=_compose_greeting_prompt(screen, playbook))],
            )
        )

    def _cancel_pending_greeting() -> None:
        nonlocal greeting_task
        if greeting_task is not None and not greeting_task.done():
            greeting_task.cancel()

    def _schedule_idle_greeting(screen: str, playbook: dict[str, Any] | None = None) -> None:
        nonlocal greeting_task
        _cancel_pending_greeting()
        epoch = greeting_gate.schedule()
        if epoch is None:
            return

        async def _send_after_idle() -> None:
            try:
                await asyncio.sleep(_INITIAL_GREETING_IDLE_SECONDS)
            except asyncio.CancelledError:
                return
            _send_greeting(screen, playbook, epoch)

        greeting_task = asyncio.create_task(_send_after_idle())

    # If the browser never publishes context and the visitor remains idle, a
    # short generic cue is still available. The first context replaces it with
    # a screen-aware cue rather than sending two turns.
    _schedule_idle_greeting("")

    # Last screen injected as model-visible context. Screen changes arrive as
    # app_context frames; sending content mid-generation PREEMPTS the model's
    # current turn on the Live API, so screen text is injected only when the
    # screen truly changed (never for the first frame; session state already
    # carries it for tools).
    last_injected_route_key: Optional[str] = None
    first_app_context_seen = False
    # Action outcomes are accepted only when they match a directive forwarded
    # on this same authenticated WebSocket. This keeps arbitrary browser
    # frames from becoming model-visible completion claims.
    issued_action_directives: dict[str, str] = {}
    # Every directive timeout is scoped to this WebSocket. It must be cancelled
    # on the matching browser settlement and on disconnect; otherwise an old
    # turn can inject ui_timeout into a later/closed voice conversation.
    issued_directive_gc_tasks: dict[str, asyncio.Task[None]] = {}
    issued_goal_directives: dict[str, str] = {}
    issued_goal_runs: dict[str, dict[str, Any]] = {}
    awaiting_goal_context: set[str] = set()
    initial_context_ready = asyncio.Event()

    async def pump_browser_to_queue() -> None:
        nonlocal last_injected_route_key, first_app_context_seen
        while True:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
            except (TypeError, ValueError):
                continue
            if message.get("type") == "interrupt" or message.get("interrupt") is True:
                # Real interruption: close the current activity window. The
                # model treats activity_end as end-of-input and the next
                # audio frame starts a fresh turn.
                queue.send_activity_end()
                await websocket.send_text(json.dumps({"serverContent": {"interrupted": True}}))
                continue
            if message.get("type") == "app_context" or "appContext" in message:
                context_payload = message.get("appContext")
                if not isinstance(context_payload, dict):
                    context_payload = {}
                # Governed credentials ride in session state for tools only.
                # The session object here is a service-returned copy, so state
                # must be persisted through append_event (state_delta), never
                # by mutating session.state directly.
                state_delta: dict[str, Any] = {}
                if "consent_token" in context_payload:
                    consent_token = context_payload.get("consent_token")
                    state_delta[STATE_CONSENT_TOKEN] = _bounded_text(consent_token, 4096)
                timezone_name = context_payload.get("timezone")
                if isinstance(timezone_name, str) and timezone_name.strip():
                    state_delta[STATE_TIMEZONE] = timezone_name.strip()[:64]
                # Full UI snapshots never reach the model prompt. Action tools
                # read this bounded redacted state when deciding what can be
                # proposed or executed on the current screen.
                sanitized_context = _sanitize_live_context(context_payload)
                state_delta[STATE_VOICE_CONTEXT] = sanitized_context
                canonical_screen = sanitized_context.get("screen")
                if isinstance(canonical_screen, str) and canonical_screen:
                    state_delta[STATE_SCREEN] = canonical_screen
                if state_delta:
                    await runner.session_service.append_event(
                        session,
                        AdkEvent(
                            author="user",
                            invocation_id="app_context",
                            actions=EventActions(state_delta=state_delta),
                        ),
                    )
                initial_context_ready.set()
                clean_screen = canonical_screen if isinstance(canonical_screen, str) else ""
                is_first = not first_app_context_seen
                if is_first:
                    # The first context establishes the entry screen. Keep the
                    # cue idle-only so visitor speech always owns the first
                    # actionable turn.
                    _schedule_idle_greeting(
                        clean_screen,
                        sanitized_context.get("route_playbook"),
                    )
                if clean_screen:
                    interaction_layer = sanitized_context.get("interaction_layer")
                    layer_key = (
                        ":".join(
                            [
                                str(interaction_layer.get("layer_id") or ""),
                                str(interaction_layer.get("lifecycle_state") or ""),
                            ]
                        )
                        if isinstance(interaction_layer, dict)
                        else ""
                    )
                    action_key = ",".join(
                        str(value) for value in sanitized_context.get("available_action_ids", [])
                    )
                    route_key = ":".join(
                        [
                            str(sanitized_context.get("route_pattern") or ""),
                            clean_screen,
                            str(sanitized_context.get("route_instruction_id") or ""),
                            action_key,
                            layer_key,
                        ]
                    )
                    changed = route_key != last_injected_route_key
                    last_injected_route_key = route_key
                    if changed and not is_first:
                        note_text = _compose_route_context_note(sanitized_context)
                        if note_text:
                            queue.send_content(
                                genai_types.Content(
                                    role="user",
                                    parts=[genai_types.Part(text=note_text)],
                                )
                            )
                first_app_context_seen = True
                if (
                    "goal.analysis.start_debate" in awaiting_goal_context
                    and clean_screen == "kai_analysis"
                ):
                    awaiting_goal_context.discard("goal.analysis.start_debate")
                    queue.send_content(
                        genai_types.Content(
                            role="user",
                            parts=[
                                genai_types.Part(
                                    text=(
                                        "[Goal runner - not user speech] Analysis route has settled "
                                        "with fresh app context. Call continue_app_goal now to open "
                                        "the requested preview; do not start a debate."
                                    )
                                )
                            ],
                        )
                    )
                continue
            if message.get("type") == "voice_activity_start":
                # The browser emits this once after local speech activity, not
                # on raw microphone frames. It is transport control only: no
                # transcript, page information, or intent is trusted here.
                greeting_gate.cancel_for_visitor_activity()
                _cancel_pending_greeting()
                queue.send_activity_start()
                continue
            if message.get("type") == "action_settled":
                settlement = _sanitize_action_settlement(
                    message.get("actionSettlement"), issued_action_directives
                )
                if settlement is None:
                    logger.info("one_adk_live_invalid_action_settlement")
                    continue
                directive_gc_task = issued_directive_gc_tasks.pop(settlement["directive_id"], None)
                if directive_gc_task is not None:
                    directive_gc_task.cancel()
                logger.info(
                    "one_adk_live_action_settled action=%s directive=%s status=%s",
                    settlement["action_id"],
                    settlement["directive_id"],
                    settlement["status"],
                )
                goal_id = issued_goal_directives.pop(settlement["directive_id"], None)
                if (
                    goal_id == "goal.analysis.start_debate"
                    and settlement["action_id"] == "route.kai_analysis"
                    and settlement["status"] in {"succeeded", "started"}
                ):
                    awaiting_goal_context.add(goal_id)
                settlement_state_delta: dict[str, Any] = {
                    "hussh:last_action_settlement": settlement
                }
                goal_run = issued_goal_runs.get(settlement["directive_id"])
                if goal_run is not None and settlement["action_id"] == "analysis.start":
                    issued_goal_runs.pop(settlement["directive_id"], None)
                    settlement_state_delta["hussh:goal_run"] = {
                        **goal_run,
                        "step_cursor": 2,
                        "status": (
                            "completed"
                            if settlement["status"] in {"succeeded", "started"}
                            else "blocked"
                        ),
                    }
                await runner.session_service.append_event(
                    session,
                    AdkEvent(
                        author="user",
                        invocation_id="action_settled",
                        actions=EventActions(state_delta=settlement_state_delta),
                    ),
                )
                # This is an app execution report, never user speech. The
                # wording forces a grounded follow-up rather than a fabricated
                # success claim and provides the next link in a chained turn.
                queue.send_content(
                    genai_types.Content(
                        role="user",
                        parts=[
                            genai_types.Part(
                                text=(
                                    "[App action settlement - not user speech] "
                                    f"Action '{settlement['action_id']}' reported "
                                    f"status '{settlement['status']}'. Summary: "
                                    f"{settlement['summary']}. "
                                    "Acknowledge only this reported outcome. If it "
                                    "was blocked or failed, explain the next safe "
                                    "step; do not claim the action succeeded."
                                )
                            )
                        ],
                    )
                )
                continue
            if message.get("type") == "app_speech" or "appSpeech" in message:
                text = message.get("text")
                if isinstance(text, str) and text.strip():
                    queue.send_content(
                        genai_types.Content(
                            role="user",
                            parts=[
                                genai_types.Part(
                                    text=(
                                        "Speak exactly this app-composed response and "
                                        f"do not add anything: {text.strip()}"
                                    )
                                )
                            ],
                        )
                    )
                continue
            if message.get("type") == "user_text":
                # Typed user turn (chat parity / accessibility): a real user
                # message, NOT app-composed speech.
                text = message.get("text")
                if isinstance(text, str) and text.strip():
                    greeting_gate.cancel_for_visitor_activity()
                    _cancel_pending_greeting()
                    queue.send_content(
                        genai_types.Content(
                            role="user",
                            parts=[genai_types.Part(text=text.strip()[:4000])],
                        )
                    )
                continue
            realtime = message.get("realtimeInput")
            if not isinstance(realtime, dict):
                continue
            audio = realtime.get("audio")
            if not isinstance(audio, dict):
                continue
            data = audio.get("data")
            if not isinstance(data, str) or not data:
                continue
            mime = audio.get("mimeType") or _INPUT_MIME_DEFAULT
            queue.send_realtime(genai_types.Blob(data=base64.b64decode(data), mime_type=mime))

    async def pump_events_to_browser() -> None:
        # ADK evaluates a callable system instruction when run_live opens.
        # Wait for the browser's first bounded app_context so the active
        # server-resolved playbook AND the executable-action inventory are
        # present for the first real turn. LiveRequestQueue retains queued
        # audio during this wait, so nothing the visitor says is lost. A
        # too-short window here made the first turn run with an empty
        # inventory, so every requested action was refused as unavailable.
        try:
            await asyncio.wait_for(
                initial_context_ready.wait(), timeout=_INITIAL_CONTEXT_WAIT_SECONDS
            )
        except TimeoutError:
            # Legacy/context-free clients still start; tools see an absent
            # voice context and report context_not_ready instead of refusing.
            logger.info("one_adk_live_started_without_initial_context")
        async for event in runner.run_live(
            user_id=session_user,
            session_id=session_id,
            live_request_queue=queue,
            run_config=run_config,
        ):
            if getattr(event, "interrupted", False):
                await websocket.send_text(json.dumps({"serverContent": {"interrupted": True}}))
            input_tx = getattr(event, "input_transcription", None)
            if input_tx is not None and getattr(input_tx, "text", None):
                if not getattr(event, "partial", False):
                    await websocket.send_text(
                        json.dumps({"inputTranscription": {"text": input_tx.text}})
                    )
            output_tx = getattr(event, "output_transcription", None)
            if output_tx is not None and getattr(output_tx, "text", None):
                if not getattr(event, "partial", False):
                    await websocket.send_text(
                        json.dumps({"outputTranscription": {"text": output_tx.text}})
                    )
            parts = _event_audio_parts(event)
            if parts:
                await websocket.send_text(
                    json.dumps({"serverContent": {"modelTurn": {"parts": parts}}})
                )
            # Tools park client directives (navigation etc.) in their event's
            # state_delta; forward each exactly once, ordered with the stream.
            # KNOWN LIMIT (verified against ADK): when a model turn makes
            # PARALLEL tool calls, ADK deep-merges every call's state_delta
            # into ONE merged event, so at most one pending directive survives
            # per turn. The system instruction therefore requires at most one
            # action-producing tool call per turn; do not rely on two parallel
            # run_app_action calls both reaching the browser.
            actions = getattr(event, "actions", None)
            delta = getattr(actions, "state_delta", None) or {}

            directives_to_issue = []
            for key in list(delta.keys()):
                if key.startswith(f"{STATE_PENDING_DIRECTIVE}:"):
                    directive = delta.pop(key)
                    if isinstance(directive, dict) and directive:
                        directives_to_issue.append(directive)

            for directive in directives_to_issue:
                outgoing_directive = directive
                payload = directive.get("payload")
                if directive.get("kind") == "action" and isinstance(payload, dict):
                    action_id = _bounded_text(payload.get("actionId"), 128)
                    if action_id:
                        directive_id = secrets.token_urlsafe(18)
                        issued_action_directives[directive_id] = action_id
                        goal_id = _bounded_text(payload.get("goalId"), 128)
                        if goal_id:
                            issued_goal_directives[directive_id] = goal_id
                        goal_run = payload.get("goalRun")
                        if isinstance(goal_run, dict):
                            issued_goal_runs[directive_id] = goal_run
                        outgoing_directive = {
                            **directive,
                            "payload": {**payload, "directiveId": directive_id},
                        }
                        logger.info(
                            "one_adk_live_directive_issued action=%s directive=%s",
                            action_id,
                            directive_id,
                        )

                        async def _gc_directive(did: str, aid: str):
                            try:
                                # Client route settlement can legitimately take
                                # longer than the former 15-second race window.
                                await asyncio.sleep(20)
                                if did not in issued_action_directives:
                                    return
                                issued_action_directives.pop(did, None)
                                logger.warning(
                                    "one_adk_live_directive_timeout action=%s directive=%s",
                                    aid,
                                    did,
                                )
                                settlement = {
                                    "action_id": aid,
                                    "directive_id": did,
                                    "status": "failed",
                                    "summary": "ui_timeout",
                                }
                                await runner.session_service.append_event(
                                    session,
                                    AdkEvent(
                                        author="system",
                                        invocation_id="action_settled",
                                        actions=EventActions(
                                            state_delta={"hussh:last_action_settlement": settlement}
                                        ),
                                    ),
                                )
                                queue.send_content(
                                    genai_types.Content(
                                        role="user",
                                        parts=[
                                            genai_types.Part(
                                                text=(
                                                    "[App action settlement - not user speech] "
                                                    f"Action '{aid}' reported "
                                                    f"status 'failed'. Summary: "
                                                    f"ui_timeout. "
                                                    "Acknowledge only this reported outcome. If it "
                                                    "was blocked or failed, explain the next safe "
                                                    "step; do not claim the action succeeded."
                                                )
                                            )
                                        ],
                                    )
                                )
                            except asyncio.CancelledError:
                                raise
                            finally:
                                issued_directive_gc_tasks.pop(did, None)

                        issued_directive_gc_tasks[directive_id] = asyncio.create_task(
                            _gc_directive(directive_id, action_id)
                        )

                await websocket.send_text(json.dumps({"clientDirective": outgoing_directive}))

            if getattr(event, "turn_complete", False):
                await websocket.send_text(json.dumps({"serverContent": {"turnComplete": True}}))

    up = asyncio.create_task(pump_browser_to_queue())
    down = asyncio.create_task(pump_events_to_browser())
    try:
        done, pending = await asyncio.wait({up, down}, return_when=asyncio.FIRST_EXCEPTION)
        for task in done:
            task_error = task.exception()
            if task_error is not None and not isinstance(task_error, WebSocketDisconnect):
                logger.warning(
                    "one_adk_live_relay_pump_failed error=%s", task_error.__class__.__name__
                )
    except WebSocketDisconnect:
        pass
    finally:
        up.cancel()
        down.cancel()
        for directive_gc_task in issued_directive_gc_tasks.values():
            directive_gc_task.cancel()
        if issued_directive_gc_tasks:
            await asyncio.gather(*issued_directive_gc_tasks.values(), return_exceptions=True)
        issued_directive_gc_tasks.clear()
        if greeting_task is not None:
            greeting_task.cancel()
        queue.close()
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001 - already closed
            pass
        # Ephemeral session cleanup: without this, InMemorySessionService
        # accumulates one session per voice connection until process restart.
        try:
            await runner.session_service.delete_session(
                app_name=ONE_APP_NAME, user_id=session_user, session_id=session_id
            )
        except Exception:  # noqa: BLE001 - cleanup is best-effort
            logger.debug("one_adk_live_session_cleanup_skipped session_id=%s", session_id)
