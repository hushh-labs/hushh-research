from __future__ import annotations

from typing import Any

FINAL_REMINDER_LEAD_MS = 30 * 60 * 1000
SHORT_WINDOW_FINAL_REMINDER_MIN_MS = 10 * 60 * 1000


def object_map(value: object | None) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    return {}


def coerce_optional_int(value: object | None) -> int | None:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        normalized = value.strip()
        if not normalized:
            return None
        try:
            return int(normalized)
        except ValueError:
            return None
    return None


def next_pending_notification(
    payload: dict[str, Any],
    events: list[dict[str, Any]],
    *,
    now_ms: int,
) -> tuple[int, str] | None:
    max_sequence = 0
    delivery_reasons: set[str] = set()
    for event in events:
        if str(event.get("action") or "").strip().upper() == "NOTIFICATION_OPENED":
            return None
        metadata = object_map(event.get("metadata"))
        raw_sequence = coerce_optional_int(metadata.get("notification_sequence"))
        if raw_sequence is None:
            continue
        max_sequence = max(max_sequence, raw_sequence)
        reason = str(metadata.get("delivery_reason") or "").strip()
        if reason:
            delivery_reasons.add(reason)

    approval_timeout_at = payload.get("approval_timeout_at")
    issued_at = payload.get("issued_at")
    if not isinstance(approval_timeout_at, (int, float)) or not isinstance(issued_at, (int, float)):
        return None

    approval_timeout_at = int(approval_timeout_at)
    issued_at = int(issued_at)
    if approval_timeout_at <= now_ms:
        return None

    window_ms = max(approval_timeout_at - issued_at, 0)
    final_due: int | None
    if window_ms >= FINAL_REMINDER_LEAD_MS:
        final_due = approval_timeout_at - FINAL_REMINDER_LEAD_MS
    elif window_ms >= SHORT_WINDOW_FINAL_REMINDER_MIN_MS:
        final_due = issued_at + (window_ms // 2)
    else:
        final_due = None

    if max_sequence <= 0:
        return 1, "initial_request"
    if (
        max_sequence == 1
        and final_due is not None
        and "final_reminder" not in delivery_reasons
        and now_ms >= final_due
    ):
        return 2, "final_reminder"
    return None
