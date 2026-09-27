"""Canonical AG-UI transport for the private agent's text experience."""

from __future__ import annotations

import hashlib
import logging
import re
import uuid
from typing import Any

from ag_ui.core import RunAgentInput
from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from google.adk.apps import App, ResumabilityConfig
from google.adk.events import Event
from google.adk.sessions import InMemorySessionService
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from api.middleware import require_vault_owner_token
from api.middlewares.chat_key import (
    CHAT_KEY_REQUIRED_DETAIL,
    log_chat_key_refusal,
    require_vault_owner_chat_key,
)
from api.routes.one.agent_context import sanitize_agent_context
from api.routes.one.command_proposals import require_private_runtime
from api.utils.firebase_auth import verify_firebase_bearer
from hushh_mcp.one_adk.agent_tree import (
    ONE_APP_NAME,
    STATE_CONSENT_TOKEN,
    STATE_CONVERSATION_ID,
    STATE_GMAIL_INFORMATION_REQUEST_CONTEXT,
    STATE_GMAIL_INFORMATION_REQUEST_WORKFLOW_ID,
    STATE_PKM_CONTEXT,
    STATE_SCREEN,
    STATE_TIMEZONE,
    STATE_USER_ID,
    STATE_VOICE_CONTEXT,
    build_one_intro_text_agent,
    build_one_text_agent,
)
from hushh_mcp.one_adk.agui_action_tools import action_id_from_tool_name
from hushh_mcp.one_adk.agui_factory import _authenticated_capabilities, build_authenticated_agui
from hushh_mcp.one_adk.agui_factory import _DurableSessionManager as _DurableSessionManager
from hushh_mcp.one_adk.agui_turn_timing import HEAD_INTRO, TimedADKAgent
from hushh_mcp.one_adk.encrypted_session_service import EncryptedAdkSessionService
from hushh_mcp.one_adk.external_read_boundary import (
    STATE_EXECUTION_SURFACE,
)
from hushh_mcp.one_adk.history_descriptors import (
    _discovery_source as _discovery_source,
)
from hushh_mcp.one_adk.history_descriptors import (
    _event_text as _event_text,
)
from hushh_mcp.one_adk.history_descriptors import (
    _safe_agent_history_metadata as _safe_agent_history_metadata,
)
from hushh_mcp.one_adk.history_descriptors import (
    _safe_discovery_descriptor as _safe_discovery_descriptor,
)
from hushh_mcp.one_adk.history_descriptors import (
    _safe_document_request_descriptor as _safe_document_request_descriptor,
)
from hushh_mcp.one_adk.history_descriptors import (
    _safe_drive_share_descriptor as _safe_drive_share_descriptor,
)
from hushh_mcp.one_adk.history_descriptors import (
    _safe_information_request_descriptor as _safe_information_request_descriptor,
)
from hushh_mcp.one_adk.history_descriptors import (
    _safe_scope_catalog as _safe_scope_catalog,
)
from hushh_mcp.one_adk.history_descriptors import (
    _safe_submitted_information_request_card as _safe_submitted_information_request_card,
)
from hushh_mcp.one_adk.history_descriptors import (
    _safe_submitted_information_request_descriptor as _safe_submitted_information_request_descriptor,
)
from hushh_mcp.one_adk.history_descriptors import (
    _session_title as _session_title,
)
from hushh_mcp.one_adk.history_descriptors import (
    _submitted_source_id as _submitted_source_id,
)
from hushh_mcp.one_adk.history_projection import (
    _ACTIVITY_TOOLS as _ACTIVITY_TOOLS,
)
from hushh_mcp.one_adk.history_projection import (
    _bounded_text as _bounded_text,
)
from hushh_mcp.one_adk.history_projection import (
    _call_providers,
    project_conversation_history,
)
from hushh_mcp.one_adk.history_projection import (
    _record as _record,
)
from hushh_mcp.one_adk.history_projection import (
    _safe_turn_activity as _safe_turn_activity,
)
from hushh_mcp.one_adk.history_projection import (
    _safe_workspace_connector_setup_descriptor as _safe_workspace_connector_setup_descriptor,
)
from hushh_mcp.one_adk.mcp_call_approval import STATE_MCP_APPROVAL, admit_resume_receipt
from hushh_mcp.one_adk.mcp_turn_scope import STATE_MCP_CONFIGURATION, admit_turn_configurations
from hushh_mcp.one_adk.request_secrets import (
    consume_request_secret,
    resolve_request_secret,
    store_request_secret,
)
from hushh_mcp.one_adk.turn_location import STATE_TURN_LOCATION, admit_turn_location
from hushh_mcp.one_adk.workspace_mcp_tools import WORKSPACE_CHAT_ADMISSION_STATE
from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError
from hushh_mcp.services.action_gateway import get_action_gateway_action, list_action_gateway_actions
from hushh_mcp.services.chat_key import request_has_chat_key
from hushh_mcp.services.external_mcp_client import ExternalMcpError
from hushh_mcp.services.gmail_personal_information_request_service import (
    PersonalGmailInformationRequestError,
    get_personal_gmail_information_request_service,
)
from hushh_mcp.services.information_request_service import (
    InformationRequestError,
    InformationRequestService,
)
from hushh_mcp.services.personal_agent_hosting import get_owner_hosting_mode

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Agent One"])


