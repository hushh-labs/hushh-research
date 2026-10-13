"""ADK tools for the One Location Agent.

These tools expose workflow actions while keeping persistence inside
OneLocationAgentService and scope checks inside @hushh_tool.
"""

from __future__ import annotations

from typing import Any

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
    return _service().deny_request(owner_user_id=context.user_id, request_id=request_id)


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_REFER_REQUEST, name="refer_location_recipient")
async def refer_location_recipient(
    grant_id: str,
    referred_user_id: str,
    message: str | None = None,
) -> dict[str, Any]:
    """Refer another verified user into an owner approval request."""
    context = _ctx()
    return _service().refer_recipient(
        referring_user_id=context.user_id,
        grant_id=grant_id,
        referred_user_id=referred_user_id,
        message=message,
    )


LOCATION_AGENT_TOOLS = [
    list_location_recipients,
    create_location_share,
    publish_location_envelope,
    view_location_envelope,
    revoke_location_share,
    request_location_access,
    approve_location_request,
    deny_location_request,
    refer_location_recipient,
]
