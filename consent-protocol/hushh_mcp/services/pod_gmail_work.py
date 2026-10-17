"""Bounded notification work within the existing encrypted watch snapshot.

Only provider identifiers are queued. Queueing never authorizes reading a body
or invoking a model; an admitted owner read settles only the IDs it returned.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from hushh_mcp.services import pod_connector_credentials as credentials

MAX_PENDING_MESSAGES = 1000


def current_binding() -> dict[str, str]:
    held = credentials.active_connector_credential("gmail")
    if held is None or held.status != credentials.STATUS_CONNECTED:
        raise ValueError("MAILBOX_CONNECTION_UNAVAILABLE")
    return {"credentialId": held.credential_id, "accountSubject": held.account_subject}


def require_binding(binding: dict[str, Any]) -> None:
    if any(binding.get(key) != value for key, value in current_binding().items()):
        raise ValueError("MAILBOX_CHANGED_REQUIRES_RECOVERY")


def enqueue(point: dict[str, Any], ids: list[str], binding: dict[str, str]) -> dict[str, Any]:
    require_binding(binding)
    work = dict(point.get("work") or {})
    if work.get("messageIds"):
        require_binding(work)
    previous = list(work.get("messageIds") or [])
    combined = list(dict.fromkeys([*previous, *ids]))
    if len(combined) > MAX_PENDING_MESSAGES:
        raise ValueError("OWNER_READ_BACKLOG_FULL")
    if not combined:
        return work
    if work and previous == combined:
        return work
    return {
        **binding,
        "deliveryId": uuid4().hex,
        "messageIds": combined,
        "scanOffset": int(work.get("scanOffset") or 0) % len(combined),
    }


def settle(work: dict[str, Any], delivery: dict[str, Any], returned: tuple[str, ...]) -> dict:
    require_binding(delivery)
    require_binding(work)
    if work.get("deliveryId") != delivery.get("deliveryId"):
        raise ValueError("WORK_CHANGED_RETRY")
    offered = set(returned).intersection(delivery.get("messageIds") or [])
    remaining = [item for item in work["messageIds"] if item not in offered]
    return {**work, "messageIds": remaining} if remaining else {}
