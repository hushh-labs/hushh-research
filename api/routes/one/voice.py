"""One Voice API compatibility wrappers.

These routes are the product-facing One Voice entrypoints. They intentionally
delegate to the existing Kai-era compatibility runtime so auth, rollout, kill-switch,
generated action contracts, planning, composition, and realtime-session
semantics stay identical while the public route family migrates to One.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field

from api.middleware import require_vault_owner_token
from api.routes.kai.voice import (
    VoiceComposeRequest,
    VoiceComposeResponse,
    VoicePlanRequest,
    VoicePlanResponse,
    VoiceRealtimeSessionRequest,
    VoiceRealtimeSessionResponse,
    kai_voice_compose,
    kai_voice_plan,
    kai_voice_realtime_session,
)

router = APIRouter(prefix="/api/one/voice", tags=["One Voice"])


class VoiceBenchmarkStatusResponse(BaseModel):
    enabled: bool = False
    status: str = Field(default="requires_live_adapter", max_length=64)
    message: str = Field(
        default=(
            "Live One Voice benchmarking is not enabled on this route yet. "
            "Use the existing offline realtime benchmark harness until live "
            "Gemini/OpenAI adapters publish versioned artifacts."
        ),
        max_length=512,
    )


@router.post("/session", response_model=VoiceRealtimeSessionResponse)
async def one_voice_realtime_session(
    request: Request,
    http_response: Response,
    body: VoiceRealtimeSessionRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await kai_voice_realtime_session(request, http_response, body, token_data)


@router.post("/plan", response_model=VoicePlanResponse)
async def one_voice_plan(
    request: Request,
    http_response: Response,
    body: VoicePlanRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await kai_voice_plan(request, http_response, body, token_data)


@router.post("/compose", response_model=VoiceComposeResponse)
async def one_voice_compose(
    request: Request,
    http_response: Response,
    body: VoiceComposeRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await kai_voice_compose(request, http_response, body, token_data)


@router.post("/benchmark", response_model=VoiceBenchmarkStatusResponse)
async def one_voice_benchmark_status() -> VoiceBenchmarkStatusResponse:
    return VoiceBenchmarkStatusResponse()
