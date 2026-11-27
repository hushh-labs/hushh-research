"""Opt-in all-account retained feature observations, never business-effect proof."""

from __future__ import annotations

import asyncio
import json
import os
import re
from datetime import date, datetime, time, timedelta, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.services import metrics_adoption as native
from hushh_mcp.services import metrics_uat_authority, plg_outcomes, plg_reporting, product_activity
from hushh_mcp.services.metrics_adoption_sql import (
    FEATURE_CANDIDATES_SQL,
    FEATURE_OBSERVATIONS_SQL,
    FEATURE_OBSERVATIONS_WITH_RESULTS_SQL,
    FEATURE_RESULT_COLUMN_SQL,
    MAX_ADOPTION_CANDIDATES,
)
from hushh_mcp.services.plg_catalog import activity_catalog

MAX_OBSERVATIONS = 100_000
MAX_FEATURES = 256
MAX_AGENTS = 128
MAX_CATALOG_ACTIONS = 4096
MAX_RESPONSE_BYTES = 262_144
PHASES = ("started", "returned", "failed", "cancelled", "blocked")
RESULTS = ("success", "error", "expected_error", "unclassified")
ATTEMPTS = (*PHASES, "possibleIncomplete", "inProgress")


class FeatureObservationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    reportKind: Literal["feature_observations"]
    definitionVersion: Literal["1"]
    period: native.Period
    cutoffAt: int = Field(gt=0, le=253402300799999)
    sourceGeneration: str = Field(pattern=r"^[a-f0-9]{64}$")
    scopeDigest: str = Field(pattern=r"^[a-f0-9]{64}$")


def approved_binding(environment="production"):
    """Separate approval cannot change or borrow the native v1/v2 binding."""
    if environment not in {"production", "uat"}:
        raise native.AggregateUnavailable("Metrics source authority unavailable")
    name = (
        "ONE_METRICS_UAT_FEATURE_OBSERVATIONS_BINDING_JSON"
        if environment == "uat"
        else "ONE_METRICS_FEATURE_OBSERVATIONS_BINDING_JSON"
    )
    try:
        raw = os.environ.get(name, "")
        if not raw or len(raw) > 4000:
            raise ValueError
        row = json.loads(raw)
        keys = {
            "approved",
            "reportKind",
            "definitionVersion",
            "sourceGeneration",
            "scopeDigest",
            "populationPolicyRevision",
            "reconciliationDigest",
            "coverageFrom",
        }
        if environment == "uat":
            keys |= {"databaseName", "databaseUser"}
        if (
            not isinstance(row, dict)
            or set(row) != keys
            or row["approved"] is not True
            or row["reportKind"] != "feature_observations"
            or row["definitionVersion"] != "1"
        ):
            raise ValueError
        for key in (
            "sourceGeneration",
            "scopeDigest",
            "populationPolicyRevision",
            "reconciliationDigest",
        ):
            if not isinstance(row[key], str) or not re.fullmatch(r"[a-f0-9]{64}", row[key]):
                raise ValueError
        if date.fromisoformat(row["coverageFrom"]).isoformat() != row["coverageFrom"]:
            raise ValueError
        if environment == "uat" and (
            not isinstance(row["databaseName"], str)
            or not re.fullmatch(r"[A-Za-z0-9_]{1,63}", row["databaseName"])
            or not isinstance(row["databaseUser"], str)
            or not re.fullmatch(r"[A-Za-z0-9_.@-]{1,128}", row["databaseUser"])
        ):
            raise ValueError
        return row
    except (ValueError, TypeError, KeyError):
        raise native.AggregateUnavailable("Metrics aggregate unavailable") from None


