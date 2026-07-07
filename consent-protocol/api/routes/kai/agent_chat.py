"""Agent text chat routes backed by Gemini streaming."""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from api.middleware import require_vault_owner_token
from hushh_mcp.adk_bridge.contract import SpecialistTurnResult
from hushh_mcp.adk_bridge.dispatch import is_wired_specialist
from hushh_mcp.agents.orchestrator.tools import classify_specialist_domain
from hushh_mcp.services.agent_chat_service import (
    AgentChatActionPlan,
    AgentChatConversation,
    AgentChatMessage,
    AgentRuntimeContractError,
    AgentRuntimeProviderError,
    PreparedAgentChatTurn,
    get_agent_chat_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Agent Chat"])


class DelegateResultModel(BaseModel):
    delegate_agent_id: str = Field(..., max_length=64)
    kind: str = Field(..., max_length=24)  # "action" | "selection"
    id: str = Field(..., max_length=64)
    type: Optional[str] = Field(default=None, max_length=48)
    status: Optional[str] = Field(default=None, max_length=24)
    public_url: Optional[str] = Field(default=None, alias="publicUrl", max_length=2048)
    detail: Optional[str] = Field(default=None, max_length=500)
    selected: Optional[list[dict]] = Field(default=None)
    confirmed: Optional[bool] = Field(default=None)
    free_text: Optional[str] = Field(default=None, alias="freeText", max_length=4000)
    # promptKind carries the location ClientPrompt kind ("select"|"confirm") for
    # selection delegate_results so the A2A discriminator ("selection") is never
    # misread as the prompt kind. See location_agent.py for the mapping.
    prompt_kind: Optional[str] = Field(default=None, alias="promptKind", max_length=24)
    # Human-readable delegate result text. Selection prompts usually use a
    # short chip label, but action results can contain multi-line summaries.
    # Coordinate-free; the backend persists a metadata-safe subset separately.
    display: Optional[str] = Field(default=None, max_length=8000)


class AgentChatStreamRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=128)
    message: str = Field(default="", max_length=8000)
    conversation_id: Optional[str] = Field(default=None, max_length=128)
    pkm_context: Optional[str] = Field(default=None, max_length=20000)
    screen_context: Optional[dict] = Field(default=None)
    timezone: Optional[str] = Field(default=None, max_length=64)
    runtime_credential: Optional[str] = Field(default=None, max_length=12000, exclude=True)
    runtime_credential_mode: Optional[str] = Field(default=None, max_length=64)
    delegate_agent_id: Optional[str] = Field(default=None, max_length=64)
    delegate_result: Optional[DelegateResultModel] = Field(default=None)


class AgentChatRenameRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=160)


class AgentChatConversationModel(BaseModel):
    id: str = Field(..., max_length=256)
    title: str = Field(..., max_length=256)
    status: str = Field(..., max_length=64)
    model: Optional[str] = Field(default=None, max_length=128)
    message_count: int = Field(default=0, ge=0)
    created_at: Optional[str] = Field(default=None, max_length=64)
    updated_at: Optional[str] = Field(default=None, max_length=64)
    last_message_at: Optional[str] = Field(default=None, max_length=64)


class AgentChatMessageModel(BaseModel):
    id: str = Field(..., max_length=256)
    conversation_id: str = Field(..., max_length=256)
    role: str = Field(..., max_length=64)
    status: str = Field(..., max_length=64)
    # Assistant completions are stored in full and can be far larger than a user
    # turn (long markdown answers, tables, code). An 8 KB cap here rejected real
    # stored messages at serialization time and 500'd history loads, making the
    # conversation unrecoverable. Allow up to 128 KB, well above any single turn.
    content: str = Field(..., max_length=131072)
    model: Optional[str] = Field(default=None, max_length=128)
    created_at: Optional[str] = Field(default=None, max_length=64)
    completed_at: Optional[str] = Field(default=None, max_length=64)
    # UI-safe metadata subset: only "kind" and "display" are returned.
    # Server-only keys are never exposed to clients.
    metadata: Optional[dict] = Field(default=None)


class AgentChatConversationsResponse(BaseModel):
    user_id: str = Field(..., max_length=256)
    conversations: list[AgentChatConversationModel]


class AgentChatHistoryResponse(BaseModel):
    conversation_id: str = Field(..., max_length=256)
    messages: list[AgentChatMessageModel]