def _user_id(input_data: RunAgentInput) -> str:
    state = input_data.state if isinstance(input_data.state, dict) else {}
    value = str(state.get(STATE_USER_ID) or "").strip()
    if not value:
        raise ValueError("Authenticated Agent One user is missing.")
    return value


async def _extract_state(request: Request, input_data: RunAgentInput) -> dict[str, Any]:
    if any(message.role == "system" for message in input_data.messages):
        raise HTTPException(400, detail={"code": "AGENT_SYSTEM_MESSAGE_REFUSED"})
    authorization = request.headers.get("authorization")
    consent_header = request.headers.get("x-hushh-consent")
    token: dict[str, Any] | None = None
    authorization_token = re.sub(r"^Bearer\s+", "", (authorization or "").strip(), flags=re.I)
    authorization_is_consent = authorization_token.startswith("HCT:")
    if consent_header is not None:
        token = await require_vault_owner_token(
            request=request,
            authorization=None,
            hushh_consent=consent_header,
        )
    if authorization_is_consent:
        bearer_token = await require_vault_owner_token(
            request=request,
            authorization=authorization,
            hushh_consent=None,
        )
        if token is not None and bearer_token["user_id"] != token["user_id"]:
            raise HTTPException(status_code=403, detail="Credential owner mismatch")
        token = bearer_token
    firebase_uid = ""
    if authorization and not authorization_is_consent:
        firebase_uid = await run_in_threadpool(verify_firebase_bearer, authorization)
        if token is not None and firebase_uid != token["user_id"]:
            raise HTTPException(status_code=403, detail="Credential owner mismatch")
    if token is not None:
        hosting_mode = await get_owner_hosting_mode(token["user_id"])
        if hosting_mode == "unknown":
            raise HTTPException(status_code=503, detail={"code": "AGENT_HOSTING_UNAVAILABLE"})
        if hosting_mode != "shared":
            raise HTTPException(status_code=409, detail={"code": "AGENT_PRIVATE_RUNTIME_REQUIRED"})
    forwarded = input_data.forwarded_props if isinstance(input_data.forwarded_props, dict) else {}
    if (
        forwarded.get("runtimeCredential")
        or input_data.context
        or (not token and forwarded.get("pkmContext"))
    ):
        raise HTTPException(status_code=400, detail="Private context requires the private agent")
    screen_payload = forwarded.get("screenContext")
    screen_context = sanitize_agent_context(
        screen_payload if isinstance(screen_payload, dict) else {}
    )

    # Client-provided tools are frontend execution requests, never new
    # authority. Every tool must already exist in the generated Action Gateway.
    for tool in input_data.tools:
        action_id = action_id_from_tool_name(tool.name)
        if not action_id or get_action_gateway_action(action_id) is None:
            raise HTTPException(
                status_code=400, detail="Agent tool is not in the generated action contract."
            )

    # Discard arbitrary client state before the middleware merges the trusted
    # projection. Sensitive values are represented only by expiring references.
    input_data.state = {}
    anonymous_seed = (
        f"{request.client.host if request.client else ''}|{request.headers.get('user-agent', '')}"
    )
    user_id = str((token or {}).get("user_id") or firebase_uid).strip()
    if token and user_id:
        # Durable history is sealed with the owner's chat key. Refuse before any
        # stream starts rather than failing mid-turn or reading without it.
        if not request_has_chat_key(user_id):
            log_chat_key_refusal(request, "CHAT_KEY_REQUIRED", owner_id=user_id)
            raise HTTPException(
                status_code=403,
                detail={"message": CHAT_KEY_REQUIRED_DETAIL, "code": "CHAT_KEY_REQUIRED"},
            )
        if input_data.thread_id and await _session_service.is_legacy_session(
            app_name=ONE_APP_NAME, user_id=user_id, session_id=input_data.thread_id
        ):
            raise HTTPException(
                status_code=409,
                detail={
                    "message": "This conversation is no longer available. Start a new chat.",
                    "code": "CHAT_CONVERSATION_RETIRED",
                },
            )
    try:
        mcp_approval = admit_resume_receipt(
            forwarded, owner_id=user_id if token else "", conversation_id=input_data.thread_id
        )
    except ActionDirectiveAuthorityError:
        raise HTTPException(
            status_code=403,
            detail="Connector confirmation is unavailable. Unlock and review again.",
        ) from None
    session_user_id = (
        user_id or f"anonymous:{hashlib.sha256(anonymous_seed.encode()).hexdigest()[:24]}"
    )
    workflow_id = str(forwarded.get("gmailInformationRequestWorkflowId") or "").strip()
    if workflow_id and (len(workflow_id) > 128 or not re.fullmatch(r"[A-Za-z0-9-]+", workflow_id)):
        raise HTTPException(status_code=400, detail="Selected Gmail request is invalid.")
    gmail_information_request_context = ""
    if workflow_id:
        if not token or not user_id:
            raise HTTPException(
                status_code=403,
                detail="Unlock your vault before replying to the selected Gmail request.",
            )
        try:
            gmail_information_request_context = (
                await get_personal_gmail_information_request_service().get_chat_reply_context(
                    user_id=user_id,
                    workflow_id=workflow_id,
                )
            )
        except PersonalGmailInformationRequestError as exc:
            logger.info("one.gmail_information_request_context_unavailable code=%s", exc.code)
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001 - do not surface provider details to chat
            logger.warning(
                "one.gmail_information_request_context_failed error=%s", type(exc).__name__
            )
            raise HTTPException(
                status_code=503,
                detail="The selected Gmail request is temporarily unavailable. Please try again.",
            ) from exc
    try:
        mcp_configuration = admit_turn_configurations(
            forwarded, owner_id=user_id if token else "", conversation_id=input_data.thread_id
        )
    except ExternalMcpError:
        raise HTTPException(
            status_code=403, detail="Connector configuration is unavailable. Unlock and try again."
        ) from None
    # The device sends a coarse position only when the person already granted
    # location; pre-vault turns never keep it.
    turn_location = admit_turn_location(forwarded)
    if not (token and user_id):
        consume_request_secret(turn_location)
        turn_location = ""
    return {
        STATE_EXECUTION_SURFACE: "typed_chat",
        STATE_TURN_LOCATION: turn_location,
        STATE_MCP_CONFIGURATION: mcp_configuration,
        STATE_MCP_APPROVAL: mcp_approval,
        WORKSPACE_CHAT_ADMISSION_STATE: bool(token and user_id),
        STATE_USER_ID: session_user_id,
        STATE_CONSENT_TOKEN: store_request_secret(str(token["token"])) if token else "",
        STATE_CONVERSATION_ID: input_data.thread_id,
        STATE_TIMEZONE: str(forwarded.get("timezone") or "")[:64],
        # This is only an untrusted selection request. The resolver validates
        # it against owner/thread-bound server-issued choices before any read.
        # A picker handle is an untrusted, current-turn admission request. The
        # ADK temp prefix keeps it out of persisted conversation state so an
        # expired selection cannot block or redirect a later typed prompt.
        "temp:hussh:requested_person_selection": str(forwarded.get("personSelectionHandle") or "")[
            :64
        ],
        # Typed chat carries the current screen snapshot in this request. It
        # must not inherit a stale live-voice publication that is still marked
        # as settling; that would suppress the consent confirmation card even
        # while the current browser frame is idle.
        "hussh:typed_chat_context": True,
        STATE_SCREEN: str(screen_context.get("screen") or "")[:64],
        STATE_VOICE_CONTEXT: screen_context,
        STATE_PKM_CONTEXT: store_request_secret(str(forwarded.get("pkmContext") or "")[:20000])
        if token
        else "",
        STATE_GMAIL_INFORMATION_REQUEST_WORKFLOW_ID: workflow_id,
        STATE_GMAIL_INFORMATION_REQUEST_CONTEXT: store_request_secret(
            gmail_information_request_context
        )
        if workflow_id
        else "",
    }


