"""Bounded metadata projection of existing task ledgers for an enrolled pilot.

Domain ledgers prove effects; the separate observation sink proves only collection.
absence never proves inactivity, signup, marketing permission or feed coverage.
"""

from __future__ import annotations

import asyncio
import hashlib
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from db.connection import get_pool
from hushh_mcp.services.account_deletion_lifecycle_service import AccountDeletionLifecycleService
from hushh_mcp.services.pkm_mutation_contracts import derive_pkm_mutation_commit_id
from hushh_mcp.services.plg_catalog import activity_catalog, public_activity_catalog
from hushh_mcp.services.product_activity import enabled_for


class PilotAccount(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    accountId: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9:_-]+$")
    journey: str = Field(min_length=1, max_length=128)
    since: str = Field(min_length=20, max_length=40)

    @field_validator("journey")
    @classmethod
    def valid_journey(cls, value: str) -> str:
        if value not in {"memory", "mail"} and value not in {
            a["id"] for a in activity_catalog()["agents"]
        }:
            raise ValueError("Unknown product agent")
        return value

    @field_validator("since")
    @classmethod
    def valid_since(cls, value: str) -> str:
        at = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if at.tzinfo is None:
            raise ValueError("timezone required")
        return value


class PilotRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[1, 2] = 1
    accounts: list[PilotAccount] = Field(min_length=0, max_length=20)


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
    if not request.accounts:
        if request.version != 2:
            raise ValueError("No accounts requested")
        return {
            "version": 2,
            "environment": "production",
            "retainedOnly": True,
            "asOf": now.astimezone(timezone.utc).isoformat(),
            "accounts": [],
            "catalog": public_activity_catalog(),
        }
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
            activity = None
            verified = []
            if not deleted:
                journeys = ["memory", "mail"] if request.version == 2 else [account.journey]
                if request.version == 1 and account.journey not in {"memory", "mail"}:
                    raise ValueError("Agent activity requires version 2")
                for journey in journeys:
                    query = MEMORY_SQL if journey == "memory" else MAIL_SQL
                    if request.version == 2:
                        query = query.replace("LIMIT 101", "LIMIT 1001")
                    rows = await conn.fetch(
                        query,
                        account.accountId,
                        datetime.fromisoformat(account.since.replace("Z", "+00:00")),
                        now,
                        timeout=10,
                    )
                    if len(rows) > (1000 if request.version == 2 else 100):
                        raise ValueError("pilot result limit exceeded")
                    if journey == "memory":
                        rows = [row for row in rows if confirmed_memory(row, account.accountId)]
                    if request.version == 2:
                        times = sorted(
                            row["occurred_at"].astimezone(timezone.utc).isoformat() for row in rows
                        )
                        if times:
                            verified.append(
                                {
                                    "agentId": "agent_personal_information"
                                    if journey == "memory"
                                    else "agent_email",
                                    "count": len(times),
                                    "firstAt": times[0],
                                    "lastAt": times[-1],
                                    "days": sorted({at[:10] for at in times}),
                                }
                            )
                    else:
                        tasks = [
                            {
                                "actionId": hashlib.sha256(
                                    f"{journey}:{row['action_id']}".encode()
                                ).hexdigest(),
                                "occurredAt": row["occurred_at"]
                                .astimezone(timezone.utc)
                                .isoformat(),
                            }
                            for row in rows
                        ]
                if request.version == 2:
                    activity = await activity_snapshot(conn, account, now)
            entry = {**account.model_dump(), "deleted": deleted, "tasks": tasks}
            if request.version == 2:
                entry.update({"activity": activity, "verified": verified})
            result.append(entry)
    response: dict[str, Any] = {
        "version": request.version,
        "environment": "production",
        "retainedOnly": True,
        "asOf": now.astimezone(timezone.utc).isoformat(),
        "accounts": result,
    }
    if request.version == 2:
        response["catalog"] = public_activity_catalog()
    return response


async def activity_snapshot(conn, account: PilotAccount, now: datetime) -> dict:
    """Observed execution and client reports stay separate from verified value."""
    base: dict[str, Any] = {
        "enabled": enabled_for(account.accountId),
        "mode": "best_effort",
        "limited": False,
        "startedAt": None,
        "epoch": None,
        "rollups": [],
    }
    if not base["enabled"]:
        return base
    epoch = await conn.fetchrow(
        "SELECT generation,started_at FROM one_product_activity_epochs WHERE user_id=$1",
        account.accountId,
        timeout=5,
    )
    if not epoch:
        return base
    base["startedAt"] = epoch["started_at"].astimezone(timezone.utc).isoformat()
    base["epoch"] = hashlib.sha256(str(epoch["generation"]).encode()).hexdigest()
    rows = await conn.fetch(
        """SELECT agent_id,action_id,source,phase,COUNT(*) AS count,
        MIN(observed_at) AS first_at,MAX(observed_at) AS last_at,
        ARRAY_AGG(DISTINCT to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD')) AS days
        FROM one_product_activity_observations WHERE user_id=$1 AND generation=$2
          AND observed_at>=$3 AND observed_at<=$4 AND expires_at>$4
        GROUP BY agent_id,action_id,source,phase ORDER BY agent_id,action_id,source,phase LIMIT 4001""",
        account.accountId,
        epoch["generation"],
        datetime.fromisoformat(account.since.replace("Z", "+00:00")),
        now,
        timeout=10,
    )
    if len(rows) > 4000:
        raise ValueError("Activity projection exceeds pilot bound")
    base["limited"] = bool(
        await conn.fetchval(
            """SELECT EXISTS(SELECT 1 FROM one_product_activity_observations
        WHERE user_id=$1 AND generation=$2 AND observed_at>=$3 AND expires_at>$4
        GROUP BY (observed_at AT TIME ZONE 'UTC')::date HAVING COUNT(*)>=500)""",
            account.accountId,
            epoch["generation"],
            datetime.fromisoformat(account.since.replace("Z", "+00:00")),
            now,
            timeout=5,
        )
    )
    known = {row["id"]: row for row in activity_catalog()["actions"]}
    for row in rows:
        descriptor = known.get(row["action_id"])
        if (
            not descriptor
            or descriptor["agentId"] != row["agent_id"]
            or descriptor["proof"] != row["source"]
        ):
            # A retired/reowned identifier is no longer interpretable under
            # this catalog. Surface partial coverage, never guess its meaning.
            base["limited"] = True
            continue
        base["rollups"].append(
            {
                "agentId": row["agent_id"],
                "actionId": row["action_id"],
                "source": row["source"],
                "phase": row["phase"],
                "count": row["count"],
                "firstAt": row["first_at"].astimezone(timezone.utc).isoformat(),
                "lastAt": row["last_at"].astimezone(timezone.utc).isoformat(),
                "days": sorted(row["days"]),
            }
        )
    return base
