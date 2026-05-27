"""Minimal Kai Agent Realtime session endpoint."""

from __future__ import annotations

import hashlib
import logging
import os
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api.middleware import require_vault_owner_token

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Kai Agent"])

_OPENAI_REALTIME_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets"
_REALTIME_MODEL = "gpt-realtime-1.5"
_REALTIME_VOICE = "alloy"
_REALTIME_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe"
_REALTIME_TRANSCRIPTION_LANGUAGE = "en"
_REALTIME_TRANSCRIPTION_PROMPT = (
    "Transcribe spoken English only. Do not translate or transliterate. "
    "If the speech is unclear, keep the transcript short and in English."
)
_REALTIME_NOISE_REDUCTION_TYPE = "near_field"
_REALTIME_SERVER_VAD_THRESHOLD = 0.72
_REALTIME_SERVER_VAD_PREFIX_PADDING_MS = 450
_REALTIME_SERVER_VAD_SILENCE_MS = 800
_AGENT_REALTIME_INSTRUCTIONS = (
    "You are Agent, a concise assistant inside Hussh. This demo supports text and "
    "voice conversation, but has no tools, memory, portfolio access, PKM context, or "
    "app context yet. Answer plainly and do not claim access to private user data or "
    "app actions."
)


class AgentRealtimeSessionRequest(BaseModel):
    user_id: str
    voice: str | None = None


class AgentRealtimeSessionResponse(BaseModel):
    session_id: str | None = None
    client_secret: str
    client_secret_expires_at: int | None = None
    model: str
    voice: str
    transcription_model: str
    transcription_language: str
    transcription_prompt: str
    server_vad_enabled: bool = True
    silence_duration_ms: int


def _safe_user_ref(user_id: str) -> str:
    return hashlib.sha256(str(user_id).encode("utf-8")).hexdigest()


def _extract_openai_error(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return None
    error = payload.get("error")
    if isinstance(error, dict):
        message = error.get("message")
        if isinstance(message, str) and message.strip():
            return message.strip()
        code = error.get("code")
        if isinstance(code, str) and code.strip():
            return code.strip()
    if isinstance(error, str) and error.strip():
        return error.strip()
    return None


def _parse_client_secret(payload: Any) -> tuple[str, int | None]:
    client_secret = ""
    expires_at: Any = None

    if isinstance(payload, dict):
        top_level_value = payload.get("value")
        if isinstance(top_level_value, str) and top_level_value.strip():
            client_secret = top_level_value.strip()
            expires_at = payload.get("expires_at")

        if not client_secret:
            secret_obj = payload.get("client_secret")
            if isinstance(secret_obj, dict):
                secret_value = secret_obj.get("value")
                if isinstance(secret_value, str) and secret_value.strip():
                    client_secret = secret_value.strip()
                    expires_at = (
                        secret_obj.get("expires_at")
                        if secret_obj.get("expires_at") is not None
                        else payload.get("expires_at")
                    )
            elif isinstance(secret_obj, str) and secret_obj.strip():
                client_secret = secret_obj.strip()
                expires_at = payload.get("expires_at")

    normalized_expires_at = int(expires_at) if isinstance(expires_at, (int, float)) else None
    return client_secret, normalized_expires_at


def _extract_session_id(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return None
    session_id = payload.get("id")
    if isinstance(session_id, str) and session_id.strip():
        return session_id.strip()
    session = payload.get("session")
    if isinstance(session, dict):
        nested_id = session.get("id")
        if isinstance(nested_id, str) and nested_id.strip():
            return nested_id.strip()
    return None


@router.post("/agent/realtime/session", response_model=AgentRealtimeSessionResponse)
async def create_agent_realtime_session(
    body: AgentRealtimeSessionRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    """Create an ephemeral OpenAI Realtime token for the Agent chat and voice surface."""

    if token_data.get("user_id") != body.user_id:
        raise HTTPException(
            status_code=403,
            detail="Token user_id does not match request user_id",
        )

    api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI Realtime is not configured")

    selected_voice = (body.voice or _REALTIME_VOICE).strip() or _REALTIME_VOICE
    payload = {
        "session": {
            "type": "realtime",
            "model": _REALTIME_MODEL,
            "instructions": _AGENT_REALTIME_INSTRUCTIONS,
            "audio": {
                "input": {
                    "noise_reduction": {"type": _REALTIME_NOISE_REDUCTION_TYPE},
                    "transcription": {
                        "model": _REALTIME_TRANSCRIPTION_MODEL,
                        "language": _REALTIME_TRANSCRIPTION_LANGUAGE,
                        "prompt": _REALTIME_TRANSCRIPTION_PROMPT,
                    },
                    "turn_detection": {
                        "type": "server_vad",
                        "threshold": _REALTIME_SERVER_VAD_THRESHOLD,
                        "prefix_padding_ms": _REALTIME_SERVER_VAD_PREFIX_PADDING_MS,
                        "silence_duration_ms": _REALTIME_SERVER_VAD_SILENCE_MS,
                        "create_response": False,
                        "interrupt_response": True,
                    },
                },
                "output": {
                    "voice": selected_voice,
                },
            },
        }
    }
    user_ref = _safe_user_ref(body.user_id)

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                _OPENAI_REALTIME_CLIENT_SECRETS_URL,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "OpenAI-Safety-Identifier": user_ref,
                },
                json=payload,
            )
    except httpx.HTTPError as error:
        logger.warning("[Kai Agent] realtime client secret request failed: %s", error)
        raise HTTPException(
            status_code=502,
            detail="Realtime client secret creation failed",
        ) from error

    result = response.json() if response.content else {}
    if response.status_code >= 400:
        detail = _extract_openai_error(result) or "Realtime client secret creation failed"
        raise HTTPException(status_code=502, detail=detail)

    client_secret, expires_at = _parse_client_secret(result)
    if not client_secret:
        logger.error(
            "[Kai Agent] realtime client secret missing user_ref=%s response_keys=%s",
            user_ref[:12],
            sorted(result.keys()) if isinstance(result, dict) else type(result).__name__,
        )
        raise HTTPException(
            status_code=502,
            detail="Realtime session did not return a client secret",
        )

    return AgentRealtimeSessionResponse(
        session_id=_extract_session_id(result),
        client_secret=client_secret,
        client_secret_expires_at=expires_at,
        model=_REALTIME_MODEL,
        voice=selected_voice,
        transcription_model=_REALTIME_TRANSCRIPTION_MODEL,
        transcription_language=_REALTIME_TRANSCRIPTION_LANGUAGE,
        transcription_prompt=_REALTIME_TRANSCRIPTION_PROMPT,
        silence_duration_ms=_REALTIME_SERVER_VAD_SILENCE_MS,
    )
