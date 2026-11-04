"""Bounded metadata projection of existing task ledgers for an enrolled pilot.

Domain ledgers prove effects; the separate observation sink proves only collection.
absence never proves inactivity, signup, marketing permission or feed coverage.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from db.connection import get_pool
from hushh_mcp.services.account_deletion_lifecycle_service import AccountDeletionLifecycleService
from hushh_mcp.services.actor_identity_service import ActorIdentityService
from hushh_mcp.services.plg_catalog import activity_catalog, public_activity_catalog
from hushh_mcp.services.plg_outcomes import (
    DEFINITIONS,
    MAIL_SQL,
    MEMORY_SQL,
    confirmed_memory,
    value_effects,
)
from hushh_mcp.services.plg_reporting import current_reporting_identifiers, reporting_policy
from hushh_mcp.services.product_activity import enabled_for


class PilotAccount(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    # Firebase UIDs are opaque strings. Match the permission producer's bound;
    # allow-list/permission checks below still authorize every requested owner.
    accountId: str = Field(min_length=1, max_length=128)
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
    customerReporting: bool = False
    accounts: list[PilotAccount] = Field(min_length=0, max_length=20)


async def _owner_epoch(user_id: str):
    """Read an existing cohort owner's epoch after the canonical lifecycle barrier."""
    if not enabled_for(user_id):
        return None
    pool = await get_pool()
    async with pool.acquire(timeout=5) as conn, conn.transaction():
        active = await AccountDeletionLifecycleService.active_projection_user_ids(
            conn, user_ids=[user_id]
        )
        if user_id not in active:
            return None
        return await conn.fetchrow(
            "SELECT generation,started_at FROM one_product_activity_epochs WHERE user_id=$1",
            user_id,
            timeout=5,
        )


async def owner_scope(
    user_id: str, now: datetime, *, environment: Literal["uat", "production"] = "uat"
) -> dict | None:
    """Own activity is not a marketing subscription or an email-send grant."""
    from api.utils.firebase_auth import current_auth_lane
    from hushh_mcp.services import marketing_preferences

    if environment not in {"uat", "production"} or current_auth_lane() != environment:
        return None
    before = await _owner_epoch(user_id)
    if not before or not before["started_at"]:
        return None
    try:
        recipient = await marketing_preferences.verified_recipient(user_id)
    except marketing_preferences.VerifiedEmailRequired:
        return None
    after = await _owner_epoch(user_id)
    if not after or dict(before) != dict(after):
        return None
    since = max(before["started_at"], now - timedelta(days=7))
    if since > now:
        raise ValueError("Invalid owner scope time")
    return {
        "environment": environment,
        "readAuthority": "verified_owner",
        "accountId": user_id,
        "emailHash": recipient["email_hash"],
        "ownerEpoch": hashlib.sha256(str(before["generation"]).encode()).hexdigest(),
        "since": since.astimezone(timezone.utc).isoformat(),
        "journey": "agent_one",
    }


async def owner_read_authority(
    user_id: str,
    email_hash: str,
    owner_epoch: str,
    *,
    environment: Literal["uat", "production"] = "uat",
) -> dict:
    scope = await owner_scope(user_id, datetime.now(timezone.utc), environment=environment)
    allowed = bool(
        scope and scope["emailHash"] == email_hash and scope["ownerEpoch"] == owner_epoch
    )
    # An absent scope is unavailable; do not infer erasure or inactivity.
    return {"allowed": allowed, "erased": False, "ownerEpoch": owner_epoch if allowed else None}


async def session_owner_scope(
    allowed: set[str],
    email_hash: str,
    now: datetime,
    *,
    environment: Literal["uat", "production"] = "uat",
) -> dict | None:
    """Resolve one verified session within an explicit cohort, never by UID input.

    Identity shadow email is only a candidate selector. The current verified
    identity and lifecycle/epoch checks in owner_scope remain authoritative.
    Ambiguous aliases fail closed rather than selecting another team member.
    """
    if not 1 <= len(allowed) <= 100:
        raise ValueError("Invalid owner cohort")
    pool = await get_pool()
    async with pool.acquire(timeout=5) as conn, conn.transaction():
        active = set()
        ordered = sorted(allowed)
        for start in range(0, len(ordered), 50):
            active.update(
                await AccountDeletionLifecycleService.active_projection_user_ids(
                    conn, user_ids=ordered[start : start + 50]
                )
            )
        rows = await conn.fetch(
            """SELECT user_id,email FROM actor_identity_cache
               WHERE user_id=ANY($1::text[]) AND NULLIF(BTRIM(email),'') IS NOT NULL""",
            sorted(active),
            timeout=5,
        )
    rows = [
        row
        for row in rows
        if row["user_id"] in active
        and hashlib.sha256(row["email"].strip().lower().encode()).hexdigest() == email_hash
    ]
    if len(rows) != 1 or rows[0]["user_id"] not in allowed:
        return None
    scope = await owner_scope(rows[0]["user_id"], now, environment=environment)
    if not scope or scope["emailHash"] != email_hash:
        return None
    return scope


