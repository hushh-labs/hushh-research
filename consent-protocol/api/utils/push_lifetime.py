"""Delivery lifetime calculation without SDK or owner state."""

from datetime import UTC, datetime
from typing import NamedTuple


class PushLifetime(NamedTuple):
    expiry: int
    chat_ttl: int
    sms_expiry: int
    sms_expired: bool
    alert_ttl: int
    reminder_expiry: int


def push_lifetime(
    data: dict[str, str], *, is_chat: bool, is_sms_created: bool, is_reminder: bool, now: float
) -> PushLifetime:
    expiry = int(data.get("chat_expires_at") or (int(now) + 86400)) if is_chat else 0
    chat_ttl = max(0, min(86400, expiry - int(now)))
    sms_expiry = 0
    sms_expired = False
    if is_sms_created and data.get("expires_at"):
        try:
            deadline = datetime.fromisoformat(data["expires_at"].replace("Z", "+00:00"))
            if deadline.tzinfo is None:
                deadline = deadline.replace(tzinfo=UTC)
            sms_expiry = int(deadline.timestamp())
            sms_expired = sms_expiry <= int(now)
        except (ValueError, OverflowError, TypeError):
            sms_expired = True
    # Legacy undated alerts may deliver now but must never queue for weeks.
    sms_ttl = max(0, min(28 * 86400, sms_expiry - int(now)))
    alert_ttl = sms_ttl if is_sms_created else chat_ttl
    reminder_expiry = 0
    if is_reminder:
        try:
            reminder_expiry = int(data.get("reminder_expires_at") or 0)
        except (ValueError, TypeError):
            reminder_expiry = 0
        alert_ttl = max(0, min(900, reminder_expiry - int(now)))

    return PushLifetime(expiry, chat_ttl, sms_expiry, sms_expired, alert_ttl, reminder_expiry)


def chat_badge_count(data: dict[str, str], *, enabled: bool) -> int | None:
    try:
        return max(0, min(9999, int(data["chat_badge_count"]))) if enabled else None
    except (KeyError, ValueError, TypeError):
        return None
