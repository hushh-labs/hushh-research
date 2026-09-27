"""Direct AG-UI chat and encrypted history; only an admitted owner app may enter."""

from __future__ import annotations

from contextlib import aclosing

from ag_ui.core import RunAgentInput
from ag_ui.encoder import EventEncoder
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, ValidationError
from sse_starlette.sse import EventSourceResponse

from api.routes.one.agent_context import sanitize_agent_context
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
from hushh_mcp.one_adk.mcp_turn_scope import STATE_MCP_CONFIGURATION, admit_turn_configurations
from hushh_mcp.one_adk.output_privacy import safe_exception_event
from hushh_mcp.one_adk.pod_agui_context import PodChatContext
from hushh_mcp.one_adk.request_secrets import store_request_secret
from hushh_mcp.one_adk.turn_location import STATE_TURN_LOCATION, admit_turn_location
from hushh_mcp.services.action_gateway import get_action_gateway_action
from hushh_mcp.services.external_mcp_client import ExternalMcpError

router = APIRouter(prefix="/api/one/pod/agent-chat", tags=["personal-agent"])


async def context(request: Request) -> PodChatContext:
    _require_enabled()
    result = PodChatContext(
        request.headers.get("authorization"), needs_key=request.method != "DELETE"
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
            "mcpApproval",
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
    screen_context = forwarded.get("screenContext")
    screen = sanitize_agent_context(screen_context if isinstance(screen_context, dict) else {})
    state = {
        STATE_TURN_LOCATION: admit_turn_location(forwarded),
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
