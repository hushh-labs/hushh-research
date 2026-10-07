"""Direct AG-UI chat and encrypted history; only an admitted owner app may enter."""

from __future__ import annotations

from contextlib import aclosing
from typing import Any, Literal

from ag_ui.core import RunAgentInput
from ag_ui.encoder import EventEncoder
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, ValidationError
from sse_starlette.sse import EventSourceResponse

from api.routes.external_connectors import (
    McpReviewRequest,
    PrivateConnectorRoute,
    _mcp_review_response,
)
from api.routes.one import pod_agent_chat_connectors, pod_command_proposals
from api.routes.one.agent_context import sanitize_agent_context
from api.routes.one.pod_chat_owner import owner_context
from api.routes.one.pod_turn import PodTurnRequest, _require_enabled
from hushh_mcp.one_adk.agent_tree import ONE_APP_NAME
from hushh_mcp.one_adk.agui_action_tools import action_id_from_tool_name
from hushh_mcp.one_adk.agui_factory import _authenticated_capabilities
from hushh_mcp.one_adk.history_descriptors import (
    _event_text,
    _safe_agent_history_metadata,
    _session_title,
    _submitted_source_id,
)
from hushh_mcp.one_adk.history_projection import _call_providers, project_conversation_history
from hushh_mcp.one_adk.mcp_call_approval import STATE_MCP_APPROVAL, admit_resume_receipt
from hushh_mcp.one_adk.mcp_turn_scope import STATE_MCP_CONFIGURATION, admit_turn_configurations
from hushh_mcp.one_adk.output_privacy import safe_exception_event
from hushh_mcp.one_adk.pod_agui_context import PodChatContext
from hushh_mcp.one_adk.queued_input import QueuedInputError
from hushh_mcp.one_adk.queued_input import registry as queued_input_registry
from hushh_mcp.one_adk.request_secrets import store_request_secret
from hushh_mcp.one_adk.specialist_focus import (
    STATE_SPECIALIST_FOCUS,
    SpecialistFocusInvalid,
    admit_specialist_focus,
)
from hushh_mcp.one_adk.turn_location import STATE_TURN_LOCATION, admit_turn_location
from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError
from hushh_mcp.services.action_gateway import get_action_gateway_action
from hushh_mcp.services.external_mcp_client import ExternalMcpError
from hushh_mcp.services.message_feedback_service import MessageFeedbackError

router = APIRouter(
    prefix="/api/one/pod/agent-chat", tags=["personal-agent"], route_class=PrivateConnectorRoute
)


async def context(request: Request) -> PodChatContext:
    _require_enabled()
    result = PodChatContext(
        request.headers.get("authorization"),
        needs_key=request.method != "DELETE",
        browser_runtime=getattr(request.app.state, "browser_task_runtime", None),
    )
    await result.require_access()
    return result


@router.get("/capabilities")
async def capabilities(owner: PodChatContext = Depends(context)):
    # Discovery performs no model construction, turn admission or history write.
    return _authenticated_capabilities


def trusted_state(input: RunAgentInput, owner: PodChatContext) -> tuple[dict, PodTurnRequest]:
    if any(message.role == "system" for message in input.messages):
        raise HTTPException(400, detail={"code": "AGENT_SYSTEM_MESSAGE_REFUSED"})
    forwarded = input.forwarded_props if isinstance(input.forwarded_props, dict) else {}
    if input.context or any(
        forwarded.get(key)
        for key in (
            "consentContinuation",
            "driveSearchSelection",
            "pendingEmailDraft",
            "gmailInformationRequestWorkflowId",
            "personSelectionHandle",
        )
    ):
        raise HTTPException(409, detail={"code": "POD_CHAT_AUTHORITY_UNAVAILABLE"})
    for tool in input.tools:
        action_id = action_id_from_tool_name(tool.name)
        if not action_id or get_action_gateway_action(action_id) is None:
            raise HTTPException(400, detail={"code": "AGENT_TOOL_NOT_ADMITTED"})
    options = PodTurnRequest.model_validate(
        {
            "message": "AG-UI turn",
            "conversationId": input.thread_id,
            **{
                key: forwarded[key]
                for key in (
                    "timezone",
                    "pkmContext",
                    "runtimeCredential",
                    "runtimeCredentialTransport",
                    "runtimeProvider",
                    "puppyDeviceId",
                    "vertexProject",
                    "vertexLocation",
                    "dataDoorGrants",
                )
                if key in forwarded and forwarded[key] is not None
            },
        }
    )
    try:
        focus = admit_specialist_focus(forwarded)
    except SpecialistFocusInvalid:
        raise HTTPException(400, detail={"code": "POD_CHAT_SPECIALIST_FOCUS_INVALID"}) from None
    screen_context = forwarded.get("screenContext")
    screen = sanitize_agent_context(screen_context if isinstance(screen_context, dict) else {})
    state = {
        STATE_TURN_LOCATION: admit_turn_location(forwarded),
        STATE_MCP_APPROVAL: admit_resume_receipt(
            forwarded, owner_id=owner.owner, conversation_id=input.thread_id
        ),
        STATE_MCP_CONFIGURATION: admit_turn_configurations(
            forwarded, owner_id=owner.owner, conversation_id=input.thread_id
        ),
        "temp:one_execution_surface": "typed_chat",
        "temp:hussh:workspace_chat_admission": False,
        "hussh:user_id": owner.owner,
        "hussh:consent_token": store_request_secret(
            owner.authority.local_token(owner.claims), ttl_seconds=240
        ),
        "hussh:conversation_id": input.thread_id,
        "hussh:data_door_grants": {
            key: store_request_secret(value, ttl_seconds=240)
            for key, value in (options.data_door_grants or {}).items()
        },
        "hussh:timezone": options.timezone or "",
        "hussh:typed_chat_context": True,
        "hussh:screen": str(screen.get("screen") or "")[:64],
        STATE_SPECIALIST_FOCUS: focus,
        "hussh:voice_context": screen,
        "hussh:pkm_context": store_request_secret(options.pkm_context or "", ttl_seconds=240),
    }
    return state, options