class AgentChatDeleteResponse(BaseModel):
    conversation_id: str = Field(..., max_length=256)
    deleted: bool


# Navigation intent — "open/go to/take me to the marketplace" should OPEN the
# page (central planner), not delegate a text answer to the specialist.
_NAV_INTENT_RE = re.compile(
    r"\b(?:open|go to|take me to|navigate to|launch|bring up)\b", re.IGNORECASE
)

# "marketplace" is ambiguous (Information Marketplace vs Kai Market Home). Detect
# a bare mention (no qualifier) so One can deterministically ask which one.
_BARE_MARKETPLACE_RE = re.compile(r"\bmarketplace\b", re.IGNORECASE)
_MARKETPLACE_QUALIFIER_RE = re.compile(
    r"\b(?:information marketplace|data marketplace|kai|market home)\b", re.IGNORECASE
)

_MARKETPLACE_CLARIFICATION = (
    "Which marketplace do you mean — your **Information Marketplace** (your "
    "personal data slices and potential earnings) or **Kai's Market Home** "
    "(markets and investing)?"
)


def _is_bare_marketplace(message: str | None) -> bool:
    """True when the user says 'marketplace' without qualifying which one."""
    text = message or ""
    return bool(_BARE_MARKETPLACE_RE.search(text) and not _MARKETPLACE_QUALIFIER_RE.search(text))


def resolve_delegate_target(message: str) -> str | None:
    """Return a WIRED specialist agent id for this message, else None.

    Fail-closed: no classifier match, or a classified-but-unwired specialist
    (finance/privacy/kyc in slice 1), returns None so the existing central
    planner path runs unchanged.
    """
    classified = classify_specialist_domain(message or "")
    if classified is None:
        return None
    domain, target_agent = classified
    # "open the information marketplace" is a navigation intent: decline
    # delegation so the central planner opens the page instead of answering.
    if domain == "information_marketplace" and _NAV_INTENT_RE.search(message or ""):
        return None
    import hushh_mcp.adk_bridge  # noqa: F401  (ensures specialists are registered)

    return target_agent if is_wired_specialist(target_agent) else None


def specialist_result_to_frames(
    result: SpecialistTurnResult, delegate_agent_id: str, *, include_start: bool = True
) -> list[tuple[str, dict]]:
    """Format a specialist turn as ordered additive SSE (event, data) tuples."""
    frames: list[tuple[str, dict]] = []
    if include_start:
        frames.append(("start", {"conversation_id": result.conversation_id, "model": result.model}))
    frames.append(("token", {"token": result.text}))
    if result.directive is not None:
        frontend_tool_payload = _frontend_tool_payload(result.directive.payload)
        if frontend_tool_payload is not None:
            frames.append(("tool_start", frontend_tool_payload))
            if str(frontend_tool_payload.get("execution") or "") == "frontend":
                frames.append(
                    (
                        "tool_waiting",
                        {
                            **frontend_tool_payload,
                            "message": result.text,
                            "status": "waiting_for_frontend",
                        },
                    )
                )
            else:
                frames.append(
                    (
                        "tool_result",
                        {
                            **frontend_tool_payload,
                            "message": result.text,
                            "status": "blocked",
                        },
                    )
                )
        else:
            frames.append(
                (
                    "specialist_directive",
                    {
                        "delegate_agent_id": delegate_agent_id,
                        "directive": {
                            "kind": result.directive.kind,
                            "payload": result.directive.payload,
                        },
                        "message": result.text,
                        "state_changed": result.state_changed,
                    },
                )
            )
    frames.append(
        (
            "complete",
            {
                "conversation_id": result.conversation_id,
                "status": "complete",
                "model": result.model,
            },
        )
    )
    return frames


