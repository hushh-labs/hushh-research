"""Fixed metadata projection for the company CRM; never a personal connector."""

from __future__ import annotations

import hashlib
import html
import math
from datetime import UTC, datetime, timedelta

RETENTION_DAYS = 90
CONTACT_PROPERTIES = ("one_user_id", "one_signup_at", "one_last_login_at")
EVENT_KEYS = frozenset({"agentId", "actionId", "source", "phase", "observedAt"})


def receipt_key(kind: str, identity: str) -> str:
    return hashlib.sha256(f"one-company-crm:v1:{kind}:{identity}".encode()).hexdigest()


def email_fingerprint(email: str) -> str:
    return hashlib.sha256(email.strip().lower().encode()).hexdigest()


def auth_timestamp(value: object) -> str | None:
    """Firebase timestamps are milliseconds; unknown never becomes 'now'."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        if not math.isfinite(value) or value <= 0 or value != int(value):
            return None
        return datetime.fromtimestamp(value / 1000, UTC).isoformat()
    except (OverflowError, OSError, ValueError):
        return None


def contact_properties(record, owner_hash: str) -> dict[str, str]:
    # Explicit SDK getters only. UserRecord may contain password export fields.
    metadata = record.user_metadata
    properties = {"one_user_id": owner_hash}
    for field, timestamp in (
        ("one_signup_at", metadata.creation_timestamp),
        ("one_last_login_at", metadata.last_sign_in_timestamp),
    ):
        if (value := auth_timestamp(timestamp)) is not None:
            properties[field] = value
    return properties


def activity_payload(
    *, agent_id: str, action_id: str, source: str, phase: str, observed_at: datetime
) -> dict[str, str]:
    if source not in {"client_reported", "execution_observed"} or phase not in {
        "started",
        "returned",
        "failed",
        "cancelled",
        "blocked",
    }:
        raise ValueError("invalid activity metadata")
    if not 1 <= len(agent_id) <= 128 or not 1 <= len(action_id) <= 256:
        raise ValueError("invalid catalog identifier")
    if observed_at.tzinfo is None:
        raise ValueError("activity timestamp requires timezone")
    return {
        "agentId": agent_id,
        "actionId": action_id,
        "source": source,
        "phase": phase,
        "observedAt": observed_at.astimezone(UTC).isoformat(),
    }


def note_marker(item_id: str) -> str:
    if len(item_id) != 64 or any(c not in "0123456789abcdef" for c in item_id):
        raise ValueError("invalid CRM receipt")
    return f"onecrm{item_id}"


def activity_note(item_id: str, payload: dict) -> tuple[str, str]:
    if set(payload) != EVENT_KEYS:
        raise ValueError("unexpected activity fields")
    checked = activity_payload(
        agent_id=payload["agentId"],
        action_id=payload["actionId"],
        source=payload["source"],
        phase=payload["phase"],
        observed_at=datetime.fromisoformat(payload["observedAt"]),
    )
    text = "<br>".join(html.escape(f"{key}: {checked[key]}") for key in sorted(checked))
    body = (
        f"<b>One product activity</b><br>{text}<br>"
        "Observation only; a returned call does not prove a completed business action. "
        f"Client reports use server receipt time.<br>{note_marker(item_id)}"
    )
    return checked["observedAt"], body


def summary_note(
    item_id: str,
    *,
    counts: dict[str, int],
    last_at: datetime | None,
    setup_completed: bool | None,
    as_of: datetime,
) -> tuple[str, str]:
    lines = [
        "<b>One usage summary</b>",
        f"Updated: {as_of.astimezone(UTC).isoformat()}",
        "Retained observations only (up to 90 days); collection is bounded and best effort.",
    ]
    if last_at is not None:
        lines.append(f"Last observed activity: {last_at.astimezone(UTC).isoformat()}")
    if setup_completed is not None:
        lines.append(f"Onboarding completed: {str(setup_completed).lower()}")
    for key, count in sorted(counts.items())[:30]:
        if not isinstance(count, int) or count < 0:
            raise ValueError("invalid observation count")
        lines.append(html.escape(f"{key}: {count}"))
    if len(counts) > 30:
        lines.append("Showing the first 30 observation categories; this summary is truncated.")
    lines.append(note_marker(item_id))
    return as_of.astimezone(UTC).isoformat(), "<br>".join(lines)


def expiry(observed_at: datetime) -> datetime:
    return observed_at + timedelta(days=RETENTION_DAYS)
