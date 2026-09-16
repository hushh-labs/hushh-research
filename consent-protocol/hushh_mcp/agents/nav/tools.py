"""Scoped, display-safe consent read tools for Nav's Consent child."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from google.adk.tools.tool_context import ToolContext

from hushh_mcp.consent.scope_helpers import get_scope_display_metadata
from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.hushh_adk.tools import hushh_tool
from hushh_mcp.services.consent_center_service import ConsentCenterService

DIRECTIVE_STATE_KEY = "hussh:specialist_directive"
TIMEZONE_STATE_KEY = "hussh:timezone"


async def _list_grants(tool_context: ToolContext, *, surface: str) -> dict[str, Any]:
    context = HushhContext.current()
    if context is None:
        raise PermissionError("Missing invocation context")
    timezone = _safe_timezone(tool_context.state.get(TIMEZONE_STATE_KEY))
    try:
        payload = await ConsentCenterService().list_center(
            context.user_id, actor="investor", surface=surface, top=10
        )
    except Exception:
        return {"error": "consent_center_unavailable"}
    entries = list(payload.get("items") or [])
    rows, action_items = [], []
    for entry in entries[:10]:
        label, access = _entry_label(entry), _friendly_scope(entry)
        row = {
            "label": label,
            "access": access,
            "scope": entry.get("scope"),
            "status": entry.get("status"),
            "expiresLabel": _friendly_expiry(entry, timezone=timezone),
            "endedLabel": _friendly_terminal_time(entry, timezone=timezone),
        }
        item = (
            _consent_action_item(entry, label=label, access=access) if surface == "active" else None
        )
        row["revocable"] = item is not None
        if item is not None:
            action_items.append(item)
        rows.append(row)
    if surface == "active":
        tool_context.state[DIRECTIVE_STATE_KEY] = (
            {"kind": "prompt", "payload": {"kind": "consent_actions", "items": action_items}}
            if action_items
            else None
        )
    return {"items": rows, "total": int(payload.get("total") or len(entries))}


@hushh_tool(scope="agent.nav.review")
async def list_active_consent_grants(tool_context: ToolContext) -> dict[str, Any]:
    """List who can see the owner's information now, what they see and expiry.
    Use real labels and expiry text in the result. Revocable rows attach an app
    card for Stop sharing and Details; this read never revokes access.
    """
    return await _list_grants(tool_context, surface="active")


@hushh_tool(scope="agent.nav.review")
async def list_previous_consent_grants(tool_context: ToolContext) -> dict[str, Any]:
    """List ended, declined, expired or revoked sharing and its ending time.
    Use returned labels and dates; never invent records or treat history as active.
    """
    return await _list_grants(tool_context, surface="previous")


def _entry_label(entry: dict[str, Any]) -> str:
    for key in ("counterpart_label", "counterpart_email", "counterpart_id"):
        value = str(entry.get(key) or "").strip()
        if value:
            return value
    return "An approved app or agent"


def _friendly_scope(entry: dict[str, Any]) -> str:
    scope = str(entry.get("scope") or "").strip()
    if scope == "cap.location.live.view":
        return "view your live location"
    if scope == "cap.location.live.share":
        return "share your live location"
    if scope == "cap.location.live.request":
        return "request your live location"
    if scope == "cap.location.live.revoke":
        return "revoke a live-location share"
    if scope == "cap.location.live.refer_request":
        return "refer a live-location access request"
    description = str(entry.get("scope_description") or "").strip()
    if description:
        return f"access {description[0].lower()}{description[1:]}"
    if scope:
        try:
            label = str(get_scope_display_metadata(scope).get("label") or "").strip()
        except Exception:
            label = ""
        if label:
            return f"access {label[0].lower()}{label[1:]}"
        return f"access {scope}"
    return "access an approved scope"


def _consent_action_item(
    entry: dict[str, Any],
    *,
    label: str,
    access: str,
) -> dict[str, Any] | None:
    entry_id = str(entry.get("id") or "").strip()
    scope = str(entry.get("scope") or "").strip()
    metadata = dict(entry.get("metadata") or {})
    request_source = str(metadata.get("request_source") or "").strip()
    is_location_grant = (
        entry_id.startswith("one_location_grant:")
        or request_source == "one_location_share_grant"
        or scope.startswith("cap.location.")
    )
    if not is_location_grant:
        return None

    grant_id = str(metadata.get("grant_id") or "").strip()
    if not grant_id and entry_id.startswith("one_location_grant:"):
        grant_id = entry_id.split(":", 1)[1].strip()
    if not grant_id:
        raw_id = str(entry.get("id") or "").strip()
        if raw_id and not raw_id.startswith("one_location_"):
            grant_id = raw_id
    if not grant_id:
        return None

    item_id = f"one_location_grant:{grant_id}"
    action_metadata = {
        **metadata,
        "request_source": "one_location_share_grant",
        "grant_id": grant_id,
    }
    return {
        "id": item_id,
        "label": label,
        "summary": f"{label} can {access}",
        "scope": scope,
        "expiresAt": entry.get("expires_at"),
        "metadata": action_metadata,
        "actions": ["revoke", "details"],
    }


def _friendly_expiry(entry: dict[str, Any], *, timezone: ZoneInfo) -> str:
    expires = str(entry.get("expires_at") or "").strip()
    if not expires:
        return ""
    parsed = _parse_datetime(expires)
    if parsed is None:
        return f" until {expires}"
    local_expires = parsed.astimezone(timezone)
    local_now = datetime.now(UTC).astimezone(timezone)
    day_label = local_expires.strftime("%b %-d, %Y")
    if local_expires.date() == local_now.date():
        day_label = "today"
    elif (local_expires.date() - local_now.date()).days == 1:
        day_label = "tomorrow"
    time_label = local_expires.strftime("%-I:%M %p %Z")
    return f" until {day_label} at {time_label}"


def _friendly_terminal_time(entry: dict[str, Any], *, timezone: ZoneInfo) -> str:
    for key in ("revoked_at", "resolved_at", "expires_at", "updated_at", "issued_at"):
        value = str(entry.get(key) or "").strip()
        if not value:
            continue
        parsed = _parse_datetime(value)
        if parsed is None:
            return f" until {value}"
        local_value = parsed.astimezone(timezone)
        local_now = datetime.now(UTC).astimezone(timezone)
        day_label = local_value.strftime("%b %-d, %Y")
        if local_value.date() == local_now.date():
            day_label = "today"
        elif (local_value.date() - local_now.date()).days == -1:
            day_label = "yesterday"
        time_label = local_value.strftime("%-I:%M %p %Z")
        return f" until {day_label} at {time_label}"
    return ""


def _parse_datetime(value: str) -> datetime | None:
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        # Some sources of expires_at/issued_at (consent_db.py's audit/token
        # rows, compared against now_ms throughout that module) carry epoch
        # milliseconds rather than an ISO string -- already str()'d by the
        # caller before it ever reaches here. Without this, a value that
        # failed ISO parsing fell through to being spoken aloud as a raw
        # number: "until 1785283200000."
        if normalized.isdigit():
            try:
                return datetime.fromtimestamp(int(normalized) / 1000, tz=UTC)
            except (OverflowError, OSError, ValueError):
                return None
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _safe_timezone(value: Any) -> ZoneInfo:
    name = str(value or "").strip()
    if not name:
        return ZoneInfo("UTC")
    try:
        return ZoneInfo(name)
    except (ValueError, ZoneInfoNotFoundError):
        return ZoneInfo("UTC")