def period_bounds(request, binding, now):
    start, end = (
        date.fromisoformat(request.period.startDate),
        date.fromisoformat(request.period.endDate),
    )
    today = now.astimezone(timezone.utc).date()
    if (
        request.period.timezone != "UTC"
        or (end - start).days + 1 not in {7, 14, 30, 90}
        or start < today - timedelta(days=90)
        or end > today
    ):
        raise ValueError("Unsupported feature observation period or cutoff")
    first = datetime.combine(start, time.min, timezone.utc)
    exclusive = datetime.combine(end + timedelta(days=1), time.min, timezone.utc)
    cutoff = datetime.fromtimestamp(request.cutoffAt / 1000, timezone.utc)
    if (
        request.period.timezone != "UTC"
        or (end - start).days + 1 not in {7, 14, 30, 90}
        or start < today - timedelta(days=90)
        or end > today
        or cutoff < first
        or cutoff > now
        or (end == today and (cutoff.date() != today or now - cutoff > timedelta(seconds=60)))
        or (end < today and cutoff != exclusive)
        or request.scopeDigest != binding["scopeDigest"]
        or request.sourceGeneration != binding["sourceGeneration"]
    ):
        raise ValueError("Unsupported feature observation period or cutoff")
    coverage_from = datetime.combine(
        date.fromisoformat(binding["coverageFrom"]), time.min, timezone.utc
    )
    return first, cutoff, min(cutoff, max(first, now - timedelta(days=7), coverage_from))


async def _global_read(conn):
    await native._assert_global_read(conn)
    restricted = await conn.fetchval(
        "SELECT row_security_active('public.one_product_activity_observations'::regclass)",
        timeout=5,
    )
    if restricted is not False:
        raise native.AggregateUnavailable("Metrics source authority unavailable")


async def _candidates(conn, since, through, now):
    rows = await conn.fetch(
        FEATURE_CANDIDATES_SQL, since, through - timedelta(microseconds=1), now, timeout=5
    )
    ids = [row["user_id"] for row in rows]
    if (
        any(row["observation_overflow"] is not False for row in rows)
        or len(ids) > MAX_ADOPTION_CANDIDATES
        or len(set(ids)) != len(ids)
        or any(not isinstance(uid, str) or not 1 <= len(uid) <= 128 for uid in ids)
    ):
        raise native.AggregateUnavailable("Metrics source bound exceeded")
    return ids


def _count(value):
    if type(value) is not int or not 0 <= value <= 100_000_000:
        raise native.AggregateUnavailable("Invalid feature aggregate")
    return value


def _groups(groups, keys, users):
    """The same distinct-account bound applies to phase and explicit-result cells."""
    if not isinstance(groups, dict) or not set(groups) <= set(keys):
        raise native.AggregateUnavailable("Invalid measurement groups")
    result = {}
    for key in keys:
        value = groups.get(key, {"accounts": 0, "observations": 0})
        if not isinstance(value, dict) or set(value) != {"accounts", "observations"}:
            raise native.AggregateUnavailable("Invalid measurement group")
        accounts, observations = _count(value["accounts"]), _count(value["observations"])
        if accounts > users or accounts > observations or (accounts == 0) != (observations == 0):
            raise native.AggregateUnavailable("Invalid distinct measurement accounts")
        result[key] = {"accounts": accounts, "observations": observations}
    return result