_intro_app = App(
    name=f"{ONE_APP_NAME}_intro",
    root_agent=build_one_intro_text_agent(),
    resumability_config=ResumabilityConfig(is_resumable=True),
)
_session_service = EncryptedAdkSessionService()
_intro_session_service = InMemorySessionService()


_intro_capabilities = {
    **_authenticated_capabilities,
    "reasoning": {"supported": False, "streaming": False, "encrypted": False},
    "tools": {"supported": False, "parallelCalls": False, "clientProvided": False},
    "state": {"snapshots": True, "deltas": True, "memory": False, "persistentState": False},
    "multiAgent": {"supported": False, "delegation": False, "handoffs": False},
    "humanInTheLoop": {"supported": False, "interrupts": False},
}
# The bridge defaults to 10 concurrent executions per process, across every
# person, and keeps a slot for 600 s when a run leaves a pending tool call. Ten
# people mid-confirmation would lock the route for everyone. These bounds are
# per process, not per person; TimedADKAgent releases slots for runs that end
# in error or disconnect. Measured 2026-09-14 on localhost with the latency
# driver (agent-chat-migration-baseline).
_MAX_CONCURRENT_EXECUTIONS = 64
_EXECUTION_TIMEOUT_SECONDS = 200

_agent = build_authenticated_agui(
    build_one_text_agent(allow_workspace_tools=True, include_thought_summaries=True),
    _session_service,
    app_name=ONE_APP_NAME,
    user_id_extractor=_user_id,
)
_app = _agent._app  # Compatibility handle; construction is owned by agui_factory.
_intro_agent = TimedADKAgent.from_app(
    _intro_app,
    head=HEAD_INTRO,
    user_id_extractor=_user_id,
    max_concurrent_executions=_MAX_CONCURRENT_EXECUTIONS,
    execution_timeout_seconds=_EXECUTION_TIMEOUT_SECONDS,
    # Anonymous and Firebase-only pre-vault turns intentionally remain
    # ephemeral. Durable history begins only after VAULT_OWNER authority is
    # present, where the encrypted owner-bound store can enforce teardown.
    session_service=_intro_session_service,
    use_in_memory_services=True,
    use_thread_id_as_session_id=True,
    emit_messages_snapshot=True,
    capabilities=_intro_capabilities,
)


