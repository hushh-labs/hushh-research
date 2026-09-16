"""
mcp_modules/tools/location_tools.py

Location voice-action + narrow read tool handlers for the MCP server.

Two distinct handler shapes, mirroring the two established patterns:

- Navigate-only tools follow ``kai_tools.py``'s zero-backend-call envelope
  pattern: a handler returns a canned KaiAction-style payload, validated only
  against the generated action-gateway manifest. There is no user_id/token in
  these handlers at all -- entitlement is enforced one layer up in
  mcp_server.py via ``is_tool_allowed()``, and the already-authenticated
  client app that owns the live session executes the navigation itself.

- Read tools follow ``ria_read_tools.py``'s consent_token + VAULT_OWNER
  pattern, because (unlike Kai's canned envelopes) these genuinely fetch real
  per-user data server-side: every route in api/routes/one/location.py is
  gated by require_vault_owner_token, so a caller-supplied identity has to be
  proven the same way here.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from mcp.types import TextContent

from hushh_mcp.consent.token import validate_token_with_db
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.action_gateway import list_action_gateway_actions

# OneLocationAgentService and OneLocationCircleService are imported lazily
# inside the two read handlers below, not at module scope. The published
# @hushh/mcp npm package vendors only mcp_server.py, mcp_modules, hushh_mcp,
# and db (packages/hushh-mcp/scripts/stage-runtime.mjs) -- it deliberately
# excludes the FastAPI api/ tree. OneLocationAgentService imports
# api.utils.fcm_messages and api.utils.firebase_admin at its own module
# level for push notifications, so importing it here at module scope took
# down the ENTIRE packed stdio-bridge server at startup (every tool group,
# not just Location) the moment that package's CI verified a real packed
# install. Lazy-importing means a missing api/ tree only fails these two
# specific tool calls -- gracefully, via mcp_server.call_tool()'s existing
# outer exception handler -- in that one distribution shape, while the
# hosted remote transport (which runs the full checkout, api/ included)
# and any full-repo local stdio setup are unaffected either way.

logger = logging.getLogger("hushh-mcp-server")


# ---------------------------------------------------------------------------
# Navigate-only tools (Kai pattern)
# ---------------------------------------------------------------------------


def get_manifest_action_ids() -> frozenset[str]:
    """Return action IDs from the sole generated action gateway."""
    return frozenset(
        str(action.get("action_id"))
        for action in list_action_gateway_actions()
        if str(action.get("action_id") or "").strip()
    )


def _action_is_registered(action_id: str) -> bool:
    manifest_ids = get_manifest_action_ids()
    return not manifest_ids or action_id in manifest_ids


def _nav_ok(action_id: str, message: str) -> list[TextContent]:
    """Build a successful navigate-only KaiAction-style response."""
    if not _action_is_registered(action_id):
        logger.error("location_tool.unregistered_action action_id=%s", action_id)
        payload: dict[str, Any] = {
            "status": "error",
            "message": "Location action is not registered in the current action manifest.",
            "detail": action_id,
        }
        return [TextContent(type="text", text=json.dumps(payload))]

    payload = {
        "status": "success",
        "action_id": action_id,
        "message": message,
        "completion_mode": "route_settle",
    }
    return [TextContent(type="text", text=json.dumps(payload))]


async def handle_location_open_now(args: dict[str, Any]) -> list[TextContent]:
    """Navigate to the Location Now tab."""
    return _nav_ok("location.open_now", "Opening Location.")


async def handle_location_open_people(args: dict[str, Any]) -> list[TextContent]:
    """Navigate to the Location People tab."""
    return _nav_ok("location.open_people", "Opening the people you share with.")


async def handle_location_open_links(args: dict[str, Any]) -> list[TextContent]:
    """Navigate to the Location Links tab."""
    return _nav_ok("location.open_links", "Opening your sharing links.")


async def handle_location_open_share(args: dict[str, Any]) -> list[TextContent]:
    """Open the Location share composer. Nothing is shared until confirmed in-app."""
    return _nav_ok("location.open_share", "Opening the share composer.")


async def handle_location_open_ask(args: dict[str, Any]) -> list[TextContent]:
    """Open the Location request composer."""
    return _nav_ok("location.open_ask", "Opening the location request composer.")


async def handle_location_open_map(args: dict[str, Any]) -> list[TextContent]:
    """Open the full-screen Location map."""
    return _nav_ok("location.open_map", "Opening the map.")


async def handle_location_open_settings(args: dict[str, Any]) -> list[TextContent]:
    """Open Location privacy and precision settings."""
    return _nav_ok("location.open_settings", "Opening Location settings.")


async def handle_location_open_sos(args: dict[str, Any]) -> list[TextContent]:
    """Open the emergency SOS screen. Opening it never sends an alert."""
    return _nav_ok("location.open_sos", "Opening the SOS screen.")


# ---------------------------------------------------------------------------
# Narrow read tools (RIA pattern)
# ---------------------------------------------------------------------------


async def _authorize_user(user_id: str, consent_token: str) -> tuple[bool, str | None]:
    valid, reason, payload = await validate_token_with_db(consent_token, ConsentScope.VAULT_OWNER)
    if not valid or payload is None:
        return False, reason
    if payload.user_id != user_id:
        return False, "token_user_mismatch"
    return True, None


def _ok(payload: dict[str, Any]) -> list[TextContent]:
    return [TextContent(type="text", text=json.dumps(payload, default=str))]


async def handle_location_get_state(args: dict[str, Any]) -> list[TextContent]:
    """Read the caller's own aggregate Location sharing status.

    Deliberately NOT a proxy of OneLocationAgentService.list_state(): that
    method's raw payload includes myRecipientKey (the caller's own
    vault-key-encrypted private-key blob) and other people's display
    names/masked phone numbers on every grant/request row. This handler
    computes a derived, count-only summary instead -- no coordinates, no PII,
    no key material.
    """
    user_id = str(args.get("user_id") or "").strip()
    consent_token = str(args.get("consent_token") or "").strip()
    if not user_id or not consent_token:
        return _ok({"status": "error", "error": "user_id and consent_token are required"})

    allowed, reason = await _authorize_user(user_id, consent_token)
    if not allowed:
        return _ok({"status": "forbidden", "reason": reason})

    from hushh_mcp.services.one_location_agent_service import OneLocationAgentService

    state = OneLocationAgentService().list_state(user_id=user_id)
    owner_grants = state.get("ownerGrants") or []
    received_grants = state.get("receivedGrants") or []
    requests = state.get("requests") or []
    return _ok(
        {
            "status": "ok",
            "sharing": {
                "active_owner_grants": sum(
                    1 for grant in owner_grants if grant.get("status") == "active"
                ),
                "active_received_grants": sum(
                    1 for grant in received_grants if grant.get("status") == "active"
                ),
                "pending_requests": sum(
                    1 for request in requests if request.get("status") == "pending"
                ),
                "circle_count": len(state.get("circles") or []),
                "verified_recipient_count": len(state.get("recipients") or []),
            },
        }
    )


async def handle_location_list_circles(args: dict[str, Any]) -> list[TextContent]:
    """List the caller's own named Location circles.

    OneLocationCircleService.list_circles() -> _circle_summary() is already
    safe to return as-is: id/name/kind/role/memberCount/memberLimit and
    timestamps only, never another member's PII.
    """
    user_id = str(args.get("user_id") or "").strip()
    consent_token = str(args.get("consent_token") or "").strip()
    if not user_id or not consent_token:
        return _ok({"status": "error", "error": "user_id and consent_token are required"})

    allowed, reason = await _authorize_user(user_id, consent_token)
    if not allowed:
        return _ok({"status": "forbidden", "reason": reason})

    from hushh_mcp.services.one_location_circle_service import OneLocationCircleService

    circles = OneLocationCircleService().list_circles(user_id=user_id)
    return _ok({"status": "ok", "circles": circles})