def _observations(raw, descriptors, eligible):
    if isinstance(raw, str):
        raw = json.loads(raw)
    if not isinstance(raw, dict) or set(raw) != {
        "sourceRows",
        "unmappedObservations",
        "dailyCappedAccounts",
        "observedAccounts",
        "observations",
        "correlatedAttempts",
        "features",
        "byAgent",
    }:
        raise native.AggregateUnavailable("Invalid feature aggregate")
    values = {key: _count(raw[key]) for key in raw if key not in {"features", "byAgent"}}
    rows = raw["features"]
    if (
        values["sourceRows"] > MAX_OBSERVATIONS
        or not isinstance(rows, list)
        or len(rows) > MAX_FEATURES
        or values["observedAccounts"] > len(eligible)
        or values["dailyCappedAccounts"] > len(eligible)
        or values["observations"] + values["unmappedObservations"] != values["sourceRows"]
    ):
        raise native.AggregateUnavailable("Metrics source bound exceeded")
    features, seen = [], set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != {
            "action_id",
            "all_source_accounts",
            "agent_id",
            "source",
            "accounts",
            "observations",
            "uncorrelated",
            "phases",
            "results",
            "correlated",
            "attempts",
        }:
            raise native.AggregateUnavailable("Invalid feature aggregate")
        descriptor = descriptors.get(row["action_id"])
        if (
            not descriptor
            or descriptor["agentId"] != row["agent_id"]
            or descriptor["proof"] != row["source"]
            or row["action_id"] in seen
            or not isinstance(row["phases"], dict)
            or not set(row["phases"]) <= set(PHASES)
            or not isinstance(row["results"], dict)
            or not set(row["results"]) <= set(RESULTS)
            or not isinstance(row["attempts"], dict)
            or set(row["attempts"]) not in (set(), set(ATTEMPTS))
        ):
            raise native.AggregateUnavailable("Invalid reviewed feature aggregate")
        seen.add(row["action_id"])
        users, count = _count(row["accounts"]), _count(row["observations"])
        all_source = _count(row["all_source_accounts"])
        uncorrelated, correlated = _count(row["uncorrelated"]), _count(row["correlated"])
        phases = _groups(row["phases"], PHASES, users)
        results = _groups(row["results"], RESULTS, users)
        attempts = {key: _count(row["attempts"].get(key, 0)) for key in ATTEMPTS}
        if (
            not 0 < users <= all_source <= values["observedAccounts"]
            or users > count
            or count > MAX_OBSERVATIONS
            or users > sum(v["accounts"] for v in phases.values())
            or sum(v["observations"] for v in phases.values()) != count
            or sum(v["observations"] for v in results.values()) != count
            or users > sum(v["accounts"] for v in results.values())
            or uncorrelated > count
            or correlated > count - uncorrelated
            or any(v > correlated for v in attempts.values())
            or sum(attempts[key] for key in ATTEMPTS if key != "started") != correlated
        ):
            raise native.AggregateUnavailable("Invalid feature reconciliation")
        features.append(
            {
                "actionId": row["action_id"],
                "agentId": row["agent_id"],
                "source": row["source"],
                "label": descriptor["label"][:160],
                "kind": descriptor["kind"],
                "observedAccounts": users,
                "allSourceObservedAccounts": all_source,
                "observations": count,
                "phases": phases,
                "results": results,
                "attempts": attempts,
                "uncorrelatedObservations": uncorrelated,
            }
        )
    if (
        sum(row["observations"] for row in features) != values["observations"]
        or sum(_count(row["correlated"]) for row in rows) != values["correlatedAttempts"]
        or values["observedAccounts"] > sum(row["observedAccounts"] for row in features)
        or (not features and values["observedAccounts"] != 0)
    ):
        raise native.AggregateUnavailable("Invalid feature total reconciliation")
    by_agent = raw["byAgent"]
    agent_ids = {row["agentId"] for row in descriptors.values()}
    if (
        not isinstance(by_agent, dict)
        or len(by_agent) > MAX_AGENTS
        or not set(by_agent) <= agent_ids
    ):
        raise native.AggregateUnavailable("Invalid reviewed agent aggregate")
    for agent_id, value in by_agent.items():
        if not isinstance(value, dict) or set(value) != {
            "observedAccounts",
            "observations",
            "correlatedAttempts",
        }:
            raise native.AggregateUnavailable("Invalid agent aggregate")
        users, count, attempts = (
            _count(value[key]) for key in ("observedAccounts", "observations", "correlatedAttempts")
        )
        agent_features = [row for row in features if row["agentId"] == agent_id]
        if (
            not agent_features
            or not 0 < users <= min(count, values["observedAccounts"])
            or users < max(row["observedAccounts"] for row in agent_features)
            or users > sum(row["observedAccounts"] for row in agent_features)
            or count != sum(row["observations"] for row in agent_features)
            or attempts != sum(row["correlated"] for row in rows if row["agent_id"] == agent_id)
        ):
            raise native.AggregateUnavailable("Invalid distinct agent accounts")
    if (
        sum(v["observations"] for v in by_agent.values()) != values["observations"]
        or sum(v["correlatedAttempts"] for v in by_agent.values()) != values["correlatedAttempts"]
        or values["observedAccounts"] > sum(v["observedAccounts"] for v in by_agent.values())
    ):
        raise native.AggregateUnavailable("Invalid agent reconciliation")
    return features, values, by_agent


