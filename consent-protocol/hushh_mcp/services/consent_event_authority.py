"""Consent ledger ports: exact lineage reads, guarded inserts and receipt projection.

ConsentDBService remains the public facade. Revocation transactions and their locks
stay in that owner; this module does not introduce a ledger or issue tokens.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

logger = logging.getLogger(__name__)


async def persist_external_event(db: Any, data: dict, metadata: dict | None) -> Any:
    if (
        data["agent_id"] == "personal_agent"
        and data["action"] == "CONSENT_GRANTED"
        and (metadata or {}).get("automatic_renewal") is True
    ):
        # Dev-only private-agent admission. Missing migration/disabled guard
        # refuses minting; no fallback to an unguarded INSERT. The same event
        # continues through the existing receipt and notification path below.
        try:
            response = await asyncio.to_thread(
                db.execute_raw,
                "SELECT * FROM public.insert_personal_agent_renewal(CAST(:event AS jsonb))",
                {"event": json.dumps(data)},
            )
        except Exception as exc:
            # DB exception details can contain bound token material. Neither
            # provisioning diagnostics nor relay errors may retain it.
            logger.info("personal_agent.renewal_refused error_type=%s", type(exc).__name__)
            raise PermissionError("personal agent renewal authority unavailable") from None
    else:
        try:
            response = await asyncio.to_thread(
                lambda: db.table("consent_audit").insert(data).execute()
            )
        except Exception as exc:
            if data["agent_id"] != "personal_agent":
                raise
            logger.info("personal_agent.event_refused error_type=%s", type(exc).__name__)
            raise PermissionError("personal agent consent authority unavailable") from None

    return response


def owner_lineage_is_active(db: Any, user_id: str, token_id: str, now_ms: int) -> bool:
    rows = db.execute_raw(
        """
        SELECT grant_event.id FROM internal_access_events AS grant_event
        WHERE grant_event.user_id = :user_id AND grant_event.agent_id = 'self'
          AND grant_event.scope = 'vault.owner'
          AND grant_event.action = 'CONSENT_GRANTED'
          AND grant_event.token_id = :token_id
          AND grant_event.expires_at > :now_ms
          AND grant_event.id = (
            SELECT MIN(original.id) FROM internal_access_events AS original
            WHERE original.user_id = grant_event.user_id
              AND original.agent_id = 'self' AND original.scope = 'vault.owner'
              AND original.action = 'CONSENT_GRANTED'
              AND original.token_id = grant_event.token_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM internal_access_events AS revoked
            WHERE revoked.user_id = grant_event.user_id
              AND revoked.agent_id = 'self' AND revoked.scope = 'vault.owner'
              AND revoked.action = 'REVOKED' AND revoked.id > grant_event.id
          ) LIMIT 1
    """,
        {"user_id": user_id, "token_id": token_id, "now_ms": now_ms},
    ).data
    return bool(rows)


def event_is_newer(row: dict, previous: dict) -> bool:
    current_time, new_time = previous.get("issued_at", 0), row.get("issued_at", 0)
    current_id, new_id = previous.get("id"), row.get("id")
    private_tie = (
        row.get("agent_id") == "personal_agent"
        and new_time == current_time
        and isinstance(current_id, int)
        and isinstance(new_id, int)
        and new_id > current_id
    )
    return new_time > current_time or private_tie


async def append_event_receipt(
    data: dict, *, issued_at: int, event_id: Any, internal: bool = False
) -> None:
    from hushh_mcp.services.consent_audit_chain_service import (
        LEDGER_CONSENT,
        LEDGER_INTERNAL,
        append_consent_receipt_safe,
    )

    await append_consent_receipt_safe(
        subject_id=data["user_id"],
        event_type=data["action"],
        issued_at_ms=issued_at,
        agent_id=data["agent_id"],
        scope=data["scope"],
        request_id=data.get("request_id"),
        token_id=data["token_id"],
        audit_event_id=event_id if isinstance(event_id, int) else None,
        metadata=json.loads(data["metadata"]) if data.get("metadata") else None,
        ledger=LEDGER_INTERNAL if internal else LEDGER_CONSENT,
    )
