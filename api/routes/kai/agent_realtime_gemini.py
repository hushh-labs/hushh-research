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
  reads or writes PKM/vault data on this path: realtime voice only exposes a
  proposal-only action tool, with no provider-side execution, memory, or
  persistence, so it is safe to expose at the lower privilege.
- Rate limited per user/IP to bound cost on the unauthenticated path.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, NamedTuple, Optional

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
from hushh_mcp.runtime_settings import get_core_security_settings
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
    route_family: Optional[str] = Field(default=None, max_length=64)
    voice_state: Optional[str] = Field(default=None, max_length=32)
    access_tier: Optional[str] = Field(default=None, max_length=32)
    available_action_ids: list[str] = Field(default_factory=list, max_length=10)
    visible_modules: list[str] = Field(default_factory=list, max_length=10)
    cache_freshness: Optional[str] = Field(default=None, max_length=32)
    vault_ready: Optional[bool] = None
    portfolio_ready: Optional[bool] = None


class AgentGeminiLiveTokenResponse(BaseModel):
    token: str = Field(..., max_length=4096)
    expires_at: int = Field(..., ge=0)
    model: str = Field(..., max_length=128)
    voice: str = Field(..., max_length=64)
    tier: str = Field(..., max_length=16)
    # The browser connects with v1alpha for Live + ephemeral tokens.
    api_version: str = Field(default="v1alpha", max_length=16)


class AgentGeminiLiveRelaySessionResponse(BaseModel):
    # Signed stateless tickets include a compact payload plus HMAC signature.
    # Keep the response bounded, but large enough for the signed-ticket contract.
    relay_ticket: str = Field(..., max_length=4096)
    expires_at: int = Field(..., ge=0)
    model: str = Field(..., max_length=128)
    voice: str = Field(..., max_length=64)
    tier: str = Field(..., max_length=16)


_SIGNED_RELAY_TICKET_PREFIX = "v1"
PersonaTier = Literal[
    "anon_onboarding",
    "anon_browsing",
    "signed_locked",
    "signed_unlocked",
]
RelayPersonaHints = dict[str, Any]
_RELAY_TICKETS: dict[str, tuple[Optional[str], PersonaTier, RelayPersonaHints, float]] = {}
_RELAY_TICKET_NONCES: dict[str, int] = {}


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


def _resolve_persona_tier(uid: Optional[str], requested_access_tier: Optional[str]) -> PersonaTier:
    if uid:
        return "signed_unlocked" if requested_access_tier == "signed_unlocked" else "signed_locked"
    requested = (requested_access_tier or "").strip().lower()
    if requested == "anon_browsing":
        return "anon_browsing"
    return "anon_onboarding"


def _compact_persona_hints(raw: RelayPersonaHints) -> RelayPersonaHints:
    """Keep relay tickets bounded to non-secret, redacted app-state hints."""

    hints: RelayPersonaHints = {}
    for key in ("screen", "persona", "route_family", "voice_state", "cache_freshness"):
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            hints[key] = value.strip()[:96]
    for key in ("vault_ready", "portfolio_ready"):
        value = raw.get(key)
        if isinstance(value, bool):
            hints[key] = value
    for key in ("available_action_ids", "visible_modules"):
        value = raw.get(key)
        if not isinstance(value, list):
            continue
        clean_items = [
            item.strip()[:96] for item in value if isinstance(item, str) and item.strip()
        ][:10]
        if clean_items:
            hints[key] = clean_items
    return hints


def _persona_hints_from_body(body: AgentGeminiLiveTokenRequest) -> RelayPersonaHints:
    return _compact_persona_hints(
        {
            "screen": body.screen,
            "persona": body.persona,
            "route_family": body.route_family,
            "voice_state": body.voice_state,
            "available_action_ids": body.available_action_ids,
            "visible_modules": body.visible_modules,
            "cache_freshness": body.cache_freshness,
            "vault_ready": body.vault_ready,
            "portfolio_ready": body.portfolio_ready,
        }
    )


