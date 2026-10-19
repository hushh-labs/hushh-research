"""Bounded metadata projection of existing task ledgers for an enrolled pilot.

No new event authority or runtime table. Retained rows prove positive outcomes;
absence never proves inactivity, signup, marketing permission or feed coverage.
"""

from __future__ import annotations

import asyncio
import hashlib
from datetime import datetime, timedelta, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from db.connection import get_pool
from hushh_mcp.services.account_deletion_lifecycle_service import AccountDeletionLifecycleService
from hushh_mcp.services.pkm_mutation_contracts import derive_pkm_mutation_commit_id


class PilotAccount(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    accountId: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9:_-]+$")
    journey: Literal["memory", "mail"]
    since: str = Field(min_length=20, max_length=40)

    @field_validator("since")
    @classmethod
    def valid_since(cls, value: str) -> str:
        at = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if at.tzinfo is None:
            raise ValueError("timezone required")
        return value


class PilotRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    accounts: list[PilotAccount] = Field(min_length=1, max_length=20)


MAIL_SQL = """
SELECT action_id::text AS action_id, sent_at AS occurred_at
FROM gmail_owner_send_actions
WHERE user_id = $1 AND state = 'sent'
  AND send_at IS NULL
  AND NULLIF(gmail_message_id, '') IS NOT NULL
  AND sent_at >= $2 AND sent_at <= $3
ORDER BY sent_at, action_id LIMIT 101
"""
MEMORY_SQL = """
SELECT DISTINCT c.commit_id::text AS action_id, c.created_at AS occurred_at,
  c.domain, e.metadata->'provenance'->>'mutation_plan_id' AS plan_id,
  e.metadata->'provenance'->>'authorization_mode' AS authorization_mode
FROM pkm_domain_commits c
JOIN pkm_events e ON e.user_id = c.user_id AND e.domain = c.domain
  AND e.operation_type = 'content_write'
  AND e.metadata->>'data_version' = c.result_content_revision::text
WHERE c.user_id = $1 AND c.commit_kind = 'mutation'
  AND c.result_content_revision IS NOT NULL
  AND c.created_at >= $2 AND c.created_at <= $3
  AND e.metadata->'provenance'->>'authorization_mode' = 'owner_confirmed'
  AND NULLIF(BTRIM(e.metadata->'provenance'->>'mutation_plan_id'), '') IS NOT NULL
  AND NULLIF(BTRIM(e.metadata->'provenance'->>'confirmation_receipt_id'), '') IS NOT NULL
ORDER BY occurred_at, action_id LIMIT 101
"""


def confirmed_memory(row, user_id: str) -> bool:
    """Bind the exact confirmed plan to its commit, even across revision reuse."""
    if row["authorization_mode"] != "owner_confirmed":
        return False
    try:
        return bool(
            row["action_id"]
            == derive_pkm_mutation_commit_id(
                user_id=user_id, domain=row["domain"], plan_id=row["plan_id"]
            )
        )
    except ValueError:
        return False


async def snapshot(request: PilotRequest, allowed: set[str], now: datetime) -> dict:
    """Fail the entire batch on missing authority, truncation or source failure."""
    if len({a.accountId for a in request.accounts}) != len(request.accounts):
        raise ValueError("duplicate accounts")
    for account in request.accounts:
        since = datetime.fromisoformat(account.since.replace("Z", "+00:00"))
        if (
            account.accountId not in allowed
            or since < now - timedelta(days=7, minutes=1)
            or since > now
        ):
            raise ValueError("outside enrolled pilot or observation window")
    pool = await get_pool()
    result = []
    async with pool.acquire(timeout=5) as conn:
        for account in request.accounts:
            # Reuse the existing deletion barrier; its synchronous DB work must
            # stay off the event loop. Never export rows for a tombstoned UID.
            deleted = await asyncio.to_thread(
                AccountDeletionLifecycleService.is_tombstoned, account.accountId
            )
            tasks = []
            if not deleted:
                rows = await conn.fetch(
                    MEMORY_SQL if account.journey == "memory" else MAIL_SQL,
                    account.accountId,
                    datetime.fromisoformat(account.since.replace("Z", "+00:00")),
                    now,
                    timeout=10,
                )
                if len(rows) > 100:
                    raise ValueError("pilot result limit exceeded")
                if account.journey == "memory":
                    rows = [row for row in rows if confirmed_memory(row, account.accountId)]
                tasks = [
                    {
                        "actionId": hashlib.sha256(
                            f"{account.journey}:{row['action_id']}".encode()
                        ).hexdigest(),
                        "occurredAt": row["occurred_at"].astimezone(timezone.utc).isoformat(),
                    }
                    for row in rows
                ]
            result.append({**account.model_dump(), "deleted": deleted, "tasks": tasks})
    return {
        "version": 1,
        "environment": "production",
        "retainedOnly": True,
        "asOf": now.astimezone(timezone.utc).isoformat(),
        "accounts": result,
    }
