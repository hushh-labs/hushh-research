"""The person's approximate location for one chat turn, and weather for it.

Location is level-4 personal information. The device decides whether to send
it: only when the OS permission is already granted, rounded on the device to
about a kilometre, on the same request as the question. The server rounds it
again, keeps it in the process-local expiring request store, and gives ADK
state only an opaque ``temp:`` reference, so it is never written in plaintext
and never logged. A tool result that carries it is sealed into the person's own
chat history with their chat key, like every other turn event.
"""

from __future__ import annotations

import json
import logging
import math
from typing import Any

from google.adk.tools.tool_context import ToolContext

from hushh_mcp.one_adk.request_secrets import resolve_request_secret, store_request_secret

logger = logging.getLogger(__name__)

STATE_TURN_LOCATION = "temp:hussh:turn_location"
# Two decimal places is about 1.1 km of latitude: enough for weather, not an address.
COARSE_DECIMALS = 2
# Covers the chat route's 200 s execution bound, then the value expires.
_TTL_SECONDS = 240
_WITHHELD_STATES = frozenset({"denied", "not_granted", "unavailable"})

_PERMISSION_GUIDANCE = {
    "denied": (
        "Location access for Hussh is turned off on this device. Turn it on in the "
        "device's Settings, then ask again."
    ),
    "not_granted": (
        "Hussh hasn't been allowed to use this device's location yet. Open Location "
        "in One and allow location access, then ask again."
    ),
    "unavailable": "This device couldn't provide a location just now. Try again shortly.",
    "not_provided": (
        "This request didn't include the person's location. If location access is "
        "allowed for Hussh, asking again from chat will include it."
    ),
}


def _coordinate(value: Any, limit: float) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    number = float(value)
    if not math.isfinite(number) or not -limit <= number <= limit:
        return None
    return round(number, COARSE_DECIMALS)


def admit_turn_location(forwarded: dict) -> str:
    """Remove ``turnLocation`` from forwarded props; return an expiring reference.

    Popped before the bridge can copy or serialize forwarded props. A malformed
    value is treated as absent rather than failing the person's turn.
    """
    value = forwarded.pop("turnLocation", None)
    if not isinstance(value, dict):
        return ""
    status = value.get("status")
    if status == "available":
        latitude = _coordinate(value.get("latitude"), 90.0)
        longitude = _coordinate(value.get("longitude"), 180.0)
        if latitude is None or longitude is None:
            return ""
        record: dict[str, Any] = {
            "status": "available",
            "latitude": latitude,
            "longitude": longitude,
        }
    elif status in _WITHHELD_STATES:
        record = {"status": status}
    else:
        return ""
    return store_request_secret(json.dumps(record), ttl_seconds=_TTL_SECONDS)


def _turn_location(tool_context: Any) -> dict[str, Any]:
    state = getattr(tool_context, "state", None)
    reference = state.get(STATE_TURN_LOCATION) if state is not None else None
    raw = resolve_request_secret(reference) if reference else ""
    try:
        record = json.loads(raw) if raw else None
    except ValueError:
        record = None
    return record if isinstance(record, dict) else {"status": "not_provided"}


def _needs_permission(status: str) -> dict[str, Any]:
    return {
        "status": "needs_location_permission",
        "permission": status,
        "message": _PERMISSION_GUIDANCE.get(status, _PERMISSION_GUIDANCE["not_provided"]),
    }


async def get_my_location(tool_context: ToolContext) -> dict[str, Any]:
    """Get the person's approximate current location, shared by their device for this turn.

    Use this whenever an answer depends on where the person is now ("near me",
    "here", local time or weather) instead of asking them for their city or
    saying you cannot access their location. Returns coordinates rounded to
    about 1 km. When status is needs_location_permission, relay its message
    once, briefly; do not repeat it or refuse in general terms.
    """
    record = _turn_location(tool_context)
    if record.get("status") != "available":
        return _needs_permission(str(record.get("status") or "not_provided"))
    return {
        "status": "available",
        "latitude": record["latitude"],
        "longitude": record["longitude"],
        "precision": "approximate, about 1 km",
    }


__all__ = [
    "COARSE_DECIMALS",
    "STATE_TURN_LOCATION",
    "admit_turn_location",
    "get_my_location",
]