def _persona_hints_from_query(websocket: WebSocket) -> RelayPersonaHints:
    def _query_bool(key: str) -> Optional[bool]:
        value = (websocket.query_params.get(key) or "").strip().lower()
        if value in {"1", "true", "yes"}:
            return True
        if value in {"0", "false", "no"}:
            return False
        return None

    return _compact_persona_hints(
        {
            "screen": websocket.query_params.get("screen"),
            "persona": websocket.query_params.get("persona"),
            "route_family": websocket.query_params.get("route_family"),
            "voice_state": websocket.query_params.get("voice_state"),
            "available_action_ids": websocket.query_params.getlist("action_id"),
            "visible_modules": websocket.query_params.getlist("module"),
            "cache_freshness": websocket.query_params.get("cache_freshness"),
            "vault_ready": _query_bool("vault_ready"),
            "portfolio_ready": _query_bool("portfolio_ready"),
        }
    )


def _merge_persona_hints(
    ticket_hints: RelayPersonaHints,
    query_hints: RelayPersonaHints,
) -> RelayPersonaHints:
    """Prefer POST-bound ticket hints, then fall back to legacy query hints."""

    merged = dict(query_hints)
    for key, value in ticket_hints.items():
        if value in (None, "", []):
            continue
        merged[key] = value
    return merged


def _hint_str(hints: RelayPersonaHints, key: str) -> Optional[str]:
    value = hints.get(key)
    return value if isinstance(value, str) else None


def _hint_bool(hints: RelayPersonaHints, key: str) -> Optional[bool]:
    value = hints.get(key)
    return value if isinstance(value, bool) else None


def _hint_list(hints: RelayPersonaHints, key: str) -> list[str]:
    value = hints.get(key)
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def _relay_ticket_secret() -> Optional[str]:
    try:
        return get_core_security_settings().app_signing_key
    except ValueError:
        return None


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(f"{value}{padding}")


def _sign_relay_ticket_payload(payload_segment: str, secret: str) -> str:
    signature = hmac.new(
        secret.encode("utf-8"),
        payload_segment.encode("ascii"),
        hashlib.sha256,
    ).digest()
    return _b64url_encode(signature)


def _prune_relay_tickets(now_monotonic: float) -> None:
    expired = [
        ticket
        for ticket, (_uid, _tier, _hints, expires_monotonic) in _RELAY_TICKETS.items()
        if expires_monotonic <= now_monotonic
    ]
    for ticket in expired:
        _RELAY_TICKETS.pop(ticket, None)
    now_epoch = int(datetime.now(tz=timezone.utc).timestamp())
    expired_nonces = [
        nonce for nonce, expires_at in _RELAY_TICKET_NONCES.items() if expires_at <= now_epoch
    ]
    for nonce in expired_nonces:
        _RELAY_TICKET_NONCES.pop(nonce, None)


def _issue_relay_ticket(
    uid: Optional[str],
    persona_tier: PersonaTier,
    persona_hints: Optional[RelayPersonaHints] = None,
) -> tuple[str, int]:
    now_monotonic = time.monotonic()
    _prune_relay_tickets(now_monotonic)
    expires_at = int(datetime.now(tz=timezone.utc).timestamp()) + _SESSION_START_WINDOW_SECONDS
    secret = _relay_ticket_secret()
    hints = _compact_persona_hints(persona_hints or {})
    if secret:
        payload = {
            "uid": uid,
            "tier": persona_tier,
            "exp": expires_at,
            "nonce": secrets.token_urlsafe(18),
        }
        if hints:
            payload["ctx"] = hints
        payload_segment = _b64url_encode(
            json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
        )
        signature = _sign_relay_ticket_payload(payload_segment, secret)
        return f"{_SIGNED_RELAY_TICKET_PREFIX}.{payload_segment}.{signature}", expires_at

    ticket = secrets.token_urlsafe(32)
    expires_monotonic = now_monotonic + _SESSION_START_WINDOW_SECONDS
    _RELAY_TICKETS[ticket] = (uid, persona_tier, hints, expires_monotonic)
    return ticket, expires_at


