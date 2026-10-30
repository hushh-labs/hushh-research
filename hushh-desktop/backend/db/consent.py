# db/consent.py
"""
Consent event insertion operations.
"""

import json
import logging
from datetime import datetime
from typing import Dict, Optional

from .connection import get_pool

logger = logging.getLogger(__name__)


def _is_internal_event(agent_id: str, action: str, scope: str) -> bool:
    normalized_agent = str(agent_id or "").strip().lower()
    normalized_action = str(action or "").strip().upper()
    normalized_scope = str(scope or "").strip().lower()
    return (
        normalized_action == "OPERATION_PERFORMED"
        or normalized_agent in {"self", "agent_kai", "kai"}
        or (normalized_scope == "vault.owner" and normalized_agent in {"", "system"})
    )


async def insert_event(
    user_id: str,
    agent_id: str,
    scope: str,
    action: str,
    token_id: Optional[str] = None,
    request_id: Optional[str] = None,
    scope_description: Optional[str] = None,
    expires_at: Optional[int] = None,
    poll_timeout_at: Optional[int] = None,
    metadata: Optional[Dict] = None,
) -> int:
    """
    Insert a consent event into consent_audit table.

    Uses event-sourcing pattern - all actions (REQUESTED, GRANTED, DENIED, REVOKED)
    are separate events. The latest event per scope determines current state.

    Returns the event ID.
    """
    pool = await get_pool()

    issued_at = int(datetime.now().timestamp() * 1000)
    token_id = token_id or f"evt_{issued_at}"

    table_name = (
        "internal_access_events" if _is_internal_event(agent_id, action, scope) else "consent_audit"
    )

    query = f"""
        INSERT INTO {table_name} (
            token_id, user_id, agent_id, scope, action,
            request_id, scope_description, issued_at, expires_at, metadata
            {", poll_timeout_at" if table_name == "consent_audit" else ""}
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
            {", $11" if table_name == "consent_audit" else ""}
        )
        RETURNING id
    """

    metadata_json = json.dumps(metadata or {})

    async with pool.acquire() as conn:
        params = [
            token_id,
            user_id,
            agent_id,
            scope,
            action,
            request_id,
            scope_description,
            issued_at,
            expires_at,
            metadata_json,
        ]
        if table_name == "consent_audit":
            params.append(poll_timeout_at)
            # reorder to match consent_audit column order
            params = [
                token_id,
                user_id,
                agent_id,
                scope,
                action,
                request_id,
                scope_description,
                issued_at,
                expires_at,
                poll_timeout_at,
                metadata_json,
            ]

        row = await conn.fetchrow(query, *params)
        event_id = row["id"]
        logger.info("Inserted %s event into %s: %s", action, table_name, event_id)
        return int(event_id)


async def log_operation(
    user_id: str, operation: str, target: Optional[str] = None, metadata: Optional[Dict] = None
) -> int:
    """
    Log an operation performed using vault.owner token.

    This provides granular audit logging for vault owner operations,
    showing WHAT operation was performed (e.g., kai.analyze) and
    on WHAT target (e.g., AAPL ticker).

    Args:
        user_id: The user performing the operation
        operation: The operation type (e.g., "kai.analyze", "kai.preferences.read")
        target: Optional target of the operation (e.g., "AAPL" for ticker analysis)
        metadata: Additional context to store

    Returns:
        The event ID
    """
    operation_metadata = {
        "operation": operation,
        **({"target": target} if target else {}),
        **(metadata or {}),
    }

    return await insert_event(
        user_id=user_id,
        agent_id="self",
        scope="vault.owner",
        action="OPERATION_PERFORMED",
        scope_description=operation,
        metadata=operation_metadata,
    )
