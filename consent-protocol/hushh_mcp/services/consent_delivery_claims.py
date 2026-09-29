"""Exactly-once claims for consent event side effects across workers and instances.

PostgreSQL delivers every ``consent_audit_new`` NOTIFY to every listening
backend worker on every instance. Anything with a global effect (a push, a
delivery record, the requester's doorbell) must therefore be claimed first: the
worker whose ``INSERT ... ON CONFLICT DO NOTHING RETURNING`` returns a row owns
the side effect, and every other worker skips it. Measured on UAT 2026-09-28:
without the claim one consent event produced eight pushes and eight delivery
records.

A claim is only a key and a time (migration 259). Process-local effects, such
as pushing to an SSE stream that this worker holds, are not claimed: each open
stream lives in exactly one worker, so it receives each event exactly once.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Mapping
from typing import Any

logger = logging.getLogger(__name__)

CLAIM_RETENTION_DAYS = 14
_MAX_KEY_LENGTH = 200


def consent_event_delivery_key(event: Mapping[str, Any]) -> str:
    """The idempotency key for one consent_audit event.

    The row id (``audit_id``, added to the NOTIFY payload by migration 259) is
    the canonical key. A payload from an older trigger has no id, so the key
    falls back to a digest of the fields that identify the row.
    """
    audit_id = str(event.get("audit_id") or "").strip()
    if audit_id:
        return f"consent_audit:{audit_id}"[:_MAX_KEY_LENGTH]
    identity = json.dumps(
        [
            str(event.get(field) or "")
            for field in ("user_id", "request_id", "action", "scope", "agent_id", "issued_at")
        ],
        separators=(",", ":"),
    )
    return "consent_audit_payload:" + hashlib.sha256(identity.encode()).hexdigest()


def request_notification_key(request_id: str, sequence: int) -> str:
    """One owner delivery per request and sequence, shared by the listener and the job."""
    return f"request_notification:{request_id}:{int(sequence)}"[:_MAX_KEY_LENGTH]


def timeout_emission_key(user_id: str, request_id: str) -> str:
    """One TIMEOUT row per request, however many workers run the timeout job."""
    digest = hashlib.sha256(f"{user_id}|{request_id}".encode()).hexdigest()
    return f"request_timeout:{digest}"


async def claim_delivery(key: str) -> bool:
    """True for exactly one caller per key across every worker and instance.

    Fails open: if the claim cannot be recorded (the table is missing because
    the code deployed ahead of its migration, or the database errored), the
    caller proceeds. That preserves the previous at-least-once delivery rather
    than silently dropping a person's notification.
    """
    normalized = str(key or "").strip()[:_MAX_KEY_LENGTH]
    if not normalized:
        return True
    try:
        from db.connection import get_pool

        pool = await get_pool()
        claimed = await pool.fetchval(
            """INSERT INTO consent_event_deliveries (delivery_key)
               VALUES ($1)
               ON CONFLICT (delivery_key) DO NOTHING
               RETURNING delivery_key""",
            normalized,
        )
        return claimed is not None
    except Exception as exc:  # noqa: BLE001 - delivery must survive a claim failure
        logger.warning("consent.delivery_claim_unavailable error=%s", type(exc).__name__)
        return True


async def prune_delivery_claims() -> int:
    """Drop claims older than the retention window. Returns the rows removed."""
    try:
        from db.connection import get_pool

        pool = await get_pool()
        status = await pool.execute(
            "DELETE FROM consent_event_deliveries WHERE claimed_at < NOW() - make_interval(days => $1)",
            CLAIM_RETENTION_DAYS,
        )
        return int(str(status).rsplit(" ", 1)[-1] or 0)
    except Exception as exc:  # noqa: BLE001 - housekeeping is best-effort
        logger.info("consent.delivery_claim_prune_skipped error=%s", type(exc).__name__)
        return 0


__all__ = [
    "CLAIM_RETENTION_DAYS",
    "claim_delivery",
    "consent_event_delivery_key",
    "prune_delivery_claims",
    "request_notification_key",
    "timeout_emission_key",
]
