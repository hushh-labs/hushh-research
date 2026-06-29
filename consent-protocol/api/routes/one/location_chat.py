"""One Location agent chat endpoint (v1, control-plane, non-streaming)."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_vault_owner_token
from hushh_mcp.services.location_chat_service import LocationChatService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one", tags=["One Location Agent Chat"])


def _service() -> LocationChatService:
    return LocationChatService()


class LocationChatRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    message: str = Field(min_length=1, max_length=4000)
    conversation_id: str | None = Field(default=None, alias="conversationId", max_length=128)


@router.post("/location/chat")
async def location_chat(
    request: LocationChatRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    try:
        result: dict[str, Any] = await _service().handle_turn(
            user_id=token_data["user_id"],
            message=request.message,
            consent_token=token_data.get("token", ""),
            conversation_id=request.conversation_id,
        )
        return result
    except Exception:
        logger.exception("Location chat turn failed")
        raise HTTPException(status_code=500, detail="Location chat could not be processed")
