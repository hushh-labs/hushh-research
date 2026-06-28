"""ADK tools for the One Location Agent.

These tools expose workflow actions while keeping persistence inside
OneLocationAgentService and scope checks inside @hushh_tool.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from hushh_mcp.constants import ConsentScope
from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.hushh_adk.tools import hushh_tool
from hushh_mcp.services.one_location_agent_service import OneLocationAgentService


def _ctx() -> HushhContext:
    context = HushhContext.current()
    if not context:
        raise PermissionError("No active context - location consent required")
    return context


def _service() -> OneLocationAgentService:
    return OneLocationAgentService()


def _require_uuid(value: str, label: str) -> str:
    """Validate a UUID-typed identifier before it reaches the database.

    The LLM can hallucinate ids; without this guard a bad value reaches Postgres
    and raises an opaque InvalidTextRepresentation. Raising a clear ValueError
    instead gives the model actionable feedback to look the id up first.
    """
    try:
        UUID(str(value))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError(
            f"{label} '{value}' is not a valid id. "
            "Call list_active_location_shares to get real ids first."
        ) from exc
    return str(value)


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_SHARE, name="list_location_recipients")
async def list_location_recipients(limit: int = 50) -> dict[str, Any]:
    """List verified recipients eligible for a per-recipient location grant."""
    context = _ctx()
    return {
        "recipients": _service().list_verified_recipients(
            owner_user_id=context.user_id,
            limit=limit,
        )
    }


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_SHARE, name="create_location_share")
async def create_location_share(
    recipient_user_id: str,
    recipient_key_id: str | None,
    duration_hours: float,
    reason: str | None = None,
) -> dict[str, Any]:
    """Create a recipient-bound live-location grant without publishing plaintext coordinates."""
    context = _ctx()
    return _service().create_grant(
        owner_user_id=context.user_id,
        recipient_user_id=recipient_user_id,
        recipient_key_id=recipient_key_id,
        duration_hours=duration_hours,
        reason=reason,
    )


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_SHARE, name="publish_location_envelope")
async def publish_location_envelope(grant_id: str, envelope: dict[str, Any]) -> dict[str, Any]:
    """Publish an encrypted coordinate envelope for an active grant."""
    context = _ctx()
    return _service().store_encrypted_envelope(
        owner_user_id=context.user_id,
        grant_id=grant_id,
        envelope=envelope,
    )


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_VIEW, name="view_location_envelope")
async def view_location_envelope(grant_id: str) -> dict[str, Any]:
    """Return ciphertext-only latest envelope for the authenticated approved recipient."""
    context = _ctx()
    return _service().view_latest_envelope(
        recipient_user_id=context.user_id,
        grant_id=grant_id,
    )


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_REVOKE, name="revoke_location_share")
async def revoke_location_share(grant_id: str) -> dict[str, Any]:
    """Revoke an active live-location grant owned by the current user."""
    context = _ctx()
    grant_id = _require_uuid(grant_id, "grant_id")
    return _service().revoke_grant(owner_user_id=context.user_id, grant_id=grant_id)


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_REQUEST, name="request_location_access")
async def request_location_access(owner_user_id: str, message: str | None = None) -> dict[str, Any]:
    """Request live-location access from an owner; this never grants access by itself."""
    context = _ctx()
    return _service().request_access(
        requester_user_id=context.user_id,
        owner_user_id=owner_user_id,
        message=message,
    )


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_SHARE, name="approve_location_request")
async def approve_location_request(request_id: str, duration_hours: float) -> dict[str, Any]:
    """Approve a pending request and create a separate recipient-scoped grant."""
    context = _ctx()
    return _service().approve_request(
        owner_user_id=context.user_id,
        request_id=request_id,
        duration_hours=duration_hours,
    )


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_REQUEST, name="deny_location_request")
async def deny_location_request(request_id: str) -> dict[str, Any]:
    """Deny a pending request without creating access."""
    context = _ctx()
    request_id = _require_uuid(request_id, "request_id")
    return _service().deny_request(owner_user_id=context.user_id, request_id=request_id)


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_REFER_REQUEST, name="refer_location_recipient")
async def refer_location_recipient(
    grant_id: str,
    referred_user_id: str,
    message: str | None = None,
) -> dict[str, Any]:
    """Refer another verified user into an owner approval request."""
    context = _ctx()
    grant_id = _require_uuid(grant_id, "grant_id")
    return _service().refer_recipient(
        referring_user_id=context.user_id,
        grant_id=grant_id,
        referred_user_id=referred_user_id,
        message=message,
    )


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_SHARE, name="list_active_location_shares")
async def list_active_location_shares() -> dict[str, Any]:
    """List the user's active outgoing live-location shares.

    Returns each active share's grant id and recipient so the agent can revoke or
    refer by a real id instead of guessing. Coordinate-free (no lat/lng).
    """
    context = _ctx()
    state = _service().list_state(user_id=context.user_id)
    shares = [
        {
            "grantId": grant.get("id"),
            "recipientUserId": grant.get("recipientUserId"),
            "recipientDisplayName": grant.get("recipientDisplayName"),
            "expiresAt": grant.get("expiresAt"),
        }
        for grant in state.get("ownerGrants", [])
        if grant.get("status") == "active"
    ]
    return {"activeShares": shares}


LOCATION_AGENT_TOOLS = [
    list_location_recipients,
    list_active_location_shares,
    create_location_share,
    publish_location_envelope,
    view_location_envelope,
    revoke_location_share,
    request_location_access,
    approve_location_request,
    deny_location_request,
    refer_location_recipient,
]


# v1 control-plane subset: tools the agent can fully complete server-side with no
# client-side encryption handoff. Excludes create/publish/view/approve, which
# require the client to capture, encrypt, and upload a coordinate envelope.
CONTROL_PLANE_LOCATION_TOOLS = [
    list_location_recipients,
    list_active_location_shares,
    revoke_location_share,
    request_location_access,
    deny_location_request,
    refer_location_recipient,
]
