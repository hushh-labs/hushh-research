"""Serve a DB-backed specialist in a keyless pod, by READING through the hub.

On the hub, ``dispatch("agent_location", task)`` runs a full location sub-agent
that reads Postgres and reasons to an answer. A pod holds no database credential,
so that dispatch fails and the specialist reports ``runtime_unavailable`` -- the
DB wall. This module is the read-path around the wall: when the relay couriered a
per-specialist scope (the data door), the pod hands it to the hub broker, gets the
owner's fail-closed state projection back, and renders a faithful answer from it.

Where this sits on the parity ladder, stated honestly rather than overclaimed:

* **runtime_unavailable** (before this) -- the pod answers nothing.
* **deterministic render** (this) -- the pod answers the location question from
  the owner's REAL state, rendered by fixed code. Accurate and verifiable, but
  not the location sub-agent's own prose or its interactive cards.
* **sub-agent parity** (next, live-verified) -- the same LocationChatService runs
  in the pod with projection-backed tools, so the wording and directives match
  the hub exactly. That step needs a pod-safe chat store and the pod's own model
  wired, both of which must be proven against a live dev pod, so it lands
  separately rather than as unverified enclave code.

The gate is the GRANT's presence, not a second flag: the relay only couriers a
scope when ``POD_DATA_DOOR_ENABLED`` is on, so an absent grant (the default)
means this returns None and the caller falls through to the normal dispatch --
today's behaviour, untouched.
"""

from __future__ import annotations

import logging
from typing import Any

from hushh_mcp.one_adk.agent_tree import STATE_DATA_DOOR_GRANTS

logger = logging.getLogger(__name__)

#: Which specialist maps to which data-door read. Mirrors the broker's
#: ``_REQUIRED_SCOPE`` and the door registry. Location was first; email is the
#: next door in the north-star's staged door-by-door plan.
_SPECIALIST_DOOR_NAMES: dict[str, str] = {
    "agent_location": "location",
    "agent_email": "email",
    "agent_calendar": "calendar",
}


def _active(entries: Any, *statuses: str) -> list[dict[str, Any]]:
    ok = {s.lower() for s in statuses}
    return [
        e
        for e in (entries or [])
        if isinstance(e, dict) and str(e.get("status") or "").strip().lower() in ok
    ]


