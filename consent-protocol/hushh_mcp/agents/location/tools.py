"""ADK tools for the One Location Agent.

These tools expose workflow actions while keeping persistence inside
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
    Coordinate-free."""
    _ctx()
    try:
        hours = float(duration_hours)
    except (TypeError, ValueError) as exc:
        raise ValueError("duration_hours must be a number between 0 and 24") from exc
    if not (0 < hours <= 24):
        raise ValueError("duration_hours must be greater than 0 and at most 24")
    return {"proposed": "create_public_link", "durationHours": hours}


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_SHARE, name="propose_sos_panic")
async def propose_sos_panic() -> dict[str, Any]:
    """Propose an emergency SOS broadcast to the user's ready trusted contacts.
    The browser creates 8h grants per recipient, encrypts, publishes, and records
    the incident. Coordinate-free."""
    _ctx()
    return {"proposed": "sos_panic"}


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_SHARE, name="propose_check_in")
async def propose_check_in(duration_hours: float, note: str | None = None) -> dict[str, Any]:
    """Propose a check-in: share live location with the user's ready trusted
    contacts for a bounded time with an optional note. The browser creates the
    grants per recipient, encrypts, and publishes. Coordinate-free."""
    _ctx()
    try:
        hours = float(duration_hours)
    except (TypeError, ValueError) as exc:
        raise ValueError("duration_hours must be a number between 0 and 24") from exc
    if not (0 < hours <= 24):
        raise ValueError("duration_hours must be greater than 0 and at most 24")
    clean_note = (note or "").strip()[:120] or None
    return {"proposed": "check_in", "durationHours": hours, "note": clean_note}


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_VIEW, name="propose_location_view")
async def propose_location_view(grant_id: str) -> dict[str, Any]:
    """Propose viewing an incoming share's latest location. The browser fetches the
    ciphertext and decrypts it; the server never returns coordinates. grant_id MUST
    come from list_incoming_location_shares. Coordinate-free."""
    _ctx()
    grant_id = _require_uuid(grant_id, "grant_id")
    return {"proposed": "view_envelope", "grantId": grant_id}


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


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_SHARE, name="request_recipient_choice")
async def request_recipient_choice(name: str | None = None) -> dict[str, Any]:
    """Ask the user to pick who to share with. Returns a coordinate-free select
    prompt whose options carry real recipient ids.

    Pass ``name`` when the user named a person but it matched more than one contact
    (e.g. two "Neelesh Meena"): the options are then limited to just the contacts
    whose display name matches, so the picker shows only the ambiguous matches
    instead of the whole directory. Omit ``name`` only when the user has not named
    anyone at all — then the picker lists everyone plus a public-link option.
    """
    context = _ctx()
    recipients = _service().list_verified_recipients(owner_user_id=context.user_id)
    needle = (name or "").strip().lower()
    matches = (
        [r for r in recipients if needle in str(r.get("displayName") or "").strip().lower()]
        if needle
        else recipients
    )
    # Disambiguation mode: only when a name was given AND it matched someone. A
    # name that matches nothing falls back to the full directory so a typo can't
    # strand the user with an empty picker.
    disambiguating = bool(needle) and bool(matches)
    chosen = matches if matches else recipients
    options = [
        {
            "label": r.get("displayName") or "Someone",
            "ref": {"recipientUserId": r.get("userId"), "recipientKeyId": r.get("keyId")},
            "hint": None if r.get("canReceiveLocation") else "hasn't set up location yet",
        }
        for r in chosen
    ]
    if not disambiguating:
        # The user named a specific person, so a public link is not a valid
        # disambiguation answer — only offer it in the open "who?" case.
        options.append({"label": "Public link (anyone)", "ref": {"publicLink": True}, "hint": None})
    question = (
        f"Which “{name}” do you want to share your location with?"
        if disambiguating
        else "Who do you want to share your location with?"
    )
    return {
        "prompt": {
            "kind": "select",
            "purpose": "select_recipient",
            "question": question,
            "options": options,
            "minSelections": 1,
            "maxSelections": 1 if disambiguating else None,
            "allowFreeText": True,
        }
    }


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_REVOKE, name="request_active_share_choice")
async def request_active_share_choice() -> dict[str, Any]:
    """Ask the user which active outgoing share(s) to stop. Returns a coordinate-free
    multi-select prompt whose options carry real grant ids, plus a 'Stop all' option.
    Call this when the user wants to stop sharing but did not name a single share."""
    context = _ctx()
    state = _service().list_state(user_id=context.user_id)
    active = [g for g in state.get("ownerGrants", []) if g.get("status") == "active"]
    if not active:
        return {"activeShares": []}
    options = [
        {
            "label": g.get("recipientDisplayName") or "Someone",
            "ref": {"grantId": g.get("id")},
            "hint": _expiry_hint(g.get("expiresAt")),
        }
        for g in active
    ]
    options.append({"label": "Stop all", "ref": {"all": True}, "hint": None})
    return {
        "prompt": {
            "kind": "select",
            "purpose": "select_share",
            "question": "Which sharing do you want to stop?",
            "options": options,
            "minSelections": 1,
            "maxSelections": None,
            "allowFreeText": True,
            "confirmLabel": "Stop sharing",
            "destructive": False,
        }
    }


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_SHARE, name="request_duration_choice")
async def request_duration_choice() -> dict[str, Any]:
    """Ask the user how long a share should last. Coordinate-free single-select."""
    _ctx()
    return {
        "prompt": {
            "kind": "select",
            "purpose": "select_duration",
            "question": "How long should this share last?",
            "options": [
                {"label": "1 hour", "ref": {"hours": 1}, "hint": None},
                {"label": "8 hours", "ref": {"hours": 8}, "hint": None},
                {"label": "24 hours", "ref": {"hours": 24}, "hint": None},
            ],
            "minSelections": 1,
            "maxSelections": 1,
            "allowFreeText": True,
        }
    }


