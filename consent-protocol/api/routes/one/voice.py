"""One Live Voice routes: readiness, session tickets, and the Live relay.

The retired ``/api/one/adk/*`` voice paths stay as explicit retirement
responders in :mod:`api.routes.one.retired_voice`; this module owns the
maintained surface under ``/api/one/voice``. No provider client is constructed
while ``ONE_VOICE_LIVE_ENABLED`` is off.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket
from fastapi.concurrency import run_in_threadpool
from google.genai import types as genai_types
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import (
    _enforce_account_lifecycle_status,
    require_firebase_auth,
    require_vault_owner_token,
)
from api.middlewares.rate_limit import RateLimits, limiter
from hushh_mcp.consent.token import validate_token_with_db
from hushh_mcp.constants import ConsentScope
from hushh_mcp.one_voice import protocol
from hushh_mcp.one_voice.config import (
    PROTOCOL_VERSION,
    OneVoiceConfigError,
    OneVoiceLiveConfig,
)
from hushh_mcp.one_voice.live_client import build_live_config, connect_live
from hushh_mcp.one_voice.pending_actions import PendingActionConflict, PendingActionStore
from hushh_mcp.one_voice.session import AuthResult, VoiceSession
from hushh_mcp.one_voice.tickets import TicketClaims, TicketError, consume_ticket, issue_ticket
from hushh_mcp.one_voice.tools import registry
from hushh_mcp.one_voice.tools.base import EntityContext, ScreenContext, ToolContext
from hushh_mcp.one_voice.tools.executor import ToolExecutor
from hushh_mcp.runtime_providers.dependency_health import classify_provider_error
from hushh_mcp.runtime_providers.factory import build_managed_live_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/voice", tags=["One voice"])

_READINESS_PROBE_TIMEOUT_SECONDS = 8.0
_READINESS_TTL_SECONDS = 60.0

ReadinessStatus = Literal["ready", "disabled", "not_configured", "provider_unavailable"]


class VoiceReadinessResponse(BaseModel):
    """The single flag the frontend reads to decide which voice owner mounts."""

    enabled: bool
    status: ReadinessStatus
    model: str | None = None
    location: str | None = None
    protocol_version: Literal["one-voice-v1"] = PROTOCOL_VERSION
    ws_path: str = "/api/one/voice/live"


_readiness_cache: tuple[float, VoiceReadinessResponse] | None = None


def reset_readiness_cache() -> None:
    global _readiness_cache
    _readiness_cache = None


async def _probe_live_connect(config: OneVoiceLiveConfig) -> None:
    """Open and immediately close one Live session. No audio, no output."""
    client = build_managed_live_client(model=config.model_id, location=config.location)
    # Native-audio Live models refuse a TEXT-only session; opening with AUDIO and
    # closing immediately proves availability without sending or receiving audio.
    live_config = genai_types.LiveConnectConfig(response_modalities=[genai_types.Modality.AUDIO])
    async with client.aio.live.connect(model=config.model_id, config=live_config):
        return


async def compute_readiness() -> VoiceReadinessResponse:
    """Evaluate the flag, the contract, and (when enabled) a cached connect probe."""
    global _readiness_cache
    now = time.monotonic()
    if _readiness_cache and now - _readiness_cache[0] <= _READINESS_TTL_SECONDS:
        return _readiness_cache[1]
    try:
        config = OneVoiceLiveConfig.from_environment()
    except OneVoiceConfigError:
        logger.warning("one_voice.readiness reason=not_configured")
        response = VoiceReadinessResponse(enabled=False, status="not_configured")
        _readiness_cache = (now, response)
        return response
    if not config.enabled:
        # Not cached: turning the flag on must take effect on the next request.
        return VoiceReadinessResponse(enabled=False, status="disabled")
    try:
        await asyncio.wait_for(
            _probe_live_connect(config), timeout=_READINESS_PROBE_TIMEOUT_SECONDS
        )
    except Exception as exc:  # noqa: BLE001 - classified, never reflected
        logger.warning(
            "one_voice.readiness reason=provider_unavailable class=%s",
            classify_provider_error(exc),
        )
        response = VoiceReadinessResponse(
            enabled=False,
            status="provider_unavailable",
            model=config.model_id,
            location=config.location,
        )
        _readiness_cache = (now, response)
        return response
    response = VoiceReadinessResponse(
        enabled=True,
        status="ready",
        model=config.model_id,
        location=config.location,
    )
    _readiness_cache = (now, response)
    return response


@router.get("/readiness", response_model=VoiceReadinessResponse)
@limiter.limit(RateLimits.AGENT_CHAT)
async def voice_readiness(
    request: Request,
    _firebase_uid: str = Depends(require_firebase_auth),
) -> VoiceReadinessResponse:
    """Cached, output-suppressed proof that a Live session can be opened.

    Always HTTP 200: the frontend decides what to mount from ``enabled``. A
    provider outage reports ``provider_unavailable`` and hides the control; it
    never falls back to another model or region.
    """
    return await compute_readiness()


# --------------------------------------------------------------------------
# Session tickets
# --------------------------------------------------------------------------


class VoiceSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    conversation_id: str = Field(min_length=36, max_length=36)
    client: Literal["web", "ios", "android"] = "web"


class VoiceSessionResponse(BaseModel):
    ticket: str
    expires_at: int
    session_id: str
    ws_path: str = "/api/one/voice/live"
    protocol_version: Literal["one-voice-v1"] = PROTOCOL_VERSION


# Per-instance bookkeeping: one live session per user, bounded per instance.
_active_sessions: dict[str, VoiceSession] = {}
_active_lock = asyncio.Lock()


def _require_enabled() -> OneVoiceLiveConfig:
    try:
        config = OneVoiceLiveConfig.from_environment()
    except OneVoiceConfigError:
        raise HTTPException(
            status_code=503,
            detail={"code": "ONE_VOICE_NOT_CONFIGURED", "message": "Voice is not configured."},
        ) from None
    if not config.enabled:
        raise HTTPException(
            status_code=404,
            detail={"code": "ONE_VOICE_LIVE_DISABLED", "message": "Voice is not available."},
        )
    return config


@router.post("/sessions", response_model=VoiceSessionResponse)
@limiter.limit(RateLimits.AGENT_CHAT)
async def mint_voice_session(
    request: Request,
    payload: VoiceSessionRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> VoiceSessionResponse:
    """Mint a single-use ticket that may open the Live socket (60 s)."""
    _require_enabled()
    user_id = str(token_data.get("user_id") or "").strip()
    try:
        uuid.UUID(payload.conversation_id)
    except ValueError:
        raise HTTPException(status_code=422, detail={"code": "CONVERSATION_ID_INVALID"}) from None
    session_id = uuid.uuid4().hex
    try:
        ticket, expires_at = issue_ticket(
            user_id=user_id, session_id=session_id, conversation_id=payload.conversation_id
        )
    except TicketError:
        raise HTTPException(status_code=503, detail={"code": "ONE_VOICE_NOT_CONFIGURED"}) from None
    return VoiceSessionResponse(ticket=ticket, expires_at=expires_at, session_id=session_id)


# --------------------------------------------------------------------------
# The relay
# --------------------------------------------------------------------------


async def verify_voice_auth(frame: protocol.AuthFrame, claims: TicketClaims) -> AuthResult:
    """Validate the vault-owner token (DB revocation + lifecycle) and, when
    present, the Firebase proof. Both must name the ticket's user."""
    valid, _reason, token_obj = await validate_token_with_db(
        frame.vault_owner_token, ConsentScope.VAULT_OWNER
    )
    if not valid or token_obj is None:
        raise PermissionError("Vault owner token is invalid.")
    user_id = str(getattr(token_obj, "user_id", "") or "").strip()
    if not user_id or user_id != claims.user_id:
        raise PermissionError("Token does not match the ticket.")
    await _enforce_account_lifecycle_status(user_id)
    firebase_uid: str | None = None
    if frame.firebase_id_token:
        from api.utils.firebase_auth import verify_firebase_bearer

        try:
            firebase_uid = await run_in_threadpool(
                verify_firebase_bearer, f"Bearer {frame.firebase_id_token}", check_revoked=True
            )
        except Exception:  # noqa: BLE001 - treat as absent, never as another user
            raise PermissionError("Sign-in proof is invalid.") from None
        if firebase_uid != user_id:
            raise PermissionError("Sign-in proof does not match the ticket.")
    display_name: str | None = None
    try:
        from hushh_mcp.services.actor_identity_service import ActorIdentityService

        identity = (await ActorIdentityService().get_many([user_id])).get(user_id) or {}
        display_name = str(identity.get("display_name") or "").strip() or None
    except Exception:  # noqa: BLE001 - name is a nicety
        display_name = None
    return AuthResult(
        user_id=user_id,
        vault_owner_token=frame.vault_owner_token,
        firebase_id_token=frame.firebase_id_token if firebase_uid else None,
        display_name=display_name,
    )