async def snapshot(
    request: PilotRequest,
    allowed: set[str],
    now: datetime,
    *,
    environment: Literal["production", "uat"] = "production",
) -> dict:
    """Fail the entire batch on missing authority, truncation or source failure."""
    if environment not in {"production", "uat"}:
        raise ValueError("Invalid evidence environment")
    if environment == "uat" and (request.version != 2 or request.customerReporting):
        raise ValueError("UAT evidence cannot claim production customer reporting")
    policy = reporting_policy() if request.customerReporting else None
    if not request.accounts:
        if request.version != 2:
            raise ValueError("No accounts requested")
        return {
            "version": 2,
            "environment": environment,
            "retainedOnly": True,
            "asOf": now.astimezone(timezone.utc).isoformat(),
            "accounts": [],
            "catalog": public_activity_catalog(),
            **({"customerReporting": policy.proof()} if policy else {}),
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
    identifiers = (
        await current_reporting_identifiers(a.accountId for a in request.accounts) if policy else {}
    )
    pool = await get_pool()
    result = []
    async with pool.acquire(timeout=5) as conn, conn.transaction(isolation="read_committed"):
        await conn.execute("SET LOCAL statement_timeout='5s'")
        await conn.execute("SET LOCAL lock_timeout='1s'")
        active = await AccountDeletionLifecycleService.active_projection_user_ids(
            conn, user_ids=[a.accountId for a in request.accounts]
        )
        identities = await ActorIdentityService().get_many(active, conn=conn) if policy else {}
        aliases = (
            await ActorIdentityService().get_many_verified_email_aliases(active, conn=conn)
            if policy
            else {}
        )
        for account in request.accounts:
            # Hold the same canonical read barriers as the private audience view.
            deleted = account.accountId not in active
            reporting_eligible = not deleted and (
                policy is None
                or (
                    account.accountId in identifiers
                    and policy.eligible(
                        account.accountId,
                        identities.get(account.accountId),
                        (*identifiers[account.accountId], *aliases.get(account.accountId, [])),
                    )
                )
            )
            tasks = []
            activity = None
            verified = []
            if reporting_eligible:
                if request.version == 1:
                    if account.journey not in {"memory", "mail"}:
                        raise ValueError("Agent activity requires version 2")
                    query = MEMORY_SQL if account.journey == "memory" else MAIL_SQL
                    rows = await conn.fetch(
                        query,
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
                if request.version == 2:
                    outcome_cache: dict = {}
                    for agent_id, (proof, _label) in DEFINITIONS.items():
                        effects, limited = await value_effects(
                            conn,
                            account.accountId,
                            agent_id,
                            datetime.fromisoformat(account.since.replace("Z", "+00:00")),
                            now,
                            outcome_cache,
                        )
                        if limited:
                            raise ValueError("pilot outcome result limit exceeded")
                        times = sorted(at.isoformat() for at in effects.values())
                        if times:
                            verified.append(
                                {
                                    "agentId": agent_id,
                                    "proof": proof,
                                    "count": len(times),
                                    "firstAt": times[0],
                                    "lastAt": times[-1],
                                    "days": sorted({at[:10] for at in times}),
                                }
                            )
                    activity = await activity_snapshot(conn, account, now)
            entry = {**account.model_dump(), "deleted": deleted, "tasks": tasks}
            if policy:
                entry["reportingEligible"] = reporting_eligible
            if request.version == 2:
                entry.update({"activity": activity, "verified": verified})
            result.append(entry)
    response: dict[str, Any] = {
        "version": request.version,
        "environment": environment,
        "retainedOnly": True,
        "asOf": now.astimezone(timezone.utc).isoformat(),
        "accounts": result,
        **({"customerReporting": policy.proof()} if policy else {}),
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