async def _resolve_agent(_request: Request, input_data: RunAgentInput) -> ADKAgent:
    state = input_data.state if isinstance(input_data.state, dict) else {}
    reference = state.get(STATE_CONSENT_TOKEN)
    if not reference:
        return _intro_agent
    if (
        not isinstance(reference, str)
        or not reference.startswith("one_secret_ref:")
        or not resolve_request_secret(reference)
    ):
        raise HTTPException(status_code=409, detail={"code": "AGENT_PRIVATE_RUNTIME_REQUIRED"})
    return _agent


add_adk_fastapi_endpoint(
    router,
    _agent,
    path="/api/one/agent-chat",
    extract_state_from_request=_extract_state,
    agent_resolver=_resolve_agent,
)


class RenameConversation(BaseModel):
    title: str = Field(min_length=1, max_length=160)


class RecordInformationRequestSubmission(BaseModel):
    source_activity_id: str = Field(min_length=1, max_length=256)
    bundle_id: uuid.UUID
    idempotency_key: str = Field(min_length=16, max_length=256)


@router.post("/api/one/agent-chat/history/{conversation_id}/information-requests")
async def record_information_request_submission(
    conversation_id: str,
    payload: RecordInformationRequestSubmission,
    token: dict = Depends(require_vault_owner_chat_key),
):
    """Record one confirmed browser request in the existing encrypted ADK history.

    The caller supplies locators and the one-time request key, never a card body.
    The request ledger and this owner's conversation derive every display field.
    """
    owner = str(token["user_id"])
    session = await _session_service.get_session(
        app_name=ONE_APP_NAME, user_id=owner, session_id=conversation_id
    )
    if session is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    source = _discovery_source(session, payload.source_activity_id)
    if source is None:
        raise HTTPException(status_code=404, detail="Discovery card not found.")
    source_card_id, discovery = source
    try:
        bundle = await InformationRequestService().verify_submission_receipt(
            requester_user_id=owner,
            bundle_id=str(payload.bundle_id),
            idempotency_key=payload.idempotency_key,
        )
    except InformationRequestError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    person = discovery["person"]
    if bundle["personRef"] != person.get("personRef") or not bundle.get("items"):
        raise HTTPException(status_code=409, detail="Request recipient did not match discovery.")
    statuses = [item["status"] for item in bundle["items"]]
    status = statuses[0] if all(value == statuses[0] for value in statuses) else "mixed"
    hours = bundle["durationSeconds"] // 3600
    duration_label = (
        f"{hours // 24} {'day' if hours // 24 == 1 else 'days'}"
        if hours % 24 == 0
        else f"{hours} {'hour' if hours == 1 else 'hours'}"
    )
    card = {
        "activityType": "one.information_request_review.v1",
        "direction": "outgoing",
        "phase": "submitted",
        "status": status,
        "personName": person["displayName"],
        "subjectRef": bundle["personRef"],
        "bundleId": bundle["bundleId"],
        "purpose": bundle["purpose"],
        "durationLabel": duration_label,
        "fields": [
            {
                "requestId": item["requestId"],
                "label": item["label"],
                "domain": "Information",
                "sensitivity": item.get("sensitivity") or "standard",
                "status": item["status"],
            }
            for item in bundle["items"]
        ],
    }
    descriptor = _safe_submitted_information_request_card(card)
    if descriptor is None:
        raise HTTPException(status_code=409, detail="Request receipt could not be projected.")
    event = Event(
        id=f"request_submission_{hashlib.sha256(source_card_id.encode()).hexdigest()[:32]}",
        author="one",
        invocation_id=f"information_request_{payload.bundle_id}",
        custom_metadata={
            "kind": "information_request_submission_v1",
            "sourceCardId": source_card_id,
            "card": card,
        },
    )
    persisted = await _session_service.append_event_once(
        app_name=ONE_APP_NAME, user_id=owner, session_id=conversation_id, event=event
    )
    persisted_metadata = _record(persisted.custom_metadata) or {}
    persisted_descriptor = _safe_submitted_information_request_card(persisted_metadata.get("card"))
    if _submitted_source_id(persisted) != source_card_id or not persisted_descriptor:
        raise HTTPException(status_code=409, detail="Discovery was already submitted.")
    if persisted_descriptor["content"].get("bundleId") != str(payload.bundle_id):
        raise HTTPException(status_code=409, detail="Discovery was already submitted.")
    return {"descriptor": persisted_descriptor, "sourceActivityId": source_card_id}


