"""Public AG-UI intro and protected historical conversation access.

Personal turns use the existing owner-authorized pod relay. This hub endpoint
never selects a full shared runner, even for valid vault-owner credentials.
"""

from __future__ import annotations

import hashlib
from typing import Any

from ag_ui.core import RunAgentInput
from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from google.adk.apps import App, ResumabilityConfig
from google.adk.sessions import InMemorySessionService
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from api.middleware import _extract_token, require_vault_owner_token
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
)
from hushh_mcp.one_adk.encrypted_session_service import EncryptedAdkSessionService

router = APIRouter(tags=["Agent One"])


def _user_id(input_data: RunAgentInput) -> str:
    state = input_data.state if isinstance(input_data.state, dict) else {}
    value = str(state.get(STATE_USER_ID) or "").strip()
    if not value:
        raise ValueError("Authenticated Agent One user is missing.")
    return value


def _private_runtime_required() -> HTTPException:
    return HTTPException(
        status_code=409,
        detail={
            "code": "AGENT_PRIVATE_RUNTIME_REQUIRED",
            "message": "Open your private agent to continue this conversation.",
        },
    )


async def _extract_state(request: Request, input_data: RunAgentInput) -> dict[str, Any]:
    authorization = request.headers.get("authorization")
    consent_header = request.headers.get("x-hushh-consent")
    token: dict[str, Any] | None = None
    # Credential presence selects the verifier, never the eventual privilege.
    # A rejected owner token must not downgrade to Firebase-only or anonymous.
    owner_authorization = authorization is not None and _extract_token(
        authorization, allow_raw=True
    ).startswith("HCT:")
    if consent_header is not None or owner_authorization:
        token = await require_vault_owner_token(
            request=request,
            # A present empty custom header is invalid; do not fall back to a
            # different credential inside the compatibility verifier.
            authorization=authorization if consent_header is None else None,
            hushh_consent=consent_header,
        )
        if consent_header is not None and owner_authorization:
            authorization_owner = await require_vault_owner_token(
                request=request, authorization=authorization, hushh_consent=None
            )
            if authorization_owner.get("user_id") != token.get("user_id"):
                raise HTTPException(
                    status_code=403, detail="Credentials belong to different accounts"
                )
    firebase_uid = ""
    if authorization is not None and not owner_authorization:
        firebase_uid = await run_in_threadpool(verify_firebase_bearer, authorization)
        if not isinstance(firebase_uid, str) or not firebase_uid.strip():
            raise HTTPException(status_code=401, detail="Invalid Firebase identity")
    if token is not None:
        owner_id = str(token.get("user_id") or "").strip()
        if not owner_id:
            raise HTTPException(status_code=401, detail="Invalid owner identity")
        if firebase_uid and owner_id != firebase_uid:
            raise HTTPException(status_code=403, detail="Credentials belong to different accounts")
        # Owner credentials are valid, but do not authorize personal execution
        # on shared compute. Refuse before retaining context or creating a session.
        raise _private_runtime_required()
    forwarded = input_data.forwarded_props if isinstance(input_data.forwarded_props, dict) else {}
    if input_data.tools or input_data.context or set(forwarded) - {"screenContext", "timezone"}:
        raise HTTPException(
            status_code=400, detail="Intro accepts public conversation context only"
        )
    screen_payload = forwarded.get("screenContext")
    screen_context = sanitize_live_context(
        screen_payload if isinstance(screen_payload, dict) else {}
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
        STATE_CONSENT_TOKEN: "",
        STATE_CONVERSATION_ID: input_data.thread_id,
        STATE_TIMEZONE: str(forwarded.get("timezone") or "")[:64],
        STATE_SCREEN: str(screen_context.get("screen") or "")[:64],
        STATE_VOICE_CONTEXT: screen_context,
        STATE_PKM_CONTEXT: "",
    }


_intro_app = App(
    name=f"{ONE_APP_NAME}_intro",
    root_agent=build_one_intro_text_agent(),
    resumability_config=ResumabilityConfig(is_resumable=True),
)
_session_service = EncryptedAdkSessionService()
_intro_session_service = InMemorySessionService()
_intro_capabilities = {
    "identity": {
        "name": "One onboarding",
        "type": "google-adk",
        "description": "Public onboarding conversation",
        "version": "1.0.0",
        "provider": "Hussh",
    },
    "transport": {"streaming": True, "websocket": False, "httpBinary": False, "resumable": True},
    "tools": {"supported": False, "parallelCalls": False, "clientProvided": False},
    "state": {"snapshots": True, "deltas": True, "memory": False, "persistentState": False},
    "multiAgent": {"supported": False, "delegation": False, "handoffs": False},
    "reasoning": {"supported": True, "streaming": True, "encrypted": False},
    "humanInTheLoop": {"supported": False, "interrupts": False},
}
_intro_agent = ADKAgent.from_app(
    _intro_app,
    user_id_extractor=_user_id,
    # Public intro is ephemeral. Existing encrypted history remains readable
    # through the owner-protected routes below; personal execution lives in pods.
    session_service=_intro_session_service,
    use_in_memory_services=True,
    use_thread_id_as_session_id=True,
    emit_messages_snapshot=True,
    capabilities=_intro_capabilities,
)


async def _resolve_agent(_request: Request, input_data: RunAgentInput) -> ADKAgent:
    state = input_data.state if isinstance(input_data.state, dict) else {}
    if state.get(STATE_CONSENT_TOKEN) or state.get(STATE_PKM_CONTEXT):
        raise _private_runtime_required()
    return _intro_agent


add_adk_fastapi_endpoint(
    router,
    _intro_agent,
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


__all__ = ["router"]
