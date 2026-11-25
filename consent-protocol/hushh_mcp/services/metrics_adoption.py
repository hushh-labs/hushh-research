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

from hushh_mcp.services import metrics_uat_authority, plg_outcomes, plg_reporting
from hushh_mcp.services.account_deletion_lifecycle_service import AccountDeletionLifecycleService
from hushh_mcp.services.account_generation_service import EXACT_OWNER_IDENTITIES_SQL
from hushh_mcp.services.actor_identity_service import ActorIdentityService
from hushh_mcp.services.metrics_adoption_sql import (
    CANDIDATES_SQL,
    MEANINGFUL_REPLIES_SQL,
    SOURCE_TABLES,
)

_production_aggregate_lock = asyncio.Lock()


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


def approved_binding(environment: str = "production") -> dict:
    """No activation defaults, borrowed PLG signing key or implicit source policy."""
    try:
        if environment not in {"production", "uat"}:
            raise ValueError
        name = (
            "ONE_METRICS_UAT_ADOPTION_BINDING_JSON"
            if environment == "uat"
            else "ONE_METRICS_ADOPTION_BINDING_JSON"
        )
        raw = os.environ.get(name, "")
        if not raw or len(raw) > 4000:
            raise ValueError
        row = json.loads(raw)
        required = {
            "approved",
            "definitionVersion",
            "sourceGeneration",
            "scopeDigest",
            "populationPolicyRevision",
            "reconciliationDigest",
            "coverageFrom",
        }
        if environment == "uat":
            required |= {"databaseName", "databaseUser"}
        optional = {"provisionalUtcDay"} if environment == "uat" else set()
        if (
            not isinstance(row, dict)
            or not required <= row.keys() <= required | optional
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
        if "provisionalUtcDay" in row:
            day = row["provisionalUtcDay"]
            if date.fromisoformat(day).isoformat() != day or day < row["coverageFrom"]:
                raise ValueError
        if environment == "uat" and (
            not isinstance(row["databaseName"], str)
            or not re.fullmatch(r"[A-Za-z0-9_]{1,63}", row["databaseName"])
        ):
            raise ValueError
        if environment == "uat" and (
            not isinstance(row["databaseUser"], str)
            or not re.fullmatch(r"[A-Za-z0-9_.@-]{1,128}", row["databaseUser"])
        ):
            raise ValueError
        return row
    except (ValueError, TypeError, KeyError):
        raise AggregateUnavailable("Metrics aggregate unavailable") from None


def period_bounds(
    request: AdoptionRequest, binding: dict, now: datetime, *, environment="production"
):
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
    local_day = now.astimezone(zone).date()
    provisional = (
        environment == "uat"
        and request.period.timezone == "UTC"
        and start == end == local_day
        and binding.get("provisionalUtcDay") == end.isoformat()
    )
    if (
        environment not in {"production", "uat"}
        or start > end
        or (end - start).days >= 7
        or start.isoformat() < binding["coverageFrom"]
        or (end >= local_day and not provisional)
        or (environment == "uat" and first < now - timedelta(days=7))
        or (environment == "production" and start < local_day - timedelta(days=7))
        or any(
            getattr(request, key) != binding[key]
            for key in ("definitionVersion", "sourceGeneration", "scopeDigest")
        )
    ):
        raise ValueError("Unsupported aggregate period or generation")
    # Existing effect adapters use inclusive bounds. Preserve the half-open day
    # contract at the boundary, including 23/25-hour source days.
    return first, now if provisional else exclusive - timedelta(microseconds=1)


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


async def _owner_identities(ids, conn):
    # NULL means the table is genuinely absent on a pre-generation installation.
    # Active row security could hide a retired row and manufacture a legacy match.
    restricted = await conn.fetchval(
        "SELECT row_security_active(to_regclass('public.account_generations'))", timeout=5
    )
    if restricted is None:
        if os.getenv("ACCOUNT_GENERATION_ADMISSION_ENABLED", "").strip().lower() == "true" or any(
            re.fullmatch(r"acct_[0-9a-f]{32}", owner) for owner in ids
        ):
            raise AggregateUnavailable("Metrics generation authority unavailable")
        return {owner: owner for owner in ids}
    if restricted is not False:
        raise AggregateUnavailable("Metrics generation authority unavailable")
    rows = await conn.fetch(EXACT_OWNER_IDENTITIES_SQL, ids, timeout=5)
    identities = {row["owner"]: row["identity_uid"] for row in rows}
    if (
        len(identities) != len(rows)
        or not identities.keys() <= set(ids)
        or len(set(identities.values())) != len(identities)
    ):
        raise AggregateUnavailable("Ambiguous Metrics owner identity")
    return identities


async def _identity(ids, conn, environment="production"):
    if not ids:
        return {}, {}, {}
    identities = await _owner_identities(ids, conn)
    firebase_uids = list(identities.values())
    firebase_records = await (
        metrics_uat_authority.current_records(firebase_uids)
        if environment == "uat"
        else plg_reporting.current_reporting_records(firebase_uids)
    )
    records = {
        owner: {**firebase_records[uid], "firebase_uid": uid}
        for owner, uid in identities.items()
        if uid in firebase_records
    }
    identity = ActorIdentityService()
    owners = list(records)
    canonical = await identity.get_many(owners, conn=conn)
    aliases = await identity.get_many_verified_email_aliases(owners, conn=conn)
    return records, canonical, aliases


def _identity_authority(environment="production"):
    # Empty candidates skip per-owner lookups. They must not skip validation of
    # the actual auth source and turn a foreign/missing source into a valid zero.
    try:
        return (
            metrics_uat_authority.auth_app()
            if environment == "uat"
            else plg_reporting.reporting_auth_app()
        )
    except Exception:
        raise AggregateUnavailable("Metrics source authority unavailable") from None


def _eligible(ids, active, identity, policy):
    records, canonical, aliases = identity
    return [
        owner
        for owner in ids
        if owner in active
        and owner in records
        and owner not in policy.account_ids
        and policy.eligible(
            records[owner]["firebase_uid"],
            canonical.get(owner),
            (*records[owner]["emails"], *aliases.get(owner, [])),
        )
    ]


async def adoption_aggregate(
    request: AdoptionRequest, binding: dict, *, pool=None, now=None, environment="production"
):
    if environment not in {"production", "uat"}:
        raise AggregateUnavailable("Metrics source authority unavailable")
    if environment == "uat":
        metrics_uat_authority.runtime_authority(binding)
    now = now or datetime.now(timezone.utc)
    since, through = period_bounds(request, binding, now, environment=environment)
    provisional = through == now
    auth_app = _identity_authority(environment) if environment == "uat" else _identity_authority()
    policy = (
        metrics_uat_authority.policy() if environment == "uat" else plg_reporting.reporting_policy()
    )
    if policy.revision != binding["populationPolicyRevision"]:
        raise AggregateUnavailable("Metrics population changed")
    if pool is None and environment == "uat":
        raise AggregateUnavailable("UAT Metrics pool unavailable")
    if pool is None:
        from db.connection import get_pool

        pool = await get_pool()
    # Keep canonical READ COMMITTED deletion/identity barriers in the first
    # connection. A second, read-only REPEATABLE READ transaction provides one
    # business-record snapshot across the existing domain adapters. Never change
    # the isolation of the canonical lifecycle helper or hold a process cache.
    async with pool.acquire(timeout=3) as guard, guard.transaction(isolation="read_committed"):
        if environment == "uat":
            await metrics_uat_authority.verify_database(guard, binding)
        await guard.execute("SET LOCAL statement_timeout='5s'")
        await guard.execute("SET LOCAL lock_timeout='1s'")
        await _assert_global_read(guard)
        ids = await _candidates(guard, since, through)
        active = (
            await AccountDeletionLifecycleService.active_projection_user_ids(guard, user_ids=ids)
            if ids
            else set()
        )
        before = (
            await _identity(ids, guard, environment)
            if environment == "uat"
            else await _identity(ids, guard)
        )
        eligible = _eligible(ids, active, before, policy)
        async with (
            pool.acquire(timeout=3) as data,
            data.transaction(isolation="repeatable_read", readonly=True),
        ):
            if environment == "uat":
                await metrics_uat_authority.verify_database(data, binding)
            await data.execute("SET LOCAL statement_timeout='5s'")
            await _assert_global_read(data)
            watermark = await data.fetchval("SELECT transaction_timestamp()", timeout=5)
            if provisional and (
                not isinstance(watermark, datetime)
                or watermark.tzinfo is None
                or watermark < through
            ):
                raise AggregateUnavailable("Metrics snapshot precedes provisional cutoff")
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
        after = (
            await _identity(ids, guard, environment)
            if environment == "uat"
            else await _identity(ids, guard)
        )
        if environment == "uat":
            metrics_uat_authority.runtime_authority(binding)
        current_auth = (
            _identity_authority(environment) if environment == "uat" else _identity_authority()
        )
        current_policy = (
            metrics_uat_authority.policy()
            if environment == "uat"
            else plg_reporting.reporting_policy()
        )
        current_binding = (
            approved_binding(environment) if environment == "uat" else approved_binding()
        )
        if (
            after != before
            or current_auth is not auth_app
            or current_policy.revision != policy.revision
            or current_binding != binding
        ):
            raise AggregateUnavailable("Metrics authority changed")
        checked = datetime.now(timezone.utc)
        if not isinstance(watermark, datetime) or watermark.tzinfo is None or watermark > checked:
            raise AggregateUnavailable("Invalid source watermark")
        # Same-day counts cover the admitted cutoff. Later writes belong to a
        # subsequent publication, even if they were committed during the read.
        coverage = "provisional" if provisional else "partial"
        source_through = through if provisional else watermark
        return {
            "metrics": {
                "activeAccounts": {
                    "value": len(users),
                    "coverage": coverage,
                    "unit": "account",
                    "basis": "exact",
                },
                "confirmedOutcomes": {
                    "value": outcomes,
                    "coverage": coverage,
                    "unit": "outcome",
                    "basis": "exact",
                },
            },
            "sourceCheckedAt": int(checked.timestamp() * 1000),
            "sourceWatermark": int(source_through.timestamp() * 1000),
            "sourceGeneration": request.sourceGeneration,
            "scopeDigest": request.scopeDigest,
            "definitionVersion": request.definitionVersion,
            "period": request.period.model_dump(),
            "reconciled": True,
        }


async def bounded_adoption_aggregate(request, binding, *, environment="production"):
    async def run():
        if environment == "uat":
            async with metrics_uat_authority.dedicated_pool(binding) as pool:
                return await adoption_aggregate(request, binding, pool=pool, environment="uat")
        if environment == "production":
            # Admit one aggregate per worker before either pool acquisition.
            # Overlapping reads can otherwise hold every guard connection while
            # waiting for the second connection. The deadline includes admission.
            async with _production_aggregate_lock:
                return await adoption_aggregate(request, binding, environment="production")
        return await adoption_aggregate(request, binding, environment=environment)

    return await asyncio.wait_for(run(), timeout=20)
