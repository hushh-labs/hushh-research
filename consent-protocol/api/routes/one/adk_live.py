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
import binascii
import json
import logging
import re
import secrets
import time
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
from hushh_mcp.services.action_directive_ledger import (
    ActionDirectiveAuthorityError,
    get_action_directive_store,
)
from hushh_mcp.services.action_gateway import get_action_gateway_action
from hushh_mcp.services.live_voice_context import (
    clear_live_voice_context,
    publish_live_voice_context,
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
_RESUMPTION_HANDLE_CAP = 4_096
_MAX_BROWSER_FRAME_CHARS = 1_000_000
_MAX_REALTIME_AUDIO_BYTES = 512 * 1024
_MAX_REALTIME_AUDIO_BASE64_CHARS = ((_MAX_REALTIME_AUDIO_BYTES + 2) // 3) * 4
_VERTEX_PROJECT_RE = re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$")
_VERTEX_LOCATION_RE = re.compile(r"^(?:global|[a-z]+-[a-z]+[0-9]+)$")


# A navigate-then-act journey is TWO tool calls, and only the first one is
# One's own idea. `start_app_goal` issues the route step and answers
# `navigation_started`; the action the person actually asked for has not run,
# so its result does not exist yet. `continue_app_goal` is the only thing that
# runs it, and nothing in the protocol calls it on One's behalf -- so a journey
# whose navigation lands and is never continued just stops, looking in the log
# exactly like one that finished.
_GOAL_CONTINUATION_NOTE = (
    "[Goal runner - not user speech] The journey's destination screen has settled with "
    "fresh app context. Call continue_app_goal now; it is the only thing that runs the "
    "step you started. Do not describe what that step found and do not ask a question "
    "about it yet -- its own settlement report is what tells you the outcome."
)


def _is_navigation_step_settlement(goal_run: Any) -> bool:
    """True when this settlement is a navigate-then-act journey's route step."""
    return (
        isinstance(goal_run, dict)
        and goal_run.get("schema_version") == "one.goal_run.v1"
        and goal_run.get("step_cursor", 0) == 0
    )


def _navigation_continuation_screen(
    goal_id: str | None, goal_run: Any, settlement_status: str
) -> str | None:
    """Screen a navigate-then-act journey must reach before it may continue.

    Returns the destination to wait for, or ``None`` when this settlement is
    not a journey's navigation step. Reading it from the run rather than
    naming a screen keeps every authored journey on one path: this was
    hardcoded to Analysis, which is why the journeys authored after it
    navigated and then stalled with nothing left to move them.
    """
    # Past the navigation step, what settles is the journey's ACTION, whose
    # result is the thing One is waiting on -- never another cue to act.
    if not goal_id or not _is_navigation_step_settlement(goal_run):
        return None
    if settlement_status not in {"succeeded", "started"}:
        return None
    return str(goal_run.get("expected_screen") or "").strip() or None


def _goal_continuation_is_already_ready(
    latest_context: Any, continuation_screen: str | None
) -> bool:
    """Whether the destination context arrived before its route settlement.

    The browser publishes the destination context and waits for its ack before
    it reports the route directive settled. That ordering is valid and must
    release the parked goal without requiring an unrelated later context frame.
    """
    return bool(
        continuation_screen
        and isinstance(latest_context, dict)
        and latest_context.get("screen") == continuation_screen
    )


def _browser_frame_within_bounds(raw: str) -> bool:
    return len(raw) <= _MAX_BROWSER_FRAME_CHARS


def _decode_realtime_audio(data: str) -> bytes | None:
    if not data or len(data) > _MAX_REALTIME_AUDIO_BASE64_CHARS:
        return None
    try:
        decoded = base64.b64decode(data, validate=True)
    except (ValueError, binascii.Error):
        return None
    if len(decoded) > _MAX_REALTIME_AUDIO_BYTES:
        return None
    return decoded


async def _close_quietly(
    websocket: WebSocket, *, code: int = 1000, reason: str | None = None
) -> None:
    """Best-effort close: the browser may already be gone by the time a
    rejection path calls this (tab closed, network drop mid-handshake), which
    hits a known websockets/uvicorn legacy-protocol bug -- close() raises
    AttributeError('transfer_data_task') instead of a clean no-op when the
    connection never finished setting up its transfer task
    (https://github.com/python-websockets/websockets/issues/1396). There is no
    one left to notify either way, so log and move on rather than let a
    disconnected client turn an ordinary rejection into an unhandled
    exception.
    """
    try:
        await websocket.close(code=code, reason=reason or "")
    except Exception:  # noqa: BLE001 - best-effort notification, client may be gone
        logger.debug("one_adk_live_close_failed code=%s", code)


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
    str | None,
]:
    """Read the one non-model-visible startup frame.

    A raw BYOK credential crosses TLS only in this first WebSocket message. It
    is not added to session state, context, queues, tickets, telemetry, or
    errors. The caller must discard its local reference after runner creation.
    """
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), _RUNTIME_BOOTSTRAP_WAIT_SECONDS)
        if not _browser_frame_within_bounds(raw):
            raise ValueError("runtime_bootstrap_invalid")
        message = json.loads(raw)
    except (asyncio.TimeoutError, WebSocketDisconnect, TypeError, ValueError):
        raise ValueError("runtime_bootstrap_required") from None
    if not isinstance(message, dict) or message.get("type") != "runtime_bootstrap":
        raise ValueError("runtime_bootstrap_required")
    # A resumption handle from a previous socket for this same person. It is
    # an opaque provider token, not a credential and not model context: it
    # only lets a dropped conversation continue instead of starting over.
    resumption_handle = str(message.get("resumption_handle") or "").strip()
    if len(resumption_handle) > _RESUMPTION_HANDLE_CAP:
        resumption_handle = ""
    mode = message.get("runtime_credential_mode")
    if mode == "hushh_managed_vertex":
        # Never accept a credential in managed mode, even if a buggy client
        # supplied one. This keeps the startup contract unambiguous.
        if message.get("runtime_credential") not in (None, ""):
            raise ValueError("runtime_bootstrap_invalid")
        return "hushh_managed_vertex", None, "developer_api", None, None, resumption_handle or None
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
        return "byok", credential, "vertex_api_key", project, location, resumption_handle or None
    if project or location:
        raise ValueError("runtime_bootstrap_invalid")
    return "byok", credential, "developer_api", None, None, resumption_handle or None


