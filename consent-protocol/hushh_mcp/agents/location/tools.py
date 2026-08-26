"""ADK tools for the One Location Agent.

The Location Agent is a narrow fallback: everything with a generated action
(sharing, requesting, revoking, approving, denying, circles, SOS, check-in)
runs directly from One, never through this module. These tools cover what the
generated action gateway cannot do at all -- public links, viewing an incoming
share, device permission, and referral -- while keeping persistence inside
OneLocationAgentService and scope checks inside @hushh_tool.
"""

from __future__ import annotations

from datetime import datetime, timezone
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


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_REFER_REQUEST, name="refer_location_recipient")
async def refer_location_recipient(
    grant_id: str,
    referred_user_id: str,
    message: str | None = None,
) -> dict[str, Any]:
    """Introduce another verified person into an approval request for a share the
    current user already RECEIVES, without granting the new person access itself.
    grant_id MUST come from list_incoming_location_shares -- it identifies the
    current user's own incoming grant from the owner, never a share the current
    user gave out."""
    context = _ctx()
    grant_id = _require_uuid(grant_id, "grant_id")
    return _service().refer_recipient(
        referring_user_id=context.user_id,
        grant_id=grant_id,
        referred_user_id=referred_user_id,
        message=message,
    )


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_VIEW, name="list_incoming_location_shares")
async def list_incoming_location_shares() -> dict[str, Any]:
    """List active shares where the current user is the recipient (so they can be
    viewed). Returns grant ids + owner names; coordinate-free (no lat/lng)."""
    context = _ctx()
    state = _service().list_state(user_id=context.user_id)
    shares = [
        {
            "grantId": grant.get("id"),
            "ownerUserId": grant.get("ownerUserId"),
            "ownerDisplayName": grant.get("ownerDisplayName"),
            "expiresAt": grant.get("expiresAt"),
        }
        for grant in state.get("receivedGrants", [])
        if grant.get("status") == "active"
    ]
    return {"incomingShares": shares}


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_SHARE, name="list_public_links")
async def list_public_links() -> dict[str, Any]:
    """List the user's active public location links (id + expiry). Coordinate-free."""
    context = _ctx()
    state = _service().list_state(user_id=context.user_id)
    links = [
        {
            "inviteId": invite.get("id"),
            "status": invite.get("status"),
            "expiresAt": invite.get("expiresAt"),
            "publicUrl": invite.get("publicUrl"),
        }
        for invite in state.get("publicInvites", [])
        if invite.get("status") == "active"
    ]
    return {"publicLinks": links}


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_SHARE, name="propose_public_link")
async def propose_public_link(duration_hours: float) -> dict[str, Any]:
    """Propose creating an owner-confirmed public link. Does NOT create it (the
    browser captures the snapshot and creates it after explicit confirmation).
    duration_hours must be between 0.25 and 1. Coordinate-free."""
    _ctx()
    try:
        hours = float(duration_hours)
    except (TypeError, ValueError) as exc:
        raise ValueError("duration_hours must be a number between 0.25 and 1") from exc
    # 24 was the PRIVATE share ceiling, copied. A public link is readable by
    # anyone holding it, and both the route field (le=1) and the service
    # (PUBLIC_INVITE_MAX_DURATION_HOURS) stop at an hour -- so this tool could
    # propose a duration that was guaranteed to 422 the moment the person
    # confirmed it. The floor is the shared minimum share length; below it
    # normalize_duration_hours rejects the request.
    if not (0.25 <= hours <= 1):
        raise ValueError("duration_hours must be between 0.25 and 1 for a public link")
    return {"proposed": "create_public_link", "durationHours": hours}


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_VIEW, name="propose_location_view")
async def propose_location_view(grant_id: str) -> dict[str, Any]:
    """Propose viewing an incoming share's latest location. The browser fetches the
    ciphertext and decrypts it; the server never returns coordinates. grant_id MUST
    come from list_incoming_location_shares. Coordinate-free."""
    _ctx()
    grant_id = _require_uuid(grant_id, "grant_id")
    return {"proposed": "view_envelope", "grantId": grant_id}


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_SHARE, name="request_device_location_permission")
async def request_device_location_permission() -> dict[str, Any]:
    """Ask the device to (re-)prompt the OS location permission dialog. Use this
    whenever an action needs the device's location and it is not currently
    available or was previously denied - e.g. the user asks to share, check in,
    or send SMS and a prior attempt failed because permission was never granted
    or was denied. The server never receives a coordinate here; the OS prompt
    and outcome happen entirely client-side."""
    _ctx()
    return {"proposed": "request_device_location_permission"}


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_SHARE, name="revoke_public_link")
async def revoke_public_link(invite_id: str) -> dict[str, Any]:
    """Revoke an active public location link owned by the current user. invite_id
    MUST come from list_public_links."""
    context = _ctx()
    invite_id = _require_uuid(invite_id, "invite_id")
    return _service().revoke_public_invite(owner_user_id=context.user_id, invite_id=invite_id)


