"""UAT-only identity, policy and database authority for Metrics aggregates."""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import re
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from api.utils.firebase_auth import current_auth_lane
from hushh_mcp.services.plg_reporting import ReportingPolicy, reporting_identifiers

PROJECT = "hushh-pda-uat"
INSTANCE = "hushh-pda-uat:us-central1:hushh-uat-pg"


@asynccontextmanager
async def dedicated_pool(binding: dict):
    """Create each request's pool against the fixed native UAT socket only."""
    import asyncpg

    runtime_authority(binding)
    user, password = os.environ.get("DB_USER", ""), os.environ.get("DB_PASSWORD", "")
    if not user or not password or os.environ.get("DB_PORT", "5432") != "5432":
        raise RuntimeError("UAT Metrics database unavailable")
    pool = await asyncpg.create_pool(
        user=user,
        password=password,
        database=binding["databaseName"],
        host=f"/cloudsql/{INSTANCE}",
        port=5432,
        ssl=False,
        min_size=0,
        max_size=2,
        timeout=3,
        command_timeout=5,
    )
    try:
        runtime_authority(binding)
        yield pool
    finally:
        try:
            await asyncio.wait_for(pool.close(), timeout=3)
        except (Exception, asyncio.CancelledError):
            pool.terminate()
            raise


def runtime_authority(binding: dict) -> None:
    """Require the actual UAT lane and pinned UAT socket before and after reads."""
    if (
        current_auth_lane() != "uat"
        or os.environ.get("GOOGLE_CLOUD_PROJECT") != PROJECT
        or os.environ.get("DB_UNIX_SOCKET") != f"/cloudsql/{INSTANCE}"
        or os.environ.get("CLOUDSQL_INSTANCE_CONNECTION_NAME") != INSTANCE
        or not binding.get("databaseName")
        or os.environ.get("DB_NAME", "postgres") != binding["databaseName"]
        or not binding.get("databaseUser")
        or os.environ.get("DB_USER") != binding["databaseUser"]
        or any(
            os.environ.get(name)
            for name in (
                "PGSERVICE",
                "PGSERVICEFILE",
                "PGHOST",
                "PGPORT",
                "PGUSER",
                "PGPASSWORD",
                "PGDATABASE",
                "PGOPTIONS",
                "PGSSLMODE",
            )
        )
    ):
        raise RuntimeError("UAT Metrics authority unavailable")


async def verify_database(conn, binding: dict) -> None:
    runtime_authority(binding)
    if await conn.fetchval("SELECT current_database()", timeout=5) != binding["databaseName"]:
        raise RuntimeError("UAT Metrics database unavailable")
    if await conn.fetchval("SELECT current_user", timeout=5) != binding["databaseUser"]:
        raise RuntimeError("UAT Metrics database unavailable")


def auth_app():
    from api.utils.firebase_admin import get_firebase_auth_app

    app = get_firebase_auth_app()
    if app is None or app.project_id != PROJECT:
        raise RuntimeError("UAT Metrics identity unavailable")
    return app


async def current_records(user_ids):
    from firebase_admin import auth

    ids = sorted(set(user_ids))
    if not ids:
        return {}
    if len(ids) > 50 or any(not isinstance(uid, str) or not 1 <= len(uid) <= 128 for uid in ids):
        raise RuntimeError("UAT Metrics identity bound exceeded")
    app = auth_app()
    result = await asyncio.wait_for(
        asyncio.to_thread(auth.get_users, [auth.UidIdentifier(uid) for uid in ids], app=app),
        timeout=6,
    )
    records, missing = list(result.users), list(result.not_found)
    returned_ids = [record.uid for record in records]
    missing_ids = [item.uid for item in missing if isinstance(item, auth.UidIdentifier)]
    if (
        len(missing_ids) != len(missing)
        or len(set(returned_ids + missing_ids)) != len(ids)
        or sorted(returned_ids + missing_ids) != ids
    ):
        raise RuntimeError("Invalid UAT Metrics identities")
    identifiers = {}
    for record in records:
        emails = reporting_identifiers(record)
        if emails is not None:
            created = getattr(getattr(record, "user_metadata", None), "creation_timestamp", None)
            registered = None
            if (
                isinstance(created, (int, float))
                and not isinstance(created, bool)
                and math.isfinite(created)
                and 0 < created <= datetime.now(timezone.utc).timestamp() * 1000
            ):
                registered = datetime.fromtimestamp(created / 1000, timezone.utc).isoformat()
            identifiers[record.uid] = {"emails": emails, "registeredAt": registered}
    return identifiers


def policy() -> ReportingPolicy:
    """A dedicated test-account policy; never reads the production policy."""
    raw = os.environ.get("ONE_METRICS_UAT_REPORTING_POLICY_JSON", "")
    if not raw or len(raw) > 250_000:
        raise RuntimeError("UAT Metrics policy unavailable")
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        raise RuntimeError("Invalid UAT Metrics policy") from None
    keys = {"version", "excludedAccountIds", "excludedEmails", "excludedDomains"}
    if (
        not isinstance(value, dict)
        or set(value) != keys
        or type(value["version"]) is not int
        or value["version"] != 1
    ):
        raise RuntimeError("Invalid UAT Metrics policy")
    for key in keys - {"version"}:
        items = value[key]
        if (
            not isinstance(items, list)
            or len(items) > 5000
            or any(
                not isinstance(item, str)
                or not item.strip()
                or len(item) > 254
                or re.search(r"[\x00-\x1f\x7f]", item)
                for item in items
            )
        ):
            raise RuntimeError("Invalid UAT Metrics policy")
    ids = {x.strip() for x in value["excludedAccountIds"]}
    emails = {x.strip().lower() for x in value["excludedEmails"]}
    domains = {x.strip().lower() for x in value["excludedDomains"]}
    if (
        any(len(uid) > 128 for uid in ids)
        or any(not re.fullmatch(r"[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+", email) for email in emails)
        or any(
            not re.fullmatch(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", domain)
            for domain in domains
        )
        or not (ids or emails or domains)
    ):
        raise RuntimeError("Invalid UAT Metrics policy")
    revision = hashlib.sha256(
        json.dumps(
            ["uat_registered_test_accounts_v1", sorted(ids), sorted(emails), sorted(domains)],
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    return ReportingPolicy(frozenset(ids), frozenset(emails), frozenset(domains), revision)
