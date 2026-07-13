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

Wire protocol (browser-facing) is kept byte-compatible with the legacy relay
so ``gemini-live-client.ts`` needs only a URL change:

  browser -> server: {"realtimeInput": {"audio": {"data": b64, "mimeType"}}}
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
import os
import secrets
import uuid
from typing import Any, Optional

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
    get_one_runner,
)
from hushh_mcp.services.route_orchestration_index import resolve_route_orchestration_entry
from hushh_mcp.services.voice_action_manifest import get_voice_manifest_action

logger = logging.getLogger(__name__)

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
_LIVE_CONTEXT_STRING_CAP = 64
_LIVE_CONTEXT_ARRAY_CAP = 18
_LIVE_MODULE_CAP = 10
_LIVE_CAPABILITY_CAP = 10
_ONBOARDING_PHASES = frozenset(
    {
        "anonymous_auth",
        "phone_required",
        "setup_hub",
        "capability_setup",
        "external_connector",
        "root_completion",
    }
)
_ONBOARDING_CALLBACK_STATES = frozenset({"none", "pending", "succeeded", "cancelled", "failed"})
_ONBOARDING_CAPABILITIES = frozenset(
    {"finance", "gmail", "email", "location", "pkm", "consent", "marketplace", "connected-systems"}
)
_ACTION_SETTLEMENT_STATUSES = frozenset(
    {"succeeded", "started", "blocked", "invalid", "failed", "noop"}
)
_INITIAL_GREETING_IDLE_SECONDS = 1.5
_ROUTE_PLAYBOOK_TEXT_CAP = 480


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


def _bounded_text(value: Any, limit: int = _LIVE_CONTEXT_STRING_CAP) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _bounded_text_list(value: Any, limit: int) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for item in value:
        clean = _bounded_text(item)
        if not clean or clean in seen:
            continue
        result.append(clean)
        seen.add(clean)
        if len(result) >= limit:
            break
    return result


def _sanitize_route_playbook(route_entry: Any) -> dict[str, Any] | None:
    """Read only checked-in generated guidance; never trust browser prose."""
    if (os.getenv("HUSHH_ROUTE_PLAYBOOKS_DISABLED") or "").strip().lower() in {
        "1",
        "true",
        "yes",
    }:
        return None
    if not isinstance(route_entry, dict):
        return None
    value = route_entry.get("voice_playbook")
    if not isinstance(value, dict):
        return None
    proactivity = _bounded_text(value.get("proactivity"), 16)
    return {
        "playbook_id": _bounded_text(value.get("playbook_id"), 96),
        "purpose": _bounded_text(value.get("purpose"), _ROUTE_PLAYBOOK_TEXT_CAP),
        "screen": _bounded_text(value.get("screen"), 64),
        "entry_cue": _bounded_text(value.get("entry_cue"), 240),
        "proactivity": proactivity if proactivity in {"on_entry", "ambient"} else "ambient",
        "primary_action_id": _bounded_text(value.get("primary_action_id"), 128) or None,
        "completion_boundary": _bounded_text(
            value.get("completion_boundary"), _ROUTE_PLAYBOOK_TEXT_CAP
        ),
        "next_route": _bounded_text(value.get("next_route"), 128) or None,
        "return_policy": _bounded_text(value.get("return_policy"), 32),
        "out_of_scope_behavior": _bounded_text(
            value.get("out_of_scope_behavior"), _ROUTE_PLAYBOOK_TEXT_CAP
        ),
    }


