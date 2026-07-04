"""One Personal Information agent chat endpoint (marketplace, read-only, non-streaming)."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_vault_owner_token
from hushh_mcp.services.information_chat_service import InformationChatService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one", tags=["One Personal Information Agent Chat"])


def _service() -> InformationChatService:
    return InformationChatService()


class InformationChatRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    message: str | None = Field(default=None, max_length=4000)
    conversation_id: str | None = Field(default=None, alias="conversationId", max_length=128)


@router.post("/information/chat")
async def information_chat(
    request: InformationChatRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    if not request.message:
        raise HTTPException(status_code=422, detail="message is required")
    try:
        result: dict[str, Any] = await _service().handle_turn(
            user_id=token_data["user_id"],
            message=request.message,
            consent_token=token_data.get("token", ""),
            conversation_id=request.conversation_id,
        )
        return result
    except Exception:
        logger.exception("Information chat turn failed")
        raise HTTPException(status_code=500, detail="Information chat could not be processed")
