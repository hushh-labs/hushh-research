"""Canonical AG-UI transport for the private agent's text experience."""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone
from typing import Any

from ag_ui.core import RunAgentInput, UserMessage
from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from google.adk.apps import App, ResumabilityConfig
from google.adk.sessions import InMemorySessionService
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from api.middleware import require_vault_owner_token
from api.routes.one.live_context import sanitize_live_context
from api.utils.firebase_auth import verify_firebase_bearer
from hushh_mcp.one_adk.agent_tree import (
    ONE_APP_NAME,
    STATE_CONSENT_TOKEN,
    STATE_CONVERSATION_ID,
    STATE_PKM_CONTEXT,
    STATE_SCREEN,
    STATE_TIMEZONE,
    STATE_USER_ID,
    STATE_VOICE_CONTEXT,
    build_one_intro_text_agent,
    build_one_text_agent,
)
from hushh_mcp.one_adk.agui_action_tools import action_id_from_tool_name
from hushh_mcp.one_adk.encrypted_session_service import EncryptedAdkSessionService
from hushh_mcp.one_adk.request_secrets import store_request_secret
from hushh_mcp.services.action_gateway import get_action_gateway_action, list_action_gateway_actions

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Agent One"])


def _user_id(input_data: RunAgentInput) -> str:
    state = input_data.state if isinstance(input_data.state, dict) else {}
    value = str(state.get(STATE_USER_ID) or "").strip()
    if not value:
        raise ValueError("Authenticated Agent One user is missing.")
    return value