def _consume_relay_ticket(
    ticket: Optional[str],
) -> tuple[bool, Optional[str], PersonaTier, RelayPersonaHints]:
    clean = (ticket or "").strip()
    if not clean:
        return False, None, "anon_onboarding", {}
    now_monotonic = time.monotonic()
    _prune_relay_tickets(now_monotonic)
    if clean.startswith(f"{_SIGNED_RELAY_TICKET_PREFIX}."):
        secret = _relay_ticket_secret()
        if not secret:
            return False, None, "anon_onboarding", {}
        parts = clean.split(".")
        if len(parts) != 3:
            return False, None, "anon_onboarding", {}
        _version, payload_segment, signature = parts
        expected_signature = _sign_relay_ticket_payload(payload_segment, secret)
        if not hmac.compare_digest(signature, expected_signature):
            return False, None, "anon_onboarding", {}
        try:
            payload = json.loads(_b64url_decode(payload_segment))
        except (TypeError, ValueError, json.JSONDecodeError, binascii.Error):
            return False, None, "anon_onboarding", {}
        expires_at = int(payload.get("exp") or 0)
        if expires_at <= int(datetime.now(tz=timezone.utc).timestamp()):
            return False, None, "anon_onboarding", {}
        nonce = str(payload.get("nonce") or "").strip()
        if not nonce or nonce in _RELAY_TICKET_NONCES:
            return False, None, "anon_onboarding", {}
        _RELAY_TICKET_NONCES[nonce] = expires_at
        uid_value = payload.get("uid")
        uid = uid_value if isinstance(uid_value, str) and uid_value else None
        tier_value = payload.get("tier")
        tier = (
            tier_value
            if tier_value
            in {"anon_onboarding", "anon_browsing", "signed_locked", "signed_unlocked"}
            else _resolve_persona_tier(uid, None)
        )
        ctx_value = payload.get("ctx")
        hints = _compact_persona_hints(ctx_value if isinstance(ctx_value, dict) else {})
        return True, uid, tier, hints

    stored = _RELAY_TICKETS.pop(clean, None)
    if stored is None:
        return False, None, "anon_onboarding", {}
    uid, tier, hints, expires_monotonic = stored
    if expires_monotonic <= now_monotonic:
        return False, None, "anon_onboarding", {}
    return True, uid, tier, hints