async def _confirmed(conn, eligible, since, through):
    counts = {key: 0 for key in plg_outcomes.SUBAGENT_OUTCOME_IDS}
    users = {key: set() for key in counts}
    all_users = set()
    total = 0
    for offset in range(0, len(eligible), 25):
        batch = eligible[offset : offset + 25]
        summaries = await plg_outcomes.value_summaries_with_subagents(conn, batch, since, through)
        if set(summaries) != set(batch):
            raise native.AggregateUnavailable("Incomplete confirmed source")
        for owner, summary in summaries.items():
            sub = summary.get("bySubagent")
            if (
                summary.get("supported") is not True
                or summary.get("limited") is not False
                or not isinstance(sub, dict)
                or set(sub) != set(counts)
            ):
                raise native.AggregateUnavailable("Incomplete confirmed source")
            owner_total = _count(summary.get("count"))
            total += owner_total
            if owner_total:
                all_users.add(owner)
            for agent, value in sub.items():
                if value.get("supported") is not True or value.get("limited") is not False:
                    raise native.AggregateUnavailable("Incomplete confirmed source")
                count = _count(value.get("count"))
                counts[agent] += count
                if count:
                    users[agent].add(owner)
    return {
        "coverage": "partial",
        "outcomeAccounts": len(all_users),
        "confirmedOutcomes": total,
        "bySubagent": {
            key: {"outcomeAccounts": len(users[key]), "confirmedOutcomes": count}
            for key, count in counts.items()
        },
    }


