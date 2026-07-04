"""Agent One A2A endpoint.

This route exposes Agent One over the existing Hussh A2A consent boundary.
It does not mint tokens and does not grant specialist execution authority; the
caller must present a consent token scoped to ``agent.one.orchestrate``.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.adk_bridge.delegation import validate_a2a_consent_token
from hushh_mcp.agents.one.manifest import get_manifest
from hushh_mcp.agents.orchestrator.agent import get_orchestrator

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/a2a", tags=["Agent One A2A"])


class AgentOneA2AMessageRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    message: str = Field(..., min_length=1, max_length=8192)
    user_id: str | None = Field(default=None, alias="userId", min_length=1, max_length=128)
    conversation_id: str | None = Field(default=None, alias="conversationId", max_length=128)
    persona: str = Field(default="investor", min_length=1, max_length=32)


class AgentOneA2AMessageResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    agent_id: str = Field(alias="agentId")
    conversation_id: str | None = Field(default=None, alias="conversationId")
    user_id: str = Field(alias="userId")
    response: str
    delegation: dict[str, Any] | None = None
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
            "consentHeader": "X-Consent-Token",
            "requiredScope": "agent.one.orchestrate",
        },
    }


@router.get("/card")
async def agent_one_a2a_card() -> dict[str, Any]:
    """Return Agent One capability metadata from the checked-in manifest."""
    return _agent_card()


@router.post("/message", response_model=AgentOneA2AMessageResponse)
async def agent_one_a2a_message(
    body: AgentOneA2AMessageRequest,
    x_consent_token: str | None = Header(default=None, alias="X-Consent-Token"),
) -> AgentOneA2AMessageResponse:
    """Route a caller request through Agent One after A2A scope validation."""
    token = (x_consent_token or "").strip()
    if not token:
        raise HTTPException(status_code=401, detail="Missing X-Consent-Token")

    validation = validate_a2a_consent_token("agent_one", token)
    if not validation.ok or not validation.user_id:
        logger.warning("agent_one_a2a.request_rejected_invalid_token")
        raise HTTPException(status_code=403, detail="Invalid consent token")

    user_id = str(validation.user_id)
    if body.user_id is not None and body.user_id != user_id:
        logger.warning("agent_one_a2a.request_rejected_user_mismatch")
        raise HTTPException(status_code=403, detail="Token user does not match request user")

    try:
        result = get_orchestrator().handle_message(
            message=body.message,
            user_id=user_id,
            consent_token=token,
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
        isComplete=True,
    )
