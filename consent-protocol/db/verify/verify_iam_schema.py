#!/usr/bin/env python3
"""Verify IAM schema readiness contract in connected database."""

from __future__ import annotations

import asyncio
import os
import sys

import asyncpg
from dotenv import load_dotenv

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(PROJECT_ROOT, ".env"))

sys.path.insert(0, PROJECT_ROOT)
from db.connection import get_database_ssl, get_database_url  # noqa: E402

REQUIRED_TABLES = (
    "actor_profiles",
    "ria_profiles",
    "ria_firms",
    "ria_firm_memberships",
    "ria_verification_events",
    "advisor_investor_relationships",
    "ria_client_invites",
    "consent_scope_templates",
    "marketplace_public_profiles",
    "relationship_share_grants",
    "relationship_share_events",
    "connection_scope_proposals",
    "connection_scope_proposal_events",
    "ria_pick_legacy_retirements",
    "runtime_persona_state",
)

REQUIRED_COLUMNS = {
    "relationship_share_grants": (
        "connection_request_id",
        "connection_scope_proposal_id",
    ),
    "relationship_share_events": (
        "connection_request_id",
        "connection_scope_proposal_id",
    ),
    "connection_scope_proposals": (
        "connection_request_id",
        "scope_handle",
        "capability_key",
        "direction",
        "owner_user_id",
        "receiver_user_id",
        "status",
        "expires_at",
    ),
    "connection_scope_proposal_events": (
        "connection_scope_proposal_id",
        "event_type",
    ),
    "ria_pick_legacy_retirements": (
        "legacy_upload_id",
        "owner_user_id",
        "ria_profile_id",
        "top_pick_count",
        "retired_at",
    ),
}

REQUIRED_TEMPLATE_IDS = (
    "ria_financial_summary_v1",
    "ria_risk_profile_v1",
    "investor_advisor_disclosure_v1",
)

_CONNECT_ATTEMPTS = 3
_CONNECT_TIMEOUT_SECONDS = 10


async def _connect_with_retry() -> asyncpg.Connection:
    """Tolerate a Cloud SQL proxy reconnect while local preflight is starting."""

    for attempt in range(1, _CONNECT_ATTEMPTS + 1):
        try:
            return await asyncpg.connect(
                get_database_url(),
                ssl=get_database_ssl(),
                timeout=_CONNECT_TIMEOUT_SECONDS,
            )
        except (asyncpg.PostgresConnectionError, OSError) as exc:
            if attempt == _CONNECT_ATTEMPTS:
                raise RuntimeError(
                    "database connection was unavailable after "
                    f"{_CONNECT_ATTEMPTS} attempts ({type(exc).__name__})"
                ) from exc
            print(
                "Database connection reset during IAM schema verification; "
                f"retrying ({attempt}/{_CONNECT_ATTEMPTS})..."
            )
            await asyncio.sleep(attempt)


async def main() -> int:
    try:
        conn = await _connect_with_retry()
    except RuntimeError as exc:
        print(f"IAM schema verification FAILED: {exc}")
        return 1
    try:
        failures: list[str] = []

        existing_tables: set[str] = set()
        for table in REQUIRED_TABLES:
            regclass = await conn.fetchval("SELECT to_regclass($1)", f"public.{table}")
            if regclass is None:
                failures.append(f"Missing table: {table}")
            else:
                existing_tables.add(table)

        for table, expected_columns in REQUIRED_COLUMNS.items():
            if table not in existing_tables:
                continue
            rows = await conn.fetch(
                """
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = $1
                """,
                table,
            )
            actual_columns = {str(row["column_name"]) for row in rows}
            for column in expected_columns:
                if column not in actual_columns:
                    failures.append(f"Missing column: {table}.{column}")

        if "consent_scope_templates" in existing_tables:
            try:
                rows = await conn.fetch(
                    """
                    SELECT template_id
                    FROM consent_scope_templates
                    WHERE template_id = ANY($1::text[])
                      AND active = TRUE
                    """,
                    list(REQUIRED_TEMPLATE_IDS),
                )
                found_templates = {str(row["template_id"]) for row in rows}
                for template_id in REQUIRED_TEMPLATE_IDS:
                    if template_id not in found_templates:
                        failures.append(f"Missing active consent template: {template_id}")
            except asyncpg.exceptions.UndefinedTableError:
                failures.append("Missing table: consent_scope_templates")

        if failures:
            print("IAM schema verification FAILED:")
            for failure in failures:
                print(f" - {failure}")
            return 1

        print("IAM schema verification PASSED")
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
