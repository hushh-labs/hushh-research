import asyncio
import hashlib
import json
import logging
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from api.middleware import require_vault_owner_token
from api.routes.kai.portfolio import _IMPORT_RUN_MANAGER
from api.routes.kai.stream import _RUN_MANAGER
from hushh_mcp.runtime_settings import VoiceRuntimeSettings, get_voice_runtime_settings
from hushh_mcp.services.voice_intent_service import (
    _PLANNER_NORMALIZATION_VERSION,
    VoiceIntentService,
    VoiceServiceError,
    _is_executable_tool_call,
    _response_has_executable_plan,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Kai Voice"])
voice_service = VoiceIntentService()
_VOICE_NOT_ENABLED_MESSAGE = "Voice is not enabled for this account yet."
_VOICE_KILL_SWITCH_MESSAGE = (
    "Voice actions are temporarily unavailable. I can still respond and guide you."
)
_VOICE_STAGE_TIMING: dict[str, dict[str, float]] = {}


def _voice_runtime_settings() -> VoiceRuntimeSettings:
    return get_voice_runtime_settings()


def _voice_tool_execution_disabled() -> bool:
    return _voice_runtime_settings().tool_execution_disabled


def _parse_voice_allowlist() -> set[str]:
    return set(_voice_runtime_settings().allowed_users)


def _safe_user_ref(user_id: str) -> str:
    digest = hashlib.sha256(str(user_id).encode("utf-8")).hexdigest()
    return digest[:12]


def _optional_text(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None


def _canonical_action_payload(
    response_payload: dict[str, Any],
    *,
    raw_tool_call: dict[str, Any] | None,
) -> dict[str, Any]:
    action_id = _optional_text(response_payload.get("action_id"))
    mode = _optional_text(response_payload.get("mode"))
    guards = [
        str(guard).strip()
        for guard in (response_payload.get("guards") or [])
        if str(guard or "").strip()
    ]
    if action_id:
        payload = {
            "action_id": action_id,
            "mode": mode,
            "slots": dict(response_payload.get("slots") or {}),
            "guards": guards,
            "reply_strategy": _optional_text(response_payload.get("reply_strategy")),
        }
        if _is_executable_tool_call(raw_tool_call):
            payload["legacy_tool_call"] = raw_tool_call
        return {"type": "canonical", "payload": payload}
    response_kind = _optional_text(response_payload.get("kind")) or "unknown"
    return {
        "type": "tool"
        if response_kind == "execute" and _is_executable_tool_call(raw_tool_call)
        else "none",
        "payload": raw_tool_call
        if response_kind == "execute" and _is_executable_tool_call(raw_tool_call)
        else {},
    }


def _sanitize_response_payload(response_payload: dict[str, Any]) -> dict[str, Any]:
    sanitized = dict(response_payload)
    raw_tool_call = sanitized.get("tool_call")
    if _response_has_executable_plan(sanitized):
        if not _is_executable_tool_call(raw_tool_call):
            sanitized.pop("tool_call", None)
    elif _is_executable_tool_call(raw_tool_call):
        sanitized.pop("tool_call", None)
    return sanitized


def _stable_user_bucket(user_id: str) -> int:
    digest = hashlib.sha256(str(user_id).encode("utf-8")).hexdigest()
    return int(digest[:8], 16) % 100


def _voice_rollout_state(user_id: str) -> dict[str, Any]:
    settings = _voice_runtime_settings()
    enabled_globally = settings.hosted_voice_enabled
    if not enabled_globally:
        return {
            "enabled": False,
            "reason": "globally_disabled",
            "bucket": None,
            "canary_percent": 0,
        }

    allowlist = _parse_voice_allowlist()
    if allowlist:
        in_allowlist = user_id in allowlist
        return {
            "enabled": in_allowlist,
            "reason": "allowlist" if in_allowlist else "not_allowlisted",
            "bucket": None,
            "canary_percent": None,
        }

    canary_percent = settings.canary_percent
    bucket = _stable_user_bucket(user_id)
    enabled = bucket < canary_percent
    return {
        "enabled": enabled,
        "reason": "canary_enabled" if enabled else "canary_excluded",
        "bucket": bucket,
        "canary_percent": canary_percent,
    }


def _voice_capability_state(user_id: str) -> dict[str, Any]:
    rollout = _voice_rollout_state(user_id)
    tool_execution_disabled = _voice_tool_execution_disabled()
    execution_allowed = bool(rollout["enabled"] and not tool_execution_disabled)
    realtime_enabled = bool(rollout["enabled"] and _voice_runtime_settings().realtime_enabled)
    enabled = realtime_enabled
    if enabled:
        reason = None
    elif not rollout["enabled"]:
        reason = _VOICE_NOT_ENABLED_MESSAGE
    else:
        reason = "Realtime voice is temporarily unavailable."
    return {
        "user_id": user_id,
        "enabled": enabled,
        "reason": reason,
        "voice_enabled": bool(rollout["enabled"]),
        "execution_allowed": execution_allowed,
        "tool_execution_disabled": tool_execution_disabled,
        "rollout_reason": rollout["reason"],
        "bucket": rollout["bucket"],
        "canary_percent": rollout["canary_percent"],
        "realtime_enabled": realtime_enabled,
        "tts_enabled": bool(rollout["enabled"]),
        "tts_timeout_ms": int(voice_service.tts_timeout_seconds * 1000),
        "tts_model": str(voice_service.tts_model or ""),
        "tts_voice": str(voice_service.tts_default_voice or ""),
        "tts_format": str(voice_service.tts_format or ""),
    }


def _resolve_voice_turn_id(request: Request) -> str:
    raw = (request.headers.get("x-voice-turn-id") or "").strip()
    if raw:
        return raw[:128]
    return f"vturn_{uuid.uuid4().hex}"


def _set_voice_turn_id_header(response: Response, turn_id: str) -> None:
    response.headers["X-Voice-Turn-Id"] = turn_id


def _log_voice_metric(
    name: str,
    value: int | float,
    *,
    turn_id: str,
    user_id: str,
    tags: dict[str, Any] | None = None,
) -> None:
    payload = {
        "event": "kai_voice_metric",
        "metric": name,
        "value": value,
        "turn_id": turn_id,
        "user_ref": _safe_user_ref(user_id),
        "tags": tags or {},
    }
    logger.info("[KAI_VOICE_METRIC] %s", json.dumps(payload, sort_keys=True))


def _log_voice_audit(
    *,
    turn_id: str,
    user_id: str,
    response_payload: dict[str, Any],
    meta: dict[str, Any] | None = None,
) -> None:
    payload = {
        "event": "kai_voice_audit",
        "turn_id": turn_id,
        "user_ref": _safe_user_ref(user_id),
        "kind": response_payload.get("kind"),
        "reason": response_payload.get("reason"),
        "task": response_payload.get("task"),
        "tool_name": (
            response_payload.get("tool_call", {}).get("tool_name")
            if isinstance(response_payload.get("tool_call"), dict)
            else None
        ),
        "ticker": response_payload.get("ticker"),
        "run_id": response_payload.get("run_id"),
        "execution_allowed": response_payload.get("execution_allowed"),
        "meta": meta or {},
    }
    logger.info("[KAI_VOICE_AUDIT] %s", json.dumps(payload, sort_keys=True))


def _resolve_planner_branch(*, model: str, response_kind: str, response_reason: str) -> str:
    normalized_model = str(model or "").strip().lower()
    if response_kind == "clarify" and response_reason == "stt_unusable":
        return "clarify_fallback"
    if normalized_model.startswith("deterministic"):
        return "deterministic"
    return "nano_model"


def _trace_voice_stage(
    turn_id: str,
    stage: str,
    metadata: dict[str, Any] | None = None,
    *,
    finalize: bool = False,
) -> None:
    if not turn_id:
        return
    now_ms = time.perf_counter() * 1000.0
    current = _VOICE_STAGE_TIMING.get(turn_id)
    if current is None:
        current = {
            "turn_start_ms": now_ms,
            "last_stage_ms": now_ms,
        }
        _VOICE_STAGE_TIMING[turn_id] = current
    since_prev_ms = int(max(0.0, now_ms - current["last_stage_ms"]))
    since_turn_start_ms = int(max(0.0, now_ms - current["turn_start_ms"]))
    current["last_stage_ms"] = now_ms

    payload = {
        # Compatibility field retained for existing parsers.
        "event": "kai_voice_stage_timing",
        "event_name": stage,
        "turn_id": turn_id,
        "layer": "backend",
        "source": (
            (metadata or {}).get("source")
            if isinstance((metadata or {}).get("source"), str)
            else "kai_voice_route"
        ),
        "route": (
            (metadata or {}).get("route")
            if isinstance((metadata or {}).get("route"), str)
            else None
        ),
        "timestamp_iso": datetime.now(timezone.utc).isoformat(),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "stage": stage,
        "since_prev_ms": since_prev_ms,
        "since_turn_start_ms": since_turn_start_ms,
        **(metadata or {}),
    }
    logger.info("[KAI_VOICE_TRACE_BE] %s", json.dumps(payload, sort_keys=True))

    if finalize:
        _VOICE_STAGE_TIMING.pop(turn_id, None)


async def _ensure_client_connected(
    request: Request,
    *,
    turn_id: str,
    route: str,
    stage: str = "request_aborted",
    metadata: dict[str, Any] | None = None,
    finalize: bool = True,
) -> None:
    if not await request.is_disconnected():
        return
    payload = {
        "route": route,
        "status": "aborted",
        "error": "client_disconnected",
        "client_disconnected": True,
    }
    if metadata:
        payload.update(metadata)
    _trace_voice_stage(
        turn_id,
        stage,
        payload,
        finalize=finalize,
    )
    raise HTTPException(status_code=499, detail="Client disconnected")


class AppRuntimeAuth(BaseModel):
    signed_in: bool = False
    user_id: Optional[str] = None


class AppRuntimeVault(BaseModel):
    unlocked: bool = False
    token_available: bool = False
    token_valid: bool = False


class AppRuntimeRoute(BaseModel):
    pathname: str = ""
    screen: str = ""
    subview: Optional[str] = None


class AppRuntimeRuntime(BaseModel):
    analysis_active: bool = False
    analysis_ticker: Optional[str] = None
    analysis_run_id: Optional[str] = None
    import_active: bool = False
    import_run_id: Optional[str] = None
    busy_operations: list[str] = Field(default_factory=list)


class AppRuntimePortfolio(BaseModel):
    has_portfolio_data: bool = False


class AppRuntimeVoice(BaseModel):
    available: bool = False
    tts_playing: bool = False
    last_tool_name: Optional[str] = None
    last_ticker: Optional[str] = None


class AppRuntimeState(BaseModel):
    auth: AppRuntimeAuth = Field(default_factory=AppRuntimeAuth)
    vault: AppRuntimeVault = Field(default_factory=AppRuntimeVault)
    route: AppRuntimeRoute = Field(default_factory=AppRuntimeRoute)
    runtime: AppRuntimeRuntime = Field(default_factory=AppRuntimeRuntime)
    portfolio: AppRuntimePortfolio = Field(default_factory=AppRuntimePortfolio)
    voice: AppRuntimeVoice = Field(default_factory=AppRuntimeVoice)


class VoicePlanRequest(BaseModel):
    user_id: str
    transcript: str
    context: dict[str, Any] = Field(default_factory=dict)
    app_state: Optional[AppRuntimeState] = None
    turn_id: Optional[str] = None
    transcript_final: Optional[str] = None
    context_structured: dict[str, Any] = Field(default_factory=dict)
    memory_short: list[dict[str, Any]] = Field(default_factory=list)
    memory_retrieved: list[dict[str, Any]] = Field(default_factory=list)


class VoiceMemoryHints(BaseModel):
    allow_durable_write: bool = False


class VoiceResponsePayload(BaseModel):
    kind: str
    message: str
    speak: bool = True
    execution_allowed: bool = False
    reason: Optional[str] = None
    task: Optional[str] = None
    ticker: Optional[str] = None
    run_id: Optional[str] = None
    candidate: Optional[str] = None
    tool_call: Optional[dict[str, Any]] = None


class VoiceClarificationPayload(BaseModel):
    reason: str
    question: str
    options: list[str] = Field(default_factory=list)
    candidate: Optional[str] = None


class VoicePlanResponse(BaseModel):
    response: VoiceResponsePayload
    execution_allowed: bool = False
    tool_call: dict[str, Any]
    memory: VoiceMemoryHints
    elapsed_ms: int
    openai_http_ms: int
    model: str
    turn_id: Optional[str] = None
    response_id: Optional[str] = None
    intent: Optional[dict[str, Any]] = None
    action: Optional[dict[str, Any]] = None
    needs_confirmation: bool = False
    ack_text: Optional[str] = None
    final_text: Optional[str] = None
    is_long_running: bool = False
    memory_write_candidates: list[dict[str, Any]] = Field(default_factory=list)
    schema_version: Optional[str] = None
    mode: Optional[str] = None
    action_id: Optional[str] = None
    slots: dict[str, Any] = Field(default_factory=dict)
    guards: list[str] = Field(default_factory=list)
    reply_strategy: Optional[str] = None
    clarification: Optional[VoiceClarificationPayload] = None
    action_completion: Optional[str] = None


class VoiceComposeRequest(BaseModel):
    user_id: str
    transcript: str
    response: VoiceResponsePayload
    app_state: Optional[AppRuntimeState] = None
    context: dict[str, Any] = Field(default_factory=dict)
    context_structured: dict[str, Any] = Field(default_factory=dict)
    turn_id: Optional[str] = None
    response_id: Optional[str] = None
    mode: Optional[str] = None
    action_id: Optional[str] = None
    slots: dict[str, Any] = Field(default_factory=dict)
    guards: list[str] = Field(default_factory=list)
    reply_strategy: Optional[str] = None
    clarification: Optional[VoiceClarificationPayload] = None
    action_completion: Optional[str] = None
    action_result: Optional[dict[str, Any]] = None
    memory_short: list[dict[str, Any]] = Field(default_factory=list)
    memory_retrieved: list[dict[str, Any]] = Field(default_factory=list)


class VoiceComposeResponse(BaseModel):
    text: str
    segment_type: str
    elapsed_ms: int
    openai_http_ms: int
    model: str
    turn_id: Optional[str] = None
    response_id: Optional[str] = None


class VoiceTTSRequest(BaseModel):
    user_id: str
    text: str
    voice: Optional[str] = "alloy"


class VoiceCapabilityRequest(BaseModel):
    user_id: str


class VoiceCapabilityResponse(BaseModel):
    user_id: str
    enabled: bool
    reason: Optional[str] = None
    voice_enabled: bool
    execution_allowed: bool
    tool_execution_disabled: bool
    rollout_reason: str
    bucket: Optional[int] = None
    canary_percent: Optional[int] = None
    realtime_enabled: bool = False
    tts_enabled: bool = False
    tts_timeout_ms: int
    tts_model: str
    tts_voice: str
    tts_format: str


class VoiceRealtimeSessionRequest(BaseModel):
    user_id: str
    voice: Optional[str] = None


class VoiceRealtimeSessionResponse(BaseModel):
    session_id: Optional[str] = None
    client_secret: str
    client_secret_expires_at: Optional[int] = None
    model: str
    voice: str
    transcription_model: str = "gpt-4o-mini-transcribe"
    transcription_language: str = "en"
    transcription_prompt: str = ""
    server_vad_enabled: bool = True
    silence_duration_ms: int = 800
    auto_response_enabled: bool = False
    barge_in_enabled: bool = True


async def _resolve_active_analysis(
    user_id: str, app_state: dict[str, Any]
) -> dict[str, Any] | None:
    runtime = app_state.get("runtime") if isinstance(app_state.get("runtime"), dict) else {}
    run_id = runtime.get("analysis_run_id")
    if isinstance(run_id, str) and run_id.strip():
        run = await _RUN_MANAGER.get_run(run_id.strip())
        if run and run.user_id == user_id and run.status == "running":
            return {
                "active": True,
                "source": "run_manager",
                "run_id": run.run_id,
                "ticker": run.ticker,
            }
        return {"active": False, "source": "run_manager", "run_id": run_id.strip()}

    if runtime.get("analysis_active") is True:
        ticker = runtime.get("analysis_ticker")
        return {
            "active": True,
            "source": "app_runtime",
            "run_id": run_id.strip() if isinstance(run_id, str) and run_id.strip() else None,
            "ticker": str(ticker).strip().upper() if ticker else None,
        }
    return None


async def _resolve_active_import(user_id: str, app_state: dict[str, Any]) -> dict[str, Any] | None:
    runtime = app_state.get("runtime") if isinstance(app_state.get("runtime"), dict) else {}
    run_id = runtime.get("import_run_id")
    if isinstance(run_id, str) and run_id.strip():
        run = await _IMPORT_RUN_MANAGER.get_run(run_id.strip())
        if run and run.user_id == user_id and run.status == "running":
            return {"active": True, "source": "run_manager", "run_id": run.run_id}
        return {"active": False, "source": "run_manager", "run_id": run_id.strip()}

    if runtime.get("import_active") is True:
        return {
            "active": True,
            "source": "app_runtime",
            "run_id": run_id.strip() if isinstance(run_id, str) and run_id.strip() else None,
        }
    return None


@router.post("/voice/realtime/session", response_model=VoiceRealtimeSessionResponse)
async def kai_voice_realtime_session(
    request: Request,
    http_response: Response,
    body: VoiceRealtimeSessionRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    turn_id = _resolve_voice_turn_id(request)
    _set_voice_turn_id_header(http_response, turn_id)
    _trace_voice_stage(
        turn_id,
        "backend_received",
        {
            "route": "/voice/realtime/session",
            "method": "POST",
        },
    )

    if token_data.get("user_id") != body.user_id:
        _trace_voice_stage(
            turn_id,
            "response_sent",
            {
                "route": "/voice/realtime/session",
                "status": "error",
                "http_status": 403,
                "error": "Token user_id does not match request user_id",
            },
            finalize=True,
        )
        raise HTTPException(status_code=403, detail="Token user_id does not match request user_id")

    rollout = _voice_rollout_state(body.user_id)
    if not rollout["enabled"]:
        _log_voice_metric(
            "realtime_session_rollout_blocked_count",
            1,
            turn_id=turn_id,
            user_id=body.user_id,
            tags={
                "reason": rollout["reason"],
                "canary_percent": rollout["canary_percent"],
            },
        )
        _trace_voice_stage(
            turn_id,
            "response_sent",
            {
                "route": "/voice/realtime/session",
                "status": "error",
                "http_status": 403,
                "error": _VOICE_NOT_ENABLED_MESSAGE,
                "rollout_reason": rollout["reason"],
                "canary_percent": rollout["canary_percent"],
                "bucket": rollout["bucket"],
            },
            finalize=True,
        )
        raise HTTPException(status_code=403, detail=_VOICE_NOT_ENABLED_MESSAGE)

    try:
        await _ensure_client_connected(request, turn_id=turn_id, route="/voice/realtime/session")
        session = await voice_service.create_realtime_session(
            voice=body.voice,
            include_input_transcription=True,
            server_vad_silence_ms=1000,
            disable_auto_response=True,
            enable_barge_in=False,
        )
        _trace_voice_stage(
            turn_id,
            "response_sent",
            {
                "route": "/voice/realtime/session",
                "status": "ok",
                "http_status": 200,
                "session_id": session.get("session_id"),
                "model": session.get("model"),
                "voice": session.get("voice"),
            },
            finalize=True,
        )
        return VoiceRealtimeSessionResponse(
            session_id=session.get("session_id"),
            client_secret=str(session.get("client_secret") or ""),
            client_secret_expires_at=(
                int(session.get("client_secret_expires_at"))
                if isinstance(session.get("client_secret_expires_at"), (int, float))
                else None
            ),
            model=str(session.get("model") or voice_service.realtime_model),
            voice=str(session.get("voice") or voice_service.tts_default_voice),
            transcription_model=str(session.get("transcription_model") or "gpt-4o-mini-transcribe"),
            transcription_language=str(session.get("transcription_language") or "en"),
            transcription_prompt=str(session.get("transcription_prompt") or ""),
            server_vad_enabled=bool(session.get("server_vad_enabled", True)),
            silence_duration_ms=int(session.get("silence_duration_ms") or 800),
            auto_response_enabled=bool(session.get("auto_response_enabled", False)),
            barge_in_enabled=bool(session.get("barge_in_enabled", True)),
        )
    except VoiceServiceError as error:
        _trace_voice_stage(
            turn_id,
            "response_sent",
            {
                "route": "/voice/realtime/session",
                "status": "error",
                "http_status": error.status_code,
                "error": error.message,
            },
            finalize=True,
        )
        raise HTTPException(status_code=error.status_code, detail=error.message)
    except HTTPException:
        raise
    except Exception as error:
        _trace_voice_stage(
            turn_id,
            "response_sent",
            {
                "route": "/voice/realtime/session",
                "status": "error",
                "http_status": 500,
                "error": str(error),
            },
            finalize=True,
        )
        logger.exception("[Kai Voice] realtime session failed turn_id=%s: %s", turn_id, error)
        raise HTTPException(status_code=500, detail="Realtime session creation failed")


@router.post("/voice/capability", response_model=VoiceCapabilityResponse)
async def kai_voice_capability(
    request: Request,
    http_response: Response,
    body: VoiceCapabilityRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    turn_id = _resolve_voice_turn_id(request)
    _set_voice_turn_id_header(http_response, turn_id)
    if token_data.get("user_id") != body.user_id:
        _trace_voice_stage(
            turn_id,
            "response_sent",
            {
                "route": "/voice/capability",
                "status": "error",
                "http_status": 403,
                "error": "Token user_id does not match request user_id",
            },
            finalize=True,
        )
        raise HTTPException(status_code=403, detail="Token user_id does not match request user_id")

    capability = _voice_capability_state(body.user_id)
    _trace_voice_stage(
        turn_id,
        "response_sent",
        {
            "route": "/voice/capability",
            "status": "ok",
            "http_status": 200,
            "voice_enabled": capability["voice_enabled"],
            "execution_allowed": capability["execution_allowed"],
            "rollout_reason": capability["rollout_reason"],
        },
        finalize=True,
    )
    return VoiceCapabilityResponse(**capability)


@router.post("/voice/plan", response_model=VoicePlanResponse)
async def kai_voice_plan(
    request: Request,
    http_response: Response,
    body: VoicePlanRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    started_at = time.perf_counter()
    turn_id = _resolve_voice_turn_id(request)
    _set_voice_turn_id_header(http_response, turn_id)
    _trace_voice_stage(
        turn_id,
        "backend_received",
        {
            "route": "/voice/plan",
            "method": "POST",
            "transcript_chars": len((body.transcript_final or body.transcript or "")),
            "memory_short_count": len(body.memory_short or []),
            "memory_retrieved_count": len(body.memory_retrieved or []),
        },
    )
    if token_data.get("user_id") != body.user_id:
        _trace_voice_stage(
            turn_id,
            "response_sent",
            {
                "route": "/voice/plan",
                "status": "error",
                "http_status": 403,
                "error": "Token user_id does not match request user_id",
            },
            finalize=True,
        )
        raise HTTPException(status_code=403, detail="Token user_id does not match request user_id")

    try:
        logger.info(
            "[KAI_VOICE_DIAG] planner_normalization_version=%s",
            _PLANNER_NORMALIZATION_VERSION,
        )
        app_state_payload = body.app_state.model_dump() if body.app_state is not None else {}
        portfolio_state = (
            app_state_payload.get("portfolio") if isinstance(app_state_payload, dict) else {}
        )
        has_portfolio_data = bool(
            isinstance(portfolio_state, dict) and portfolio_state.get("has_portfolio_data")
        )
        rollout = _voice_rollout_state(body.user_id)
        if not rollout["enabled"]:
            response_payload = voice_service._finalize_response(
                voice_service._build_response(
                    kind="speak_only",
                    message=_VOICE_NOT_ENABLED_MESSAGE,
                ),
                gate_state={
                    "signed_in": True,
                    "vault_unlocked": True,
                    "token_available": True,
                    "token_valid": True,
                    "voice_available": False,
                },
                has_active_analysis=False,
                has_portfolio_data=has_portfolio_data,
                memory_override={"allow_durable_write": False},
            )
            tool_call = voice_service._legacy_tool_call_for_response(response_payload)
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            planner_turn_id = str(body.turn_id or turn_id).strip() or turn_id
            planner_response_id = f"vrsp_{planner_turn_id.removeprefix('vturn_')}"
            _log_voice_metric(
                "planner_latency_ms",
                elapsed_ms,
                turn_id=turn_id,
                user_id=body.user_id,
                tags={"route": "/voice/plan", "model": "deterministic_rollout"},
            )
            _log_voice_metric(
                "response_kind_count",
                1,
                turn_id=turn_id,
                user_id=body.user_id,
                tags={"kind": "speak_only", "reason": "rollout_not_enabled"},
            )
            _log_voice_audit(
                turn_id=turn_id,
                user_id=body.user_id,
                response_payload=response_payload,
                meta={
                    "rollout_reason": rollout["reason"],
                    "canary_percent": rollout["canary_percent"],
                    "bucket": rollout["bucket"],
                },
            )
            _trace_voice_stage(
                turn_id,
                "response_sent",
                {
                    "route": "/voice/plan",
                    "status": "ok",
                    "http_status": 200,
                    "final_response_kind": "speak_only",
                    "elapsed_ms": elapsed_ms,
                    "model": "deterministic_rollout",
                },
                finalize=True,
            )
            return VoicePlanResponse(
                response=VoiceResponsePayload(**response_payload),
                execution_allowed=bool(response_payload.get("execution_allowed")),
                tool_call=tool_call,
                memory=VoiceMemoryHints(**response_payload["memory"]),
                elapsed_ms=elapsed_ms,
                openai_http_ms=0,
                model="deterministic_rollout",
                turn_id=planner_turn_id,
                response_id=planner_response_id,
                needs_confirmation=False,
                ack_text=None,
                final_text=str(response_payload.get("message") or ""),
                is_long_running=False,
                memory_write_candidates=[],
                schema_version=_optional_text(response_payload.get("schema_version")),
                mode=_optional_text(response_payload.get("mode")),
                action_id=_optional_text(response_payload.get("action_id")),
                slots=dict(response_payload.get("slots") or {}),
                guards=[
                    str(guard).strip()
                    for guard in (response_payload.get("guards") or [])
                    if str(guard or "").strip()
                ],
                reply_strategy=_optional_text(response_payload.get("reply_strategy")),
                clarification=(
                    VoiceClarificationPayload(**response_payload["clarification"])
                    if isinstance(response_payload.get("clarification"), dict)
                    else None
                ),
                action_completion=_optional_text(response_payload.get("action_completion")),
            )

        planner_turn_id = str(body.turn_id or turn_id).strip() or turn_id
        planner_transcript = str(body.transcript_final or body.transcript or "").strip()
        planner_context: dict[str, Any] = dict(body.context or {})
        if body.context_structured:
            planner_context["structured_screen_context"] = body.context_structured
        if body.memory_short:
            planner_context["memory_short"] = body.memory_short
        if body.memory_retrieved:
            planner_context["memory_retrieved"] = body.memory_retrieved
        planner_context["planner_turn_id"] = planner_turn_id
        active_analysis = await _resolve_active_analysis(body.user_id, app_state_payload)
        active_import = await _resolve_active_import(body.user_id, app_state_payload)
        await _ensure_client_connected(request, turn_id=turn_id, route="/voice/plan")
        _trace_voice_stage(
            turn_id,
            "planner_started",
            {
                "route": "/voice/plan",
                "transcript_chars": len(planner_transcript),
            },
        )
        response, openai_http_ms, model_used = await voice_service.plan_voice_response(
            transcript=planner_transcript,
            user_id=body.user_id,
            app_state=app_state_payload,
            context=planner_context,
            active_analysis=active_analysis,
            active_import=active_import,
        )
        await _ensure_client_connected(
            request,
            turn_id=turn_id,
            route="/voice/plan",
            stage="request_aborted",
            metadata={
                "abort_stage": "post_planner_upstream",
                "current_stage": "planner_finished",
                "upstream_in_flight": False,
            },
            finalize=False,
        )
        _trace_voice_stage(
            turn_id,
            "planner_finished",
            {
                "route": "/voice/plan",
                "status": "ok",
                "kind": str(response.get("kind") or ""),
                "reason": str(response.get("reason") or ""),
                "model": model_used,
                "openai_http_ms": openai_http_ms,
            },
        )
        if _voice_tool_execution_disabled() and _response_has_executable_plan(response):
            response = voice_service._finalize_response(
                voice_service._build_response(
                    kind="speak_only",
                    message=_VOICE_KILL_SWITCH_MESSAGE,
                ),
                gate_state={
                    "signed_in": True,
                    "vault_unlocked": True,
                    "token_available": True,
                    "token_valid": True,
                    "voice_available": True,
                },
                has_active_analysis=bool(active_analysis and active_analysis.get("active")),
                has_portfolio_data=has_portfolio_data,
                memory_override={"allow_durable_write": False},
            )
        response = _sanitize_response_payload(response)
        raw_tool_call = (
            response.get("tool_call") if isinstance(response.get("tool_call"), dict) else None
        )
        tool_call = voice_service._legacy_tool_call_for_response(response)
        memory_hint = response.get("memory")
        if not isinstance(memory_hint, dict):
            memory_hint = voice_service._memory_hint_from_response(response)
        elapsed_ms = int((time.perf_counter() - started_at) * 1000)
        logger.info(
            (
                "[Kai Voice] route=/voice/plan status=ok turn_id=%s elapsed_ms=%s openai_http_ms=%s "
                "model=%s transcript_chars=%s kind=%s tool_call=%s"
            ),
            turn_id,
            elapsed_ms,
            openai_http_ms,
            model_used,
            len(body.transcript or ""),
            response.get("kind"),
            tool_call,
        )
        response_kind = str(response.get("kind") or "")
        response_reason = str(response.get("reason") or "")
        response_task = str(response.get("task") or "")
        planner_turn_id = str(body.turn_id or turn_id).strip() or turn_id
        planner_response_id = f"vrsp_{planner_turn_id.removeprefix('vturn_')}"
        final_text = str(response.get("message") or "")
        is_long_running = _optional_text(response.get("mode")) == "start_background_and_ack"
        ack_text = final_text if is_long_running else None
        memory_write_candidates = (
            list(response.get("memory_write_candidates"))
            if isinstance(response.get("memory_write_candidates"), list)
            else []
        )
        planner_branch = _resolve_planner_branch(
            model=model_used,
            response_kind=response_kind,
            response_reason=response_reason,
        )
        _log_voice_metric(
            "planner_latency_ms",
            elapsed_ms,
            turn_id=turn_id,
            user_id=body.user_id,
            tags={"route": "/voice/plan", "model": model_used, "branch": planner_branch},
        )
        _log_voice_metric(
            "response_kind_count",
            1,
            turn_id=turn_id,
            user_id=body.user_id,
            tags={"kind": response_kind, "branch": planner_branch},
        )
        if response_kind == "clarify" and response_reason == "stt_unusable":
            _log_voice_metric(
                "unclear_stt_rate",
                1,
                turn_id=turn_id,
                user_id=body.user_id,
                tags={},
            )
        if response_kind == "clarify" and response_reason in {"ticker_ambiguous", "ticker_unknown"}:
            _log_voice_metric(
                "ambiguous_ticker_rate",
                1,
                turn_id=turn_id,
                user_id=body.user_id,
                tags={"reason": response_reason},
            )
        if response_kind == "already_running":
            _log_voice_metric(
                "already_running_rate",
                1,
                turn_id=turn_id,
                user_id=body.user_id,
                tags={"task": response_task or "unknown"},
            )
        _log_voice_audit(
            turn_id=turn_id,
            user_id=body.user_id,
            response_payload={**response, "tool_call": tool_call},
            meta={
                "rollout_reason": rollout["reason"],
                "canary_percent": rollout["canary_percent"],
                "bucket": rollout["bucket"],
                "tool_execution_disabled": _voice_tool_execution_disabled(),
                "planner_branch": planner_branch,
                "planner_normalization_version": _PLANNER_NORMALIZATION_VERSION,
            },
        )
        _trace_voice_stage(
            turn_id,
            "response_sent",
            {
                "route": "/voice/plan",
                "status": "ok",
                "http_status": 200,
                "final_response_kind": response_kind,
                "elapsed_ms": elapsed_ms,
                "model": model_used,
                "openai_http_ms": openai_http_ms,
            },
            finalize=True,
        )
        return VoicePlanResponse(
            response=VoiceResponsePayload(**response),
            execution_allowed=bool(response.get("execution_allowed")),
            tool_call=tool_call,
            memory=VoiceMemoryHints(**memory_hint),
            elapsed_ms=elapsed_ms,
            openai_http_ms=openai_http_ms,
            model=model_used,
            turn_id=planner_turn_id,
            response_id=planner_response_id,
            intent={
                "name": _optional_text(response.get("mode")) or response_kind or "unknown",
                "legacy_kind": response_kind or "unknown",
                "confidence": 1.0,
            },
            action=_canonical_action_payload(response, raw_tool_call=raw_tool_call),
            needs_confirmation=bool(
                _response_has_executable_plan(response)
                and response.get("reason") == "confirmation_required"
            ),
            ack_text=ack_text,
            final_text=final_text,
            is_long_running=is_long_running,
            memory_write_candidates=memory_write_candidates,
            schema_version=_optional_text(response.get("schema_version")),
            mode=_optional_text(response.get("mode")),
            action_id=_optional_text(response.get("action_id")),
            slots=dict(response.get("slots") or {}),
            guards=[
                str(guard).strip()
                for guard in (response.get("guards") or [])
                if str(guard or "").strip()
            ],
            reply_strategy=_optional_text(response.get("reply_strategy")),
            clarification=(
                VoiceClarificationPayload(**response["clarification"])
                if isinstance(response.get("clarification"), dict)
                else None
            ),
            action_completion=_optional_text(response.get("action_completion")),
        )
    except VoiceServiceError as error:
        _trace_voice_stage(
            turn_id,
            "planner_finished",
            {
                "route": "/voice/plan",
                "status": "error",
                "error": error.message,
            },
            finalize=True,
        )
        raise HTTPException(status_code=error.status_code, detail=error.message)
    except HTTPException as error:
        if error.status_code == 499:
            raise
        _trace_voice_stage(
            turn_id,
            "planner_finished",
            {
                "route": "/voice/plan",
                "status": "error",
                "error": str(error.detail),
            },
            finalize=True,
        )
        raise
    except Exception as error:
        _trace_voice_stage(
            turn_id,
            "planner_finished",
            {
                "route": "/voice/plan",
                "status": "error",
                "error": str(error),
            },
            finalize=True,
        )
        logger.exception("[Kai Voice] planning failed turn_id=%s: %s", turn_id, error)
        raise HTTPException(status_code=500, detail="Voice intent planning failed")


@router.post("/voice/compose", response_model=VoiceComposeResponse)
async def kai_voice_compose(
    request: Request,
    http_response: Response,
    body: VoiceComposeRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    started_at = time.perf_counter()
    turn_id = _resolve_voice_turn_id(request)
    _set_voice_turn_id_header(http_response, turn_id)
    _trace_voice_stage(
        turn_id,
        "backend_received",
        {
            "route": "/voice/compose",
            "method": "POST",
            "transcript_chars": len(body.transcript or ""),
            "has_action_result": bool(body.action_result),
        },
    )
    if token_data.get("user_id") != body.user_id:
        _trace_voice_stage(
            turn_id,
            "response_sent",
            {
                "route": "/voice/compose",
                "status": "error",
                "http_status": 403,
                "error": "Token user_id does not match request user_id",
            },
            finalize=True,
        )
        raise HTTPException(status_code=403, detail="Token user_id does not match request user_id")

    try:
        app_state_payload = body.app_state.model_dump() if body.app_state is not None else {}
        compose_context: dict[str, Any] = dict(body.context or {})
        if body.context_structured:
            compose_context["structured_screen_context"] = body.context_structured
        if body.memory_short:
            compose_context["memory_short"] = body.memory_short
        if body.memory_retrieved:
            compose_context["memory_retrieved"] = body.memory_retrieved

        await _ensure_client_connected(request, turn_id=turn_id, route="/voice/compose")
        _trace_voice_stage(
            turn_id,
            "planner_started",
            {
                "route": "/voice/compose",
                "response_id": _optional_text(body.response_id),
                "mode": _optional_text(body.mode),
            },
        )
        composed, openai_http_ms, model_used = await voice_service.compose_voice_reply(
            transcript=body.transcript,
            user_id=body.user_id,
            app_state=app_state_payload,
            context=compose_context,
            plan_payload={
                "mode": body.mode,
                "action_id": body.action_id,
                "slots": dict(body.slots or {}),
                "guards": list(body.guards or []),
                "reply_strategy": body.reply_strategy,
                "clarification": body.clarification.model_dump()
                if body.clarification is not None
                else None,
                "action_completion": body.action_completion,
            },
            response_payload=body.response.model_dump(),
            action_result=dict(body.action_result or {})
            if isinstance(body.action_result, dict)
            else None,
        )
        await _ensure_client_connected(
            request,
            turn_id=turn_id,
            route="/voice/compose",
            stage="request_aborted",
            metadata={
                "abort_stage": "post_composer_upstream",
                "current_stage": "composer_finished",
                "upstream_in_flight": False,
            },
            finalize=False,
        )
        elapsed_ms = int((time.perf_counter() - started_at) * 1000)
        _log_voice_metric(
            "composer_latency_ms",
            elapsed_ms,
            turn_id=turn_id,
            user_id=body.user_id,
            tags={"route": "/voice/compose", "model": model_used},
        )
        _trace_voice_stage(
            turn_id,
            "response_sent",
            {
                "route": "/voice/compose",
                "status": "ok",
                "http_status": 200,
                "elapsed_ms": elapsed_ms,
                "model": model_used,
                "openai_http_ms": openai_http_ms,
                "segment_type": str(composed.get("segment_type") or ""),
            },
            finalize=True,
        )
        return VoiceComposeResponse(
            text=str(composed.get("text") or ""),
            segment_type=str(composed.get("segment_type") or "final"),
            elapsed_ms=elapsed_ms,
            openai_http_ms=openai_http_ms,
            model=model_used,
            turn_id=_optional_text(body.turn_id) or turn_id,
            response_id=_optional_text(body.response_id),
        )
    except VoiceServiceError as error:
        _trace_voice_stage(
            turn_id,
            "planner_finished",
            {
                "route": "/voice/compose",
                "status": "error",
                "error": error.message,
            },
            finalize=True,
        )
        raise HTTPException(status_code=error.status_code, detail=error.message)
    except HTTPException as error:
        if error.status_code == 499:
            raise
        _trace_voice_stage(
            turn_id,
            "planner_finished",
            {
                "route": "/voice/compose",
                "status": "error",
                "error": str(error.detail),
            },
            finalize=True,
        )
        raise
    except Exception as error:
        _trace_voice_stage(
            turn_id,
            "planner_finished",
            {
                "route": "/voice/compose",
                "status": "error",
                "error": str(error),
            },
            finalize=True,
        )
        logger.exception("[Kai Voice] composition failed turn_id=%s: %s", turn_id, error)
        raise HTTPException(status_code=500, detail="Voice response composition failed")


@router.post("/voice/tts")
async def kai_voice_tts(
    request: Request,
    http_response: Response,
    body: VoiceTTSRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    started_at = time.perf_counter()
    turn_id = _resolve_voice_turn_id(request)
    _set_voice_turn_id_header(http_response, turn_id)
    _trace_voice_stage(
        turn_id,
        "backend_received",
        {
            "route": "/voice/tts",
            "method": "POST",
            "text_chars": len(body.text or ""),
        },
    )
    _trace_voice_stage(
        turn_id,
        "backend_request_received",
        {
            "route": "/voice/tts",
            "method": "POST",
            "origin": "backend_confirmed",
            "text_chars": len(body.text or ""),
        },
    )
    _trace_voice_stage(
        turn_id,
        "payload_parse_started",
        {
            "route": "/voice/tts",
            "origin": "backend_confirmed",
            "source": "kai_voice_tts",
        },
    )
    _trace_voice_stage(
        turn_id,
        "payload_parse_finished",
        {
            "route": "/voice/tts",
            "origin": "backend_confirmed",
            "source": "kai_voice_tts",
            "text_chars": len(body.text or ""),
            "voice": body.voice or voice_service.tts_default_voice,
        },
    )
    if token_data.get("user_id") != body.user_id:
        _trace_voice_stage(
            turn_id,
            "response_sent",
            {
                "route": "/voice/tts",
                "origin": "backend_confirmed",
                "source": "kai_voice_tts",
                "status": "error",
                "http_status": 403,
                "error": "Token user_id does not match request user_id",
            },
            finalize=True,
        )
        raise HTTPException(status_code=403, detail="Token user_id does not match request user_id")

    try:
        rollout = _voice_rollout_state(body.user_id)
        if not rollout["enabled"]:
            _log_voice_metric(
                "tts_rollout_blocked_count",
                1,
                turn_id=turn_id,
                user_id=body.user_id,
                tags={
                    "reason": rollout["reason"],
                    "canary_percent": rollout["canary_percent"],
                },
            )
            _trace_voice_stage(
                turn_id,
                "response_sent",
                {
                    "route": "/voice/tts",
                    "origin": "backend_confirmed",
                    "source": "kai_voice_tts",
                    "status": "error",
                    "http_status": 403,
                    "error": _VOICE_NOT_ENABLED_MESSAGE,
                    "rollout_reason": rollout["reason"],
                    "canary_percent": rollout["canary_percent"],
                    "bucket": rollout["bucket"],
                },
                finalize=True,
            )
            raise HTTPException(status_code=403, detail=_VOICE_NOT_ENABLED_MESSAGE)
        await _ensure_client_connected(request, turn_id=turn_id, route="/voice/tts")
        _trace_voice_stage(
            turn_id,
            "tts_started",
            {
                "route": "/voice/tts",
                "text_chars": len(body.text or ""),
                "voice": body.voice or voice_service.tts_default_voice,
                "model": voice_service.tts_model,
                "timeout_ms": int(voice_service.tts_timeout_seconds * 1000),
            },
        )
        _trace_voice_stage(
            turn_id,
            "tts_backend_started",
            {
                "route": "/voice/tts",
                "origin": "backend_confirmed",
                "source": "kai_voice_tts",
                "text_chars": len(body.text or ""),
                "voice": body.voice or voice_service.tts_default_voice,
                "model": voice_service.tts_model,
                "timeout_ms": int(voice_service.tts_timeout_seconds * 1000),
            },
        )

        def _trace_tts_upstream(stage: str, payload: dict[str, Any]) -> None:
            _trace_voice_stage(
                turn_id,
                stage,
                {
                    "route": "/voice/tts",
                    "origin": "backend_confirmed",
                    "source": "kai_voice_tts",
                    **payload,
                },
            )

        tts_stream, mime_type, tts_meta = await voice_service.open_tts_stream(
            text=body.text,
            voice=body.voice or voice_service.tts_default_voice,
            trace_hook=_trace_tts_upstream,
        )
        first_chunk = await tts_stream.read_next_chunk()
        if first_chunk is None:
            await tts_stream.aclose()
            raise VoiceServiceError(502, "TTS response was empty")

        content_length = tts_meta.get("content_length")
        response_headers = {
            "X-Voice-Turn-Id": turn_id,
            "X-Kai-TTS-Model": str(tts_meta.get("model") or ""),
            "X-Kai-TTS-Voice": str(tts_meta.get("voice") or ""),
            "X-Kai-TTS-Format": str(tts_meta.get("format") or ""),
            "X-Kai-TTS-Source": str(tts_meta.get("source") or "backend_openai_audio"),
            "X-Kai-TTS-Timeout-Ms": str(int(voice_service.tts_timeout_seconds * 1000)),
            "X-Kai-TTS-OpenAI-Http-Ms": str(int(tts_meta.get("openai_http_ms") or 0)),
            "Cache-Control": "no-store",
        }
        if isinstance(content_length, int) and content_length > 0:
            response_headers["X-Kai-TTS-Audio-Bytes"] = str(content_length)
        _trace_voice_stage(
            turn_id,
            "response_prepare_started",
            {
                "route": "/voice/tts",
                "origin": "backend_confirmed",
                "source": "kai_voice_tts",
                "status": "ok",
            },
        )

        async def _stream_audio():
            aborted = False
            sent_bytes = 0
            first_yield = True
            try:
                chunk = first_chunk
                while chunk is not None:
                    if first_yield:
                        _trace_voice_stage(
                            turn_id,
                            "response_prepare_finished",
                            {
                                "route": "/voice/tts",
                                "origin": "backend_confirmed",
                                "source": "kai_voice_tts",
                                "status": "ok",
                            },
                        )
                        first_yield = False
                    if await request.is_disconnected():
                        aborted = True
                        tts_meta["aborted"] = True
                        _trace_voice_stage(
                            turn_id,
                            "request_aborted",
                            {
                                "route": "/voice/tts",
                                "origin": "backend_confirmed",
                                "source": "kai_voice_tts",
                                "status": "aborted",
                                "error": "client_disconnected",
                                "client_disconnected": True,
                                "abort_stage": "streaming",
                                "current_stage": "tts_streaming",
                                "upstream_in_flight": False,
                            },
                            finalize=False,
                        )
                        break
                    sent_bytes += len(chunk)
                    yield chunk
                    if await request.is_disconnected():
                        aborted = True
                        tts_meta["aborted"] = True
                        _trace_voice_stage(
                            turn_id,
                            "request_aborted",
                            {
                                "route": "/voice/tts",
                                "origin": "backend_confirmed",
                                "source": "kai_voice_tts",
                                "status": "aborted",
                                "error": "client_disconnected",
                                "client_disconnected": True,
                                "abort_stage": "streaming",
                                "current_stage": "tts_streaming",
                                "upstream_in_flight": False,
                            },
                            finalize=False,
                        )
                        break
                    chunk = await tts_stream.read_next_chunk()

                if not first_yield and not aborted:
                    tts_meta["completed"] = True
                    elapsed_ms = int((time.perf_counter() - started_at) * 1000)
                    logger.info(
                        "[Kai Voice] route=/voice/tts status=ok turn_id=%s elapsed_ms=%s text_chars=%s "
                        "audio_bytes=%s model=%s voice=%s format=%s source=%s",
                        turn_id,
                        elapsed_ms,
                        len(body.text or ""),
                        sent_bytes,
                        tts_meta.get("model", ""),
                        tts_meta.get("voice", ""),
                        tts_meta.get("format", ""),
                        tts_meta.get("source", "backend_openai_audio"),
                    )
                    _log_voice_metric(
                        "tts_latency_ms",
                        elapsed_ms,
                        turn_id=turn_id,
                        user_id=body.user_id,
                        tags={
                            "route": "/voice/tts",
                            "model": tts_meta.get("model"),
                            "voice": tts_meta.get("voice"),
                            "format": tts_meta.get("format"),
                        },
                    )
                    _trace_voice_stage(
                        turn_id,
                        "tts_finished",
                        {
                            "route": "/voice/tts",
                            "status": "ok",
                            "model": tts_meta.get("model"),
                            "voice": tts_meta.get("voice"),
                            "format": tts_meta.get("format"),
                            "source": tts_meta.get("source") or "backend_openai_audio",
                            "attempts": tts_meta.get("attempts"),
                            "mime_type": mime_type,
                            "audio_bytes": sent_bytes,
                            "content_length": tts_meta.get("content_length"),
                        },
                    )
                    _trace_voice_stage(
                        turn_id,
                        "tts_backend_finished",
                        {
                            "route": "/voice/tts",
                            "origin": "backend_confirmed",
                            "source": "kai_voice_tts",
                            "status": "ok",
                            "model": tts_meta.get("model"),
                            "voice": tts_meta.get("voice"),
                            "format": tts_meta.get("format"),
                            "audio_bytes": sent_bytes,
                        },
                    )
                    _trace_voice_stage(
                        turn_id,
                        "response_sent",
                        {
                            "route": "/voice/tts",
                            "origin": "backend_confirmed",
                            "source": "kai_voice_tts",
                            "status": "ok",
                            "http_status": 200,
                            "elapsed_ms": elapsed_ms,
                            "model": str(tts_meta.get("model") or ""),
                            "mime_type": mime_type,
                            "audio_bytes": sent_bytes,
                        },
                        finalize=True,
                    )
                elif aborted:
                    elapsed_ms = int((time.perf_counter() - started_at) * 1000)
                    _trace_voice_stage(
                        turn_id,
                        "tts_finished",
                        {
                            "route": "/voice/tts",
                            "status": "error",
                            "error": "Client disconnected",
                            "audio_bytes": sent_bytes,
                            "content_length": tts_meta.get("content_length"),
                        },
                    )
                    _trace_voice_stage(
                        turn_id,
                        "response_sent",
                        {
                            "route": "/voice/tts",
                            "origin": "backend_confirmed",
                            "source": "kai_voice_tts",
                            "status": "error",
                            "http_status": 499,
                            "elapsed_ms": elapsed_ms,
                            "error": "client_disconnected",
                            "client_disconnected": True,
                            "audio_bytes": sent_bytes,
                        },
                        finalize=True,
                    )
            except asyncio.CancelledError:
                tts_meta["aborted"] = True
                elapsed_ms = int((time.perf_counter() - started_at) * 1000)
                _trace_voice_stage(
                    turn_id,
                    "request_aborted",
                    {
                        "route": "/voice/tts",
                        "origin": "backend_confirmed",
                        "source": "kai_voice_tts",
                        "status": "aborted",
                        "error": "client_disconnected",
                        "client_disconnected": True,
                        "abort_stage": "stream_cancelled",
                        "current_stage": "tts_streaming",
                        "upstream_in_flight": False,
                    },
                    finalize=False,
                )
                _trace_voice_stage(
                    turn_id,
                    "response_sent",
                    {
                        "route": "/voice/tts",
                        "origin": "backend_confirmed",
                        "source": "kai_voice_tts",
                        "status": "error",
                        "http_status": 499,
                        "elapsed_ms": elapsed_ms,
                        "error": "client_disconnected",
                        "client_disconnected": True,
                    },
                    finalize=True,
                )
                raise
            finally:
                await tts_stream.aclose()

        return StreamingResponse(_stream_audio(), media_type=mime_type, headers=response_headers)
    except HTTPException as error:
        if error.status_code == 499:
            raise
        _trace_voice_stage(
            turn_id,
            "tts_finished",
            {
                "route": "/voice/tts",
                "status": "error",
                "error": str(error.detail),
            },
        )
        _trace_voice_stage(
            turn_id,
            "response_prepare_started",
            {
                "route": "/voice/tts",
                "origin": "backend_confirmed",
                "source": "kai_voice_tts",
                "status": "error",
            },
        )
        _trace_voice_stage(
            turn_id,
            "response_prepare_finished",
            {
                "route": "/voice/tts",
                "origin": "backend_confirmed",
                "source": "kai_voice_tts",
                "status": "error",
            },
        )
        _trace_voice_stage(
            turn_id,
            "response_sent",
            {
                "route": "/voice/tts",
                "origin": "backend_confirmed",
                "source": "kai_voice_tts",
                "status": "error",
                "http_status": error.status_code,
                "error": str(error.detail),
            },
            finalize=True,
        )
        raise
    except VoiceServiceError as error:
        _trace_voice_stage(
            turn_id,
            "tts_finished",
            {
                "route": "/voice/tts",
                "status": "error",
                "error": error.message,
            },
        )
        _trace_voice_stage(
            turn_id,
            "response_prepare_started",
            {
                "route": "/voice/tts",
                "origin": "backend_confirmed",
                "source": "kai_voice_tts",
                "status": "error",
            },
        )
        _trace_voice_stage(
            turn_id,
            "response_prepare_finished",
            {
                "route": "/voice/tts",
                "origin": "backend_confirmed",
                "source": "kai_voice_tts",
                "status": "error",
            },
        )
        _trace_voice_stage(
            turn_id,
            "response_sent",
            {
                "route": "/voice/tts",
                "origin": "backend_confirmed",
                "source": "kai_voice_tts",
                "status": "error",
                "http_status": error.status_code,
                "error": error.message,
            },
            finalize=True,
        )
        raise HTTPException(status_code=error.status_code, detail=error.message)
    except Exception as error:
        _trace_voice_stage(
            turn_id,
            "tts_finished",
            {
                "route": "/voice/tts",
                "status": "error",
                "error": str(error),
            },
        )
        _trace_voice_stage(
            turn_id,
            "response_prepare_started",
            {
                "route": "/voice/tts",
                "origin": "backend_confirmed",
                "source": "kai_voice_tts",
                "status": "error",
            },
        )
        _trace_voice_stage(
            turn_id,
            "response_prepare_finished",
            {
                "route": "/voice/tts",
                "origin": "backend_confirmed",
                "source": "kai_voice_tts",
                "status": "error",
            },
        )
        _trace_voice_stage(
            turn_id,
            "response_sent",
            {
                "route": "/voice/tts",
                "origin": "backend_confirmed",
                "source": "kai_voice_tts",
                "status": "error",
                "http_status": 500,
                "error": str(error),
            },
            finalize=True,
        )
        logger.exception("[Kai Voice] TTS failed turn_id=%s: %s", turn_id, error)
        raise HTTPException(status_code=500, detail="Voice synthesis failed")