def _expiry_hint(expires_at: Any, *, now: datetime | None = None) -> str | None:
    """Human-friendly relative expiry for chat option hints.

    Renders "expires in N hours" (rounded to the nearest hour), or
    "expires in N minutes" when under an hour, since these hints are shown inline
    in the chat picker where a raw ISO timestamp is unreadable. Returns None when
    there is no timestamp, "expired" when it is already past, and preserves the
    raw value if it can't be parsed.
    """
    if not expires_at:
        return None
    if isinstance(expires_at, datetime):
        when = expires_at
    else:
        try:
            when = datetime.fromisoformat(str(expires_at).replace("Z", "+00:00"))
        except ValueError:
            return f"expires {expires_at}"
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    current = now or datetime.now(timezone.utc)
    total_minutes = int((when - current).total_seconds() // 60)
    if total_minutes <= 0:
        return "expired"
    if total_minutes < 60:
        return f"expires in {total_minutes} minute{'s' if total_minutes != 1 else ''}"
    hours = int(total_minutes / 60 + 0.5)
    return f"expires in {hours} hour{'s' if hours != 1 else ''}"


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_VIEW, name="request_incoming_choice")
async def request_incoming_choice() -> dict[str, Any]:
    """Ask the user whose incoming shared location to view. Coordinate-free
    single-select whose options carry real grant ids."""
    context = _ctx()
    state = _service().list_state(user_id=context.user_id)
    incoming = [g for g in state.get("receivedGrants", []) if g.get("status") == "active"]
    if not incoming:
        return {"incomingShares": []}
    options = [
        {
            "label": g.get("ownerDisplayName") or "Someone",
            "ref": {"grantId": g.get("id")},
            "hint": _expiry_hint(g.get("expiresAt")),
        }
        for g in incoming
    ]
    return {
        "prompt": {
            "kind": "select",
            "purpose": "select_incoming",
            "question": "Whose location do you want to see?",
            "options": options,
            "minSelections": 1,
            "maxSelections": 1,
            "allowFreeText": True,
        }
    }


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_SHARE, name="request_confirmation")
async def request_confirmation(summary: str, destructive: bool = True) -> dict[str, Any]:
    """Ask the user to confirm an irreversible action before it runs. Returns a
    coordinate-free yes/no confirm prompt. Use before revoke_public_link, since it
    ends currently-active sharing immediately. Do NOT use before propose_public_link
    — the browser shows its own owner-confirmation card for the link, so confirming
    here would make the user confirm twice."""
    _ctx()
    return {
        "prompt": {
            "kind": "confirm",
            "purpose": "confirm_action",
            "question": str(summary or "Are you sure?"),
            "confirmLabel": "Yes",
            "cancelLabel": "Cancel",
            "destructive": bool(destructive),
        }
    }


# Every tool the Location Agent can call. This specialist is a narrow fallback
# for the handful of Location capabilities the generated action gateway cannot
# run itself: managing a public link, viewing an incoming share, re-prompting
# the device for location permission, and referring someone into another
# owner's approval flow. Sharing, requesting, revoking, approving, denying,
# circles, SOS, and check-in all now run directly from One's own generated
# actions before this agent is ever reached, so they have no tool here.
V2_LOCATION_TOOLS = [
    list_incoming_location_shares,
    list_public_links,
    propose_public_link,
    propose_location_view,
    revoke_public_link,
    request_device_location_permission,
    refer_location_recipient,
    request_incoming_choice,
    request_confirmation,
]
