"""Rate one assistant turn, so response quality is something the team can read.

The rating is an id plus an enum. No prompt, no answer, no content of any kind
crosses this boundary, so nothing here needs a vault key. It still requires the
vault-owner token, because the inputs are conversation and message ids from the
owner's encrypted conversation namespace and every sibling route on this surface
requires the same authority.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from api.middleware import require_vault_owner_token
from hushh_mcp.services.message_feedback_service import (
    MessageFeedbackError,
    get_feedback,
    set_feedback,
)

router = APIRouter(prefix="/api/one/agent-chat/feedback", tags=["one-agent-feedback"])


class MessageFeedbackRequest(BaseModel):
    """A null rating clears the person's existing rating for that turn."""

    conversation_id: str = Field(max_length=200)
    message_id: str = Field(max_length=200)
    rating: Literal["up", "down"] | None = None


@router.get("")
async def read_feedback(
    conversation_id: str = Query(max_length=200),
    token: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    feedback: dict[str, Any] = await get_feedback(
        user_id=str(token["user_id"]), conversation_ref=conversation_id
    )
    return feedback


@router.put("")
async def write_feedback(
    payload: MessageFeedbackRequest,
    token: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    try:
        recorded: dict[str, Any] = await set_feedback(
            user_id=str(token["user_id"]),
            conversation_ref=payload.conversation_id,
            message_ref=payload.message_id,
            rating=payload.rating,
        )
    except MessageFeedbackError as exc:
        raise HTTPException(
            status_code=400, detail={"code": exc.code, "message": str(exc)}
        ) from exc
    return recorded
