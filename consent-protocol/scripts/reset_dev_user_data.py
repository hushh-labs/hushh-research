#!/usr/bin/env python3
"""Reset user-scoped development data across vault/PKM/consent tables."""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from dataclasses import dataclass

import asyncpg
from dotenv import load_dotenv

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(PROJECT_ROOT, ".env"))

sys.path.insert(0, PROJECT_ROOT)
from db.connection import get_database_ssl, get_database_url  # noqa: E402

TABLES_TO_TRUNCATE = [
    "vault_key_wrappers",
    "vault_keys",
    "pkm_data",
    "pkm_index",
    "consent_audit",
    "consent_exports",
    "user_push_tokens",
    "chat_messages",
    "chat_conversations",
]

SAFE_ENV_VALUES = {"development", "dev", "staging", "local"}
SAFE_HOST_HINTS = ("localhost", "127.0.0.1", "dev", "staging")


@dataclass
class TableCount:
    table: str
    exists: bool
    count: int | None


def _is_safe_environment() -> bool:
    env_mode = (
        (os.getenv("ENVIRONMENT_MODE") or os.getenv("ENVIRONMENT") or os.getenv("APP_ENV") or "")
        .strip()
        .lower()
    )
    db_host = (os.getenv("DB_HOST") or "").strip().lower()

    env_safe = env_mode in SAFE_ENV_VALUES
    host_safe = any(hint in db_host for hint in SAFE_HOST_HINTS)
    return env_safe or host_safe


async def _table_count(conn: asyncpg.Connection, table: str) -> TableCount:
    regclass = await conn.fetchval("SELECT to_regclass($1)", f"public.{table}")
    if regclass is None:
        return TableCount(table=table, exists=False, count=None)
    count = await conn.fetchval(f"SELECT COUNT(*) FROM {table}")  # noqa: S608
    return TableCount(table=table, exists=True, count=int(count))


async def _collect_counts(conn: asyncpg.Connection) -> list[TableCount]:
    counts: list[TableCount] = []
    for table in TABLES_TO_TRUNCATE:
        counts.append(await _table_count(conn, table))
    return counts


def _print_counts(title: str, counts: list[TableCount]) -> None:
    print(f"\n{title}")
    for item in counts:
        if not item.exists:
            print(f"  - {item.table}: (missing)")
            continue
        print(f"  - {item.table}: {item.count} rows")


async def main() -> None:
    parser = argparse.ArgumentParser(
        description="Reset all user-scoped tables in development/staging environments"
    )
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="Required. Executes truncation when present.",
    )
    args = parser.parse_args()

    if not args.confirm:
        print("Refusing to run without --confirm")
        sys.exit(2)

    if not _is_safe_environment():
        print("Refusing to run: environment is not marked as dev/staging-safe.")
        print(
            "Set ENVIRONMENT_MODE=development|staging (or use a dev/staging DB host hint) to proceed."
        )
        sys.exit(3)

    db_url = get_database_url()
    ssl_cfg = get_database_ssl()

    conn = await asyncpg.connect(db_url, ssl=ssl_cfg)
    try:
        before = await _collect_counts(conn)
        _print_counts("Before reset:", before)

        async with conn.transaction():
            for table in TABLES_TO_TRUNCATE:
                regclass = await conn.fetchval("SELECT to_regclass($1)", f"public.{table}")
                if regclass is None:
                    continue
                await conn.execute(f"TRUNCATE TABLE {table} RESTART IDENTITY CASCADE")  # noqa: S608

        after = await _collect_counts(conn)
        _print_counts("After reset:", after)

        print("\n✅ Development user data reset complete.")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
