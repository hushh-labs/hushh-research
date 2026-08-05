"""Durable typed Agent Chat routes backed by One's ADK semantic head."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Literal, Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from api.middleware import require_vault_owner_token
from api.routes.one.live_context import sanitize_live_context
from hushh_mcp.adk_bridge.contract import SpecialistTurnResult
from hushh_mcp.adk_bridge.dispatch import is_wired_specialist
from hushh_mcp.one_adk.text_runtime import OneTextDirective
from hushh_mcp.services.action_directive_ledger import (
    ActionDirectiveAuthorityError,
    get_action_directive_store,
)
from hushh_mcp.services.action_gateway import get_action_gateway_action
from hushh_mcp.services.agent_chat_service import (
    AgentChatConversation,
    AgentChatMessage,
    AgentRuntimeContractError,
    AgentRuntimeProviderError,
    PreparedAgentChatTurn,
    get_agent_chat_service,
)
from hushh_mcp.services.pkm_grounding_service import resolve_grounding

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Agent Chat"])
_EXCLUDED_AGENT_CHAT_SPECIALISTS = frozenset({"agent_personal_information"})


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
    runtime_credential_transport: Optional[Literal["developer_api", "vertex_api_key"]] = Field(
        default=None
    )
    runtime_vertex_project: Optional[str] = Field(default=None, max_length=30)
    runtime_vertex_location: Optional[str] = Field(default=None, max_length=64)
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


class ActionConfirmationRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=128)
    conversation_id: str = Field(..., min_length=1, max_length=128)
    action_id: str = Field(..., min_length=1, max_length=160)
    context_revision: str = Field(..., min_length=1, max_length=256)
    trusted_activation: bool = False


class ActionConsumeRequest(ActionConfirmationRequest):
    receipt: str = Field(..., min_length=32, max_length=256, exclude=True)


class ActionCancelRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=128)
    conversation_id: str = Field(..., min_length=1, max_length=128)
    action_id: str = Field(..., min_length=1, max_length=160)
    context_revision: str = Field(..., min_length=1, max_length=256)
    reason_code: str = Field(default="user_cancelled", min_length=1, max_length=64)


class ActionSettlementRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=128)
    receipt: str = Field(..., min_length=32, max_length=256, exclude=True)
    action_id: str = Field(..., min_length=1, max_length=160)
    context_revision: str = Field(..., min_length=1, max_length=256)
    status: Literal["succeeded", "failed", "cancelled"]
    reason_code: str = Field(default="none", min_length=1, max_length=64)
    route_after: Optional[str] = Field(default=None, max_length=256)
    screen_after: Optional[str] = Field(default=None, max_length=128)


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


def _one_directive_frames(
    directive: OneTextDirective,
    *,
    conversation_text: str,
    directive_id: str | None = None,
    conversation_id: str | None = None,
    context_revision: str | None = None,
    expires_at: str | None = None,
) -> list[tuple[str, dict[str, Any]]]:
    """Translate One's canonical directive into the existing chat SSE frames."""
    if (
        directive.delegate_agent_id
        and directive.delegate_agent_id not in _EXCLUDED_AGENT_CHAT_SPECIALISTS
    ):
        return [
            (
                "specialist_directive",
                {
                    "delegate_agent_id": directive.delegate_agent_id,
                    "directive": {
                        "kind": directive.kind,
                        "payload": directive.payload,
                    },
                    "message": conversation_text,
                    "state_changed": False,
                },
            )
        ]

    if directive.kind != "action":
        return []
    action_id = str(directive.payload.get("actionId") or "").strip()
    action = get_action_gateway_action(action_id)
    if action is None:
        return []
    label = str(action.get("label") or action_id).strip()
    receipt = conversation_text.strip() or f"{label} in the app."
    payload: dict[str, Any] = {
        "call_id": directive_id or f"one_text_{uuid4().hex}",
        "action_id": action_id,
        "label": label,
        "execution": "frontend",
        "slots": directive.payload.get("slots")
        if isinstance(directive.payload.get("slots"), dict)
        else {},
        "message": receipt,
        "execution_policy": str(
            (action.get("risk") or {}).get("execution_policy") or "allow_direct"
        ),
        "requires_confirmation": True,
        "trusted_activation_required": bool(
            directive.payload.get("trustedActivationRequired") is True
            or action.get("activation_policy") == "trusted_activation_required"
        ),
    }
    if directive_id is not None:
        payload["directive_id"] = directive_id
    if conversation_id is not None:
        payload["conversation_id"] = conversation_id
    if context_revision is not None:
        payload["context_revision"] = context_revision
    if expires_at is not None:
        payload["expires_at"] = expires_at
    return [
        ("tool_start", payload),
        (
            "tool_waiting",
            {
                **payload,
                "status": "waiting_for_frontend",
            },
        ),
    ]


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
    """Stream one One text turn through the compatibility SSE envelope."""

    request_started = time.perf_counter()
    _assert_user(token_data, body.user_id)
    service = get_agent_chat_service()
    sanitized_screen_context = sanitize_live_context(body.screen_context or {})

    requested_delegate_ids = {
        candidate
        for candidate in (
            body.delegate_agent_id,
            body.delegate_result.delegate_agent_id if body.delegate_result else None,
        )
        if candidate
    }
    if requested_delegate_ids & _EXCLUDED_AGENT_CHAT_SPECIALISTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Information Marketplace is not available in Agent Chat.",
        )

    # Explicit specialist continuity remains supported for client-rendered
    # cards and follow-up results. New user meaning is never classified here;
    # it enters One's semantic head below.
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

    if delegate_agent_id is not None and is_wired_specialist(delegate_agent_id):
        delegated_turn: PreparedAgentChatTurn | None = None
        delegated_conversation_id = body.conversation_id
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
                if body.conversation_id:
                    await get_action_directive_store().cancel_open_for_conversation(
                        user_id=body.user_id,
                        conversation_id=delegated_turn.conversation_id,
                    )
                prepare_ms = (time.perf_counter() - prepare_started) * 1000
            except Exception as error:
                logger.exception(
                    "agent_chat.delegation_prepare_failed: %s",
                    error,
                )
                raise HTTPException(
                    status_code=500,
                    detail="Agent chat could not be started",
                ) from error

        task = A2ATask(
            user_id=body.user_id,
            consent_token=token_data.get("token", ""),
            conversation_id=delegated_conversation_id,
            message=body.message or None,
            delegate_result=delegate_result_payload,
            timezone=body.timezone,
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
                    "agent_chat.delegation_failed delegate_agent_id=%s prepare_ms=%.1f dispatch_ms=%.1f: %s",
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
                "agent_chat.delegation_timing delegate_agent_id=%s prepare_ms=%.1f dispatch_ms=%.1f save_ms=%.1f total_ms=%.1f",
                delegate_agent_id,
                prepare_ms,
                dispatch_ms,
                save_ms,
                prepare_ms + dispatch_ms + save_ms,
            )
            frames = specialist_result_to_frames(result, delegate_agent_id, include_start=False)
            frontend_frame = next(
                (
                    data
                    for name, data in frames
                    if name in {"tool_start", "tool_waiting"}
                    and str(data.get("execution") or "") == "frontend"
                    and str(data.get("action_id") or "").strip()
                ),
                None,
            )
            if frontend_frame is not None:
                action_id = str(frontend_frame["action_id"]).strip()
                action = get_action_gateway_action(action_id)
                if action is None or not conversation_id:
                    frames = [
                        (name, data)
                        for name, data in frames
                        if name not in {"tool_start", "tool_waiting"}
                    ]
                    frames.insert(
                        -1,
                        (
                            "tool_result",
                            {
                                **frontend_frame,
                                "execution": "blocked",
                                "status": "blocked",
                                "reason": "confirmation_authority_unavailable",
                            },
                        ),
                    )
                else:
                    context_revision = str(
                        sanitized_screen_context.get("context_revision")
                        or f"conversation:{conversation_id}"
                    )
                    try:
                        issued = await get_action_directive_store().issue(
                            user_id=body.user_id,
                            channel="typed_chat",
                            conversation_id=conversation_id,
                            action_id=action_id,
                            context_revision=context_revision,
                            action_contract=action,
                            slots=(
                                frontend_frame.get("slots")
                                if isinstance(frontend_frame.get("slots"), dict)
                                else {}
                            ),
                            trusted_activation_required=True,
                        )
                    except Exception:
                        logger.warning(
                            "agent_chat.specialist_confirmation_authority_unavailable action=%s",
                            action_id,
                        )
                        frames = [
                            (name, data)
                            for name, data in frames
                            if name not in {"tool_start", "tool_waiting"}
                        ]
                        frames.insert(
                            -1,
                            (
                                "tool_result",
                                {
                                    **frontend_frame,
                                    "execution": "blocked",
                                    "status": "blocked",
                                    "reason": "confirmation_authority_unavailable",
                                },
                            ),
                        )
                    else:
                        authority = {
                            "call_id": issued.directive_id,
                            "directive_id": issued.directive_id,
                            "conversation_id": conversation_id,
                            "context_revision": issued.context_revision,
                            "expires_at": issued.expires_at.isoformat(),
                            "requires_confirmation": True,
                            "trusted_activation_required": True,
                        }
                        frames = [
                            (
                                name,
                                {**data, **authority}
                                if name in {"tool_start", "tool_waiting"}
                                else data,
                            )
                            for name, data in frames
                        ]
            for name, data in frames:
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
    # Every new typed-chat turn now enters One's ADK semantic head. The old
    # keyword delegate classifier, deterministic marketplace branch, and
    # finance-biased action-planner/answer split are intentionally absent.
    try:
        runtime = await service.prepare_agent_runtime(
            runtime_credential=body.runtime_credential,
            runtime_credential_mode=body.runtime_credential_mode,
            runtime_credential_transport=body.runtime_credential_transport,
            runtime_vertex_project=body.runtime_vertex_project,
            runtime_vertex_location=body.runtime_vertex_location,
        )
        turn = await service.prepare_turn(
            user_id=body.user_id,
            message=body.message,
            conversation_id=body.conversation_id,
        )
        # A fresh user message supersedes every older unconsumed proposal in
        # this conversation. This is server-side; hiding the old card alone is
        # not authority revocation.
        if body.conversation_id:
            await get_action_directive_store().cancel_open_for_conversation(
                user_id=body.user_id,
                conversation_id=turn.conversation_id,
            )
    except AgentRuntimeContractError as error:
        logger.warning(
            "agent_chat.runtime_contract_failed error_code=%s mode=%s credential_supplied=%s",
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
            "agent_chat.runtime_provider_failed error_code=%s detail=%s",
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
        logger.exception("agent_chat.prepare_failed: %s", error)
        raise HTTPException(status_code=500, detail="Agent chat could not be started") from error

    async def generate():
        chunks: list[str] = []
        directives: list[OneTextDirective] = []
        sources_seen: dict[str, dict[str, Any]] = {}
        saved = False
        first_meaningful_logged = False
        try:
            # Resolve the grounding source server-side rather than taking the
            # request body as the answer. With the pod-native flag off this returns
            # the client blob unchanged, so today's behaviour is byte-identical; the
            # difference is that the SOURCE is now a decided, reported fact instead
            # of an assumption, which is what lets a pod ground its own agent when
            # no browser is open. See pkm_grounding_service.
            grounding = await resolve_grounding(
                user_id=body.user_id, client_context=body.pkm_context
            )
            logger.info(
                "agent_chat.telemetry event=sse_open latency_ms=%.1f runtime_mode=%s "
                "pkm_context=%s grounding_source=%s grounding_reason=%s",
                (time.perf_counter() - request_started) * 1000,
                runtime.mode,
                "provided" if grounding.is_grounded else "absent",
                grounding.source,
                grounding.reason,
            )
            yield _event(
                "start",
                {
                    "conversation_id": turn.conversation_id,
                    "model": runtime.model,
                },
            )
            async for one_event in service.stream_one_turn(
                user_id=body.user_id,
                consent_token=str(token_data.get("token") or ""),
                conversation_id=turn.conversation_id,
                message=body.message,
                history=turn.history,
                timezone=body.timezone,
                screen_context=sanitized_screen_context,
                pkm_context=grounding.text or None,
                runtime=runtime,
                runtime_credential=body.runtime_credential,
                runtime_credential_transport=runtime.gemini_byok_transport,
                runtime_vertex_project=runtime.vertex_project,
                runtime_vertex_location=runtime.vertex_location,
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
                if one_event.kind == "thought" and one_event.text:
                    # Visible reasoning trace, streamed separately from the answer
                    # so the client can render a collapsible "Thinking" panel. Not
                    # persisted to the saved message (chunks) - it is not the answer.
                    yield _event("thought", {"text": one_event.text})
                elif one_event.kind == "source" and one_event.source is not None:
                    # A subagent (specialist) One consulted this turn. Dedupe by
                    # agent and re-emit the accumulated list so the client can
                    # render a "Sources = which subagents were required" rail.
                    src = one_event.source
                    if src.agent_id not in sources_seen:
                        sources_seen[src.agent_id] = {
                            "agent_id": src.agent_id,
                            "label": src.label,
                            "reason": src.reason,
                        }
                        yield _event("sources", {"sources": list(sources_seen.values())})
                elif one_event.kind == "token" and one_event.text:
                    if not first_meaningful_logged:
                        first_meaningful_logged = True
                        logger.info(
                            "agent_chat.telemetry event=first_token latency_ms=%.1f",
                            (time.perf_counter() - request_started) * 1000,
                        )
                    chunks.append(one_event.text)
                    yield _event("token", {"token": one_event.text})
                elif one_event.kind == "directive" and one_event.directive is not None:
                    if not first_meaningful_logged:
                        first_meaningful_logged = True
                        logger.info(
                            "agent_chat.telemetry event=first_tool latency_ms=%.1f",
                            (time.perf_counter() - request_started) * 1000,
                        )
                    # One's instruction permits one action-producing tool per
                    # turn. Keep the fail-closed invariant even if a provider
                    # emits multiple state deltas.
                    if directives:
                        logger.warning(
                            "agent_chat.extra_directive_rejected",
                        )
                    else:
                        directives.append(one_event.directive)

            text = "".join(chunks)
            if not text.strip() and not directives:
                raise AgentRuntimeProviderError(
                    error_code="AGENT_RUNTIME_EMPTY_RESPONSE",
                    message="One did not receive a response from the configured model. Please try again.",
                    detail={"phase": "text_stream"},
                )
            directive_frames: list[tuple[str, dict[str, Any]]] = []
            if directives:
                directive = directives[0]
                if directive.delegate_agent_id:
                    # Specialist prompt/choice cards are not executable app
                    # actions. Their existing specialist continuation contract
                    # remains external to the action receipt ledger.
                    directive_frames = _one_directive_frames(
                        directive,
                        conversation_text=text,
                    )
                else:
                    action_id = str(directive.payload.get("actionId") or "").strip()
                    logger.info(
                        "agent_chat.telemetry event=tool_selected action_id=%s",
                        action_id,
                    )
                    action = get_action_gateway_action(action_id)
                    if action is None:
                        raise ActionDirectiveAuthorityError("unknown generated action")
                    slots = (
                        directive.payload.get("slots")
                        if isinstance(directive.payload.get("slots"), dict)
                        else {}
                    )
                    context_revision = str(
                        sanitized_screen_context.get("context_revision")
                        or f"conversation:{turn.conversation_id}"
                    )
                    issued = await get_action_directive_store().issue(
                        user_id=body.user_id,
                        channel="typed_chat",
                        conversation_id=turn.conversation_id,
                        action_id=action_id,
                        context_revision=context_revision,
                        action_contract=action,
                        slots=slots,
                        # Every private-agent action is a proposal. There is no
                        # low-risk bypass: even navigation needs a fresh trusted
                        # user activation before this directive can be consumed.
                        trusted_activation_required=True,
                    )
                    directive_frames = _one_directive_frames(
                        directive,
                        conversation_text=text,
                        directive_id=issued.directive_id,
                        conversation_id=turn.conversation_id,
                        context_revision=issued.context_revision,
                        expires_at=issued.expires_at.isoformat(),
                    )
            if not text.strip() and directives:
                frame_message = next(
                    (
                        str(data.get("message") or "").strip()
                        for _, data in directive_frames
                        if str(data.get("message") or "").strip()
                    ),
                    "Working on that in the app.",
                )
                text = frame_message
                chunks.append(frame_message)
                yield _event("token", {"token": frame_message})
            await _save_assistant_message(
                service=service,
                turn=turn,
                user_id=body.user_id,
                text=text,
                status_value="complete",
            )
            saved = True
            if directives and text.strip():
                directive_frames = _one_directive_frames(
                    directives[0],
                    conversation_text=text,
                    directive_id=str(directive_frames[0][1].get("directive_id") or ""),
                    conversation_id=turn.conversation_id,
                    context_revision=str(directive_frames[0][1].get("context_revision") or ""),
                    expires_at=str(directive_frames[0][1].get("expires_at") or ""),
                )
            for event_name, data in directive_frames:
                yield _event(event_name, data)
            yield _event(
                "complete",
                {
                    "conversation_id": turn.conversation_id,
                    "status": "complete",
                    "model": runtime.model,
                },
            )
            logger.info(
                "agent_chat.telemetry event=complete latency_ms=%.1f directive=%s",
                (time.perf_counter() - request_started) * 1000,
                bool(directives),
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
                "agent_chat.stream_provider_failed error_code=%s detail=%s",
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
            logger.exception("agent_chat.stream_failed: %s", error)
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
        "X-Agent-Model": runtime.model,
    }
    return StreamingResponse(generate(), media_type="text/event-stream", headers=headers)


def _directive_conflict(error: ActionDirectiveAuthorityError) -> HTTPException:
    # Keep cross-user and stale/replayed failures deliberately indistinguishable.
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "code": "ACTION_CONFIRMATION_REJECTED",
            "message": "This action is no longer confirmable. Ask One to propose it again.",
        },
    )


