"""Source-owned, aggregate-only retained One activity and confirmed outcomes.

No owner export, warehouse, content read, account mutation or sending authority.
The existing domain adapters retain effect validation and deduplication ownership.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.services import plg_outcomes, plg_reporting
from hushh_mcp.services.account_deletion_lifecycle_service import AccountDeletionLifecycleService
from hushh_mcp.services.actor_identity_service import ActorIdentityService


class AggregateUnavailable(RuntimeError):
    """No complete, currently authorized result within the existing source bounds."""


class Period(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    startDate: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    endDate: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    timezone: str = Field(min_length=1, max_length=64)


class AdoptionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    period: Period
    definitionVersion: str = Field(pattern=r"^1$")
    sourceGeneration: str = Field(pattern=r"^[a-f0-9]{64}$")
    scopeDigest: str = Field(pattern=r"^[a-f0-9]{64}$")


def approved_binding() -> dict:
    """No activation defaults, borrowed PLG signing key or implicit source policy."""
    try:
        raw = os.environ.get("ONE_METRICS_ADOPTION_BINDING_JSON", "")
        if not raw or len(raw) > 4000:
            raise ValueError
        row = json.loads(raw)
        if (
            not isinstance(row, dict)
            or set(row)
            != {
                "approved",
                "definitionVersion",
                "sourceGeneration",
                "scopeDigest",
                "populationPolicyRevision",
                "reconciliationDigest",
                "coverageFrom",
            }
            or row["approved"] is not True
            or row["definitionVersion"] != "1"
        ):
            raise ValueError
        for field in (
            "sourceGeneration",
            "scopeDigest",
            "populationPolicyRevision",
            "reconciliationDigest",
        ):
            if not isinstance(row[field], str) or not re.fullmatch(r"[a-f0-9]{64}", row[field]):
                raise ValueError
        if date.fromisoformat(row["coverageFrom"]).isoformat() != row["coverageFrom"]:
            raise ValueError
        return row
    except (ValueError, TypeError, KeyError):
        raise AggregateUnavailable("Metrics aggregate unavailable") from None


def period_bounds(request: AdoptionRequest, binding: dict, now: datetime):
    start, end = (
        date.fromisoformat(request.period.startDate),
        date.fromisoformat(request.period.endDate),
    )
    try:
        zone = ZoneInfo(request.period.timezone)
        first = datetime.combine(start, time.min, zone).astimezone(timezone.utc)
        exclusive = datetime.combine(end + timedelta(days=1), time.min, zone).astimezone(
            timezone.utc
        )
    except (ZoneInfoNotFoundError, OverflowError):
        raise ValueError("Unsupported aggregate timezone or period") from None
    if (
        start > end
        or (end - start).days >= 7
        or start.isoformat() < binding["coverageFrom"]
        or end >= now.astimezone(zone).date()
        or first < now - timedelta(days=7)
        or any(
            getattr(request, key) != binding[key]
            for key in ("definitionVersion", "sourceGeneration", "scopeDigest")
        )
    ):
        raise ValueError("Unsupported aggregate period or generation")
    # Existing effect adapters use inclusive bounds. Preserve the half-open day
    # contract at the boundary, including 23/25-hour source days.
    return first, exclusive - timedelta(microseconds=1)


# Overinclusive candidates are safe: proof/eligibility is applied before counts.
# LIMIT 51 is an overflow sentinel, never a truncated global measurement. Fifty
# is the existing lifecycle/identity contract, not a new production capacity.
CANDIDATES_SQL = """
WITH candidates AS (
 SELECT user_id FROM agent_chat_messages WHERE completed_at >= $1 AND completed_at <= $2
 UNION SELECT user_id FROM pkm_domain_commits WHERE created_at >= $1 AND created_at <= $2
 UNION SELECT user_id FROM gmail_owner_send_actions WHERE sent_at >= $1 AND sent_at <= $2
 UNION SELECT user_id FROM one_product_value_receipts WHERE occurred_at >= $1 AND occurred_at <= $2
 UNION SELECT user_id FROM one_action_directive_ledger WHERE settled_at >= $1 AND settled_at <= $2
 UNION SELECT user_id FROM connected_system_audit_events WHERE created_at >= $1 AND created_at <= $2
 UNION SELECT user_id FROM drive_share_permission_operations WHERE settled_at >= $1 AND settled_at <= $2
)
SELECT user_id FROM candidates ORDER BY user_id LIMIT 51
"""
MEANINGFUL_REPLIES_SQL = """
SELECT DISTINCT a.user_id FROM agent_chat_messages a
WHERE a.user_id=ANY($1::text[]) AND a.role='assistant' AND a.status='complete'
 AND a.error_code IS NULL AND a.completed_at >= $2 AND a.completed_at <= $3
 AND EXISTS(SELECT 1 FROM agent_chat_messages u WHERE u.user_id=a.user_id
   AND u.conversation_id=a.conversation_id AND u.role='user' AND u.status='complete'
   AND u.created_at <= a.created_at)