def _name_of(entry: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = str(entry.get(key) or "").strip()
        if value:
            return value
    return "someone"


def _format_location_summary(projection: dict[str, Any]) -> str:
    """A faithful, deterministic summary of the owner's location-sharing state.

    Built only from what the projection actually carries, so it never claims a
    share that is not there. One reasons over this to answer the specific question
    the person asked; the job here is to make the real state available, complete
    and correct, in words.
    """
    if not isinstance(projection, dict):
        return "I could not read your location sharing just now."

    lines: list[str] = []

    sharing = _active(projection.get("ownerGrants"), "active")
    if sharing:
        who = ", ".join(_name_of(g, "recipientDisplayName") for g in sharing)
        lines.append(f"You're currently sharing your location with {who}.")
    else:
        lines.append("You're not currently sharing your location with anyone.")

    received = _active(projection.get("receivedGrants"), "active")
    if received:
        who = ", ".join(_name_of(g, "ownerDisplayName") for g in received)
        lines.append(f"{who} is sharing their location with you.")

    requests = _active(projection.get("requests"), "pending")
    if requests:
        who = ", ".join(_name_of(r, "requesterDisplayName") for r in requests)
        lines.append(f"{who} is requesting access to your location.")

    public = _active(projection.get("publicInvites"), "active")
    if public:
        count = len(public)
        noun = "public link" if count == 1 else "public links"
        lines.append(f"You have {count} active {noun}.")

    circles = [c for c in (projection.get("circles") or []) if isinstance(c, dict)]
    if circles:
        names = ", ".join(str(c.get("name") or "").strip() for c in circles if c.get("name"))
        if names:
            lines.append(f"Your location circles: {names}.")

    return " ".join(lines)


def _format_email_summary(projection: dict[str, Any]) -> str:
    """A faithful, deterministic summary of the owner's email nudges.

    Built only from the fail-closed projection, so it never names an address, a
    body, or a message the door did not carry. The connect / reconnect cases are
    answered helpfully rather than as a dead end, so 'not connected' reads as a
    next step, not a failure.
    """
    if not isinstance(projection, dict):
        return "I could not read your email just now."

    if not projection.get("connected", False):
        reason = str(projection.get("reason") or "").strip().lower()
        if reason == "not_connected":
            return (
                "Your Gmail isn't connected yet. Connect it in settings and I can "
                "summarize what needs your attention."
            )
        if reason == "needs_reauth":
            return (
                "Your Gmail connection needs reconnecting. Reconnect it in settings "
                "and I can summarize your inbox again."
            )
        return "I couldn't reach your email just now."

    nudges = [n for n in (projection.get("nudges") or []) if isinstance(n, dict)]
    if not nudges:
        return "Your inbox has nothing that needs your attention right now."

    lines: list[str] = []
    meetings = [n for n in nudges if str(n.get("type") or "").strip().lower() == "meeting"]
    others = [n for n in nudges if str(n.get("type") or "").strip().lower() != "meeting"]

    if meetings:
        titles = ", ".join(str(m.get("title") or "an event").strip() for m in meetings[:5])
        lines.append(f"Coming up from your email: {titles}.")
    if others:
        who = ", ".join(_name_of(n, "sender") for n in others[:5])
        count = len(others)
        noun = "message" if count == 1 else "messages"
        lines.append(f"{count} {noun} may need your attention, from {who}.")

    return " ".join(lines)


def _event_when(event: dict[str, Any]) -> str:
    """When an event happens, from the projected boundary only. All-day events
    render their date; timed events render date and clock in the event's own
    offset. Unparseable input renders as 'time unknown' rather than raising."""
    raw_start = event.get("start")
    start: dict[str, Any] = raw_start if isinstance(raw_start, dict) else {}
    if event.get("all_day") or ("date" in start and "dateTime" not in start):
        return f"all day {start.get('date') or 'date unknown'}"
    raw = str(start.get("dateTime") or "")
    try:
        from datetime import datetime  # noqa: PLC0415

        when = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return "time unknown"
    return when.strftime("%b %d at %H:%M")


def _format_calendar_summary(projection: dict[str, Any]) -> str:
    """A faithful, deterministic summary of the owner's upcoming events.

    Built only from the fail-closed projection -- titles and times -- so it can
    never name an attendee, a location, a description or a link the door did not
    carry. Read-only by construction: it ends by saying where a change is made.
    """
    if not isinstance(projection, dict):
        return "I could not read your calendar just now."

    if not projection.get("connected", False):
        reason = str(projection.get("reason") or "").strip().lower()
        if reason == "not_connected":
            return (
                "Your Google Calendar isn't connected yet. Connect it in settings and "
                "I can tell you what's coming up."
            )
        if reason == "needs_reauth":
            return (
                "Your Google Calendar connection needs reconnecting. Reconnect it in "
                "settings and I can read your schedule again."
            )
        return "I couldn't reach your calendar just now."

    events = [e for e in (projection.get("events") or []) if isinstance(e, dict)]
    if not events:
        return "Nothing is on your calendar for the next day and a half."

    items = [
        f"{str(e.get('title') or 'Untitled event').strip()} ({_event_when(e)})" for e in events[:8]
    ]
    more = len(events) - len(items)
    tail = f", and {more} more" if more > 0 else ""
    return (
        f"Coming up on your calendar: {'; '.join(items)}{tail}. "
        "To add or change an event, use the Calendar screen."
    )


#: door name -> the deterministic summary that renders its projection. Adding a
#: door means adding its summarizer here; an unmapped door has no renderer and so
#: never serves, which is the fail-closed default.
_SUMMARIZERS: dict[str, Any] = {
    "location": _format_location_summary,
    "email": _format_email_summary,
    "calendar": _format_calendar_summary,
}


async def serve_specialist_via_data_door(
    agent_id: str,
    tool_context: Any,
    *,
    broker: Any = None,
) -> dict[str, Any] | None:
    """Answer a DB-backed specialist through the hub broker, or return None.

    Returns None -- so the caller falls through to the normal dispatch -- for
    every case that is NOT a served data-door read: an unmapped specialist, no
    couriered grant (the door is off), or a broker refusal/outage. None therefore
    degrades to today's ``runtime_unavailable`` rather than to a wrong answer.
    A non-None result is a completed specialist turn payload, shaped like the
    dispatch path's ``ok`` payload so One consumes it identically.
    """
    door_name = _SPECIALIST_DOOR_NAMES.get(agent_id)
    if not door_name:
        return None

    grants = tool_context.state.get(STATE_DATA_DOOR_GRANTS) or {}
    scope_token = str(grants.get(door_name) or "") if isinstance(grants, dict) else ""
    if not scope_token:
        # No grant couriered -> the door is off for this turn. Fall through.
        return None

    client = broker
    if client is None:
        from hushh_mcp.services.pod_hub_client import PodHubClient  # noqa: PLC0415

        client = PodHubClient()

    try:
        projection = client.read_specialist(door_name, scope_token)
    except Exception as exc:  # noqa: BLE001 - a broker refusal/outage degrades the read, not the turn
        logger.info(
            "one_adk.data_door_read_unavailable agent_id=%s %s", agent_id, type(exc).__name__
        )
        return None

    summarizer = _SUMMARIZERS.get(door_name)
    if summarizer is None:
        # A mapped door with no renderer -> fall through rather than emit an empty
        # or wrong answer. Fail-closed: adding a door requires adding its summary.
        logger.info("one_adk.data_door_no_summarizer door=%s", door_name)
        return None

    logger.info("one_adk.data_door_served agent_id=%s door=%s", agent_id, door_name)
    return {
        "status": "ok",
        "source": "data_door",
        "text": summarizer(projection),
        "is_complete": True,
    }


__all__ = ["serve_specialist_via_data_door", "_SPECIALIST_DOOR_NAMES"]