def _live_factory(config: OneVoiceLiveConfig):
    from hushh_mcp.one_voice.instruction import voice_name

    @asynccontextmanager
    async def _factory(model: str, live_config: dict[str, Any]):
        cfg = build_live_config(
            system_instruction=str(live_config["system_instruction"]),
            tool_declarations=list(live_config["tool_declarations"]),
            voice_name=voice_name(),
            resumption_handle=live_config.get("resumption_handle"),
        )
        async with connect_live(config, cfg) as live:
            yield live

    return _factory


class _WebSocketTransport:
    def __init__(self, websocket: WebSocket) -> None:
        self._ws = websocket

    async def receive(self) -> str:
        return await self._ws.receive_text()

    async def send(self, frame: dict[str, Any]) -> None:
        await self._ws.send_json(frame)

    async def close(self, code: int, reason: str) -> None:
        await self._ws.close(code=code, reason=reason[:120])


def _allowed_origins() -> set[str]:
    from hushh_mcp.runtime_settings import get_app_runtime_settings

    origins: set[str] = set()
    frontend_origin = get_app_runtime_settings().app_frontend_origin
    for raw in (frontend_origin, os.getenv("CORS_ALLOWED_ORIGINS", "")):
        for item in str(raw).split(","):
            clean = item.strip().rstrip("/").lower()
            if clean and clean != "*":
                origins.add(clean)
    # Capacitor shells.
    origins.update(
        {
            "capacitor://localhost",
            "ionic://localhost",
            "app://localhost",
            "http://localhost",
            "https://localhost",
        }
    )
    return origins