async def aggregate(request, binding, *, pool=None, now=None, environment="production"):
    if environment not in {"production", "uat"}:
        raise native.AggregateUnavailable("Metrics source authority unavailable")
    if environment == "uat":
        metrics_uat_authority.runtime_authority(binding)
    now = now or datetime.now(timezone.utc)
    since, through, retained_from = period_bounds(request, binding, now)
    authority = native._identity_authority(environment)
    policy = (
        metrics_uat_authority.policy() if environment == "uat" else plg_reporting.reporting_policy()
    )
    if policy.revision != binding["populationPolicyRevision"]:
        raise native.AggregateUnavailable("Metrics population changed")
    if pool is None:
        if environment == "uat":
            raise native.AggregateUnavailable("UAT Metrics pool unavailable")
        from db.connection import get_pool

        pool = await get_pool()
    catalog = activity_catalog()
    descriptors = {row["id"]: row for row in catalog["actions"]}
    if len(descriptors) != len(catalog["actions"]) or len(descriptors) > MAX_CATALOG_ACTIONS:
        raise native.AggregateUnavailable("Metrics catalogue bound exceeded")
    reviewed = json.dumps(
        [
            {"action_id": row["id"], "agent_id": row["agentId"], "source": row["proof"]}
            for row in descriptors.values()
        ]
    )
    async with pool.acquire(timeout=3) as guard, guard.transaction(isolation="read_committed"):
        if environment == "uat":
            await metrics_uat_authority.verify_database(guard, binding)
        await guard.execute("SET LOCAL statement_timeout='5s'")
        await guard.execute("SET LOCAL lock_timeout='1s'")
        await _global_read(guard)
        ids = await _candidates(guard, since, through, now)
        active = await native._active_projection_ids(guard, ids) if ids else set()
        before = await native._identity(ids, guard, environment)
        eligible = native._eligible(ids, active, before, policy)
        enabled = [owner for owner in eligible if product_activity.enabled_for(owner)]
        async with (
            pool.acquire(timeout=3) as data,
            data.transaction(isolation="repeatable_read", readonly=True),
        ):
            if environment == "uat":
                await metrics_uat_authority.verify_database(data, binding)
            await data.execute("SET LOCAL statement_timeout='5s'")
            await _global_read(data)
            watermark = await data.fetchval("SELECT transaction_timestamp()", timeout=5)
            if (
                not isinstance(watermark, datetime)
                or watermark.tzinfo is None
                or watermark < through
            ):
                raise native.AggregateUnavailable("Metrics snapshot precedes cutoff")
            if await _candidates(data, since, through, now) != ids:
                raise native.AggregateUnavailable("Metrics population changed")
            result_column = await data.fetchval(FEATURE_RESULT_COLUMN_SQL, timeout=5)
            if result_column not in {None, "text"}:
                raise native.AggregateUnavailable("Metrics result schema unavailable")
            query = (
                FEATURE_OBSERVATIONS_WITH_RESULTS_SQL if result_column else FEATURE_OBSERVATIONS_SQL
            )
            raw = await data.fetchval(
                query, enabled, retained_from, through, now, reviewed, timeout=5
            )
            features, values, by_agent = _observations(raw, descriptors, enabled)
            confirmed = await _confirmed(data, eligible, since, through - timedelta(microseconds=1))
        after = await native._identity(ids, guard, environment)
        active_after = await native._active_projection_ids(guard, ids) if ids else set()
        current_policy = (
            metrics_uat_authority.policy()
            if environment == "uat"
            else plg_reporting.reporting_policy()
        )
        if environment == "uat":
            metrics_uat_authority.runtime_authority(binding)
        if (
            after != before
            or active_after != active
            or native._identity_authority(environment) is not authority
            or current_policy.revision != policy.revision
            or approved_binding(environment) != binding
            or [owner for owner in eligible if product_activity.enabled_for(owner)] != enabled
            or activity_catalog()["revision"] != catalog["revision"]
        ):
            raise native.AggregateUnavailable("Metrics authority changed")
        checked = datetime.now(timezone.utc)
        if watermark > checked:
            raise native.AggregateUnavailable("Invalid source watermark")
        result = {
            "reportKind": request.reportKind,
            "definitionVersion": request.definitionVersion,
            "period": request.period.model_dump(),
            "cutoffAt": request.cutoffAt,
            "sourceGeneration": request.sourceGeneration,
            "scopeDigest": request.scopeDigest,
            "catalogRevision": catalog["revision"],
            "sourceCheckedAt": int(checked.timestamp() * 1000),
            "sourceWatermark": int(watermark.timestamp() * 1000),
            "reconciled": True,
            "coverage": {
                "mode": "best_effort",
                "retentionDays": 7,
                "retainedFrom": int(retained_from.timestamp() * 1000),
                "retainedThrough": request.cutoffAt,
                "windowFullyRetained": retained_from == since,
                "eligibleAccounts": len(eligible),
                "captureEnabledAccounts": len(enabled),
                "dailyCappedAccounts": values["dailyCappedAccounts"],
                "unmappedObservations": values["unmappedObservations"],
            },
            "totals": {
                key: values[key]
                for key in ("observedAccounts", "observations", "correlatedAttempts")
            },
            "features": features,
            "byAgent": by_agent,
            "confirmed": confirmed,
        }
        if len(json.dumps(result, separators=(",", ":")).encode()) > MAX_RESPONSE_BYTES:
            raise native.AggregateUnavailable("Metrics response bound exceeded")
        return result


async def bounded_aggregate(request, binding, *, environment="production"):
    async def run():
        if environment == "uat":
            async with metrics_uat_authority.dedicated_pool(binding) as pool:
                return await aggregate(request, binding, pool=pool, environment="uat")
        async with native._production_aggregate_lock:
            return await aggregate(request, binding, environment=environment)

    return await asyncio.wait_for(run(), timeout=20)