def _compose_route_context_note(context: dict[str, Any]) -> str | None:
    """Build one bounded model note from server-resolved route intelligence."""
    playbook = context.get("route_playbook")
    if not isinstance(playbook, dict):
        return None
    if context.get("route_context_policy") == "suppress":
        return None
    purpose = str(playbook.get("purpose") or "Use the verified current screen.")
    cue = str(playbook.get("entry_cue") or "")
    primary = str(playbook.get("primary_action_id") or "")
    proactive = playbook.get("proactivity") == "on_entry"
    return (
        "[App route context - not user speech] The verified current route is "
        f"'{context.get('route_pattern') or context.get('route_family') or '/'}' "
        f"and its purpose is: {purpose} "
        "Generated actions and their guards remain the only execution authority. "
        "For an explicit request matching a visible action, call list_app_actions "
        "and run the exact returned id before any identity or greeting response. "
        f"The preferred action reference is '{primary or 'none'}'. "
        + (
            f"After route settlement, orient once with this intent: {cue} "
            if proactive and cue
            else "Use this context silently until the person speaks. "
        )
        + "Never claim completion before correlated browser settlement."
    )


def _sanitize_live_context(payload: dict[str, Any]) -> dict[str, Any]:
    """Keep only bounded, redacted UI state for tool availability decisions."""
    cache_freshness = _bounded_text(payload.get("cache_freshness"), 32)
    route_family = _bounded_text(payload.get("route_family"))
    route_entry = resolve_route_orchestration_entry(route_family)
    submitted_action_ids = [
        action_id
        for action_id in _bounded_text_list(
            payload.get("available_action_ids"), _LIVE_CONTEXT_ARRAY_CAP
        )
        if get_voice_manifest_action(action_id) is not None
    ]
    return {
        # The generated index is the server-side source of route policy.  A
        # client may describe its current UI, but cannot invent a route
        # instruction or route policy. Action execution remains independently
        # guarded by the generated action gateway and surface metadata.
        "route_family": route_family,
        "route_pattern": route_entry.get("route_pattern")
        if isinstance(route_entry, dict)
        else None,
        "route_instruction_id": route_entry.get("instruction_id")
        if isinstance(route_entry, dict)
        else None,
        "route_context_policy": route_entry.get("context_policy")
        if isinstance(route_entry, dict)
        else "suppress",
        "route_playbook": _sanitize_route_playbook(route_entry),
        "persona": _bounded_text(payload.get("persona")),
        "voice_state": _bounded_text(payload.get("voice_state"), 32),
        "available_action_ids": submitted_action_ids,
        "visible_modules": _bounded_text_list(payload.get("visible_modules"), _LIVE_MODULE_CAP),
        "visible_control_ids": _bounded_text_list(
            payload.get("visible_control_ids"), _LIVE_MODULE_CAP
        ),
        "pending_settlement": payload.get("pending_settlement") is True,
        "cache_freshness": cache_freshness
        if cache_freshness in {"fresh_or_stale_safe", "locked", "missing"}
        else "missing",
        "vault_ready": payload.get("vault_ready") is True,
        "portfolio_ready": payload.get("portfolio_ready") is True,
        "busy_operations": _bounded_text_list(payload.get("busy_operations"), _LIVE_MODULE_CAP),
        "onboarding": _sanitize_onboarding_context(payload.get("onboarding")),
    }


def _sanitize_onboarding_context(value: Any) -> dict[str, Any]:
    """Bound anonymous/new-user guidance to non-sensitive journey metadata."""
    payload = value if isinstance(value, dict) else {}
    phase = _bounded_text(payload.get("phase"), 32)
    callback_state = _bounded_text(payload.get("callback_state"), 16)
    active_capability = _bounded_text(payload.get("active_capability"), 32)
    return {
        "phase": phase if phase in _ONBOARDING_PHASES else "anonymous_auth",
        "active_capability": active_capability
        if active_capability in _ONBOARDING_CAPABILITIES
        else None,
        "root_resolved": payload.get("root_resolved") is True,
        "return_route": "/one/setup",
        "callback_state": callback_state
        if callback_state in _ONBOARDING_CALLBACK_STATES
        else "none",
        "phone_verified": payload.get("phone_verified")
        if isinstance(payload.get("phone_verified"), bool)
        else None,
        "setup_capability_ids": [
            capability
            for capability in _bounded_text_list(
                payload.get("setup_capability_ids"), _LIVE_CAPABILITY_CAP
            )
            if capability in _ONBOARDING_CAPABILITIES
        ],
    }


