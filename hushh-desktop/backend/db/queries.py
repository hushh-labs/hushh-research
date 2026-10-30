# db/queries.py
"""
Database query operations for consent management.

Includes:
- Pending requests (consent requests awaiting user approval)
- Active tokens (granted consents that haven't expired or been revoked)
- Audit log (full history of consent events)
"""

import json
from datetime import datetime
from typing import Dict, List, Optional

from .connection import get_pool

# ============================================================================
# Pending Requests
# ============================================================================


async def get_pending_requests(user_id: str) -> List[Dict]:
    """
    Get pending consent requests for a user.
    A request is pending if it has REQUESTED action with no resolution.
    """
    pool = await get_pool()

    query = """
        WITH latest_per_request AS (
            SELECT DISTINCT ON (request_id)
                id, user_id, request_id, agent_id, scope, scope_description,
                action, poll_timeout_at, issued_at, metadata
            FROM consent_audit
            WHERE user_id = $1 AND request_id IS NOT NULL
            ORDER BY request_id, issued_at DESC
        )
        SELECT * FROM latest_per_request
        WHERE action = 'REQUESTED'
          AND (poll_timeout_at IS NULL OR poll_timeout_at > $2)
        ORDER BY issued_at DESC
    """

    now_ms = int(datetime.now().timestamp() * 1000)

    async with pool.acquire() as conn:
        rows = await conn.fetch(query, user_id, now_ms)
        results = []
        for row in rows:
            # Extract expiryHours from metadata JSON
            metadata = row["metadata"] or {}
            if isinstance(metadata, str):
                metadata = json.loads(metadata) if metadata else {}
            expiry_hours = metadata.get("expiry_hours", 24)

            results.append(
                {
                    "id": row["request_id"],
                    "developer": row["agent_id"],
                    "scope": row["scope"],
                    "scopeDescription": row["scope_description"],
                    "requestedAt": row["issued_at"],
                    "pollTimeoutAt": row["poll_timeout_at"],
                    "expiryHours": expiry_hours,
                }
            )
        return results


async def get_pending_by_request_id(user_id: str, request_id: str) -> Optional[Dict]:
    """Get a specific pending request by request_id."""
    pool = await get_pool()

    query = """
        SELECT * FROM consent_audit
        WHERE user_id = $1 AND request_id = $2
        ORDER BY issued_at DESC
        LIMIT 1
    """

    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, user_id, request_id)
        if row and row["action"] == "REQUESTED":
            poll_timeout_at = row["poll_timeout_at"] or row["expires_at"]
            if poll_timeout_at is not None:
                now_ms = int(datetime.now().timestamp() * 1000)
                if poll_timeout_at <= now_ms:
                    return None
            metadata = row["metadata"] or {}
            if isinstance(metadata, str):
                metadata = json.loads(metadata) if metadata else {}
            return {
                "request_id": row["request_id"],
                "developer": row["agent_id"],
                "scope": row["scope"],
                "scope_description": row["scope_description"],
                "poll_timeout_at": row["poll_timeout_at"],
                "issued_at": row["issued_at"],
                "metadata": metadata,
            }
        return None


# ============================================================================
# Active Tokens
# ============================================================================


async def get_active_tokens(
    user_id: str,
    agent_id: Optional[str] = None,
    scope: Optional[str] = None,
) -> List[Dict]:
    """
    Get active consent tokens for a user.
    Active = CONSENT_GRANTED with no subsequent REVOKED and not expired.
    """
    pool = await get_pool()

    now_ms = int(datetime.now().timestamp() * 1000)

    query = """
        WITH latest_per_agent_scope AS (
            SELECT DISTINCT ON (agent_id, scope)
                id, user_id, agent_id, scope, action, token_id,
                expires_at, issued_at, request_id
            FROM consent_audit
            WHERE user_id = $1
              AND action IN ('CONSENT_GRANTED', 'REVOKED')
              AND ($2::text IS NULL OR agent_id = $2)
              AND ($3::text IS NULL OR scope = $3)
            ORDER BY agent_id, scope, issued_at DESC
        )
        SELECT * FROM latest_per_agent_scope
        WHERE action = 'CONSENT_GRANTED' AND (expires_at IS NULL OR expires_at > $4)
    """

    async with pool.acquire() as conn:
        rows = await conn.fetch(query, user_id, agent_id, scope, now_ms)
        return [
            {
                "id": row["token_id"][:20] + "..." if row["token_id"] else str(row["id"]),
                "scope": row["scope"],
                "developer": row["agent_id"],
                "agent_id": row["agent_id"],
                "issued_at": row["issued_at"],
                "expires_at": row["expires_at"],
                "time_remaining_ms": (row["expires_at"] - now_ms) if row["expires_at"] else 0,
                "request_id": row["request_id"],
                "token_id": row["token_id"],
            }
            for row in rows
        ]