@router.post(
    "/agent/realtime/gemini/relay-session",
    response_model=AgentGeminiLiveRelaySessionResponse,
)
@limiter.limit(RateLimits.AGENT_CHAT)
async def create_agent_gemini_live_relay_session(
    request: Request,
    body: AgentGeminiLiveTokenRequest,
    authorization: Optional[str] = Header(default=None),
) -> AgentGeminiLiveRelaySessionResponse:
    """Mint an opaque, short-lived relay ticket for the backend Live WebSocket."""

    if not _gemini_live_enabled():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Gemini Live voice is not enabled.",
        )

    uid = await _resolve_optional_uid(authorization)
    persona_tier = _resolve_persona_tier(uid, body.access_tier)
    tier = "full" if uid else "intro"
    ticket, expires_at = _issue_relay_ticket(uid, persona_tier, _persona_hints_from_body(body))
    return AgentGeminiLiveRelaySessionResponse(
        relay_ticket=ticket,
        expires_at=expires_at,
        model=_VERTEX_LIVE_MODEL,
        voice=_resolve_voice(body.voice),
        tier=tier,
    )


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
    persona_tier = _resolve_persona_tier(uid, body.access_tier)
    persona_ctx = build_persona_context(
        tier=persona_tier,
        screen=body.screen,
        persona=body.persona,
        route_family=body.route_family,
        voice_state=body.voice_state,
        available_action_ids=body.available_action_ids,
        visible_modules=body.visible_modules,
        cache_freshness=body.cache_freshness,
        vault_ready=body.vault_ready,
        portfolio_ready=body.portfolio_ready,
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
_ONE_VOICE_ACTION_PROPOSAL_TOOL = "one_voice_propose_action"


def _read_attr_or_key(value: Any, key: str) -> Any:
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _read_text_field(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = _read_attr_or_key(value, "text") or _read_attr_or_key(value, "transcript")
    if isinstance(text, str) and text.strip():
        return text.strip()
    return None


def _read_mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if value is None:
        return {}
    to_json = getattr(value, "to_json_dict", None)
    if callable(to_json):
        try:
            raw = to_json()
            return raw if isinstance(raw, dict) else {}
        except Exception:  # noqa: BLE001 - best-effort provider normalization
            return {}
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        try:
            raw = model_dump(exclude_none=True)
            return raw if isinstance(raw, dict) else {}
        except Exception:  # noqa: BLE001 - best-effort provider normalization
            return {}
    return {}


def _extract_transcription_text(
    response: Any, *, direction: Literal["input", "output"]
) -> Optional[str]:
    """Best-effort extractor for Live transcription fields across SDK shapes."""

    field_names = (
        ("input_transcription", "inputTranscription")
        if direction == "input"
        else ("output_transcription", "outputTranscription")
    )
    for field_name in field_names:
        text = _read_text_field(_read_attr_or_key(response, field_name))
        if text:
            return text
    server_content = _read_attr_or_key(response, "server_content") or _read_attr_or_key(
        response, "serverContent"
    )
    for field_name in field_names:
        text = _read_text_field(_read_attr_or_key(server_content, field_name))
        if text:
            return text
    return None


def _normalize_action_proposal_args(args: Any) -> Optional[dict[str, Any]]:
    raw = _read_mapping(args)
    action_id = raw.get("action_id") or raw.get("actionId")
    if not isinstance(action_id, str) or not action_id.strip():
        return None
    slots = raw.get("slots") if isinstance(raw.get("slots"), dict) else {}
    return {
        "action_id": action_id.strip()[:160],
        "slots": slots,
        "confidence": raw.get("confidence")
        if isinstance(raw.get("confidence"), (int, float))
        else None,
        "reason": raw.get("reason") if isinstance(raw.get("reason"), str) else None,
        "needs_confirmation": bool(raw.get("needs_confirmation") or raw.get("needsConfirmation")),
    }


class _ActionProposalCall(NamedTuple):
    proposal: dict[str, Any]
    call_id: Optional[str]
    name: str


def _extract_action_proposal_calls(response: Any) -> list[_ActionProposalCall]:
    """Extract provider function calls as proposal-only app signals.

    Gemini Live function calling is synchronous for the Gemini 3.1 Live preview:
    the relay must acknowledge every provider tool call even though Hussh never
    executes the action provider-side. The call id/name are therefore retained
    for ``send_tool_response`` while the proposal payload is forwarded to the
    frontend One Goal path.
    """

    calls: list[_ActionProposalCall] = []
    tool_call = _read_attr_or_key(response, "tool_call") or _read_attr_or_key(response, "toolCall")
    function_calls = _read_attr_or_key(tool_call, "function_calls") or _read_attr_or_key(
        tool_call, "functionCalls"
    )
    if isinstance(function_calls, list):
        for call in function_calls:
            name = _read_attr_or_key(call, "name")
            if name != _ONE_VOICE_ACTION_PROPOSAL_TOOL:
                continue
            proposal = _normalize_action_proposal_args(_read_attr_or_key(call, "args"))
            if proposal:
                call_id = _read_attr_or_key(call, "id")
                calls.append(
                    _ActionProposalCall(
                        proposal=proposal,
                        call_id=call_id if isinstance(call_id, str) and call_id.strip() else None,
                        name=name,
                    )
                )

    server_content = _read_attr_or_key(response, "server_content") or _read_attr_or_key(
        response, "serverContent"
    )
    model_turn = _read_attr_or_key(server_content, "model_turn") or _read_attr_or_key(
        server_content, "modelTurn"
    )
    parts = _read_attr_or_key(model_turn, "parts")
    if isinstance(parts, list):
        for part in parts:
            function_call = _read_attr_or_key(part, "function_call") or _read_attr_or_key(
                part, "functionCall"
            )
            if not function_call:
                continue
            name = _read_attr_or_key(function_call, "name")
            if name != _ONE_VOICE_ACTION_PROPOSAL_TOOL:
                continue
            proposal = _normalize_action_proposal_args(_read_attr_or_key(function_call, "args"))
            if proposal:
                call_id = _read_attr_or_key(function_call, "id")
                calls.append(
                    _ActionProposalCall(
                        proposal=proposal,
                        call_id=call_id if isinstance(call_id, str) and call_id.strip() else None,
                        name=name,
                    )
                )
    return calls


def _extract_action_proposals(response: Any) -> list[dict[str, Any]]:
    """Compatibility helper for tests and callers that only need proposals."""

    return [call.proposal for call in _extract_action_proposal_calls(response)]


def _build_proposal_tool_responses(genai_types: Any, calls: list[_ActionProposalCall]) -> list[Any]:
    """Build synchronous Live API FunctionResponse acknowledgements.

    The response intentionally says "proposal_received" rather than success.
    Execution still belongs to One Goal and the generated gateway.
    """

    responses: list[Any] = []
    for call in calls:
        response_payload = {
            "result": "proposal_received",
            "execution": "not_executed_by_provider",
            "next": "hussh_one_goal_planner_validates_gateway_guards_and_settlement",
            "action_id": call.proposal.get("action_id"),
        }
        try:
            kwargs: dict[str, Any] = {
                "name": call.name,
                "response": response_payload,
            }
            if call.call_id:
                kwargs["id"] = call.call_id
            responses.append(genai_types.FunctionResponse(**kwargs))
        except Exception:  # noqa: BLE001 - SDK shape fallback for relay tests/older clients
            fallback: dict[str, Any] = {
                "name": call.name,
                "response": response_payload,
            }
            if call.call_id:
                fallback["id"] = call.call_id
            responses.append(fallback)
    return responses


def _build_action_proposal_tools(genai_types: Any) -> Optional[list[Any]]:
    """Return proposal-only Live tools when the installed SDK supports them."""

    try:
        # Keep schema broad for SDK compatibility; the app gateway validates the
        # action id, slots, availability, and confirmation policy later.
        declaration = genai_types.FunctionDeclaration(
            name=_ONE_VOICE_ACTION_PROPOSAL_TOOL,
            description=(
                "Proposal-only signal for Hussh One Voice. Provide a generated "
                "action_id, slots, confidence, and reason. Never execute the action."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "action_id": {"type": "string"},
                    "slots": {"type": "object"},
                    "confidence": {"type": "number"},
                    "reason": {"type": "string"},
                    "needs_confirmation": {"type": "boolean"},
                },
                "required": ["action_id"],
            },
        )
        return [genai_types.Tool(function_declarations=[declaration])]
    except Exception:  # noqa: BLE001 - older SDKs can run transcript-only
        return None


def _with_live_proposal_instructions(instructions: str) -> str:
    return (
        f"{instructions}\n\n"
        "Gemini Live action bridge: operate Agent First. Use the system "
        "instruction, active app state, and generated action contracts to infer "
        "the user's goal. When the user asks for an app action, you may call "
        f"{_ONE_VOICE_ACTION_PROPOSAL_TOOL} with a generated action id, slots, "
        "confidence, and reason as a proposal only. The provider must never claim "
        "execution. Hussh One will validate guards, confirmation policy, A2A "
        "delegation, and route settlement through the generated gateway before "
        "any action occurs."
    )


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

    base_kwargs = {
        "response_modalities": ["AUDIO"],
        "system_instruction": _with_live_proposal_instructions(instructions),
        "speech_config": genai_types.SpeechConfig(
            voice_config=genai_types.VoiceConfig(
                prebuilt_voice_config=genai_types.PrebuiltVoiceConfig(voice_name=voice)
            )
        ),
        "input_audio_transcription": genai_types.AudioTranscriptionConfig(),
        "output_audio_transcription": genai_types.AudioTranscriptionConfig(),
    }
    proposal_tools = _build_action_proposal_tools(genai_types)
    if proposal_tools:
        with contextlib.suppress(TypeError, ValueError):
            return genai_types.LiveConnectConfig(**base_kwargs, tools=proposal_tools)
    return genai_types.LiveConnectConfig(**base_kwargs)


@router.websocket("/agent/realtime/gemini/live")
async def agent_gemini_live_relay(websocket: WebSocket) -> None:
    """Relay browser audio to/from a Vertex AI Live session via ADC."""

    await websocket.accept()

    if not _gemini_live_enabled():
        await websocket.close(code=1011, reason="Gemini Live voice is not enabled.")
        return

    # Auth-optional, same tier model as the token route. Modern clients mint a
    # short-lived opaque relay ticket over HTTPS so Firebase bearers do not ride
    # in WebSocket URLs. The authorization query parameter remains as a
    # compatibility fallback for older clients only.
    relay_ticket = websocket.query_params.get("relay_ticket")
    uid: Optional[str] = None
    ticket_hints: RelayPersonaHints = {}
    if relay_ticket:
        accepted, uid, persona_tier, ticket_hints = _consume_relay_ticket(relay_ticket)
        if not accepted:
            await websocket.close(code=1008, reason="Voice relay ticket is expired.")
            return
    else:
        authorization = websocket.query_params.get("authorization")
        if authorization and not authorization.startswith("Bearer "):
            authorization = f"Bearer {authorization}"
        uid = await _resolve_optional_uid(authorization)
        persona_tier = _resolve_persona_tier(
            uid,
            websocket.query_params.get("access_tier"),
        )
    persona_hints = _merge_persona_hints(ticket_hints, _persona_hints_from_query(websocket))
    persona_ctx = build_persona_context(
        tier=persona_tier,
        screen=_hint_str(persona_hints, "screen"),
        persona=_hint_str(persona_hints, "persona"),
        route_family=_hint_str(persona_hints, "route_family"),
        voice_state=_hint_str(persona_hints, "voice_state"),
        available_action_ids=_hint_list(persona_hints, "available_action_ids"),
        visible_modules=_hint_list(persona_hints, "visible_modules"),
        cache_freshness=_hint_str(persona_hints, "cache_freshness"),
        vault_ready=_hint_bool(persona_hints, "vault_ready"),
        portfolio_ready=_hint_bool(persona_hints, "portfolio_ready"),
    )
    instructions = compose_voice_instructions(persona_ctx)
    voice = _resolve_voice(websocket.query_params.get("voice"))

    try:
        client = _resolve_vertex_live_client()
        live_config = _build_live_config(voice, instructions)
        from google.genai import types as genai_types
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
                    if message.get("type") == "interrupt" or message.get("interrupt") is True:
                        # The provider stream owns actual interruption semantics;
                        # locally we acknowledge the app request and let the next
                        # realtime audio frame continue the session.
                        await websocket.send_text(
                            json.dumps({"serverContent": {"interrupted": True}})
                        )
                        continue
                    if message.get("type") == "app_speech" or "appSpeech" in message:
                        speech_payload = message.get("appSpeech")
                        if not isinstance(speech_payload, dict):
                            speech_payload = message
                        text = (
                            speech_payload.get("text") if isinstance(speech_payload, dict) else None
                        )
                        if not isinstance(text, str) or not text.strip():
                            continue
                        # Best-effort app-owned speech through the active Live
                        # session. This asks Gemini to synthesize the exact
                        # app-composed text; if the SDK shape differs, the
                        # frontend falls back to its non-Live TTS path.
                        try:
                            await session.send_client_content(
                                turns={
                                    "role": "user",
                                    "parts": [
                                        {
                                            "text": (
                                                "Speak exactly this app-composed One Voice "
                                                f"response and do not add anything: {text.strip()}"
                                            )
                                        }
                                    ],
                                },
                                turn_complete=True,
                            )
                        except Exception as error:  # noqa: BLE001 - fallback signal only
                            await websocket.send_text(
                                json.dumps(
                                    {
                                        "appSpeechError": {
                                            "message": "Live app speech is unavailable.",
                                            "provider_error": error.__class__.__name__,
                                        }
                                    }
                                )
                            )
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
                        input_transcript = _extract_transcription_text(response, direction="input")
                        if input_transcript:
                            await websocket.send_text(
                                json.dumps({"inputTranscription": {"text": input_transcript}})
                            )
                        output_transcript = _extract_transcription_text(
                            response, direction="output"
                        )
                        if output_transcript:
                            await websocket.send_text(
                                json.dumps({"outputTranscription": {"text": output_transcript}})
                            )
                        proposal_calls = _extract_action_proposal_calls(response)
                        for proposal_call in proposal_calls:
                            await websocket.send_text(
                                json.dumps({"actionProposal": proposal_call.proposal})
                            )
                        if proposal_calls:
                            try:
                                await session.send_tool_response(
                                    function_responses=_build_proposal_tool_responses(
                                        genai_types, proposal_calls
                                    )
                                )
                            except Exception as error:  # noqa: BLE001 - keep relay alive
                                logger.warning(
                                    "agent_gemini_live_tool_ack_failed count=%s error=%s",
                                    len(proposal_calls),
                                    error.__class__.__name__,
                                )
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