def _sanitize_action_settlement(
    payload: Any, issued_directives: dict[str, str]
) -> dict[str, str] | None:
    """Validate a browser report against an action directive from this socket."""
    if not isinstance(payload, dict):
        return None
    directive_id = _bounded_text(payload.get("directiveId"), 128)
    action_id = _bounded_text(payload.get("actionId"), 128)
    if not directive_id or issued_directives.get(directive_id) != action_id:
        return None
    status_value = _bounded_text(payload.get("status"), 16)
    if status_value not in _ACTION_SETTLEMENT_STATUSES:
        return None
    issued_directives.pop(directive_id, None)
    return {
        "directive_id": directive_id,
        "action_id": action_id,
        "status": status_value,
        "summary": _bounded_text(payload.get("summary"), 320) or "The app returned no detail.",
        "reason": _bounded_text(payload.get("reason"), 96),
        "route_after": _bounded_text(payload.get("routeAfter"), 128),
        "screen_after": _bounded_text(payload.get("screenAfter"), 64),
    }


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

    runner = get_one_runner()
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
                screen_value = context_payload.get("screen")
                if isinstance(screen_value, str) and screen_value.strip():
                    state_delta[STATE_SCREEN] = screen_value.strip()[:64]
                # Full UI snapshots never reach the model prompt. Action tools
                # read this bounded redacted state when deciding what can be
                # proposed or executed on the current screen.
                sanitized_context = _sanitize_live_context(context_payload)
                state_delta[STATE_VOICE_CONTEXT] = sanitized_context
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
                screen = context_payload.get("screen")
                clean_screen = screen.strip()[:64] if isinstance(screen, str) else ""
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
                    route_key = ":".join(
                        [
                            str(sanitized_context.get("route_pattern") or ""),
                            clean_screen,
                            str(sanitized_context.get("route_instruction_id") or ""),
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
                await runner.session_service.append_event(
                    session,
                    AdkEvent(
                        author="user",
                        invocation_id="action_settled",
                        actions=EventActions(
                            state_delta={"hussh:last_action_settlement": settlement}
                        ),
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
        # Wait briefly for the browser's first bounded app_context so the
        # active server-resolved playbook is present for the first real turn.
        # Legacy clients still start after the compatibility timeout; queued
        # audio is retained by LiveRequestQueue during this bounded wait.
        try:
            await asyncio.wait_for(initial_context_ready.wait(), timeout=1.0)
        except TimeoutError:
            pass
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
            actions = getattr(event, "actions", None)
            delta = getattr(actions, "state_delta", None) or {}
            directive = delta.get(STATE_PENDING_DIRECTIVE)
            if isinstance(directive, dict) and directive:
                outgoing_directive = directive
                payload = directive.get("payload")
                if directive.get("kind") == "action" and isinstance(payload, dict):
                    action_id = _bounded_text(payload.get("actionId"), 128)
                    if action_id:
                        directive_id = secrets.token_urlsafe(18)
                        issued_action_directives[directive_id] = action_id
                        outgoing_directive = {
                            **directive,
                            "payload": {**payload, "directiveId": directive_id},
                        }
                await websocket.send_text(json.dumps({"clientDirective": outgoing_directive}))
            if getattr(event, "turn_complete", False):
                await websocket.send_text(json.dumps({"serverContent": {"turnComplete": True}}))

    up = asyncio.create_task(pump_browser_to_queue())
    down = asyncio.create_task(pump_events_to_browser())
    try:
        done, pending = await asyncio.wait({up, down}, return_when=asyncio.FIRST_EXCEPTION)
        for task in done:
            exc = task.exception()
            if exc is not None and not isinstance(exc, WebSocketDisconnect):
                logger.warning("one_adk_live_relay_pump_failed error=%s", exc.__class__.__name__)
    except WebSocketDisconnect:
        pass
    finally:
        up.cancel()
        down.cancel()
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