def _origin_allowed(websocket: WebSocket) -> bool:
    origin = str(websocket.headers.get("origin") or "").strip().rstrip("/").lower()
    if not origin:
        # Native clients may omit Origin entirely.
        return True
    if os.getenv("ENVIRONMENT", "").strip().lower() in {
        "",
        "development",
        "dev",
        "test",
    } and origin.startswith("http://localhost"):
        return True
    return origin in _allowed_origins()


@router.websocket("/live")
async def voice_live(websocket: WebSocket, ticket: str = Query(default="")) -> None:
    await websocket.accept()
    try:
        config = OneVoiceLiveConfig.from_environment()
    except OneVoiceConfigError:
        await websocket.send_json(
            protocol.error("ONE_VOICE_NOT_CONFIGURED", "Voice is not configured.")
        )
        await websocket.close(code=protocol.CLOSE_DISABLED)
        return
    if not config.enabled:
        # Mirrors retired_voice.py: no provider is constructed while disabled.
        await websocket.send_json(
            protocol.error("ONE_VOICE_LIVE_DISABLED", "Voice is not available.")
        )
        await websocket.close(code=protocol.CLOSE_DISABLED)
        return
    if not _origin_allowed(websocket):
        await websocket.close(code=protocol.CLOSE_AUTH)
        return
    try:
        claims = await consume_ticket(ticket)
    except TicketError as exc:
        await websocket.send_json(protocol.error(str(exc), "Voice ticket was not accepted."))
        await websocket.close(code=protocol.CLOSE_TICKET)
        return

    session = VoiceSession(
        transport=_WebSocketTransport(websocket),
        config=config,
        claims=claims,
        verify_auth=verify_voice_auth,
        live_factory=_live_factory(config),
    )
    async with _active_lock:
        if (
            len(_active_sessions) >= config.max_sessions_per_instance
            and claims.user_id not in _active_sessions
        ):
            await websocket.send_json(protocol.error("capacity", "Voice is busy right now."))
            await websocket.close(code=protocol.CLOSE_CAPACITY)
            return
        previous = _active_sessions.get(claims.user_id)
        _active_sessions[claims.user_id] = session
    if previous is not None:
        await previous._close(protocol.CLOSE_REPLACED, "replaced")
    try:
        await session.run()
    finally:
        async with _active_lock:
            if _active_sessions.get(claims.user_id) is session:
                _active_sessions.pop(claims.user_id, None)