class _InitialGreetingGate:
    """Own one initial cue without allowing it to overtake visitor speech.

    The browser sends ``voice_activity_start`` only after local speech activity
    crosses its bounded threshold. That explicit, transcript-free signal lets
    the relay cancel an idle cue without guessing from continuous microphone
    frames (which include silence). The epoch makes a delayed task harmless if
    cancellation races with its timer.
    """

    def __init__(self, idle_seconds: float = _INITIAL_GREETING_IDLE_SECONDS) -> None:
        self._epoch = 0
        self._visitor_activity_seen = False
        self._greeting_sent = False
        self._idle_seconds = idle_seconds
        self._deadline: float | None = None

    def hold_seconds(self, now: float) -> float:
        """Seconds still owed before this session's cue may go out.

        The hold is a guard against One talking over someone who opened the
        mic already speaking, so it is owed ONCE per session. Re-arming the
        cue to upgrade its wording once the screen is known must not restart
        it: that charged the person a second full wait for the app context
        arriving, on top of however long the browser took to send it. Past the
        deadline this returns 0 and the cue goes out immediately.
        """
        if self._deadline is None:
            self._deadline = now + self._idle_seconds
        return max(0.0, self._deadline - now)

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
        await _close_quietly(websocket, code=1011, reason="One voice is not enabled.")
        return

    relay_ticket = websocket.query_params.get("relay_ticket")
    # Shared consumer: nonce single-use holds across workers and instances
    # (Postgres registry, migration 084; Redis swap seam documented there).
    accepted, uid, _persona_tier = await consume_relay_ticket_shared(relay_ticket)
    if not accepted:
        logger.info("one_adk_live_relay_ticket_rejected")
        await _close_quietly(websocket, code=1008, reason="Voice relay ticket is expired.")
        return

    try:
        (
            runtime_mode,
            runtime_credential,
            runtime_credential_transport,
            runtime_vertex_project,
            runtime_vertex_location,
            resumption_handle,
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
        logger.info("one_adk_live_runtime_bootstrap_rejected reason=%s", reason)
        if reason == "byok_live_unsupported":
            await _close_quietly(
                websocket, code=1008, reason="BYOK Live is unavailable. Use managed Gemini."
            )
        else:
            await _close_quietly(
                websocket, code=1008, reason="Voice session configuration was not accepted."
            )
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
        # No explicit trigger/target tokens: leaving both unset uses the
        # provider's own defaults for when/how much to compress, per the
        # documented "if not set" fallback on SlidingWindow.target_tokens.
        context_window_compression=genai_types.ContextWindowCompressionConfig(
            sliding_window=genai_types.SlidingWindow(),
        ),
        # Without this a dropped socket ends the conversation outright: a 1011,
        # a network blip, or the provider's own scheduled disconnect all lost
        # everything said so far. The provider issues a handle it will accept
        # back, so a reconnect continues the same conversation instead of
        # restarting it. Passing a handle from the browser resumes; passing
        # none starts fresh and begins issuing handles for next time.
        session_resumption=genai_types.SessionResumptionConfig(
            handle=resumption_handle or None,
        ),
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
    # One deadline for the whole session, set when the cue is first armed. The
    # idle wait exists so visitor speech owns the first turn -- it is a hold
    # against talking over someone, so it is owed ONCE. Re-arming the cue to
    # upgrade its wording used to restart it, which charged the person a second
    # full wait for the app context arriving, on top of however long that took.
    # Nothing measured how long the person actually waits, so "the greeting is
    # slow" could not be attributed: the relay's own hold, the browser taking
    # its time to publish the first context, and the model's first token are
    # three different problems with one symptom.
    session_started_at = time.monotonic()

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
        logger.info(
            "one_adk_live_greeting_queued screen=%s elapsed_ms=%s",
            screen or "none",
            round((time.monotonic() - session_started_at) * 1000),
        )
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
        remaining = greeting_gate.hold_seconds(time.monotonic())

        async def _send_after_idle() -> None:
            try:
                if remaining > 0:
                    await asyncio.sleep(remaining)
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
    last_injected_entry_key: Optional[str] = None
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
    issued_journey_started_at: dict[str, float] = {}
    # Nothing upstream stops the model from calling the same action-producing
    # tool again while an identical directive is still outstanding (the
    # one-tool-call-per-turn rule is a prompt-level ask, not enforced). Each
    # retry used to issue a brand-new directive and push a brand-new
    # clientDirective, which the browser treats as superseding whatever
    # confirmation card is currently up -- so a retrying model could blow away
    # its own still-unanswered proposal before the person had a chance to tap
    # it. Track a fingerprint per outstanding directive (same shape as the
    # browser's own directiveFingerprint()) and skip re-issuing an identical
    # one while it's still open.
    issued_action_fingerprints: dict[str, str] = {}
    # Directives parked with needsConfirmation:false. They raise no card, so
    # they mint no receipt, so the ledger's confirmed-path settle can never
    # close them -- and their settlements were refused, discarding the outcome
    # of nearly every action One runs. Tracked here so those can close on the
    # receipt-less path instead of being dropped.
    issued_direct_run_directives: set[str] = set()
    # goal id -> the destination screen whose arrival releases its continuation.
    awaiting_goal_context: dict[str, str] = {}
    initial_context_ready = asyncio.Event()
    latest_context: dict[str, Any] = {}

    async def _disarm_open_directives() -> None:
        """Cancel loose proposals when fresh user intent supersedes the prior turn.

        Journey steps are deliberately exempt. ``voice_activity_start`` carries
        no transcript and no intent, so it cannot tell "analyse Tesla instead"
        from "did that work?" -- and treating both as supersession silently
        abandoned a multi-step task the person had already asked for, mid-flight.
        A journey now ends only when it completes or when the person explicitly
        stops it (the goal's authored ``cancellation_contract.cancel_action_id``).

        The directive payload carries the generated activation boundary. Only
        browser APIs that require a fresh user gesture retain
        ``trusted_activation_required``; ordinary confirm-required actions can
        be confirmed from the person's own voice transcript.
        """
        for stale_directive_id, stale_action_id in list(issued_action_directives.items()):
            if stale_directive_id in issued_goal_directives:
                logger.info(
                    "one_adk_goal_decision goal=%s status=journey_directive_preserved action=%s",
                    issued_goal_directives[stale_directive_id],
                    stale_action_id,
                )
                continue
            try:
                await get_action_directive_store().cancel_voice(
                    directive_id=stale_directive_id,
                    user_id=session_user,
                    session_id=session_id,
                    action_id=stale_action_id,
                )
            except ActionDirectiveAuthorityError:
                # A terminal/replayed directive is already inert; the browser
                # clears its pending card on the same user-activity event.
                pass
            issued_action_directives.pop(stale_directive_id, None)
            goal_id = issued_goal_directives.pop(stale_directive_id, None)
            if goal_id:
                # Disarming an in-flight journey directive also drops its
                # pending continuation. Speaking while a journey's navigation
                # card is still open therefore cancels the whole journey, which
                # is invisible in the log without this line.
                logger.info(
                    "one_adk_goal_decision goal=%s status=disarmed_by_new_intent action=%s",
                    goal_id,
                    stale_action_id,
                )
                awaiting_goal_context.pop(goal_id, None)
            issued_goal_runs.pop(stale_directive_id, None)
            issued_journey_started_at.pop(stale_directive_id, None)
            issued_action_fingerprints.pop(stale_directive_id, None)
            issued_direct_run_directives.discard(stale_directive_id)
            gc_task = issued_directive_gc_tasks.pop(stale_directive_id, None)
            if gc_task is not None:
                gc_task.cancel()

    async def pump_browser_to_queue() -> None:
        nonlocal last_injected_route_key, last_injected_entry_key
        nonlocal first_app_context_seen, latest_context
        while True:
            raw = await websocket.receive_text()
            if not _browser_frame_within_bounds(raw):
                await _close_quietly(websocket, code=1009, reason="Voice frame is too large.")
                return
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
                context_id = _bounded_text(
                    message.get("contextId") or context_payload.get("context_id"), 128
                )
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
                latest_context = sanitized_context
                state_delta[STATE_VOICE_CONTEXT] = sanitized_context
                # run_live holds ONE invocation for this whole socket, so the
                # session state below is frozen at connect time and the tools
                # would keep reasoning about the screen the person started on.
                # Publish the live view they actually read from.
                publish_live_voice_context(session_id, sanitized_context)
                canonical_screen = sanitized_context.get("screen")
                # What the browser actually claimed vs what the index resolved.
                # A journey waiting on a screen can only be debugged from the
                # inputs: a stale publisher and a mis-resolved query look
                # identical downstream, and both surface only as "settling".
                logger.info(
                    "one_adk_live_context_received family=%s query=%s -> screen=%s",
                    _bounded_text(context_payload.get("route_family"), 64),
                    _bounded_text(context_payload.get("route_query"), 64),
                    canonical_screen,
                )
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
                if context_id:
                    # An acknowledgement is a control-plane barrier only. It
                    # confirms this bounded context has been persisted on this
                    # authenticated socket; it never becomes model context.
                    await websocket.send_text(
                        json.dumps({"appContextAccepted": {"contextId": context_id}})
                    )
                initial_context_ready.set()
                clean_screen = canonical_screen if isinstance(canonical_screen, str) else ""
                is_first = not first_app_context_seen
                if is_first:
                    logger.info(
                        "one_adk_live_first_context screen=%s elapsed_ms=%s",
                        clean_screen or "none",
                        round((time.monotonic() - session_started_at) * 1000),
                    )
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
                    # Active-screen awareness: the visible content composition
                    # (modules + controls) is part of the change signal, so One
                    # is re-notified when the person focuses different content on
                    # the SAME route (e.g. selecting another item), not only on
                    # navigation. Both lists are bounded and redacted upstream.
                    content_key = "|".join(
                        [
                            ",".join(
                                str(value) for value in sanitized_context.get("visible_modules", [])
                            ),
                            ",".join(
                                str(value)
                                for value in sanitized_context.get("visible_control_ids", [])
                            ),
                        ]
                    )
                    route_key = ":".join(
                        [
                            str(sanitized_context.get("route_pattern") or ""),
                            clean_screen,
                            str(sanitized_context.get("route_instruction_id") or ""),
                            action_key,
                            layer_key,
                            content_key,
                        ]
                    )
                    changed = route_key != last_injected_route_key
                    last_injected_route_key = route_key
                    # Arriving somewhere new is a different event from the
                    # content changing where the person already is. Both
                    # refresh One's inventory, but only the former is an
                    # entry: without this split, opening a preview on the
                    # current screen re-fired the route's on-entry cue and
                    # One announced a screen change that never happened.
                    entry_key = ":".join(
                        [
                            str(sanitized_context.get("route_pattern") or ""),
                            clean_screen,
                            str(sanitized_context.get("route_instruction_id") or ""),
                        ]
                    )
                    route_entered = entry_key != last_injected_entry_key
                    last_injected_entry_key = entry_key
                    journey_waiting_for_settlement = any(
                        isinstance(run, dict)
                        and run.get("schema_version") == "one.settled_action_journey.v1"
                        and run.get("status") == "awaiting_destination_context"
                        for run in issued_goal_runs.values()
                    )
                    # A route-context note normally keeps One informed of a
                    # user navigation. During an authored journey it would be
                    # an out-of-order model turn: the originating action has
                    # not settled yet. The correlated settlement below is the
                    # only event allowed to make its next choice eligible.
                    if changed and not is_first and not journey_waiting_for_settlement:
                        note_text = _compose_route_context_note(
                            sanitized_context, is_route_entry=route_entered
                        )
                        if note_text:
                            queue.send_content(
                                genai_types.Content(
                                    role="user",
                                    parts=[genai_types.Part(text=note_text)],
                                )
                            )
                first_app_context_seen = True
                released_goal_id = next(
                    (
                        waiting_goal_id
                        for waiting_goal_id, waiting_screen in awaiting_goal_context.items()
                        if waiting_screen == clean_screen
                    ),
                    None,
                )
                if released_goal_id is not None:
                    awaiting_goal_context.pop(released_goal_id, None)
                    logger.info(
                        "one_adk_goal_decision goal=%s status=continuation_nudge_sent screen=%s",
                        released_goal_id,
                        clean_screen,
                    )
                    queue.send_content(
                        genai_types.Content(
                            role="user",
                            parts=[genai_types.Part(text=_GOAL_CONTINUATION_NOTE)],
                        )
                    )
                continue
            if message.get("type") == "voice_activity_start":
                # The browser emits this once after local speech activity, not
                # on raw microphone frames. It is transport control only: no
                # transcript, page information, or intent is trusted here.
                # New speech can never double as confirmation. Disarm every
                # unconsumed proposal from the prior turn before the model
                # receives the replacement intent.
                await _disarm_open_directives()
                greeting_gate.cancel_for_visitor_activity()
                _cancel_pending_greeting()
                queue.send_activity_start()
                continue
            if message.get("type") == "action_confirm":
                confirmation_payload = message.get("actionConfirmation")
                confirmation_payload = (
                    confirmation_payload if isinstance(confirmation_payload, dict) else {}
                )
                directive_id = _bounded_text(confirmation_payload.get("directiveId"), 128)
                action_id = _bounded_text(confirmation_payload.get("actionId"), 128)
                context_revision = _bounded_text(confirmation_payload.get("contextRevision"), 256)
                if (
                    not directive_id
                    or issued_action_directives.get(directive_id) != action_id
                    or not context_revision
                ):
                    await websocket.send_text(
                        json.dumps(
                            {
                                "actionConfirmationRejected": {
                                    "directiveId": directive_id,
                                    "code": "binding_mismatch",
                                }
                            }
                        )
                    )
                    continue
                try:
                    confirmation = await get_action_directive_store().confirm(
                        directive_id=directive_id,
                        user_id=session_user,
                        session_id=session_id,
                        action_id=action_id,
                        context_revision=context_revision,
                        # This frame is emitted only by the browser's explicit
                        # confirmation control; model/tool output cannot emit
                        # websocket client frames.
                        trusted_activation=True,
                    )
                    # Consume before the browser can invoke the side effect.
                    # A lost response requires a new directive; it is never replayed.
                    await get_action_directive_store().consume(
                        directive_id=directive_id,
                        receipt=confirmation.receipt,
                        user_id=session_user,
                        session_id=session_id,
                        action_id=action_id,
                        context_revision=context_revision,
                    )
                except ActionDirectiveAuthorityError:
                    await websocket.send_text(
                        json.dumps(
                            {
                                "actionConfirmationRejected": {
                                    "directiveId": directive_id,
                                    "code": "stale_or_replayed",
                                }
                            }
                        )
                    )
                    continue
                await websocket.send_text(
                    json.dumps(
                        {
                            "actionConfirmationAccepted": {
                                "directiveId": directive_id,
                                "receipt": confirmation.receipt,
                                "expiresAt": confirmation.expires_at.isoformat(),
                            }
                        }
                    )
                )
                continue
            if message.get("type") == "action_settled":
                raw_settlement = message.get("actionSettlement")
                settlement = _sanitize_action_settlement(raw_settlement, issued_action_directives)
                if settlement is None:
                    logger.info("one_adk_live_invalid_action_settlement")
                    continue
                issued_action_fingerprints.pop(settlement["directive_id"], None)
                raw_settlement = raw_settlement if isinstance(raw_settlement, dict) else {}
                receipt = _bounded_text(raw_settlement.get("receipt"), 256)
                try:
                    if receipt:
                        await get_action_directive_store().settle(
                            directive_id=settlement["directive_id"],
                            receipt=receipt,
                            user_id=session_user,
                            action_id=settlement["action_id"],
                            context_revision=settlement["context_revision"],
                            status=(
                                "succeeded"
                                if settlement["status"] in {"succeeded", "started", "noop"}
                                else "failed"
                            ),
                            reason_code=settlement.get("reason") or settlement["status"],
                        )
                    elif settlement["status"] in {"blocked", "invalid", "failed"}:
                        await get_action_directive_store().cancel_voice(
                            directive_id=settlement["directive_id"],
                            user_id=session_user,
                            session_id=session_id,
                            action_id=settlement["action_id"],
                        )
                    elif settlement["directive_id"] in issued_direct_run_directives:
                        await get_action_directive_store().settle_direct(
                            directive_id=settlement["directive_id"],
                            user_id=session_user,
                            action_id=settlement["action_id"],
                            context_revision=settlement["context_revision"],
                            status="succeeded",
                            reason_code=settlement.get("reason") or settlement["status"],
                        )
                    else:
                        raise ActionDirectiveAuthorityError("settlement receipt required")
                except ActionDirectiveAuthorityError:
                    logger.info(
                        # Was a bare line with no fields, so a replayed receipt,
                        # an expired directive and a receipt-less success were
                        # one indistinguishable message -- which is why this
                        # swallowed every action outcome for so long unnoticed.
                        "one_adk_live_action_settlement_authority_rejected "
                        "action=%s directive=%s status=%s receipt=%s direct_run=%s",
                        settlement["action_id"],
                        settlement["directive_id"],
                        settlement["status"],
                        "present" if receipt else "absent",
                        settlement["directive_id"] in issued_direct_run_directives,
                    )
                    continue
                finally:
                    issued_direct_run_directives.discard(settlement["directive_id"])
                goal_run_for_settlement = issued_goal_runs.get(settlement["directive_id"])
                journey_started_at = issued_journey_started_at.pop(settlement["directive_id"], None)
                journey_destination_rejected = False
                if (
                    isinstance(goal_run_for_settlement, dict)
                    and goal_run_for_settlement.get("schema_version")
                    == "one.settled_action_journey.v1"
                ):
                    expected = goal_run_for_settlement.get("settlement_target")
                    expected = expected if isinstance(expected, dict) else {}
                    expected_route = str(expected.get("route") or "")
                    expected_screen = str(expected.get("screen") or "")
                    # The settlement already self-reports route_after/screen_after
                    # at the same trust boundary as everything else in
                    # _sanitize_action_settlement. Trusting those directly (instead
                    # of requiring a SEPARATE app_context frame to have landed and
                    # match destination_context_id) removes a race the live
                    # confirm-tap path never actually satisfies today -- it never
                    # populates destinationContextId at all, so this check was
                    # unconditionally rejecting a real journey continuation.
                    context_matches = (
                        not expected_route or settlement.get("route_after") == expected_route
                    ) and (not expected_screen or settlement.get("screen_after") == expected_screen)
                    if not context_matches:
                        journey_destination_rejected = True
                        settlement = {
                            **settlement,
                            "status": "blocked",
                            "summary": "The destination screen did not finish settling.",
                            "reason": "destination_context_unacknowledged",
                        }
                        issued_goal_runs.pop(settlement["directive_id"], None)
                        logger.info(
                            "one_adk_live_journey_destination_rejected action=%s directive=%s",
                            settlement["action_id"],
                            settlement["directive_id"],
                        )
                directive_gc_task = issued_directive_gc_tasks.pop(settlement["directive_id"], None)
                if directive_gc_task is not None:
                    directive_gc_task.cancel()
                logger.info(
                    # reason/summary are what the browser refused with. Without
                    # them a blocked settlement is unattributable: guard, screen
                    # mismatch and executor error all read as "blocked".
                    "one_adk_live_action_settled action=%s directive=%s status=%s reason=%s summary=%s",
                    settlement["action_id"],
                    settlement["directive_id"],
                    settlement["status"],
                    _bounded_text(settlement.get("reason"), 64),
                    _bounded_text(settlement.get("summary"), 160),
                )
                goal_id = issued_goal_directives.pop(settlement["directive_id"], None)
                continuation_screen = _navigation_continuation_screen(
                    goal_id, issued_goal_runs.get(settlement["directive_id"]), settlement["status"]
                )
                continuation_ready_now = False
                if continuation_screen is not None and goal_id:
                    awaiting_goal_context[goal_id] = continuation_screen
                    logger.info(
                        "one_adk_goal_decision goal=%s status=awaiting_destination_context "
                        "screen=%s",
                        goal_id,
                        continuation_screen,
                    )
                    # The browser acknowledges destination context *before*
                    # it settles the navigation directive. Waiting only for a
                    # later context frame strands the goal: there normally is
                    # no second publish. The live snapshot is already
                    # sanitized and `continue_app_goal` will still verify its
                    # fresh revision before issuing the destination action.
                    if _goal_continuation_is_already_ready(
                        latest_context, continuation_screen
                    ):
                        awaiting_goal_context.pop(goal_id, None)
                        continuation_ready_now = True
                        logger.info(
                            "one_adk_goal_decision goal=%s status=continuation_nudge_sent "
                            "screen=%s source=settlement",
                            goal_id,
                            continuation_screen,
                        )
                elif _is_navigation_step_settlement(
                    issued_goal_runs.get(settlement["directive_id"])
                ):
                    # The journey's own navigation settled but did NOT arm the
                    # continuation. Without this, a lost goal linkage looks
                    # exactly like a successful navigation in the log.
                    logger.info(
                        "one_adk_goal_decision goal=%s status=continuation_not_armed "
                        "action=%s settlement_status=%s",
                        goal_id,
                        settlement["action_id"],
                        settlement["status"],
                    )
                settlement_state_delta: dict[str, Any] = {
                    "hussh:last_action_settlement": settlement
                }
                goal_run = issued_goal_runs.get(settlement["directive_id"])
                journey_continuation_note = ""
                if journey_destination_rejected:
                    settlement_state_delta["hussh:goal_run"] = None
                if (
                    isinstance(goal_run, dict)
                    and goal_run.get("schema_version") == "one.settled_action_journey.v1"
                ):
                    issued_goal_runs.pop(settlement["directive_id"], None)
                    if settlement["status"] in {"succeeded", "started"}:
                        settled_run = {
                            **goal_run,
                            "status": "destination_context_accepted",
                            "destination_context_id": settlement.get("destination_context_id"),
                        }
                        settlement_state_delta["hussh:goal_run"] = settled_run
                        if str(goal_run.get("deferred_action_id") or "").strip():
                            journey_continuation_note = (
                                "[Settled action journey - not user speech] The authored destination "
                                "context is accepted. Call continue_app_goal now. It may issue only the "
                                "already-authorized destination action; do not describe it first."
                            )
                        else:
                            journey_continuation_note = (
                                "[Settled action journey - not user speech] The authored destination "
                                "context is accepted. Call continue_app_goal now, then ask one concise "
                                "question using only the returned available choices."
                            )
                    else:
                        settlement_state_delta["hussh:goal_run"] = None
                elif goal_run is not None and settlement["action_id"] == str(
                    goal_run.get("action_id") or ""
                ):
                    # Was the literal `== "analysis.start"`, so 14 of the 15
                    # navigate-then-act journeys never recorded a terminal step:
                    # the run stayed at step_cursor 1 forever, and
                    # continue_app_goal answers "preview_already_open" from
                    # there -- pointing at a card that is gone when the step
                    # was blocked. The run already names its own action.
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
                if (
                    isinstance(goal_run_for_settlement, dict)
                    and goal_run_for_settlement.get("schema_version")
                    == "one.settled_action_journey.v1"
                ):
                    logger.info(
                        "one_adk_live_journey_settlement journey=%s action=%s directive=%s "
                        "status=%s route=%s screen=%s revision=%s elapsed_ms=%s",
                        _bounded_text(goal_run_for_settlement.get("journey_id"), 128),
                        settlement["action_id"],
                        settlement["directive_id"],
                        settlement["status"],
                        _bounded_text(latest_context.get("route_pattern"), 128),
                        _bounded_text(latest_context.get("screen"), 64),
                        _bounded_text(latest_context.get("context_revision"), 128),
                        round((time.perf_counter() - journey_started_at) * 1000, 3)
                        if journey_started_at is not None
                        else None,
                    )
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
                settlement_follow_up = (
                    " A settled journey continuation follows this report; obey it before responding."
                    if journey_continuation_note
                    else ""
                )
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
                                    f"step; do not claim the action succeeded.{settlement_follow_up}"
                                    + (
                                        f"\n{journey_continuation_note}"
                                        if journey_continuation_note
                                        else ""
                                    )
                                )
                            )
                        ],
                    )
                )
                if continuation_ready_now:
                    queue.send_content(
                        genai_types.Content(
                            role="user",
                            parts=[genai_types.Part(text=_GOAL_CONTINUATION_NOTE)],
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
                    await _disarm_open_directives()
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
            audio_bytes = _decode_realtime_audio(data)
            if audio_bytes is None:
                continue
            mime = _bounded_text(audio.get("mimeType") or _INPUT_MIME_DEFAULT, 128)
            if not mime.startswith("audio/"):
                continue
            queue.send_realtime(genai_types.Blob(data=audio_bytes, mime_type=mime))

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
        # A model naming a tool that does not exist is ordinary LLM behaviour,
        # not an exceptional condition. ADK raises ValueError from _get_tool,
        # it escapes the live flow, and the whole pump dies -- so one bad guess
        # ended the call. Observed: One called the action id
        # 'analysis.open_summary_tab' as if it were a tool.
        #
        # Contain it here so a bad tool name costs a turn instead of a session.
        # The browser is told the reason so it can resume rather than treating
        # this as an ordinary close.
        try:
            await _pump_live_events()
        except ValueError as tool_error:
            logger.warning("one_adk_live_unknown_tool_call error=%s", str(tool_error)[:160])
            await websocket.send_text(
                json.dumps({"sessionEnded": {"reason": "unknown_tool_call", "resumable": True}})
            )
            return

    async def _pump_live_events() -> None:
        async for event in runner.run_live(
            user_id=session_user,
            session_id=session_id,
            live_request_queue=queue,
            run_config=run_config,
        ):
            # The provider hands out a token it will accept back on a new
            # socket. Forward it so the browser can resume THIS conversation
            # after a drop rather than starting a new one. It is opaque, and
            # never becomes model context.
            resumption_update = getattr(event, "live_session_resumption_update", None)
            if resumption_update is not None and getattr(resumption_update, "resumable", False):
                new_handle = _bounded_text(
                    getattr(resumption_update, "new_handle", None), _RESUMPTION_HANDLE_CAP
                )
                if new_handle:
                    await websocket.send_text(
                        json.dumps({"sessionResumption": {"handle": new_handle}})
                    )
            # Advance warning that the provider is about to close. Telling the
            # browser lets it reconnect on its own terms rather than
            # discovering mid-sentence that the socket is gone.
            go_away = getattr(event, "go_away", None)
            if go_away is not None:
                time_left = getattr(go_away, "time_left", None)
                logger.info("one_adk_live_go_away time_left=%s", str(time_left)[:32])
                await websocket.send_text(
                    json.dumps({"goAway": {"timeLeft": str(time_left) if time_left else None}})
                )
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
                        action = get_action_gateway_action(action_id)
                        if action is None:
                            logger.warning(
                                "one_adk_live_unknown_action_directive action=%s", action_id
                            )
                            continue
                        context_revision = (
                            _bounded_text(latest_context.get("context_revision"), 256)
                            or f"session:{session_id}"
                        )
                        raw_slots = payload.get("slots")
                        slots: dict[str, Any] = raw_slots if isinstance(raw_slots, dict) else {}
                        # Same fingerprint shape as the browser's own
                        # directiveFingerprint() -- key names/types only, never
                        # values, so nothing sensitive (e.g. an OTP) is retained
                        # even transiently.
                        new_fingerprint = json.dumps(
                            {"actionId": action_id, "slotKeys": sorted(slots.keys())},
                            sort_keys=True,
                        )
                        duplicate_directive_id = next(
                            (
                                did
                                for did, aid in issued_action_directives.items()
                                if aid == action_id
                                and issued_action_fingerprints.get(did) == new_fingerprint
                            ),
                            None,
                        )
                        if duplicate_directive_id:
                            logger.info(
                                "one_adk_live_directive_deduped action=%s directive=%s",
                                action_id,
                                duplicate_directive_id,
                            )
                            # Dedupe used to drop the repeat and say nothing.
                            # But run_app_action had already answered the model
                            # `confirm_pending`, so from One's side the proposal
                            # succeeded -- and it asked again, out loud, every
                            # time. Reported live as the agent "repeating the
                            # same line without pause"; the card on screen was
                            # correct throughout, only the narration doubled.
                            #
                            # Swallowing the directive is right. Swallowing it
                            # without telling the model is what makes it repeat.
                            queue.send_content(
                                genai_types.Content(
                                    role="user",
                                    parts=[
                                        genai_types.Part(
                                            text=(
                                                "[Directive ledger - not user speech] That exact "
                                                "confirmation is already on screen and still "
                                                "waiting. Do not propose it again and do not "
                                                "repeat the question. Say nothing further until "
                                                "its settlement arrives."
                                            )
                                        )
                                    ],
                                )
                            )
                            continue
                        try:
                            issued = await get_action_directive_store().issue(
                                user_id=session_user,
                                channel="voice",
                                session_id=session_id,
                                action_id=action_id,
                                context_revision=context_revision,
                                action_contract=action,
                                slots=slots,
                                trusted_activation_required=(
                                    payload.get("trustedActivationRequired") is True
                                ),
                            )
                        except Exception as error:  # fail closed on shared-store outage
                            logger.warning(
                                "one_adk_live_directive_authority_unavailable action=%s error=%s",
                                action_id,
                                error.__class__.__name__,
                            )
                            continue
                        directive_id = issued.directive_id
                        issued_action_directives[directive_id] = action_id
                        issued_action_fingerprints[directive_id] = new_fingerprint
                        # Remembered at ISSUE time, from the payload this relay
                        # parked itself. Asking the settling frame whether it
                        # needed confirming would let the browser decide its own
                        # authority; the relay already knows, so it answers.
                        if payload.get("needsConfirmation") is False:
                            issued_direct_run_directives.add(directive_id)
                        goal_id = _bounded_text(payload.get("goalId"), 128)
                        if goal_id:
                            issued_goal_directives[directive_id] = goal_id
                        goal_run = payload.get("goalRun")
                        if isinstance(goal_run, dict):
                            issued_goal_runs[directive_id] = goal_run
                            if goal_run.get("schema_version") == "one.settled_action_journey.v1":
                                issued_journey_started_at[directive_id] = time.perf_counter()
                        outgoing_directive = {
                            **directive,
                            "payload": {
                                **payload,
                                "directiveId": directive_id,
                                "contextRevision": issued.context_revision,
                                "expiresAt": issued.expires_at.isoformat(),
                            },
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
                                await asyncio.sleep(300)
                                if did not in issued_action_directives:
                                    return
                                issued_action_directives.pop(did, None)
                                issued_goal_directives.pop(did, None)
                                expired_goal_run = issued_goal_runs.pop(did, None)
                                issued_journey_started_at.pop(did, None)
                                issued_action_fingerprints.pop(did, None)
                                issued_direct_run_directives.discard(did)
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
                                            state_delta={
                                                "hussh:last_action_settlement": settlement,
                                                **(
                                                    {"hussh:goal_run": None}
                                                    if isinstance(expired_goal_run, dict)
                                                    and expired_goal_run.get("schema_version")
                                                    == "one.settled_action_journey.v1"
                                                    else {}
                                                ),
                                            }
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
        # Same lifetime as the session itself: the published live context is
        # per-socket, so it must not outlive the socket that owns it.
        clear_live_voice_context(session_id)
        await _close_quietly(websocket)
        # Ephemeral session cleanup: without this, InMemorySessionService
        # accumulates one session per voice connection until process restart.
        try:
            await runner.session_service.delete_session(
                app_name=ONE_APP_NAME, user_id=session_user, session_id=session_id
            )
        except Exception:  # noqa: BLE001 - cleanup is best-effort
            logger.debug("one_adk_live_session_cleanup_skipped session_id=%s", session_id)