@router.post("/agent/chat/actions/{directive_id}/confirm")
async def confirm_agent_chat_action(
    directive_id: str,
    body: ActionConfirmationRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _assert_user(token_data, body.user_id)
    try:
        confirmation = await get_action_directive_store().confirm(
            directive_id=directive_id,
            user_id=body.user_id,
            conversation_id=body.conversation_id,
            action_id=body.action_id,
            context_revision=body.context_revision,
            trusted_activation=body.trusted_activation,
        )
    except ActionDirectiveAuthorityError as error:
        raise _directive_conflict(error) from error
    logger.info("agent_chat.telemetry event=action_confirmed action_id=%s", body.action_id)
    return {
        "directive_id": confirmation.directive_id,
        "receipt": confirmation.receipt,
        "expires_at": confirmation.expires_at.isoformat(),
        "confirmed_at": confirmation.confirmed_at.isoformat(),
        "trusted_activation": confirmation.trusted_activation,
    }


@router.post("/agent/chat/actions/{directive_id}/consume")
async def consume_agent_chat_action(
    directive_id: str,
    body: ActionConsumeRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _assert_user(token_data, body.user_id)
    try:
        await get_action_directive_store().consume(
            directive_id=directive_id,
            receipt=body.receipt,
            user_id=body.user_id,
            conversation_id=body.conversation_id,
            action_id=body.action_id,
            context_revision=body.context_revision,
        )
    except ActionDirectiveAuthorityError as error:
        raise _directive_conflict(error) from error
    logger.info("agent_chat.telemetry event=action_consumed action_id=%s", body.action_id)
    return {"directive_id": directive_id, "status": "consumed"}


@router.post("/agent/chat/actions/{directive_id}/cancel")
async def cancel_agent_chat_action(
    directive_id: str,
    body: ActionCancelRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _assert_user(token_data, body.user_id)
    try:
        await get_action_directive_store().cancel_typed(
            directive_id=directive_id,
            user_id=body.user_id,
            conversation_id=body.conversation_id,
            action_id=body.action_id,
            context_revision=body.context_revision,
            reason_code=body.reason_code,
        )
    except ActionDirectiveAuthorityError as error:
        raise _directive_conflict(error) from error
    logger.info(
        "agent_chat.telemetry event=action_cancelled action_id=%s",
        body.action_id,
    )
    return {"directive_id": directive_id, "status": "cancelled"}


@router.post("/agent/chat/actions/{directive_id}/settle")
async def settle_agent_chat_action(
    directive_id: str,
    body: ActionSettlementRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _assert_user(token_data, body.user_id)
    try:
        await get_action_directive_store().settle(
            directive_id=directive_id,
            receipt=body.receipt,
            user_id=body.user_id,
            action_id=body.action_id,
            context_revision=body.context_revision,
            status=body.status,
            reason_code=body.reason_code,
        )
    except ActionDirectiveAuthorityError as error:
        raise _directive_conflict(error) from error
    logger.info(
        "agent_chat.telemetry event=action_settled action_id=%s status=%s",
        body.action_id,
        body.status,
    )
    return {
        "directive_id": directive_id,
        "action_id": body.action_id,
        "context_revision": body.context_revision,
        "status": body.status,
        "reason_code": body.reason_code,
        "route_after": body.route_after,
        "screen_after": body.screen_after,
    }


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