def _frontend_tool_payload(payload: dict[str, Any]) -> dict[str, Any] | None:
    if str(payload.get("kind") or "") != "frontend_tool":
        return None
    return {key: value for key, value in payload.items() if key != "kind"}


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
        metadata=(
            {k: message.metadata[k] for k in ("kind", "display") if k in message.metadata}
            if isinstance(getattr(message, "metadata", None), dict)
            else None
        ),
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
    message_text = text.strip()
    if not message_text and status_value == "error":
        message_text = "Agent chat failed. Please try again."
    if not message_text and status_value == "interrupted":
        message_text = "Agent response was interrupted before it could finish."
    if not message_text:
        return
    await service.add_message(
        conversation_id=turn.conversation_id,
        user_id=user_id,
        role="assistant",
        content=message_text,
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

    # --- One → specialist delegation (slice 1: location) --------------------
    # Fail-closed: only a WIRED specialist match (or an explicit delegate_result)
    # is intercepted; everything else falls through to the existing planner.
    import hushh_mcp.adk_bridge  # noqa: F401  (ensures specialists are registered)
    from hushh_mcp.adk_bridge.contract import A2ATask
    from hushh_mcp.adk_bridge.dispatch import dispatch as a2a_dispatch

    delegate_agent_id: str | None = None
    delegate_result_payload: dict | None = None
    if body.delegate_result is not None:
        delegate_agent_id = body.delegate_result.delegate_agent_id
        delegate_result_payload = body.delegate_result.model_dump(by_alias=True, exclude_none=True)
    elif body.delegate_agent_id and is_wired_specialist(body.delegate_agent_id):
        delegate_agent_id = body.delegate_agent_id
    elif body.message:
        delegate_agent_id = resolve_delegate_target(body.message)

    if delegate_agent_id is not None and is_wired_specialist(delegate_agent_id):
        delegated_turn: PreparedAgentChatTurn | None = None
        delegated_conversation_id = body.conversation_id
        planned_action_payload: dict[str, Any] | None = None
        prepare_started = time.perf_counter()
        prepare_ms = 0.0
        if body.message.strip():
            try:
                delegated_turn = await service.prepare_turn(
                    user_id=body.user_id,
                    message=body.message,
                    conversation_id=body.conversation_id,
                )
                delegated_conversation_id = delegated_turn.conversation_id
                prepare_ms = (time.perf_counter() - prepare_started) * 1000
            except Exception as error:
                logger.exception(
                    "agent_chat.delegation_prepare_failed user_id=%s: %s",
                    body.user_id,
                    error,
                )
                raise HTTPException(
                    status_code=500,
                    detail="Agent chat could not be started",
                ) from error
            if delegate_agent_id == "agent_connected_systems" and delegated_turn is not None:
                try:
                    runtime = await service.prepare_agent_runtime(
                        runtime_credential=body.runtime_credential,
                        runtime_credential_mode=body.runtime_credential_mode,
                    )
                    planned_action = await service.plan_action_with_gemini(
                        user_message=body.message,
                        history=delegated_turn.history,
                        runtime_client=runtime.client,
                        runtime_model=runtime.model,
                        pkm_context=body.pkm_context,
                        screen_context=body.screen_context,
                        deterministic_crm_first=False,
                    )
                    if planned_action is not None:
                        planned_action_payload = planned_action.to_event_payload()
                except Exception as error:  # noqa: BLE001
                    logger.warning(
                        "agent_chat.delegation_planner_failed user_id=%s delegate_agent_id=%s: %s",
                        body.user_id,
                        delegate_agent_id,
                        error,
                    )

        task = A2ATask(
            user_id=body.user_id,
            consent_token=token_data.get("token", ""),
            conversation_id=delegated_conversation_id,
            message=body.message or None,
            delegate_result=delegate_result_payload,
            timezone=body.timezone,
            planned_action=planned_action_payload,
        )

        async def generate_delegated():
            yield _event(
                "start",
                {
                    "conversation_id": delegated_conversation_id or "",
                    "model": "delegated",
                    "delegate_agent_id": delegate_agent_id,
                },
            )
            dispatch_started = time.perf_counter()
            try:
                result = await a2a_dispatch(delegate_agent_id, task)
            except Exception as error:  # noqa: BLE001
                dispatch_ms = (time.perf_counter() - dispatch_started) * 1000
                logger.exception(
                    "agent_chat.delegation_failed user_id=%s delegate_agent_id=%s prepare_ms=%.1f dispatch_ms=%.1f: %s",
                    body.user_id,
                    delegate_agent_id,
                    prepare_ms,
                    dispatch_ms,
                    error,
                )
                yield _event(
                    "error",
                    {
                        "message": "Agent chat failed. Please try again.",
                        "conversation_id": body.conversation_id or "",
                    },
                )
                return
            dispatch_ms = (time.perf_counter() - dispatch_started) * 1000
            conversation_id = result.conversation_id or delegated_conversation_id
            save_ms = 0.0
            if conversation_id:
                save_turn = PreparedAgentChatTurn(
                    conversation_id=conversation_id,
                    user_message_id=delegated_turn.user_message_id if delegated_turn else "",
                    history=delegated_turn.history if delegated_turn else [],
                    model=result.model,
                )
                save_started = time.perf_counter()
                await _save_assistant_message(
                    service=service,
                    turn=save_turn,
                    user_id=body.user_id,
                    text=result.text,
                    status_value="complete",
                )
                save_ms = (time.perf_counter() - save_started) * 1000
            logger.info(
                "agent_chat.delegation_timing user_id=%s conversation_id=%s delegate_agent_id=%s prepare_ms=%.1f dispatch_ms=%.1f save_ms=%.1f total_ms=%.1f",
                body.user_id,
                conversation_id or "",
                delegate_agent_id,
                prepare_ms,
                dispatch_ms,
                save_ms,
                prepare_ms + dispatch_ms + save_ms,
            )
            for name, data in specialist_result_to_frames(
                result, delegate_agent_id, include_start=False
            ):
                yield _event(name, data)

        headers = {
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "X-Content-Type-Options": "nosniff",
        }
        if delegated_conversation_id:
            headers["X-Agent-Conversation-Id"] = delegated_conversation_id
        return StreamingResponse(
            generate_delegated(), media_type="text/event-stream", headers=headers
        )
    # --- end delegation branch --------------------------------------------

    # Deterministic disambiguation: a bare "marketplace" (not already delegated as
    # a clear data-slice question) gets a fixed clarifying question instead of
    # letting the planner guess a surface.
    if (
        body.delegate_result is None
        and body.delegate_agent_id is None
        and _is_bare_marketplace(body.message)
    ):
        conv_id = body.conversation_id or ""
        headers = {
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "X-Content-Type-Options": "nosniff",
        }

        async def generate_clarification():
            yield _event("start", {"conversation_id": conv_id, "model": "one"})
            yield _event("token", {"token": _MARKETPLACE_CLARIFICATION})
            yield _event("complete", {"conversation_id": conv_id, "status": "complete"})

        return StreamingResponse(
            generate_clarification(), media_type="text/event-stream", headers=headers
        )

    try:
        runtime = await service.prepare_agent_runtime(
            runtime_credential=body.runtime_credential,
            runtime_credential_mode=body.runtime_credential_mode,
        )
        turn = await service.prepare_turn(
            user_id=body.user_id,
            message=body.message,
            conversation_id=body.conversation_id,
        )
        action_plan: AgentChatActionPlan | None = await service.plan_action_with_gemini(
            user_message=body.message,
            history=turn.history,
            runtime_client=runtime.client,
            runtime_model=runtime.model,
            pkm_context=body.pkm_context,
            screen_context=body.screen_context,
            deterministic_crm_first=False,
        )
    except AgentRuntimeContractError as error:
        logger.warning(
            "agent_chat.runtime_contract_failed user_id=%s error_code=%s mode=%s credential_supplied=%s",
            body.user_id,
            error.error_code,
            body.runtime_credential_mode,
            bool((body.runtime_credential or "").strip()),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": error.error_code,
                "message": error.message,
            },
        ) from error
    except AgentRuntimeProviderError as error:
        logger.warning(
            "agent_chat.runtime_provider_failed user_id=%s error_code=%s detail=%s",
            body.user_id,
            error.error_code,
            error.detail,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": error.error_code,
                "message": error.message,
            },
        ) from error
    except Exception as error:
        logger.exception("agent_chat.prepare_failed user_id=%s: %s", body.user_id, error)
        raise HTTPException(status_code=500, detail="Agent chat could not be started") from error

    if (
        action_plan is not None
        and str(action_plan.action_id or "").startswith("connected_system.crm.")
        and is_wired_specialist("agent_connected_systems")
    ):
        task = A2ATask(
            user_id=body.user_id,
            consent_token=token_data.get("token", ""),
            conversation_id=turn.conversation_id,
            message=body.message or None,
            timezone=body.timezone,
            planned_action=action_plan.to_event_payload(),
        )

        async def generate_planned_delegated():
            yield _event(
                "start",
                {
                    "conversation_id": turn.conversation_id,
                    "model": "delegated",
                    "delegate_agent_id": "agent_connected_systems",
                },
            )
            dispatch_started = time.perf_counter()
            try:
                result = await a2a_dispatch("agent_connected_systems", task)
            except Exception as error:  # noqa: BLE001
                dispatch_ms = (time.perf_counter() - dispatch_started) * 1000
                logger.exception(
                    "agent_chat.planned_delegation_failed user_id=%s delegate_agent_id=%s dispatch_ms=%.1f: %s",
                    body.user_id,
                    "agent_connected_systems",
                    dispatch_ms,
                    error,
                )
                yield _event(
                    "error",
                    {
                        "message": "Agent chat failed. Please try again.",
                        "conversation_id": turn.conversation_id,
                    },
                )
                return
            await _save_assistant_message(
                service=service,
                turn=turn,
                user_id=body.user_id,
                text=result.text,
                status_value="complete",
            )
            for name, data in specialist_result_to_frames(
                result, "agent_connected_systems", include_start=False
            ):
                yield _event(name, data)

        headers = {
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "X-Content-Type-Options": "nosniff",
            "X-Agent-Conversation-Id": turn.conversation_id,
        }
        return StreamingResponse(
            generate_planned_delegated(), media_type="text/event-stream", headers=headers
        )

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
                    receipt_text = action_plan.message.strip() or "Working on that in Kai."
                    await _save_assistant_message(
                        service=service,
                        turn=turn,
                        user_id=body.user_id,
                        text=receipt_text,
                        status_value="complete",
                    )
                    chunks.append(receipt_text)
                    saved = True
                    yield _event("token", {"token": receipt_text})
                    yield _event(
                        "tool_waiting",
                        {
                            **payload,
                            "message": receipt_text,
                            "status": "waiting_for_frontend",
                        },
                    )
                    yield _event(
                        "complete",
                        {
                            "conversation_id": turn.conversation_id,
                            "status": "complete",
                            "model": turn.model,
                        },
                    )
                    return
                else:
                    receipt_text = action_plan.message.strip() or "That action is blocked in Agent."
                    await _save_assistant_message(
                        service=service,
                        turn=turn,
                        user_id=body.user_id,
                        text=receipt_text,
                        status_value="complete",
                    )
                    chunks.append(receipt_text)
                    saved = True
                    yield _event(
                        "tool_result",
                        {
                            **payload,
                            "status": "blocked",
                        },
                    )
                    yield _event("token", {"token": receipt_text})
                    yield _event(
                        "complete",
                        {
                            "conversation_id": turn.conversation_id,
                            "status": "complete",
                            "model": turn.model,
                        },
                    )
                    return
            async for token in service.stream_response(
                user_message=body.message,
                history=turn.history,
                runtime_client=runtime.client,
                runtime_model=runtime.model,
                action_plan=action_plan,
                pkm_context=body.pkm_context,
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
        except AgentRuntimeProviderError as error:
            logger.warning(
                "agent_chat.stream_provider_failed user_id=%s error_code=%s detail=%s",
                body.user_id,
                error.error_code,
                error.detail,
            )
            if not saved:
                await _save_assistant_message(
                    service=service,
                    turn=turn,
                    user_id=body.user_id,
                    text=error.message,
                    status_value="error",
                    error_code=error.error_code,
                )
                saved = True
            yield _event(
                "error",
                {
                    "code": error.error_code,
                    "message": error.message,
                    "conversation_id": turn.conversation_id,
                },
            )
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
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
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


@router.patch(
    "/agent/chat/conversations/{conversation_id}", response_model=AgentChatConversationModel
)
async def rename_agent_chat_conversation(
    conversation_id: str,
    body: AgentChatRenameRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    user_id = str(token_data.get("user_id") or "")
    conversation = await get_agent_chat_service().rename_conversation(
        conversation_id,
        user_id=user_id,
        title=body.title,
    )
    if conversation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    return _conversation_model(conversation)


@router.delete(
    "/agent/chat/conversations/{conversation_id}",
    response_model=AgentChatDeleteResponse,
)
async def delete_agent_chat_conversation(
    conversation_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    user_id = str(token_data.get("user_id") or "")
    deleted = await get_agent_chat_service().delete_conversation(
        conversation_id,
        user_id=user_id,
    )
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    return AgentChatDeleteResponse(conversation_id=conversation_id, deleted=True)


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