@router.post("")
async def chat(input: RunAgentInput, owner: PodChatContext = Depends(context)):
    try:
        state, options = trusted_state(input, owner)
    except ValidationError:
        raise HTTPException(400, detail={"code": "POD_CHAT_REQUEST_INVALID"}) from None
    except ActionDirectiveAuthorityError:
        raise HTTPException(409, detail={"code": "MCP_REVIEW_CHANGED"}) from None
    except ExternalMcpError as exc:
        raise HTTPException(400, detail={"code": exc.code}) from None
    agent = await owner.build_agent(options)
    # Never merge client state or forward credentials into SDK/session state.
    admitted = input.model_copy(update={"state": state, "forwarded_props": {}})
    encoder = EventEncoder(accept="text/event-stream")

    async def events():
        try:
            async with aclosing(agent.run(admitted)) as stream:
                async for event in stream:
                    yield encoder.encode(event).encode("utf-8")
        except Exception as exc:
            # Admission, memory preparation and final persistence also execute
            # outside the SDK's error projection. Never serialize their details.
            yield encoder.encode(safe_exception_event(exc)).encode("utf-8")

    return EventSourceResponse(events(), headers={"Cache-Control": "no-store"})


@router.get("/conversations/{user_id}")
async def conversations(
    user_id: str, limit: int = Query(5, ge=1, le=20), owner: PodChatContext = Depends(context)
):
    if user_id != owner.owner:
        raise HTTPException(403, detail={"code": "POD_CHAT_OWNER_MISMATCH"})
    response = await owner.sessions.list_sessions(app_name=ONE_APP_NAME, user_id=owner.owner)
    sessions = sorted(response.sessions, key=lambda item: item.last_update_time, reverse=True)[
        :limit
    ]
    return {
        "user_id": owner.owner,
        "conversations": [
            {
                "id": session.id,
                "title": _session_title(session),
                "status": "active",
                "model": None,
                "message_count": sum(1 for event in session.events if _event_text(event)),
                "created_at": None,
                "updated_at": session.last_update_time,
                "last_message_at": session.last_update_time,
            }
            for session in sessions
        ],
    }


@router.get("/history/{conversation_id}")
async def history(
    conversation_id: str,
    limit: int = Query(50, ge=1, le=100),
    owner: PodChatContext = Depends(context),
):
    session = await owner.sessions.get_session(
        app_name=ONE_APP_NAME, user_id=owner.owner, session_id=conversation_id
    )
    if session is None:
        raise HTTPException(404, detail="Conversation not found.")
    submitted = {source for event in session.events if (source := _submitted_source_id(event))}
    providers = _call_providers(session.events)
    return project_conversation_history(
        session.events,
        conversation_id,
        limit,
        project_event=lambda event: (
            _event_text(event),
            _safe_agent_history_metadata(event, submitted, providers),
        ),
    )


class Rename(BaseModel):
    title: str = Field(min_length=1, max_length=160)


@router.patch("/conversations/{conversation_id}")
async def rename(conversation_id: str, payload: Rename, owner: PodChatContext = Depends(context)):
    from hushh_mcp.services.pod_upgrade_admission import ADMISSION, pod_incarnation

    permit = await ADMISSION.acquire_turn(incarnation=pod_incarnation())
    try:
        session = await owner.sessions.set_title(
            app_name=ONE_APP_NAME,
            user_id=owner.owner,
            session_id=conversation_id,
            title=payload.title,
        )
    finally:
        await permit.release()
    if session is None:
        raise HTTPException(404, detail="Conversation not found.")
    return {
        "id": session.id,
        "title": _session_title(session),
        "status": "active",
        "message_count": len(session.events),
    }


@router.delete("/conversations/{conversation_id}")
async def delete(conversation_id: str, owner: PodChatContext = Depends(context)):
    from hushh_mcp.services.pod_upgrade_admission import ADMISSION, pod_incarnation

    permit = await ADMISSION.acquire_turn(incarnation=pod_incarnation())
    try:
        deleted = await owner.sessions.delete_owned_session(
            app_name=ONE_APP_NAME, user_id=owner.owner, session_id=conversation_id
        )
    finally:
        await permit.release()
    if not deleted:
        raise HTTPException(404, detail="Conversation not found.")
    return {"conversation_id": conversation_id, "deleted": True}