"""
SOURCE_TABLES = (
    "actor_identity_cache",
    "actor_verified_email_aliases",
    "account_deletion_tombstones",
    "agent_chat_messages",
    "pkm_domain_commits",
    "pkm_events",
    "gmail_owner_send_actions",
    "gmail_personal_information_requests",
    "one_product_value_receipts",
    "one_product_activity_epochs",
    "one_action_directive_ledger",
    "connected_system_intents",
    "connected_system_audit_events",
    "drive_share_permission_operations",
    "drive_share_reviews",
    "wallet_card_registrations",
)


async def _assert_global_read(conn):
    # A filtered RLS result must never masquerade as an empty global population.
    # This checks the existing role; it changes no policy, privilege or setting.
    restricted = await conn.fetchval(
        "SELECT bool_or(row_security_active(t::regclass)) FROM unnest($1::text[]) names(t)",
        [f"public.{name}" for name in SOURCE_TABLES],
        timeout=5,
    )
    if restricted is not False:
        raise AggregateUnavailable("Metrics source authority unavailable")


async def _candidates(conn, since, through):
    rows = await conn.fetch(CANDIDATES_SQL, since, through, timeout=5)
    ids = [row["user_id"] for row in rows]
    if (
        len(ids) > 50
        or len(set(ids)) != len(ids)
        or any(not isinstance(uid, str) or not 1 <= len(uid) <= 128 for uid in ids)
    ):
        raise AggregateUnavailable("Metrics source bound exceeded")
    return ids


async def _identity(ids, conn):
    if not ids:
        return {}, {}, {}
    records = await plg_reporting.current_reporting_records(ids)
    identity = ActorIdentityService()
    canonical = await identity.get_many(ids, conn=conn)
    aliases = await identity.get_many_verified_email_aliases(ids, conn=conn)
    return records, canonical, aliases


def _eligible(ids, active, identity, policy):
    records, canonical, aliases = identity
    return [
        uid
        for uid in ids
        if uid in active
        and uid in records
        and policy.eligible(
            uid, canonical.get(uid), (*records[uid]["emails"], *aliases.get(uid, []))
        )
    ]


async def adoption_aggregate(request: AdoptionRequest, binding: dict, *, pool=None, now=None):
    now = now or datetime.now(timezone.utc)
    since, through = period_bounds(request, binding, now)
    policy = plg_reporting.reporting_policy()
    if policy.revision != binding["populationPolicyRevision"]:
        raise AggregateUnavailable("Metrics population changed")
    if pool is None:
        from db.connection import get_pool

        pool = await get_pool()
    # Keep canonical READ COMMITTED deletion/identity barriers in the first
    # connection. A second, read-only REPEATABLE READ transaction provides one
    # business-record snapshot across the existing domain adapters. Never change
    # the isolation of the canonical lifecycle helper or hold a process cache.
    async with pool.acquire(timeout=3) as guard, guard.transaction(isolation="read_committed"):
        await guard.execute("SET LOCAL statement_timeout='5s'")
        await guard.execute("SET LOCAL lock_timeout='1s'")
        await _assert_global_read(guard)
        ids = await _candidates(guard, since, through)
        active = (
            await AccountDeletionLifecycleService.active_projection_user_ids(guard, user_ids=ids)
            if ids
            else set()
        )
        before = await _identity(ids, guard)
        eligible = _eligible(ids, active, before, policy)
        async with (
            pool.acquire(timeout=3) as data,
            data.transaction(isolation="repeatable_read", readonly=True),
        ):
            await data.execute("SET LOCAL statement_timeout='5s'")
            await _assert_global_read(data)
            watermark = await data.fetchval("SELECT transaction_timestamp()", timeout=5)
            if await _candidates(data, since, through) != ids:
                raise AggregateUnavailable("Metrics population changed")
            replies = (
                await data.fetch(MEANINGFUL_REPLIES_SQL, eligible, since, through, timeout=5)
                if eligible
                else []
            )
            users = {row["user_id"] for row in replies}
            if not users <= set(eligible):
                raise AggregateUnavailable("Invalid aggregate source")
            outcomes = 0
            for offset in range(0, len(eligible), 25):
                owners = eligible[offset : offset + 25]
                summaries = await plg_outcomes.value_summaries(
                    data, owners, "agent_one", since, through
                )
                if set(summaries) != set(owners):
                    raise AggregateUnavailable("Incomplete aggregate source")
                for uid, summary in summaries.items():
                    count = summary.get("count")
                    if (
                        summary.get("supported") is not True
                        or summary.get("limited") is not False
                        or type(count) is not int
                        or count < 0
                    ):
                        raise AggregateUnavailable("Incomplete aggregate source")
                    outcomes += count
                    if count:
                        users.add(uid)
        after = await _identity(ids, guard)
        if (
            after != before
            or plg_reporting.reporting_policy().revision != policy.revision
            or approved_binding() != binding
        ):
            raise AggregateUnavailable("Metrics authority changed")
        checked = datetime.now(timezone.utc)
        if not isinstance(watermark, datetime) or watermark.tzinfo is None or watermark > checked:
            raise AggregateUnavailable("Invalid source watermark")
        # These are exact counts of retained positive records, not proof of full
        # emitter/history coverage. Missing observations never establish inactivity.
        return {
            "metrics": {
                "activeAccounts": {
                    "value": len(users),
                    "coverage": "partial",
                    "unit": "account",
                    "basis": "exact",
                },
                "confirmedOutcomes": {
                    "value": outcomes,
                    "coverage": "partial",
                    "unit": "outcome",
                    "basis": "exact",
                },
            },
            "sourceCheckedAt": int(checked.timestamp() * 1000),
            "sourceWatermark": int(watermark.timestamp() * 1000),
            "sourceGeneration": request.sourceGeneration,
            "scopeDigest": request.scopeDigest,
            "definitionVersion": request.definitionVersion,
            "period": request.period.model_dump(),
            "reconciled": True,
        }


async def bounded_adoption_aggregate(request, binding):
    return await asyncio.wait_for(adoption_aggregate(request, binding), timeout=20)