# --------------------------------------------------------------------------
# Pending-action HTTP twins (refresh-safe; same executor as the socket)
# --------------------------------------------------------------------------


class PendingConfirmRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    receipt_token: str | None = Field(default=None, max_length=200)
    firebase_id_token: str | None = Field(default=None, max_length=8_000)


@router.get("/pending-actions")
async def list_pending_actions(
    conversation_id: str = Query(min_length=36, max_length=36),
    token_data: dict = Depends(require_vault_owner_token),
):
    user_id = str(token_data.get("user_id") or "").strip()
    rows = await PendingActionStore().list_open(user_id=user_id, conversation_id=conversation_id)
    return {"pending_actions": [row.public() for row in rows]}


async def _tool_context_for(
    token_data: dict, pending_conversation_id: str, firebase_id_token: str | None
) -> ToolContext:
    from hushh_mcp.one_voice.conversations import ConversationStore

    user_id = str(token_data.get("user_id") or "").strip()
    conversation = await ConversationStore().get(
        user_id=user_id, conversation_id=pending_conversation_id
    )
    try:
        entities = EntityContext.model_validate(
            (conversation.entity_context if conversation else None) or {}
        )
    except Exception:  # noqa: BLE001
        entities = EntityContext()
    return ToolContext(
        user_id=user_id,
        conversation_id=pending_conversation_id,
        entities=entities,
        screen=ScreenContext(),
        vault_owner_token=str(token_data.get("token") or ""),
        firebase_id_token=firebase_id_token,
    )


@router.post("/pending-actions/{pending_action_id}/confirm")
async def confirm_pending_action_http(
    pending_action_id: str,
    payload: PendingConfirmRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    user_id = str(token_data.get("user_id") or "").strip()
    store = PendingActionStore()
    row = await store.get(user_id=user_id, pending_action_id=pending_action_id)
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "PENDING_ACTION_NOT_FOUND"})
    spec = registry.get_tool(row.tool_name)
    if spec is not None and spec.device_step:
        # The result hands the device a step (publish the encrypted position)
        # that only the live session can run and verify; confirming here would
        # arm an effect nobody publishes or reports. The row stays pending so
        # the session's card can still be tapped.
        raise HTTPException(
            status_code=409,
            detail={"code": "SESSION_CONFIRM_REQUIRED", "tool": row.tool_name},
        )
    if spec is not None and spec.firebase_plane:
        from hushh_mcp.one_voice.actor_proof import verify_firebase_actor

        proof = await verify_firebase_actor(payload.firebase_id_token, user_id)
        if proof != "ok":
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "FIREBASE_PROOF_REQUIRED"
                    if proof == "missing"
                    else "FIREBASE_PROOF_INVALID"
                },
            )
    try:
        confirmed = await store.confirm(
            user_id=user_id,
            pending_action_id=pending_action_id,
            source="http",
            receipt_token=payload.receipt_token,
        )
    except PendingActionConflict as exc:
        raise HTTPException(
            status_code=409, detail={"code": "PENDING_ACTION_CONFLICT", "reason": str(exc)}
        ) from None
    ctx = await _tool_context_for(token_data, row.conversation_id, payload.firebase_id_token)
    outcome = await ToolExecutor(pending_store=store).execute_pending(ctx, confirmed)
    return {
        "pending_action": (outcome.pending.public() if outcome.pending else None),
        "result": outcome.result.public(),
    }


@router.post("/pending-actions/{pending_action_id}/cancel")
async def cancel_pending_action_http(
    pending_action_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    user_id = str(token_data.get("user_id") or "").strip()
    row = await PendingActionStore().cancel(user_id=user_id, pending_action_id=pending_action_id)
    if row is None:
        raise HTTPException(status_code=409, detail={"code": "PENDING_ACTION_NOT_PENDING"})
    return {"pending_action": row.public()}
