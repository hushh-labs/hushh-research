"""Agent text chat routes backed by Gemini streaming."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from api.middleware import require_vault_owner_token
from hushh_mcp.services.agent_chat_service import (
    AgentChatActionPlan,
    AgentChatConversation,
    AgentChatMessage,
    PreparedAgentChatTurn,
    get_agent_chat_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Agent Chat"])


class AgentChatStreamRequest(BaseModel):
    user_id: str = Field(..., min_length=1)
    message: str = Field(..., min_length=1, max_length=8000)
    conversation_id: Optional[str] = None


class AgentChatConversationModel(BaseModel):
    id: str
    title: str
    status: str
    model: Optional[str] = None
    message_count: int = 0
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    last_message_at: Optional[str] = None


class AgentChatMessageModel(BaseModel):
    id: str
    conversation_id: str
    role: str
    status: str
    content: str
    model: Optional[str] = None
    created_at: Optional[str] = None
    completed_at: Optional[str] = None


class AgentChatConversationsResponse(BaseModel):
    user_id: str
    conversations: list[AgentChatConversationModel]


class AgentChatHistoryResponse(BaseModel):
    conversation_id: str
    messages: list[AgentChatMessageModel]


def _event(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _conversation_model(conversation: AgentChatConversation) -> AgentChatConversationModel:
    return AgentChatConversationModel(
        id=conversation.id,
        title=conversation.title,
        status=conversation.status,
        model=conversation.model,
        message_count=conversation.message_count,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
        last_message_at=conversation.last_message_at,
    )


def _message_model(message: AgentChatMessage) -> AgentChatMessageModel:
    return AgentChatMessageModel(
        id=message.id,
        conversation_id=message.conversation_id,
        role=message.role,
        status=message.status,
        content=message.content,
        model=message.model,
        created_at=message.created_at,
        completed_at=message.completed_at,
    )


def _assert_user(token_data: dict, user_id: str) -> None:
    if token_data.get("user_id") != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token user_id does not match request user_id",
        )


async def _save_assistant_message(
    *,
    service,
    turn: PreparedAgentChatTurn,
    user_id: str,
    text: str,
    status_value: Literal["complete", "interrupted", "error"],
    error_code: str | None = None,
) -> None:
    if not text.strip():
        return
    await service.add_message(
        conversation_id=turn.conversation_id,
        user_id=user_id,
        role="assistant",
        content=text,
        status=status_value,
        model=turn.model,
        error_code=error_code,
    )


@router.post("/agent/chat/stream")
async def stream_agent_chat(
    request: Request,
    body: AgentChatStreamRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    """Stream one Agent text response as simple token SSE events."""

    _assert_user(token_data, body.user_id)
    service = get_agent_chat_service()
    try:
        turn = await service.prepare_turn(
            user_id=body.user_id,
            message=body.message,
            conversation_id=body.conversation_id,
        )
        action_plan: AgentChatActionPlan | None = service.plan_action(body.message)
    except Exception as error:
        logger.exception("agent_chat.prepare_failed user_id=%s: %s", body.user_id, error)
        raise HTTPException(status_code=500, detail="Agent chat could not be started") from error

    async def generate():
        chunks: list[str] = []
        saved = False
        try:
            yield _event(
                "start",
                {
                    "conversation_id": turn.conversation_id,
                    "model": turn.model,
                },
            )
            if action_plan is not None:
                payload = action_plan.to_event_payload()
                yield _event("tool_start", payload)
                if action_plan.execution == "frontend":
                    yield _event(
                        "tool_waiting",
                        {
                            **payload,
                            "message": action_plan.message,
                            "status": "waiting_for_frontend",
                        },
                    )
                else:
                    yield _event(
                        "tool_result",
                        {
                            **payload,
                            "status": "blocked",
                        },
                    )
            async for token in service.stream_response(
                user_message=body.message,
                history=turn.history,
                action_plan=action_plan,
            ):
                if await request.is_disconnected():
                    text = "".join(chunks)
                    await _save_assistant_message(
                        service=service,
                        turn=turn,
                        user_id=body.user_id,
                        text=text,
                        status_value="interrupted",
                    )
                    saved = True
                    return
                chunks.append(token)
                yield _event("token", {"token": token})

            text = "".join(chunks)
            await _save_assistant_message(
                service=service,
                turn=turn,
                user_id=body.user_id,
                text=text,
                status_value="complete",
            )
            saved = True
            yield _event(
                "complete",
                {
                    "conversation_id": turn.conversation_id,
                    "status": "complete",
                    "model": turn.model,
                },
            )
        except asyncio.CancelledError:
            if not saved:
                await _save_assistant_message(
                    service=service,
                    turn=turn,
                    user_id=body.user_id,
                    text="".join(chunks),
                    status_value="interrupted",
                )
            raise
        except Exception as error:
            logger.exception("agent_chat.stream_failed user_id=%s: %s", body.user_id, error)
            if not saved:
                await _save_assistant_message(
                    service=service,
                    turn=turn,
                    user_id=body.user_id,
                    text="".join(chunks),
                    status_value="error",
                    error_code="AGENT_CHAT_STREAM_FAILED",
                )
                saved = True
            yield _event(
                "error",
                {
                    "message": "Agent chat failed. Please try again.",
                    "conversation_id": turn.conversation_id,
                },
            )

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Agent-Conversation-Id": turn.conversation_id,
        "X-Agent-Model": turn.model,
    }
    return StreamingResponse(generate(), media_type="text/event-stream", headers=headers)


@router.get("/agent/chat/conversations/{user_id}", response_model=AgentChatConversationsResponse)
async def list_agent_chat_conversations(
    user_id: str,
    token_data: dict = Depends(require_vault_owner_token),
    limit: int = Query(default=5, ge=1, le=20),
):
    _assert_user(token_data, user_id)
    conversations = await get_agent_chat_service().list_conversations(user_id, limit=limit)
    return AgentChatConversationsResponse(
        user_id=user_id,
        conversations=[_conversation_model(conversation) for conversation in conversations],
    )


@router.get("/agent/chat/history/{conversation_id}", response_model=AgentChatHistoryResponse)
async def get_agent_chat_history(
    conversation_id: str,
    token_data: dict = Depends(require_vault_owner_token),
    limit: int = Query(default=50, ge=1, le=100),
):
    service = get_agent_chat_service()
    conversation = await service.get_conversation(
        conversation_id,
        user_id=str(token_data.get("user_id") or ""),
    )
    if conversation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    messages = await service.get_recent_messages(
        conversation_id,
        user_id=str(token_data.get("user_id") or ""),
        limit=limit,
    )
    return AgentChatHistoryResponse(
        conversation_id=conversation_id,
        messages=[_message_model(message) for message in messages],
    )