@router.get("/api/one/agent-chat/conversations/{user_id}")
async def list_conversations(
    user_id: str,
    limit: int = Query(default=5, ge=1, le=20),
    token: dict = Depends(require_vault_owner_chat_key),
):
    if str(token["user_id"]) != user_id:
        raise HTTPException(status_code=403, detail="Conversation owner mismatch.")
    response = await _session_service.list_sessions(app_name=ONE_APP_NAME, user_id=user_id)
    sessions = sorted(response.sessions, key=lambda item: item.last_update_time, reverse=True)[
        :limit
    ]
    return {
        "user_id": user_id,
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


@router.get("/api/one/agent-chat/history/{conversation_id}")
async def conversation_history(
    conversation_id: str,
    limit: int = Query(default=50, ge=1, le=100),
    token: dict = Depends(require_vault_owner_chat_key),
):
    user_id = str(token["user_id"])
    session = await _session_service.get_session(
        app_name=ONE_APP_NAME, user_id=user_id, session_id=conversation_id
    )
    if session is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    submitted_discovery_ids = {
        source_id for event in session.events if (source_id := _submitted_source_id(event))
    }
    call_providers = _call_providers(session.events)
    return project_conversation_history(
        session.events,
        conversation_id,
        limit,
        project_event=lambda event: (
            _event_text(event),
            _safe_agent_history_metadata(event, submitted_discovery_ids, call_providers),
        ),
    )


@router.patch("/api/one/agent-chat/conversations/{conversation_id}")
async def rename_conversation(
    conversation_id: str,
    payload: RenameConversation,
    token: dict = Depends(require_vault_owner_chat_key),
):
    session = await _session_service.set_title(
        app_name=ONE_APP_NAME,
        user_id=str(token["user_id"]),
        session_id=conversation_id,
        title=payload.title,
    )
    if session is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return {
        "id": session.id,
        "title": _session_title(session),
        "status": "active",
        "message_count": len(session.events),
    }


@router.delete("/api/one/agent-chat/conversations/{conversation_id}")
async def delete_conversation(
    conversation_id: str,
    token: dict = Depends(require_vault_owner_token),
):
    # Deleting needs no plaintext, so it needs no chat key: only the owner's
    # current conversation row, matched by id, is removed.
    deleted = await _session_service.delete_owned_session(
        app_name=ONE_APP_NAME, user_id=str(token["user_id"]), session_id=conversation_id
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return {"conversation_id": conversation_id, "deleted": True}


# ── Proposal mode: action search and structured proposals ────────────────────


class ActionSearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2048)
    context: dict[str, Any] | None = None
    limit: int = Field(default=10, ge=1, le=20)


@router.post("/api/one/actions/search", dependencies=[Depends(require_private_runtime)])
async def search_actions_endpoint(
    payload: ActionSearchRequest,
    request: Request,
    token: dict = Depends(require_vault_owner_token),
):
    """Return related generated capabilities for a natural-language query.

    This is a read-only search. No action is executed.
    """
    from hushh_mcp.one_adk.action_retrieval import search_actions_for_command_palette

    query = payload.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Query must not be empty.")

    app_runtime_state: dict[str, Any] = {}
    if isinstance(payload.context, dict):
        # Only redacted routing fields cross this search boundary. The action
        # gateway remains the execution authority and revalidates everything.
        for key in ("screen", "available_action_ids", "executable_action_ids"):
            value = payload.context.get(key)
            if key == "screen" and isinstance(value, str):
                app_runtime_state[key] = value
            elif (
                key != "screen"
                and isinstance(value, list)
                and all(isinstance(item, str) for item in value)
            ):
                app_runtime_state[key] = value[:100]
    screen = request.headers.get("x-hushh-screen")
    if screen:
        app_runtime_state["screen"] = screen

    try:
        results = search_actions_for_command_palette(
            query,
            {"actions": list_action_gateway_actions()},
            app_runtime_state=app_runtime_state,
            limit=payload.limit,
        )
    except Exception:
        logger.exception("action_search_failed")
        raise HTTPException(status_code=500, detail="Search temporarily unavailable.")

    return {
        "status": "ok",
        "query": query,
        "total": len(results),
        "results": results,
    }
