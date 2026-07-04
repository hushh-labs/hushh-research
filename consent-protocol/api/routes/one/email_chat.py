"""Gmail inbox agent chat endpoint (read-only, non-streaming).

Mirrors the Information Marketplace chat: a conversational turn over read-only
inbox tools. Reuses the connected ``gmail.readonly`` connection; VAULT_OWNER
consent is verified via the token dependency.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_vault_owner_token
from hushh_mcp.services.email_chat_service import EmailChatService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one", tags=["One Email Agent Chat"])


def _service() -> EmailChatService:
    return EmailChatService()


class EmailChatRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    message: str | None = Field(default=None, max_length=4000)
    conversation_id: str | None = Field(default=None, alias="conversationId", max_length=128)


@router.post("/email/chat")
async def email_chat(
    request: EmailChatRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    if not request.message:
        raise HTTPException(status_code=422, detail="message is required")
    try:
        return await _service().handle_turn(
            user_id=token_data["user_id"],
            message=request.message,
            consent_token=token_data.get("token", ""),
            conversation_id=request.conversation_id,
        )
    except Exception:
        logger.exception("Email chat turn failed")
        raise HTTPException(status_code=500, detail="Email chat could not be processed")