@hushh_tool(scope=ConsentScope.CAP_LOCATION_LIVE_REQUEST, name="request_request_choice")
async def request_request_choice() -> dict[str, Any]:
    """Ask the user which pending incoming access request to act on. Coordinate-free
    single-select whose options carry real request ids."""
    context = _ctx()
    state = _service().list_state(user_id=context.user_id)
    pending = [
        r
        for r in state.get("requests", [])
        if r.get("status") == "pending" and r.get("ownerUserId") == context.user_id
    ]
    if not pending:
        return {"pendingRequests": []}
    options = [
        {
            "label": r.get("requesterDisplayName") or "Someone",
            "ref": {"requestId": r.get("id")},
            "hint": "wants to see your location",
        }
        for r in pending
    ]
    return {
        "prompt": {
            "kind": "select",
            "purpose": "select_request",
            "question": "Which request do you want to act on?",
            "options": options,
            "minSelections": 1,
            "maxSelections": 1,
            "allowFreeText": True,
        }
    }


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
    """Ask the user to confirm an irreversible or bulk action before it runs. Returns
    a coordinate-free yes/no confirm prompt. Use before creating a public link,
    sharing with everyone, or stopping all shares."""
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


# v2 subset: control-plane + prep-and-handoff (create/approve create grants
# server-side, coordinate-free) + read/intent/control tools for view & public
# links. NEVER includes publish_location_envelope / view_location_envelope —
# those are impossible server-side (need ciphertext / decryption) and are handled
# by a client-action directive instead.
V2_LOCATION_TOOLS = [
    list_location_recipients,
    list_active_location_shares,
    list_incoming_location_shares,
    list_public_links,
    revoke_location_share,
    request_location_access,
    deny_location_request,
    refer_location_recipient,
    create_location_share,
    approve_location_request,
    propose_public_link,
    propose_location_view,
    revoke_public_link,
    request_recipient_choice,
    request_active_share_choice,
    request_duration_choice,
    request_request_choice,
    request_incoming_choice,
    request_confirmation,
    propose_sos_panic,
    propose_check_in,
]
