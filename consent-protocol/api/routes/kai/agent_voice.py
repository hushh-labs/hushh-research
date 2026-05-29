"""Agent voice adapter routes.

These routes only convert voice transport into text for the existing Agent.
They do not replace the text Agent brain and do not persist raw audio.
"""

from __future__ import annotations

import logging
import os

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile, status
from pydantic import BaseModel

from api.middleware import require_vault_owner_token
from hushh_mcp.services.agent_voice_service import get_agent_voice_service

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Agent Voice"])

MAX_AGENT_VOICE_AUDIO_BYTES = 8 * 1024 * 1024
_DISABLED_FLAG_VALUES = {"0", "false", "off", "disabled", "no"}


class AgentVoiceTranscriptionResponse(BaseModel):
    transcript: str
    uncertain: bool
    reason: str | None = None


class AgentVoiceTTSRequest(BaseModel):
    user_id: str
    text: str
    voice: str | None = None


def _assert_user(token_data: dict, user_id: str) -> None:
    if token_data.get("user_id") != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token user_id does not match request user_id",
        )


def _agent_gemini_voice_enabled() -> bool:
    configured = os.getenv("AGENT_GEMINI_VOICE_ENABLED", "").strip().lower()
    return configured not in _DISABLED_FLAG_VALUES


def _ensure_agent_gemini_voice_enabled() -> None:
    if _agent_gemini_voice_enabled():
        return
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Agent Gemini voice is disabled.",
    )


@router.post("/agent/voice/stt", response_model=AgentVoiceTranscriptionResponse)
async def transcribe_agent_voice(
    user_id: str = Form(...),
    audio: UploadFile = File(...),
    token_data: dict = Depends(require_vault_owner_token),
):
    _ensure_agent_gemini_voice_enabled()
    _assert_user(token_data, user_id)

    mime_type = (audio.content_type or "").strip() or "application/octet-stream"
    if not mime_type.startswith("audio/"):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Agent voice STT requires an audio upload.",
        )

    audio_bytes = await audio.read()
    if len(audio_bytes) > MAX_AGENT_VOICE_AUDIO_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Agent voice audio is too large.",
        )

    try:
        transcription = await get_agent_voice_service().transcribe_audio(
            audio_bytes=audio_bytes,
            mime_type=mime_type,
        )
    except RuntimeError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(error),
        ) from error
    except Exception as error:
        logger.exception("agent_voice.stt_failed user_id=%s: %s", user_id, error)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Agent voice transcription failed.",
        ) from error

    return AgentVoiceTranscriptionResponse(
        transcript=transcription.transcript,
        uncertain=transcription.uncertain,
        reason=transcription.reason,
    )


@router.post("/agent/voice/tts")
async def synthesize_agent_voice(
    body: AgentVoiceTTSRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _ensure_agent_gemini_voice_enabled()
    _assert_user(token_data, body.user_id)

    clean_text = " ".join((body.text or "").strip().split())
    if not clean_text:
        raise HTTPException(
            status_code=422,
            detail="Text is required for Agent voice TTS.",
        )

    try:
        synthesis = await get_agent_voice_service().synthesize_speech(
            text=clean_text,
            voice=body.voice,
        )
    except ValueError as error:
        raise HTTPException(
            status_code=422,
            detail=str(error),
        ) from error
    except RuntimeError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(error),
        ) from error
    except Exception as error:
        logger.exception("agent_voice.tts_failed user_id=%s: %s", body.user_id, error)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Agent voice TTS failed.",
        ) from error

    return Response(
        content=synthesis.audio,
        media_type=synthesis.mime_type,
        headers={
            "Cache-Control": "no-store",
            "X-Agent-TTS-Model": synthesis.model,
            "X-Agent-TTS-Voice": synthesis.voice,
            "X-Agent-TTS-Source": "backend_gemini_audio",
            "X-Agent-TTS-Audio-Bytes": str(len(synthesis.audio)),
        },
    )