async def is_token_active(user_id: str, scope: str, agent_id: Optional[str] = None) -> bool:
    """Check if there's an active token for user+scope (+agent_id when provided)."""
    pool = await get_pool()

    now_ms = int(datetime.now().timestamp() * 1000)

    query = """
        SELECT action, expires_at FROM consent_audit
        WHERE user_id = $1
          AND scope = $2
          AND action IN ('CONSENT_GRANTED', 'REVOKED')
          AND ($3::text IS NULL OR agent_id = $3)
        ORDER BY issued_at DESC
        LIMIT 1
    """

    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, user_id, scope, agent_id)
        if row and row["action"] == "CONSENT_GRANTED":
            return row["expires_at"] is None or row["expires_at"] > now_ms
        return False


async def was_recently_denied(user_id: str, scope: str, cooldown_seconds: int = 60) -> bool:
    """
    Check if consent was recently denied for user+scope.

    This prevents MCP from immediately re-requesting after a denial,
    which would cause duplicate toast notifications.
    """
    pool = await get_pool()

    now_ms = int(datetime.now().timestamp() * 1000)
    cooldown_ms = cooldown_seconds * 1000
    cutoff_ms = now_ms - cooldown_ms

    query = """
        SELECT action, issued_at FROM consent_audit
        WHERE user_id = $1 AND scope = $2 AND action = 'CONSENT_DENIED'
        AND issued_at > $3
        ORDER BY issued_at DESC
        LIMIT 1
    """

    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, user_id, scope, cutoff_ms)
        return row is not None


# ============================================================================
# Audit Log
# ============================================================================


async def get_audit_log(user_id: str, page: int = 1, limit: int = 50) -> Dict:
    """Get paginated audit log for a user."""
    import json

    pool = await get_pool()

    offset = (page - 1) * limit

    query = """
        SELECT id, token_id, agent_id, scope, action, issued_at, expires_at, 
               request_id, poll_timeout_at, scope_description, metadata
        FROM consent_audit
        WHERE user_id = $1
        ORDER BY issued_at DESC
        LIMIT $2 OFFSET $3
    """

    count_query = "SELECT COUNT(*) FROM consent_audit WHERE user_id = $1"

    now_ms = int(datetime.now().timestamp() * 1000)

    async with pool.acquire() as conn:
        rows = await conn.fetch(query, user_id, limit, offset)
        total = await conn.fetchval(count_query, user_id)

        items = []
        for row in rows:
            # Parse metadata JSON if present
            metadata = None
            if row["metadata"]:
                try:
                    metadata = (
                        json.loads(row["metadata"])
                        if isinstance(row["metadata"], str)
                        else row["metadata"]
                    )
                except (json.JSONDecodeError, TypeError):
                    metadata = None

            items.append(
                {
                    "id": str(row["id"]),
                    "token_id": row["token_id"][:20] + "..."
                    if row["token_id"] and len(row["token_id"]) > 20
                    else row["token_id"] or "N/A",
                    "agent_id": row["agent_id"],
                    "scope": row["scope"],
                    "action": row["action"],
                    "issued_at": row["issued_at"],
                    "expires_at": row["expires_at"],
                    "request_id": row["request_id"],
                    "scope_description": row["scope_description"],
                    "metadata": metadata,
                    # Detect timed out: REQUESTED with poll_timeout_at in the past
                    "is_timed_out": row["action"] == "REQUESTED"
                    and row["poll_timeout_at"]
                    and row["poll_timeout_at"] < now_ms,
                }
            )

        return {
            "items": items,
            "total": total,
            "page": page,
            "limit": limit,
        }
