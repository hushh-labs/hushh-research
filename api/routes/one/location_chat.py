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


class ActionResultModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str = Field(max_length=64)
    type: str = Field(max_length=48)
    status: str = Field(max_length=24)
    public_url: str | None = Field(default=None, alias="publicUrl", max_length=2048)
    detail: str | None = Field(default=None, max_length=500)


class SelectionResultModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str = Field(max_length=64)
    kind: str = Field(max_length=24)
    selected: list[dict[str, Any]] | None = None
    confirmed: bool | None = None
    free_text: str | None = Field(default=None, alias="freeText", max_length=4000)
    status: str = Field(max_length=24)
    display: str | None = Field(default=None, max_length=200)


class LocationChatRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    message: str | None = Field(default=None, max_length=4000)
    conversation_id: str | None = Field(default=None, alias="conversationId", max_length=128)
    action_result: ActionResultModel | None = Field(default=None, alias="actionResult")
    selection_result: SelectionResultModel | None = Field(default=None, alias="selectionResult")


@router.post("/location/chat")
async def location_chat(
    request: LocationChatRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    if not request.message and request.action_result is None and request.selection_result is None:
        raise HTTPException(
            status_code=422, detail="message, actionResult, or selectionResult is required"
        )
    try:
        result: dict[str, Any] = await _service().handle_turn(
            user_id=token_data["user_id"],
            message=request.message,
            consent_token=token_data.get("token", ""),
            conversation_id=request.conversation_id,
            action_result=(
                request.action_result.model_dump(by_alias=True, exclude_none=True)
                if request.action_result is not None
                else None
            ),
            selection_result=(
                request.selection_result.model_dump(by_alias=True, exclude_none=True)
                if request.selection_result is not None
                else None
            ),
        )
        return result
    except Exception:
        logger.exception("Location chat turn failed")
        raise HTTPException(status_code=500, detail="Location chat could not be processed")
