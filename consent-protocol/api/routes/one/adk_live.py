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
    consume_relay_ticket,
    issue_relay_ticket,
    one_voice_enabled,
    resolve_optional_uid,
    resolve_persona_tier,
)
from hushh_mcp.one_adk.agent_tree import (
    ONE_APP_NAME,
    STATE_CONSENT_TOKEN,
    STATE_PENDING_DIRECTIVE,
    STATE_TIMEZONE,
    STATE_USER_ID,
    get_one_runner,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/adk", tags=["One ADK"])

_INPUT_MIME_DEFAULT = "audio/pcm;rate=16000"
_OUTPUT_MIME = "audio/pcm;rate=24000"


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
    accepted, uid, _persona_tier = consume_relay_ticket(relay_ticket)
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
        response_modalities=["AUDIO"],
        input_audio_transcription=genai_types.AudioTranscriptionConfig(),
        output_audio_transcription=genai_types.AudioTranscriptionConfig(),
    )

    await websocket.send_text(json.dumps({"setupComplete": {}}))

    async def pump_browser_to_queue() -> None:
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
                consent_token = context_payload.get("consent_token")
                if isinstance(consent_token, str) and consent_token.strip():
                    state_delta[STATE_CONSENT_TOKEN] = consent_token.strip()
                timezone_name = context_payload.get("timezone")
                if isinstance(timezone_name, str) and timezone_name.strip():
                    state_delta[STATE_TIMEZONE] = timezone_name.strip()[:64]
                if state_delta:
                    await runner.session_service.append_event(
                        session,
                        AdkEvent(
                            author="user",
                            invocation_id="app_context",
                            actions=EventActions(state_delta=state_delta),
                        ),
                    )
                screen = context_payload.get("screen")
                if isinstance(screen, str) and screen.strip():
                    queue.send_content(
                        genai_types.Content(
                            role="user",
                            parts=[
                                genai_types.Part(
                                    text=(
                                        "[App state update - not user speech] The user "
                                        f"is now on the '{screen.strip()[:64]}' screen. "
                                        "Use this silently."
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
                await websocket.send_text(json.dumps({"clientDirective": directive}))
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
        for task in (up, down):
            task.cancel()
        queue.close()
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001 - already closed
            pass
