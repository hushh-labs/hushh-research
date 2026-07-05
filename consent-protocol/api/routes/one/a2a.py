"""Agent One A2A endpoint.

This route exposes Agent One over the existing Hussh A2A consent boundary.
It does not mint tokens and does not grant specialist execution authority; the
caller must present a consent token scoped to ``agent.one.orchestrate``.
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from api.developer_auth import authenticate_developer_principal
from api.utils.firebase_admin import get_firebase_auth_app
from hushh_mcp.agents.one.manifest import get_manifest
from hushh_mcp.agents.orchestrator.agent import get_orchestrator
from hushh_mcp.consent.scope_helpers import get_scope_description
from hushh_mcp.consent.token import validate_token_with_db
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.actor_identity_service import ActorIdentityService
from hushh_mcp.services.consent_db import ConsentDBService
from hushh_mcp.services.consent_request_links import build_consent_request_url
from hushh_mcp.services.user_identifier_service import resolve_lookup_identifier

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/a2a", tags=["Agent One A2A"])
well_known_router = APIRouter(tags=["Agent One A2A"])


class AgentOneA2AMessageRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    message: str = Field(..., min_length=1, max_length=8192)
    user_id: str | None = Field(default=None, alias="userId", min_length=1, max_length=128)
    email: str | None = Field(default=None, max_length=320)
    phone_number: str | None = Field(default=None, alias="phoneNumber", max_length=32)
    country_iso2: str | None = Field(default=None, alias="countryIso2", max_length=2)
    country: str | None = Field(default=None, max_length=64)
    conversation_id: str | None = Field(default=None, alias="conversationId", max_length=128)
    persona: str = Field(default="investor", min_length=1, max_length=32)
    reason: str | None = Field(default=None, max_length=1000)
    approval_timeout_minutes: int = Field(
        default=60,
        alias="approvalTimeoutMinutes",
        ge=5,
        le=24 * 60,
    )
    expiry_hours: int = Field(default=24, alias="expiryHours", ge=1, le=24 * 90)


class AgentOneA2AMessageResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    agent_id: str = Field(alias="agentId")
    conversation_id: str | None = Field(default=None, alias="conversationId")
    user_id: str = Field(alias="userId")
    response: str
    delegation: dict[str, Any] | None = None
    consent: dict[str, Any] | None = None
    is_complete: bool = Field(default=True, alias="isComplete")


def _agent_card() -> dict[str, Any]:
    manifest = get_manifest()
    return {
        "agentId": manifest["agent_id"],
        "legacyIds": list(manifest.get("legacy_ids") or []),
        "name": manifest["name"],
        "version": manifest["version"],
        "description": manifest["description"],
        "requiredScopes": [
            str(scope.value if hasattr(scope, "value") else scope)
            for scope in manifest["required_scopes"]
        ],
        "optionalScopes": [
            str(scope.value if hasattr(scope, "value") else scope)
            for scope in manifest.get("optional_scopes", [])
        ],
        "specialists": list(manifest.get("specialists") or []),
        "capabilities": dict(manifest.get("capabilities") or {}),
        "compliance": dict(manifest.get("compliance") or {}),
        "endpoints": {
            "message": "/api/one/a2a/message",
            "card": "/api/one/a2a/card",
        },
        "protocol": {
            "transport": "https",
            "developerAuth": "Authorization: Bearer <developer-token>",
            "consentHeader": "X-Consent-Token",
            "requiredScope": "agent.one.orchestrate",
        },
    }


def _required_scope() -> str:
    return "agent.one.orchestrate"


def _consent_reason(body: AgentOneA2AMessageRequest) -> str:
    return str(body.reason or "").strip() or "Coordinate this request through Agent One."


def _has_user_target(body: AgentOneA2AMessageRequest) -> bool:
    return any(
        str(value or "").strip()
        for value in (
            body.user_id,
            body.email,
            body.phone_number,
        )
    )


def _a2a_requester_metadata(
    *,
    principal: Any,
    body: AgentOneA2AMessageRequest,
    request_id: str,
    request_url: str,
    poll_timeout_at: int,
) -> dict[str, Any]:
    return {
        "request_source": "agent_one_a2a_consent_v1",
        "requester_actor_type": "a2a_agent",
        "developer_app_id": principal.app_id,
        "developer_agent_id": principal.agent_id,
        "developer_app_display_name": principal.display_name,
        "developer_allowed_tool_groups": list(principal.allowed_tool_groups),
        "requester_label": principal.display_name,
        "requester_image_url": getattr(principal, "brand_image_url", None),
        "requester_website_url": getattr(principal, "website_url", None),
        "reason": _consent_reason(body),
        "approval_timeout_minutes": body.approval_timeout_minutes,
        "approval_timeout_at": poll_timeout_at,
        "expiry_hours": body.expiry_hours,
        "request_url": request_url,
        "a2a_request_id": request_id,
    }


def _consent_response(
    *,
    user_id: str,
    conversation_id: str | None,
    message: str,
    consent: dict[str, Any],
) -> AgentOneA2AMessageResponse:
    return AgentOneA2AMessageResponse(
        agentId="agent_one",
        conversationId=conversation_id,
        userId=user_id,
        response=message,
        delegation=None,
        consent=consent,
        isComplete=False,
    )


async def _resolve_consent_user_id(body: AgentOneA2AMessageRequest) -> str:
    try:
        lookup_kind, lookup_value = resolve_lookup_identifier(
            identifier=body.user_id,
            email=body.email,
            phone_number=body.phone_number,
            country_iso2=body.country_iso2,
            country=body.country,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail="Missing user identifier for consent request",
        ) from exc

    if lookup_kind == "uid":
        return lookup_value

    from firebase_admin import auth

    firebase_app = get_firebase_auth_app()
    if firebase_app is None:
        raise HTTPException(status_code=503, detail="Firebase Admin not configured")

    try:
        if lookup_kind == "email":
            user_record = auth.get_user_by_email(lookup_value, app=firebase_app)
        else:
            user_record = auth.get_user_by_phone_number(lookup_value, app=firebase_app)
    except auth.UserNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail="No Hussh account found for the requested user identifier",
        ) from exc

    try:
        ActorIdentityService().schedule_sync_from_firebase(user_record.uid, force=False)
    except Exception as identity_error:
        logger.debug(
            "agent_one_a2a.identity_warmup_skipped uid=%s error=%s",
            user_record.uid,
            identity_error,
        )
    return str(user_record.uid)


async def _create_or_report_consent_request(
    *,
    body: AgentOneA2AMessageRequest,
    request: Request,
    authorization: str | None,
    developer_token: str | None,
) -> AgentOneA2AMessageResponse:
    principal = authenticate_developer_principal(
        token=developer_token,
        authorization=authorization,
        request=request,
    )
    user_id = await _resolve_consent_user_id(body)
    scope = _required_scope()
    service = ConsentDBService()

    active_tokens = await service.get_covering_active_tokens(
        user_id,
        agent_id=principal.agent_id,
        requested_scope=scope,
    )
    if active_tokens:
        return _consent_response(
            user_id=user_id,
            conversation_id=body.conversation_id,
            message="Consent already exists. Present the consent token to execute Agent One.",
            consent={
                "status": "granted",
                "requiredScope": scope,
                "agentId": principal.agent_id,
                "appId": principal.app_id,
                "appDisplayName": principal.display_name,
                "tokenRequired": True,
            },
        )

    pending = await service.get_pending_request_for_scope(
        user_id,
        agent_id=principal.agent_id,
        scope=scope,
    )
    if pending:
        return _consent_response(
            user_id=user_id,
            conversation_id=body.conversation_id,
            message="Consent request is already pending. User approval is still required.",
            consent={
                "status": "pending",
                "requiredScope": scope,
                "requestId": pending.get("id"),
                "requestUrl": pending.get("requestUrl"),
                "approvalSurface": "/consents?tab=pending",
                "pollTimeoutAt": pending.get("pollTimeoutAt"),
                "approvalTimeoutAt": pending.get("approvalTimeoutAt"),
                "agentId": principal.agent_id,
                "appId": principal.app_id,
                "appDisplayName": principal.display_name,
                "tokenRequired": True,
            },
        )

    request_id = f"req_{uuid.uuid4().hex[:28]}"
    now_ms = int(time.time() * 1000)
    poll_timeout_at = now_ms + (body.approval_timeout_minutes * 60 * 1000)
    request_url = build_consent_request_url(request_id=request_id)
    metadata = _a2a_requester_metadata(
        principal=principal,
        body=body,
        request_id=request_id,
        request_url=request_url,
        poll_timeout_at=poll_timeout_at,
    )

    await service.insert_event(
        user_id=user_id,
        agent_id=principal.agent_id,
        scope=scope,
        action="REQUESTED",
        request_id=request_id,
        scope_description=get_scope_description(scope),
        poll_timeout_at=poll_timeout_at,
        metadata=metadata,
    )
    logger.info(
        "agent_one_a2a.consent_requested app_id=%s request_id=%s",
        principal.app_id,
        request_id,
    )

    return _consent_response(
        user_id=user_id,
        conversation_id=body.conversation_id,
        message="Consent request submitted. User approval is required before Agent One can execute.",
        consent={
            "status": "pending",
            "requiredScope": scope,
            "requestId": request_id,
            "requestUrl": request_url,
            "approvalSurface": "/consents?tab=pending",
            "pollTimeoutAt": poll_timeout_at,
            "approvalTimeoutAt": poll_timeout_at,
            "approvalTimeoutMinutes": body.approval_timeout_minutes,
            "expiryHours": body.expiry_hours,
            "agentId": principal.agent_id,
            "appId": principal.app_id,
            "appDisplayName": principal.display_name,
            "tokenRequired": True,
        },
    )


@router.get("/card")
async def agent_one_a2a_card() -> dict[str, Any]:
    """Return Agent One capability metadata from the checked-in manifest."""
    return _agent_card()


@well_known_router.get("/.well-known/agent-card.json")
async def agent_one_well_known_agent_card() -> dict[str, Any]:
    """Return the public A2A Agent Card at the standard well-known URI."""
    return _agent_card()


@router.post("/message", response_model=AgentOneA2AMessageResponse)
async def agent_one_a2a_message(
    request: Request,
    body: AgentOneA2AMessageRequest,
    x_consent_token: str | None = Header(default=None, alias="X-Consent-Token"),
    authorization: str | None = Header(default=None),
    token: str | None = Query(default=None, max_length=256),
) -> AgentOneA2AMessageResponse:
    """Route a caller request through Agent One after A2A scope validation."""
    consent_token = (x_consent_token or "").strip()
    if not consent_token:
        return await _create_or_report_consent_request(
            body=body,
            request=request,
            authorization=authorization,
            developer_token=token,
        )

    principal = authenticate_developer_principal(
        token=token,
        authorization=authorization,
        request=request,
    )
    valid, _reason, token_obj = await validate_token_with_db(
        consent_token,
        expected_scope=ConsentScope.AGENT_ONE_ORCHESTRATE,
    )
    if not valid or token_obj is None:
        logger.warning("agent_one_a2a.request_rejected_invalid_token")
        raise HTTPException(status_code=403, detail="Invalid consent token")

    if str(token_obj.agent_id) != principal.agent_id:
        logger.warning("agent_one_a2a.request_rejected_app_mismatch")
        raise HTTPException(status_code=403, detail="Token app does not match caller")

    user_id = str(token_obj.user_id)
    if _has_user_target(body):
        requested_user_id = await _resolve_consent_user_id(body)
        if requested_user_id != user_id:
            logger.warning("agent_one_a2a.request_rejected_user_mismatch")
            raise HTTPException(status_code=403, detail="Token user does not match request user")

    try:
        result = get_orchestrator().handle_message(
            message=body.message,
            user_id=user_id,
            consent_token=consent_token,
            persona=body.persona,
        )
    except Exception:
        logger.exception("agent_one_a2a.orchestrator_failed")
        raise HTTPException(status_code=500, detail="Agent One could not process the request")

    return AgentOneA2AMessageResponse(
        agentId="agent_one",
        conversationId=body.conversation_id,
        userId=user_id,
        response=str(result.get("response") or ""),
        delegation=result.get("delegation") if isinstance(result.get("delegation"), dict) else None,
        consent=None,
        isComplete=True,
    )
