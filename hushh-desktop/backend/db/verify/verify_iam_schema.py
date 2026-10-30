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
    "runtime_persona_state",
)

REQUIRED_TEMPLATE_IDS = (
    "ria_financial_summary_v1",
    "ria_risk_profile_v1",
    "investor_advisor_disclosure_v1",
)


async def main() -> int:
    conn = await asyncpg.connect(get_database_url(), ssl=get_database_ssl())
    try:
        failures: list[str] = []

        existing_tables: set[str] = set()
        for table in REQUIRED_TABLES:
            regclass = await conn.fetchval("SELECT to_regclass($1)", f"public.{table}")
            if regclass is None:
                failures.append(f"Missing table: {table}")
            else:
                existing_tables.add(table)

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
