"""Independently count a closed Production UTC day under the source operator's authority."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

import asyncpg

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from hushh_mcp.services import plg_outcomes, plg_reporting
from hushh_mcp.services.account_generation_sql import EXACT_OWNER_IDENTITIES_SQL
from hushh_mcp.services.hushh_prod_database_attestation import (
    PROD_DATABASE_ATTESTATION_SQL,
    is_attested_hushh_prod_database,
    parse_connected_database_identity,
)
from hushh_mcp.services.metrics_adoption_sql import (
    CANDIDATES_SQL,
    MEANINGFUL_REPLIES_SQL,
    SOURCE_TABLES,
)

# Use a single read-only database snapshot for identity and activity. Join the
# captured owner to its generation; a retired opaque owner cannot inherit a new login.
IDENTITIES_SQL = f"""
WITH mapped AS ({EXACT_OWNER_IDENTITIES_SQL})
SELECT m.owner, m.identity_uid AS uid, i.email, i.phone_number, i.phone_verified
FROM mapped m JOIN public.actor_identity_cache i ON i.user_id=m.owner
"""


def period(day: str, today: date) -> tuple[datetime, datetime]:
    selected = date.fromisoformat(day)
    if selected.isoformat() != day or not today - timedelta(days=7) <= selected < today:
        raise ValueError("Expected one of the last seven closed UTC dates")
    start = datetime.combine(selected, time.min, timezone.utc)
    return start, start + timedelta(days=1)


async def reference(conn, day, expected_policy, reference_sha):
    start, end = period(day, datetime.now(timezone.utc).date())
    through = end - timedelta(microseconds=1)
    if not re.fullmatch("[0-9a-f]{64}", expected_policy) or not re.fullmatch(
        "[0-9a-f]{40}", reference_sha
    ):
        raise ValueError("Invalid revision")
    policy = plg_reporting.reporting_policy()
    authority = plg_reporting.reporting_auth_app()
    if policy.revision != expected_policy:
        raise ValueError("Population changed")
    async with conn.transaction(isolation="repeatable_read", readonly=True):
        await conn.execute("SET LOCAL statement_timeout='5s'")
        await conn.execute("SET LOCAL search_path=pg_catalog,public")
        row = await conn.fetchrow(PROD_DATABASE_ATTESTATION_SQL)
        if not is_attested_hushh_prod_database(parse_connected_database_identity(row)):
            raise ValueError("Production database authority unavailable")
        restricted = await conn.fetchval(
            "SELECT bool_or(row_security_active(t::regclass) OR "
            "NOT has_table_privilege(current_user,t,'SELECT')) FROM unnest($1::text[]) AS x(t)",
            ["public." + table for table in (*SOURCE_TABLES, "account_generations")],
        )
        if restricted is not False:
            raise ValueError("Partial source access")
        observed = await conn.fetchval("SELECT transaction_timestamp()")
        owners = [r["user_id"] for r in await conn.fetch(CANDIDATES_SQL, start, through)]
        if len(owners) > 50 or any(
            not isinstance(o, str) or not 1 <= len(o) <= 128 for o in owners
        ):
            raise ValueError("Source bound exceeded")
        identities = await conn.fetch(IDENTITIES_SQL, owners)
        uids = [r["uid"] for r in identities]
        if len(set(uids)) != len(uids):
            raise ValueError("Ambiguous identity")
        aliases = await conn.fetch(
            "SELECT user_id,email_normalized FROM actor_verified_email_aliases "
            "WHERE user_id=ANY($1::text[]) AND verification_status='verified' "
            "AND revoked_at IS NULL LIMIT 5001",
            owners,
        )
        if len(aliases) > 5000:
            raise ValueError("Alias bound exceeded")
        emails_by_owner = {}
        for alias in aliases:
            emails_by_owner.setdefault(alias["user_id"], []).append(alias["email_normalized"])
        before = await plg_reporting.current_reporting_records(uids)
        eligible = [
            r["owner"]
            for r in identities
            if r["uid"] in before
            and r["owner"] not in policy.account_ids
            and policy.eligible(
                r["uid"], r, (*before[r["uid"]]["emails"], *emails_by_owner.get(r["owner"], []))
            )
        ]
        active = {
            r["user_id"] for r in await conn.fetch(MEANINGFUL_REPLIES_SQL, eligible, start, through)
        }
        outcomes = 0
        for owner in eligible:
            # Independent per-owner effect enumeration, before any aggregate publication.
            effects, limited = await plg_outcomes.value_effects(
                conn, owner, "agent_one", start, through
            )
            if limited:
                raise ValueError("Incomplete outcomes")
            if effects:
                active.add(owner)
                outcomes += len(effects)
        if (
            await plg_reporting.current_reporting_records(uids) != before
            or plg_reporting.reporting_policy().revision != expected_policy
            or plg_reporting.reporting_auth_app() is not authority
        ):
            raise ValueError("Eligibility changed")
    return {
        "startInclusive": start.isoformat(),
        "endExclusive": end.isoformat(),
        "observedAt": observed.isoformat(),
        "populationRevision": expected_policy,
        "referenceRevision": reference_sha,
        "activeAccounts": len(active),
        "confirmedOutcomes": outcomes,
    }


async def run(args):
    if (
        os.environ.get("ENVIRONMENT") != "production"
        or os.environ.get("GOOGLE_CLOUD_PROJECT") != "hushh-pda"
    ):
        raise ValueError("Production operator environment required")
    # libpq PG* settings come from the existing source owner session.
    # Neither the target nor account credentials can be supplied as report inputs.
    checkout = Path(__file__).resolve().parents[3]
    reference_sha = subprocess.check_output(  # noqa: S603
        ["git", "-C", str(checkout), "rev-parse", "HEAD"], text=True
    ).strip()
    subprocess.run(  # noqa: S603
        ["git", "-C", str(checkout), "diff", "--quiet", "HEAD", "--", "consent-protocol"],
        check=True,
    )
    conn = await asyncpg.connect(timeout=5, command_timeout=5)
    try:
        async with asyncio.timeout(90):
            return await reference(conn, args.day, args.population_revision, reference_sha)
    finally:
        await conn.close(timeout=5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--day", required=True)
    parser.add_argument("--population-revision", required=True)
    try:
        print(json.dumps(asyncio.run(run(parser.parse_args())), sort_keys=True))
    except Exception as exc:
        # Driver/provider exception text can include account identifiers.
        print(f"Production reference unavailable ({type(exc).__name__})", file=sys.stderr)
        sys.exit(1)
