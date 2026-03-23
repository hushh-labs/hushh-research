#!/usr/bin/env python3
"""Inspect and optionally clean invalid vault rows in development databases."""

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

SAFE_ENV_VALUES = {"development", "dev", "staging", "local"}
SAFE_HOST_HINTS = ("localhost", "127.0.0.1", "dev", "staging")


@dataclass
class InvalidVaultRow:
    user_id: str
    wrapper_count: int
    passphrase_count: int
    primary_count: int
    methods: list[str] | None


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


async def _fetch_invalid_rows(conn: asyncpg.Connection) -> list[InvalidVaultRow]:
    rows = await conn.fetch(
        """
        SELECT
          vk.user_id,
          COUNT(vkw.*)::int AS wrapper_count,
          COALESCE(SUM(CASE WHEN vkw.method = 'passphrase' THEN 1 ELSE 0 END), 0)::int AS passphrase_count,
          COALESCE(SUM(CASE WHEN vkw.method = vk.primary_method THEN 1 ELSE 0 END), 0)::int AS primary_count,
          ARRAY_REMOVE(ARRAY_AGG(vkw.method ORDER BY vkw.method), NULL) AS methods
        FROM vault_keys vk
        LEFT JOIN vault_key_wrappers vkw
          ON vkw.user_id = vk.user_id
        GROUP BY vk.user_id, vk.primary_method
        HAVING
          COUNT(vkw.*) = 0
          OR COALESCE(SUM(CASE WHEN vkw.method = 'passphrase' THEN 1 ELSE 0 END), 0) = 0
          OR COALESCE(SUM(CASE WHEN vkw.method = vk.primary_method THEN 1 ELSE 0 END), 0) = 0
        ORDER BY vk.user_id
        """
    )
    return [
        InvalidVaultRow(
            user_id=row["user_id"],
            wrapper_count=row["wrapper_count"],
            passphrase_count=row["passphrase_count"],
            primary_count=row["primary_count"],
            methods=list(row["methods"]) if row["methods"] else None,
        )
        for row in rows
    ]


def _print_invalid_rows(rows: list[InvalidVaultRow]) -> None:
    if not rows:
        print("No invalid vault rows detected.")
        return
    print(f"Found {len(rows)} invalid vault row(s):")
    for row in rows:
        print(
            f"  - user_id={row.user_id} wrappers={row.wrapper_count} "
            f"passphrase={row.passphrase_count} primary={row.primary_count} methods={row.methods}"
        )


async def main() -> None:
    parser = argparse.ArgumentParser(
        description="Inspect or clean invalid vault states in dev/staging."
    )
    parser.add_argument(
        "--delete-invalid",
        action="store_true",
        help="Delete invalid vault rows (cascades to wrappers/PKM).",
    )
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="Required for destructive operations.",
    )
    args = parser.parse_args()

    if not _is_safe_environment():
        print("Refusing to run outside development/staging-safe environment.")
        sys.exit(3)

    if args.delete_invalid and not args.confirm:
        print("Refusing to delete without --confirm")
        sys.exit(2)

    db_url = get_database_url()
    ssl_cfg = get_database_ssl()

    conn = await asyncpg.connect(db_url, ssl=ssl_cfg)
    try:
        invalid_rows = await _fetch_invalid_rows(conn)
        _print_invalid_rows(invalid_rows)

        if not args.delete_invalid:
            return

        if not invalid_rows:
            print("Nothing to delete.")
            return

        async with conn.transaction():
            for row in invalid_rows:
                await conn.execute(
                    "DELETE FROM vault_keys WHERE user_id = $1",
                    row.user_id,
                )
        print(f"Deleted {len(invalid_rows)} invalid vault row(s).")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