async def _extract_state(request: Request, input_data: RunAgentInput) -> dict[str, Any]:
    authorization = request.headers.get("authorization")
    consent_header = request.headers.get("x-hushh-consent")
    token: dict[str, Any] | None = None
    try:
        token = await require_vault_owner_token(
            request=request,
            authorization=authorization,
            hushh_consent=consent_header,
        )
    except HTTPException:
        token = None
    firebase_uid = ""
    if token is None and authorization:
        try:
            firebase_uid = await run_in_threadpool(verify_firebase_bearer, authorization)
        except HTTPException:
            firebase_uid = ""
    forwarded = input_data.forwarded_props if isinstance(input_data.forwarded_props, dict) else {}
    screen_payload = forwarded.get("screenContext")
    screen_context = sanitize_live_context(
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
    session_user_id = (
        user_id or f"anonymous:{hashlib.sha256(anonymous_seed.encode()).hexdigest()[:24]}"
    )
    return {
        STATE_USER_ID: session_user_id,
        STATE_CONSENT_TOKEN: store_request_secret(str((token or {}).get("token") or "")),
        STATE_CONVERSATION_ID: input_data.thread_id,
        STATE_TIMEZONE: str(forwarded.get("timezone") or "")[:64],
        STATE_SCREEN: str(screen_context.get("screen") or "")[:64],
        STATE_VOICE_CONTEXT: screen_context,
        STATE_PKM_CONTEXT: store_request_secret(str(forwarded.get("pkmContext") or "")[:20000]),
    }


_app = App(
    name=ONE_APP_NAME,
    root_agent=build_one_text_agent(),
    resumability_config=ResumabilityConfig(is_resumable=True),
)
_intro_app = App(
    name=f"{ONE_APP_NAME}_intro",
    root_agent=build_one_intro_text_agent(),
    resumability_config=ResumabilityConfig(is_resumable=True),
)
_session_service = EncryptedAdkSessionService()
_intro_session_service = InMemorySessionService()
_authenticated_capabilities = {
    "identity": {
        "name": "Agent One",
        "type": "google-adk",
        "description": "Hussh private agent",
        "version": "1.0.0",
        "provider": "Hussh",
    },
    "transport": {"streaming": True, "websocket": False, "httpBinary": False, "resumable": True},
    "tools": {"supported": True, "parallelCalls": False, "clientProvided": True},
    "state": {"snapshots": True, "deltas": True, "memory": False, "persistentState": True},
    "multiAgent": {"supported": True, "delegation": True, "handoffs": False},
    "reasoning": {"supported": True, "streaming": True, "encrypted": False},
    "humanInTheLoop": {
        "supported": True,
        "approvals": True,
        "interventions": True,
        "feedback": False,
        "interrupts": True,
        "approveWithEdits": False,
    },
}
_intro_capabilities = {
    **_authenticated_capabilities,
    "tools": {"supported": False, "parallelCalls": False, "clientProvided": False},
    "state": {"snapshots": True, "deltas": True, "memory": False, "persistentState": False},
    "multiAgent": {"supported": False, "delegation": False, "handoffs": False},
    "humanInTheLoop": {"supported": False, "interrupts": False},
}
_agent = ADKAgent.from_app(
    _app,
    user_id_extractor=_user_id,
    session_service=_session_service,
    use_in_memory_services=True,
    use_thread_id_as_session_id=True,
    emit_messages_snapshot=True,
    capabilities=_authenticated_capabilities,
)
_intro_agent = ADKAgent.from_app(
    _intro_app,
    user_id_extractor=_user_id,
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
    return _agent if state.get(STATE_CONSENT_TOKEN) else _intro_agent


add_adk_fastapi_endpoint(
    router,
    _agent,
    path="/api/one/agent-chat",
    extract_state_from_request=_extract_state,
    agent_resolver=_resolve_agent,
)


def _event_text(event: Any) -> str:
    parts = getattr(getattr(event, "content", None), "parts", None) or []
    return "".join(str(getattr(part, "text", "") or "") for part in parts).strip()


def _session_title(session: Any) -> str:
    authored = str((session.state or {}).get("hussh:thread_title") or "").strip()
    if authored:
        return authored
    for event in session.events:
        if event.author == "user":
            text = _event_text(event)
            if text:
                return text[:80]
    return "New conversation"


class RenameConversation(BaseModel):
    title: str = Field(min_length=1, max_length=160)


@router.get("/api/one/agent-chat/conversations/{user_id}")
async def list_conversations(
    user_id: str,
    limit: int = Query(default=5, ge=1, le=20),
    token: dict = Depends(require_vault_owner_token),
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
    token: dict = Depends(require_vault_owner_token),
):
    user_id = str(token["user_id"])
    session = await _session_service.get_session(
        app_name=ONE_APP_NAME, user_id=user_id, session_id=conversation_id
    )
    if session is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    messages: list[dict[str, object]] = []
    for event in session.events:
        text = _event_text(event)
        if not text or event.author not in {"user", "one"}:
            continue
        messages.append(
            {
                "id": event.id or f"{event.invocation_id}:{len(messages)}",
                "conversation_id": conversation_id,
                "role": "user" if event.author == "user" else "assistant",
                "status": "interrupted" if event.interrupted else "complete",
                "content": text,
                "model": event.model_version,
                "created_at": event.timestamp,
                "completed_at": event.timestamp,
                "metadata": None,
            }
        )
    return {"conversation_id": conversation_id, "messages": messages[-limit:]}


@router.patch("/api/one/agent-chat/conversations/{conversation_id}")
async def rename_conversation(
    conversation_id: str,
    payload: RenameConversation,
    token: dict = Depends(require_vault_owner_token),
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
    user_id = str(token["user_id"])
    session = await _session_service.get_session(
        app_name=ONE_APP_NAME, user_id=user_id, session_id=conversation_id
    )
    if session is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    await _session_service.delete_session(
        app_name=ONE_APP_NAME, user_id=user_id, session_id=conversation_id
    )
    return {"conversation_id": conversation_id, "deleted": True}


# ── Proposal mode: action search and structured proposals ────────────────────


class ActionSearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2048)


class ActionProposalRequest(BaseModel):
    conversation_id: str
    query: str = Field(min_length=1, max_length=4096)


class ConfirmProposalRequest(BaseModel):
    confirmed_slots: dict[str, Any] = Field(default_factory=dict)


# In-memory proposal store keyed by proposal_id.
# Per-request scoped; proposals expire after 15 minutes.
_proposal_store: dict[str, dict[str, Any]] = {}
_PROPOSAL_TTL_SECONDS = 900


def _cleanup_expired_proposals() -> None:
    now = datetime.now(timezone.utc).timestamp()
    expired = [
        pid
        for pid, p in _proposal_store.items()
        if now - p.get("created_at", 0) > _PROPOSAL_TTL_SECONDS
    ]
    for pid in expired:
        del _proposal_store[pid]


def _proposal_owner_key(token: dict, request: Request, proposal_id: str) -> str:
    ip = request.client.host if request.client else ""
    return f"{token.get('user_id', '')}:{ip}:{proposal_id}"


@router.post("/api/one/actions/search")
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
    screen = request.headers.get("x-hushh-screen")
    if screen:
        app_runtime_state["screen"] = screen

    try:
        results = search_actions_for_command_palette(
            query,
            {"actions": list_action_gateway_actions()},
            app_runtime_state=app_runtime_state,
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


@router.post("/api/one/agent-chat/proposals")
async def create_action_proposal(
    payload: ActionProposalRequest,
    request: Request,
    token: dict = Depends(require_vault_owner_token),
):
    """Run One's restricted proposal head and return a typed action assessment.

    Emits a distinct ``one_action_proposal`` event; never an ordinary executable
    directive.
    """
    from hushh_mcp.one_adk.agent_tree import build_one_text_agent

    _cleanup_expired_proposals()
    query = payload.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Query must not be empty.")

    # Build a request-scoped session for the proposal turn.
    proposal_app = App(
        name=f"{ONE_APP_NAME}_proposal",
        root_agent=build_one_text_agent(),
        resumability_config=ResumabilityConfig(is_resumable=False),
    )
    proposal_agent = ADKAgent.from_app(
        proposal_app,
        user_id_extractor=lambda d: str(
            (d.state or {}).get(STATE_USER_ID) or token.get("user_id", "")
        ),
        session_service=InMemorySessionService(),
        use_in_memory_services=True,
        use_thread_id_as_session_id=True,
        emit_messages_snapshot=True,
    )

    # Restrict to proposal-mode tools only.
    _PROPOSAL_ALLOWED_TOOLS = {
        "list_app_actions",
        "propose_app_action",
    }
    proposal_agent._adk_app.root_agent.tools = [
        t
        for t in proposal_agent._adk_app.root_agent.tools
        if getattr(t, "name", "") in _PROPOSAL_ALLOWED_TOOLS
    ]

    # Run the proposal turn through AG-UI.
    run_input = RunAgentInput(
        thread_id=payload.conversation_id,
        run_id=f"proposal-{datetime.now(timezone.utc).timestamp()}",
        state={
            STATE_USER_ID: token.get("user_id", ""),
            STATE_CONSENT_TOKEN: store_request_secret(str(token.get("token") or "")),
        },
        messages=[
            UserMessage(id="user-proposal", role="user", content=query),
        ],
        # `context` and `tools` are required by RunAgentInput. Omitting context
        # raised ValidationError on every proposal turn, so this path had never
        # run; empty is the correct value here because the proposal turn carries
        # its context in `state`, not as AG-UI context entries.
        context=[],
        forwarded_props={},
        tools=[],
    )

    proposal_id = f"prop_{datetime.now(timezone.utc).timestamp()}_{hash(query) & 0xFFFF:04x}"
    _proposal_store[proposal_id] = {
        "proposal_id": proposal_id,
        "query": query,
        "user_id": str(token.get("user_id", "")),
        "conversation_id": payload.conversation_id,
        "status": "pending",
        "created_at": datetime.now(timezone.utc).timestamp(),
        "result": None,
    }

    # Stream the AG-UI response.
    proposal_result: dict[str, Any] | None = None
    try:
        async for event in proposal_agent.run(run_input):
            event_type = getattr(event, "type", "")
            if event_type == "one_action_proposal":
                proposal_result = getattr(event, "content", None)
                break
            if event_type == "error":
                logger.error("proposal_agent_error event=%s", event)
                break
    except Exception:
        logger.exception("proposal_agent_run_failed")

    if proposal_result is None:
        _proposal_store[proposal_id]["status"] = "no_match"
        _proposal_store[proposal_id]["result"] = {
            "schemaVersion": "one.action_proposal.v1",
            "status": "unsupported",
            "message": "One could not map this request to a supported action.",
        }
        return _proposal_store[proposal_id]["result"]

    _proposal_store[proposal_id]["status"] = "drafted"
    _proposal_store[proposal_id]["result"] = proposal_result
    proposal_result.setdefault("proposalId", proposal_id)
    proposal_result.setdefault("requestId", payload.conversation_id)
    return proposal_result


@router.post("/api/one/action-proposals/{proposal_id}/admit")
async def admit_proposal(
    proposal_id: str,
    request: Request,
    token: dict = Depends(require_vault_owner_token),
):
    """Verify the issued draft, resolve inputs, and revalidate the contract."""
    _cleanup_expired_proposals()
    proposal = _proposal_store.get(proposal_id)
    if proposal is None:
        raise HTTPException(status_code=404, detail="Proposal not found or expired.")
    if proposal["status"] != "drafted":
        raise HTTPException(
            status_code=409,
            detail=f"Proposal is in '{proposal['status']}' state; admit is only valid for 'drafted'.",
        )
    if proposal["user_id"] != str(token.get("user_id", "")):
        raise HTTPException(status_code=403, detail="Proposal owner mismatch.")

    result = proposal.get("result") or {}
    action_id = str(result.get("actionId") or "")
    if not action_id:
        raise HTTPException(status_code=400, detail="Proposal is missing an action id.")

    entry = get_action_gateway_action(action_id)
    if entry is None:
        raise HTTPException(status_code=400, detail=f"'{action_id}' is no longer a valid action.")

    # Revalidate current execution policy.
    policy = str(entry.get("execution_policy") or "allow_direct")
    if policy == "manual_only":
        raise HTTPException(
            status_code=400,
            detail=f"'{action_id}' requires the app UI and cannot be admitted here.",
        )

    # Build prepared execution grant.
    admission: dict[str, Any] = {
        "schemaVersion": "one.action_proposal.v1",
        "proposalId": proposal_id,
        "status": "ready_for_confirmation" if policy == "confirm_required" else "ready",
        "actionId": action_id,
        "label": str(entry.get("label") or ""),
        "meaning": str(entry.get("meaning") or ""),
        "executionPolicy": policy,
        "slots": result.get("slots") or {},
        "requiredInputs": result.get("requiredInputs") or [],
        "missingSlots": result.get("missingSlots") or [],
        "confirmationRequired": policy == "confirm_required",
        "useTool": result.get("useTool"),
        "navigation": result.get("navigation"),
        "guardIds": result.get("guardIds") or [],
        "admittedAt": datetime.now(timezone.utc).isoformat(),
    }
    proposal["status"] = "admitted"
    proposal["admission"] = admission
    return admission


@router.post("/api/one/action-proposals/{proposal_id}/confirm")
async def confirm_proposal(
    proposal_id: str,
    request: Request,
    payload: ConfirmProposalRequest = ConfirmProposalRequest(),
    token: dict = Depends(require_vault_owner_token),
):
    """Validate the prepared action and advance to execution permission."""
    _cleanup_expired_proposals()
    proposal = _proposal_store.get(proposal_id)
    if proposal is None:
        raise HTTPException(status_code=404, detail="Proposal not found or expired.")
    if proposal["status"] != "admitted":
        raise HTTPException(
            status_code=409,
            detail=f"Proposal is in '{proposal['status']}' state; confirm requires 'admitted'.",
        )
    if proposal["user_id"] != str(token.get("user_id", "")):
        raise HTTPException(status_code=403, detail="Proposal owner mismatch.")

    admission = proposal.get("admission") or {}
    action_id = str(admission.get("actionId") or "")
    entry = get_action_gateway_action(action_id)
    if entry is None:
        raise HTTPException(status_code=400, detail="Action is no longer valid.")

    # Revalidate the action has not changed since admission.
    current_policy = str(entry.get("execution_policy") or "allow_direct")
    if current_policy != admission.get("executionPolicy"):
        raise HTTPException(
            status_code=409,
            detail="Action policy changed since admission; re-admit required.",
        )

    # Merge any user-supplied slot corrections.
    slots = dict(admission.get("slots") or {})
    if payload and isinstance(payload.confirmed_slots, dict):
        for k, v in payload.confirmed_slots.items():
            if str(k).strip():
                slots[str(k).strip()] = v

    # Final validation: check no required slots are still missing.
    missing_slots = admission.get("missingSlots") or []
    still_missing = [s for s in missing_slots if slots.get(s.get("slot", "")) in (None, "")]

    if still_missing:
        return {
            "schemaVersion": "one.action_proposal.v1",
            "proposalId": proposal_id,
            "status": "needs_resolution",
            "actionId": action_id,
            "slots": slots,
            "missingSlots": still_missing,
        }

    proposal["status"] = "confirmed"
    proposal["confirmed_slots"] = slots

    return {
        "schemaVersion": "one.action_proposal.v1",
        "proposalId": proposal_id,
        "status": "execution_granted",
        "actionId": action_id,
        "slots": slots,
        "executionPolicy": current_policy,
        "useTool": admission.get("useTool"),
        "navigation": admission.get("navigation"),
        "guardIds": admission.get("guardIds") or [],
        "confirmedAt": datetime.now(timezone.utc).isoformat(),
    }


@router.post("/api/one/action-proposals/{proposal_id}/settle")
async def settle_proposal(
    proposal_id: str,
    result_payload: dict[str, Any],
    request: Request,
    token: dict = Depends(require_vault_owner_token),
):
    """Record the correlated handler result under existing receipt rules."""
    _cleanup_expired_proposals()
    proposal = _proposal_store.get(proposal_id)
    if proposal is None:
        raise HTTPException(status_code=404, detail="Proposal not found or expired.")
    if proposal["user_id"] != str(token.get("user_id", "")):
        raise HTTPException(status_code=403, detail="Proposal owner mismatch.")

    proposal["status"] = "settled"
    proposal["settlement"] = {
        "result": result_payload,
        "settledAt": datetime.now(timezone.utc).isoformat(),
    }
    return {
        "proposalId": proposal_id,
        "status": "settled",
        "result": result_payload,
    }


@router.delete("/api/one/action-proposals/{proposal_id}")
async def cancel_proposal(
    proposal_id: str,
    request: Request,
    token: dict = Depends(require_vault_owner_token),
):
    """Cancel an issued/prepared proposal."""
    _cleanup_expired_proposals()
    proposal = _proposal_store.get(proposal_id)
    if proposal is None:
        return {"proposalId": proposal_id, "status": "already_gone"}
    if proposal["user_id"] != str(token.get("user_id", "")):
        raise HTTPException(status_code=403, detail="Proposal owner mismatch.")

    if proposal["status"] in ("drafted", "admitted"):
        proposal["status"] = "cancelled"
        proposal["cancelledAt"] = datetime.now(timezone.utc).isoformat()
        return {"proposalId": proposal_id, "status": "cancelled"}

    return {"proposalId": proposal_id, "status": proposal["status"]}


__all__ = ["router"]
