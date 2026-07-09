# api/routes/trust.py
"""TrustLink HTTP surface.

Backs the Capacitor consent plugin's ``createTrustLink`` / ``verifyTrustLink``
methods (web implementation posts to ``/api/trust/*``). Until now those
plugin routes pointed at nothing; native iOS/Android re-implemented signing
locally with a DIFFERENT raw-string format (6 fields, no session binding),
so links could never cross-verify. This module makes the backend the single
signing authority, per the Agent Architecture Doctrine (one authority per
surface) and the agent-delegation-boundary contract (a TrustLink is a signed
delegation proof, paired with, never replacing, scoped consent tokens).

Security posture:
- create requires a VAULT_OWNER consent token and the authenticated user
  must match ``signed_by_user`` (a user can only sign delegations for
  themselves).
- verify is pure computation over the presented link (HMAC + expiry +
  optional scope/session checks); it needs no caller identity and leaks
  nothing beyond validity.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from api.middleware import require_vault_owner_token
from hushh_mcp.consent.scope_helpers import resolve_scope_to_enum
from hushh_mcp.trust.link import create_trust_link, verify_trust_link
from hushh_mcp.types import AgentID, ConsentScope, TrustLink, UserID

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/trust", tags=["TrustLink"])

_MAX_EXPIRES_IN_MS = 1000 * 60 * 60 * 24 * 90  # 90 days


class CreateTrustLinkRequest(BaseModel):
    from_agent: str = Field(..., min_length=1, max_length=128)
    to_agent: str = Field(..., min_length=1, max_length=128)
    scope: str = Field(..., min_length=1, max_length=256)
    signed_by_user: str = Field(..., min_length=1, max_length=128)
    expires_in_ms: int | None = Field(default=None, ge=1, le=_MAX_EXPIRES_IN_MS)
    session_id: str = Field(default="", max_length=256)


class TrustLinkPayload(BaseModel):
    from_agent: str = Field(..., min_length=1, max_length=128)
    to_agent: str = Field(..., min_length=1, max_length=128)
    scope: str = Field(..., min_length=1, max_length=256)
    created_at: int
    expires_at: int
    signed_by_user: str = Field(..., min_length=1, max_length=128)
    signature: str = Field(..., min_length=1, max_length=512)
    session_id: str = Field(default="", max_length=256)


class VerifyTrustLinkRequest(BaseModel):
    link: TrustLinkPayload
    required_scope: str | None = Field(default=None, max_length=256)
    expected_session_id: str | None = Field(default=None, max_length=256)


def _resolve_scope(scope_str: str) -> ConsentScope:
    try:
        return resolve_scope_to_enum(scope_str)
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="Unknown consent scope") from exc


@router.post("/create-link")
async def create_link(
    request: CreateTrustLinkRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    """Create a signed TrustLink. The signer must be the authenticated user."""
    if str(token_data["user_id"]) != request.signed_by_user:
        logger.warning("trust.create_link_user_mismatch")
        raise HTTPException(status_code=403, detail="Token user does not match signed_by_user")

    scope = _resolve_scope(request.scope)
    kwargs: dict = {}
    if request.expires_in_ms is not None:
        kwargs["expires_in_ms"] = request.expires_in_ms
    link = create_trust_link(
        from_agent=AgentID(request.from_agent),
        to_agent=AgentID(request.to_agent),
        scope=scope,
        signed_by_user=UserID(request.signed_by_user),
        session_id=request.session_id,
        **kwargs,
    )
    logger.info(
        "trust.link_created from=%s to=%s scope=%s",
        request.from_agent,
        request.to_agent,
        scope.value,
    )
    return {
        "from_agent": link.from_agent,
        "to_agent": link.to_agent,
        "scope": link.scope.value,
        "created_at": link.created_at,
        "expires_at": link.expires_at,
        "signed_by_user": link.signed_by_user,
        "signature": link.signature,
        "session_id": link.session_id,
    }


@router.post("/verify-link")
async def verify_link(request: VerifyTrustLinkRequest):
    """Verify a TrustLink's HMAC, expiry, and optional scope/session binding."""
    scope = _resolve_scope(request.link.scope)
    link = TrustLink(
        from_agent=AgentID(request.link.from_agent),
        to_agent=AgentID(request.link.to_agent),
        scope=scope,
        created_at=request.link.created_at,
        expires_at=request.link.expires_at,
        signed_by_user=UserID(request.link.signed_by_user),
        signature=request.link.signature,
        session_id=request.link.session_id,
    )

    valid = verify_trust_link(link, expected_session_id=request.expected_session_id)
    if not valid:
        return {"valid": False, "reason": "Invalid, expired, or session-mismatched link"}
    if request.required_scope is not None:
        required = _resolve_scope(request.required_scope)
        if link.scope != required:
            return {"valid": False, "reason": "Scope mismatch"}
    return {"valid": True, "reason": None}