@router.post("/connectors/{connector_id}/mcp/review")
async def review_mcp(
    connector_id: str, body: "McpReviewRequest", owner: PodChatContext = Depends(context)
):
    from hushh_mcp.one_adk.pod_mcp_review import prepare_private_review

    return await _mcp_review_response(
        prepare_private_review, owner=owner, connector_id=connector_id, body=body
    )


# ── Queued input: messages sent while One is still working ─────────────────
# The same owner-bound registry the hub uses (queued_input.py), keyed by this pod's
# owner. Only enqueue carries text; it stays in this process until the running turn
# seals it into the conversation or it is returned to the app.


class EnqueueQueuedInput(BaseModel):
    client_message_id: str = Field(min_length=8, max_length=64)
    text: str = Field(min_length=1, max_length=4000)


def _receipt(receipt: Any) -> dict[str, str]:
    return {"clientMessageId": receipt.client_message_id, "status": receipt.status}


@router.post("/runs/{conversation_id}/queue")
async def enqueue_queued_input(
    conversation_id: str,
    payload: EnqueueQueuedInput,
    owner: PodChatContext = Depends(owner_context),
):
    try:
        receipt = queued_input_registry.enqueue(
            owner.owner, conversation_id, payload.client_message_id, payload.text
        )
    except QueuedInputError as exc:
        raise HTTPException(400, detail=str(exc)) from None
    return _receipt(receipt)


@router.delete("/runs/{conversation_id}/queue/{client_message_id}")
async def withdraw_queued_input(
    conversation_id: str, client_message_id: str, owner: PodChatContext = Depends(owner_context)
):
    try:
        receipt = queued_input_registry.withdraw(owner.owner, conversation_id, client_message_id)
    except QueuedInputError as exc:
        raise HTTPException(400, detail=str(exc)) from None
    return _receipt(receipt)


@router.get("/runs/{conversation_id}/queue")
async def queued_input_status(
    conversation_id: str,
    ids: list[str] = Query(default_factory=list, max_length=16),
    owner: PodChatContext = Depends(owner_context),
):
    try:
        receipts = queued_input_registry.status(owner.owner, conversation_id, ids)
    except QueuedInputError as exc:
        raise HTTPException(400, detail=str(exc)) from None
    return {"receipts": [_receipt(receipt) for receipt in receipts]}


@router.post("/runs/{conversation_id}/stop")
async def stop_agent_turn(conversation_id: str, owner: PodChatContext = Depends(owner_context)):
    """End the running turn at its next step; queued messages come back unsent."""
    settlement = queued_input_registry.request_stop(owner.owner, conversation_id)
    if settlement is None:
        return {"stopped": False, "returned": []}
    return {"stopped": True, "returned": list(settlement.returned)}


# ── Ratings: ids and two closed enums, stored in this pod (pod_message_feedback) ──


class MessageFeedbackRequest(BaseModel):
    conversation_id: str = Field(max_length=200)
    message_id: str = Field(max_length=200)
    rating: Literal["up", "down"] | None = None
    report_reason: Literal["offensive", "harmful", "inaccurate", "other"] | None = None


@router.get("/feedback")
async def read_feedback(
    conversation_id: str = Query(max_length=200), owner: PodChatContext = Depends(owner_context)
):
    from hushh_mcp.services import pod_message_feedback

    return await pod_message_feedback.read_feedback(
        owner.log, owner=owner.owner, hushh_id=owner.hushh_id, conversation=conversation_id
    )


@router.put("/feedback")
async def write_feedback(
    payload: MessageFeedbackRequest, owner: PodChatContext = Depends(owner_context)
):
    from hushh_mcp.services import pod_message_feedback
    from hushh_mcp.services.pod_upgrade_admission import ADMISSION, pod_incarnation

    try:
        conversation, message, rating, reason = pod_message_feedback.normalize_feedback(
            conversation_ref=payload.conversation_id,
            message_ref=payload.message_id,
            rating=payload.rating,
            report_reason=payload.report_reason,
        )
        if not await pod_message_feedback.conversation_exists(ONE_APP_NAME, conversation):
            raise MessageFeedbackError(
                "That conversation does not exist.", code="CONVERSATION_NOT_FOUND"
            )
    except MessageFeedbackError as exc:
        raise HTTPException(400, detail={"code": exc.code, "message": str(exc)}) from None
    permit = await ADMISSION.acquire_turn(incarnation=pod_incarnation())
    try:
        await owner.require_access()
        return await pod_message_feedback.record_feedback(
            owner.log,
            owner=owner.owner,
            hushh_id=owner.hushh_id,
            conversation=conversation,
            message=message,
            rating=rating,
            report_reason=reason,
        )
    finally:
        await permit.release()


# Settings' connector refresh and login, and voice proposals, on the same prefix and
# owner admission (pod_agent_chat_connectors.py, pod_command_proposals.py).
router.include_router(pod_agent_chat_connectors.router)
router.include_router(pod_command_proposals.router)
