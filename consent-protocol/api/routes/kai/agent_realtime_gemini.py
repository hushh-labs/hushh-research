"""Gemini Live ephemeral-token endpoint for One's in-bar conversation mode.

This is the realtime, full-duplex sibling of the chained ``agent_voice.py`` and
the OpenAI ``agent_realtime.py``. It mints a short-lived, tightly constrained
Gemini Live *ephemeral auth token* so the browser can open a direct WebSocket to
the Gemini Live API (lowest latency, no audio relayed through our server).

Security model:

- The browser never sees the managed Gemini API key. It only receives an
  ephemeral token that the SDK mints via ``auth_tokens.create``.
- The token is locked to a single new Live session, a short expiry, and a fixed
  ``LiveConnectConfig`` (model, audio-only modality, voice, system instruction,
  VAD). ``lock_additional_fields=[]`` prevents the client from widening any
  generation parameter beyond what we set here.
- Auth is OPTIONAL, exactly like ``agent_intro.py``: a signed-in user with an
  unlocked vault gets the full persona, while an anonymous / locked-vault
  onboarding visitor gets a navigation-only informational persona. Neither tier
  reads or writes PKM/vault data on this path: realtime voice has no tools,
  memory, or persistence, so it is safe to expose at the lower privilege.
- Rate limited per user/IP to bound cost on the unauthenticated path.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import (
    APIRouter,
    Header,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from api.middlewares.rate_limit import RateLimits, limiter
from hushh_mcp.services.agent_persona import (
    build_persona_context,
    compose_voice_instructions,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Kai Agent"])

# Native-audio Live model for full-duplex voice. Override per environment without
# code changes. Note: the Live API only accepts dedicated Live model IDs; the
# text/chat model (gemini-3.5-flash) is NOT a Live model. gemini-3.1-flash-live-preview
# is the current latest high-quality, low-latency native-audio Live model (the
# prior gemini-2.5-flash-native-audio-preview-09-2025 is superseded). See
# https://ai.google.dev/gemini-api/docs/models#audio-models
_GEMINI_LIVE_MODEL = (
    os.getenv("AGENT_GEMINI_LIVE_MODEL") or "gemini-3.1-flash-live-preview"
).strip()

# Vertex AI Live model + location for the server-relayed voice path. Vertex Live
# runs over ADC (no Developer-API key), so it works on projects where the
# Developer API is restricted. gemini-live-2.5-flash is the newest Live model
# currently served on Vertex; the gemini-3.x Live previews are Developer-API
# only for now, and the native-audio variant is not yet entitled on Vertex.
# Override per environment without code changes.
_VERTEX_LIVE_MODEL = (
    os.getenv("AGENT_GEMINI_VERTEX_LIVE_MODEL") or "gemini-live-2.5-flash"
).strip()
_VERTEX_LIVE_LOCATION = (os.getenv("AGENT_GEMINI_VERTEX_LIVE_LOCATION") or "global").strip()
_VERTEX_LIVE_PROJECT = (
    os.getenv("GOOGLE_CLOUD_PROJECT")
    or os.getenv("GOOGLE_CLOUD_PROJECT_ID")
    or os.getenv("GCLOUD_PROJECT")
    or ""
).strip()

# Supported Gemini speech voices (mirrors the chained TTS voice list).
_GEMINI_LIVE_VOICES = {"Charon", "Sulafat", "Kore", "Puck"}
_DEFAULT_GEMINI_LIVE_VOICE = "Sulafat"

# Ephemeral token lifetime. The token must be used to open the session within
# this window; the session itself may then run for its own duration.
_TOKEN_EXPIRE_SECONDS = 120
_SESSION_START_WINDOW_SECONDS = 60

_DISABLED_FLAG_VALUES = {"0", "false", "off", "disabled", "no"}


def _gemini_live_enabled() -> bool:
    configured = os.getenv("AGENT_GEMINI_LIVE_ENABLED", "").strip().lower()
    return configured not in _DISABLED_FLAG_VALUES


class AgentGeminiLiveTokenRequest(BaseModel):
    voice: Optional[str] = Field(default=None, max_length=64)
    # Optional active-state hints from the agent runtime context. They only
    # shape the (tool-less) system instruction; they never widen access. The
    # persona composer sanitizes them against prompt injection.
    screen: Optional[str] = Field(default=None, max_length=64)
    persona: Optional[str] = Field(default=None, max_length=32)


class AgentGeminiLiveTokenResponse(BaseModel):
    token: str = Field(..., max_length=4096)
    expires_at: int = Field(..., ge=0)
    model: str = Field(..., max_length=128)
    voice: str = Field(..., max_length=64)
    tier: str = Field(..., max_length=16)
    # The browser connects with v1alpha for Live + ephemeral tokens.
    api_version: str = Field(default="v1alpha", max_length=16)


async def _resolve_optional_uid(authorization: Optional[str]) -> Optional[str]:
    """Best-effort Firebase UID for tier selection + rate-limit bucketing.

    Never raises: a missing/invalid token simply means the pre-vault tier, which
    is acceptable here because realtime voice reads/writes no private data.
    """
    if not authorization or not authorization.startswith("Bearer "):
        return None
    try:
        from api.utils.firebase_auth import verify_firebase_bearer

        return await run_in_threadpool(verify_firebase_bearer, authorization)
    except Exception:  # noqa: BLE001 - optional auth, anonymous is acceptable
        return None


def _resolve_voice(requested: Optional[str]) -> str:
    candidate = (requested or "").strip()
    for voice in _GEMINI_LIVE_VOICES:
        if voice.lower() == candidate.lower():
            return voice
    return _DEFAULT_GEMINI_LIVE_VOICE


@router.post("/agent/realtime/gemini/token", response_model=AgentGeminiLiveTokenResponse)
@limiter.limit(RateLimits.AGENT_CHAT)
async def create_agent_gemini_live_token(
    request: Request,
    body: AgentGeminiLiveTokenRequest,
    authorization: Optional[str] = Header(default=None),
) -> AgentGeminiLiveTokenResponse:
    """Mint a constrained ephemeral Gemini Live token for in-bar voice mode."""

    if not _gemini_live_enabled():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Gemini Live voice is not enabled.",
        )

    api_key = (os.getenv("GOOGLE_API_KEY") or "").strip()
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Gemini Live is not configured.",
        )

    uid = await _resolve_optional_uid(authorization)
    # Backward-compatible coarse tier returned to the client (full vs intro).
    tier = "full" if uid else "intro"
    # Richer access tier used only to shape the (tool-less) system instruction.
    # Realtime voice never reads vault state, so a signed-in user maps to the
    # signed_locked tier here: the instruction must not promise data access.
    persona_tier = "signed_locked" if uid else "anon_onboarding"
    persona_ctx = build_persona_context(
        tier=persona_tier,
        screen=body.screen,
        persona=body.persona,
    )
    instructions = compose_voice_instructions(persona_ctx)
    voice = _resolve_voice(body.voice)

    from google import genai
    from google.genai import types as genai_types

    now = datetime.now(tz=timezone.utc)
    expire_time = now + timedelta(seconds=_TOKEN_EXPIRE_SECONDS)
    session_start_deadline = now + timedelta(seconds=_SESSION_START_WINDOW_SECONDS)

    live_config = genai_types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        system_instruction=instructions,
        speech_config=genai_types.SpeechConfig(
            voice_config=genai_types.VoiceConfig(
                prebuilt_voice_config=genai_types.PrebuiltVoiceConfig(voice_name=voice)
            )
        ),
        input_audio_transcription=genai_types.AudioTranscriptionConfig(),
        output_audio_transcription=genai_types.AudioTranscriptionConfig(),
    )

    try:
        # Ephemeral token minting is only supported by the Gemini Developer API
        # client (the API-key path), not Vertex. The deployment sets
        # GOOGLE_GENAI_USE_VERTEXAI=True globally for chained inference, so we
        # must explicitly opt this client back into the Developer API.
        client = genai.Client(
            api_key=api_key,
            vertexai=False,
            http_options={"api_version": "v1alpha"},
        )
        auth_token = await client.aio.auth_tokens.create(
            config=genai_types.CreateAuthTokenConfig(
                uses=1,
                expire_time=expire_time,
                new_session_expire_time=session_start_deadline,
                live_connect_constraints=genai_types.LiveConnectConstraints(
                    model=_GEMINI_LIVE_MODEL,
                    config=live_config,
                ),
                # Prevent the client from overriding any field we did not set.
                lock_additional_fields=[],
            )
        )
    except Exception as error:  # noqa: BLE001 - normalize provider failures
        logger.warning(
            "agent_gemini_live_token_failed tier=%s error=%s",
            tier,
            error.__class__.__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Could not start Gemini Live. Please try again.",
        ) from error

    token_value = getattr(auth_token, "name", None)
    if not token_value:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Gemini Live token was not issued.",
        )

    return AgentGeminiLiveTokenResponse(
        token=token_value,
        expires_at=int(expire_time.timestamp()),
        model=_GEMINI_LIVE_MODEL,
        voice=voice,
        tier=tier,
    )


# ---------------------------------------------------------------------------
# Vertex AI Live relay (server-side ADC, no Developer-API key)
# ---------------------------------------------------------------------------
#
# The /token path above mints a browser ephemeral token for the Gemini
# *Developer* API. On projects where the Developer API is restricted, that path
# is unavailable. This relay runs Gemini Live over *Vertex AI* using the
# deployment's Application Default Credentials, which is the same trust path the
# chained chat/voice inference already uses, so it works wherever Vertex does.
#
# Wire protocol (browser <-> this relay) intentionally mirrors the subset of the
# Gemini Live JSON the browser already speaks, so the frontend client needs only
# a URL change:
#   - browser -> relay: {"setup": {...}} (ignored; server is authoritative) and
#                       {"realtimeInput": {"audio": {"mimeType","data"}}}
#   - relay -> browser: {"setupComplete": {}},
#                       {"serverContent": {"modelTurn": {"parts": [...]}}},
#                       {"serverContent": {"interrupted": true}},
#                       {"serverContent": {"turnComplete": true}}
#
# Audio is base64 PCM16 both ways (16 kHz in, 24 kHz out), exactly as before.

_VERTEX_LIVE_INPUT_RATE = 16000


def _resolve_vertex_live_client():
    """Build a Vertex Live genai client from ADC.

    Project/location come from explicit env overrides when set, otherwise the
    SDK resolves them from ADC (quota project) and the default location.
    """
    from google import genai

    kwargs: dict[str, object] = {"vertexai": True}
    if _VERTEX_LIVE_PROJECT:
        kwargs["project"] = _VERTEX_LIVE_PROJECT
    if _VERTEX_LIVE_LOCATION:
        kwargs["location"] = _VERTEX_LIVE_LOCATION
    return genai.Client(**kwargs)


def _build_live_config(voice: str, instructions: str):
    from google.genai import types as genai_types

    return genai_types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        system_instruction=instructions,
        speech_config=genai_types.SpeechConfig(
            voice_config=genai_types.VoiceConfig(
                prebuilt_voice_config=genai_types.PrebuiltVoiceConfig(voice_name=voice)
            )
        ),
        input_audio_transcription=genai_types.AudioTranscriptionConfig(),
        output_audio_transcription=genai_types.AudioTranscriptionConfig(),
    )


@router.websocket("/agent/realtime/gemini/live")
async def agent_gemini_live_relay(websocket: WebSocket) -> None:
    """Relay browser audio to/from a Vertex AI Live session via ADC."""

    await websocket.accept()

    if not _gemini_live_enabled():
        await websocket.close(code=1011, reason="Gemini Live voice is not enabled.")
        return

    # Auth-optional, same tier model as the token route. The browser cannot set
    # WebSocket headers, so the Firebase bearer (when present) rides in a query
    # param. Anonymous callers get the navigation-only intro persona.
    authorization = websocket.query_params.get("authorization")
    if authorization and not authorization.startswith("Bearer "):
        authorization = f"Bearer {authorization}"
    uid = await _resolve_optional_uid(authorization)
    persona_tier = "signed_locked" if uid else "anon_onboarding"
    persona_ctx = build_persona_context(
        tier=persona_tier,
        screen=websocket.query_params.get("screen"),
        persona=websocket.query_params.get("persona"),
    )
    instructions = compose_voice_instructions(persona_ctx)
    voice = _resolve_voice(websocket.query_params.get("voice"))

    try:
        client = _resolve_vertex_live_client()
        live_config = _build_live_config(voice, instructions)
    except Exception as error:  # noqa: BLE001 - normalize provider failures
        logger.warning(
            "agent_gemini_live_relay_init_failed error=%s",
            error.__class__.__name__,
        )
        await websocket.close(code=1011, reason="Voice is unavailable right now.")
        return

    try:
        async with client.aio.live.connect(model=_VERTEX_LIVE_MODEL, config=live_config) as session:
            # Tell the browser the session is live so it starts streaming mic.
            await websocket.send_text(json.dumps({"setupComplete": {}}))

            async def pump_browser_to_gemini() -> None:
                while True:
                    raw = await websocket.receive_text()
                    try:
                        message = json.loads(raw)
                    except (TypeError, ValueError):
                        continue
                    realtime = message.get("realtimeInput")
                    if not isinstance(realtime, dict):
                        # The browser may still send a {"setup": ...} frame; the
                        # server config is authoritative, so we ignore it.
                        continue
                    audio = realtime.get("audio")
                    if not isinstance(audio, dict):
                        continue
                    data = audio.get("data")
                    if not isinstance(data, str) or not data:
                        continue
                    mime = audio.get("mimeType") or (f"audio/pcm;rate={_VERTEX_LIVE_INPUT_RATE}")
                    await session.send_realtime_input(
                        audio={"data": base64.b64decode(data), "mime_type": mime}
                    )

            async def pump_gemini_to_browser() -> None:
                while True:
                    async for response in session.receive():
                        server_content = response.server_content
                        if server_content is not None:
                            if getattr(server_content, "interrupted", False):
                                await websocket.send_text(
                                    json.dumps({"serverContent": {"interrupted": True}})
                                )
                            model_turn = getattr(server_content, "model_turn", None)
                            if model_turn is not None and model_turn.parts:
                                parts: list[dict] = []
                                for part in model_turn.parts:
                                    inline = getattr(part, "inline_data", None)
                                    if inline is not None and inline.data:
                                        parts.append(
                                            {
                                                "inlineData": {
                                                    "mimeType": inline.mime_type
                                                    or "audio/pcm;rate=24000",
                                                    "data": base64.b64encode(inline.data).decode(
                                                        "ascii"
                                                    ),
                                                }
                                            }
                                        )
                                    elif getattr(part, "text", None):
                                        parts.append({"text": part.text})
                                if parts:
                                    await websocket.send_text(
                                        json.dumps(
                                            {"serverContent": {"modelTurn": {"parts": parts}}}
                                        )
                                    )
                            if getattr(server_content, "turn_complete", False):
                                await websocket.send_text(
                                    json.dumps({"serverContent": {"turnComplete": True}})
                                )

            up = asyncio.create_task(pump_browser_to_gemini())
            down = asyncio.create_task(pump_gemini_to_browser())
            done, pending = await asyncio.wait({up, down}, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            # Surface a non-cancellation error from whichever pump finished.
            for task in done:
                exc = task.exception()
                if exc is not None and not isinstance(
                    exc, (WebSocketDisconnect, asyncio.CancelledError)
                ):
                    raise exc
    except WebSocketDisconnect:
        return
    except Exception as error:  # noqa: BLE001 - normalize provider failures
        logger.warning(
            "agent_gemini_live_relay_failed tier=%s error=%s",
            "full" if uid else "intro",
            error.__class__.__name__,
        )
        with contextlib.suppress(Exception):
            await websocket.close(code=1011, reason="Voice session ended unexpectedly.")
        return

    with contextlib.suppress(Exception):
        await websocket.close()
