#!/usr/bin/env python3
"""Verify vault multi-wrapper schema contract in connected database."""

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

REQUIRED_COLUMNS = {
    "vault_keys": {
        "user_id",
        "vault_key_hash",
        "primary_method",
        "primary_wrapper_id",
        "recovery_encrypted_vault_key",
        "recovery_salt",
        "recovery_iv",
        "created_at",
        "updated_at",
    },
    "vault_key_wrappers": {
        "id",
        "user_id",
        "method",
        "wrapper_id",
        "encrypted_vault_key",
        "salt",
        "iv",
        "passkey_credential_id",
        "passkey_prf_salt",
        "passkey_rp_id",
        "passkey_provider",
        "passkey_device_label",
        "passkey_last_used_at",
        "created_at",
        "updated_at",
    },
}


async def main() -> int:
    conn = await asyncpg.connect(get_database_url(), ssl=get_database_ssl())
    try:
        failures: list[str] = []
        for table, expected_columns in REQUIRED_COLUMNS.items():
            regclass = await conn.fetchval("SELECT to_regclass($1)", f"public.{table}")
            if regclass is None:
                failures.append(f"Missing table: {table}")
                continue

            rows = await conn.fetch(
                """
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = $1
                """,
                table,
            )
            actual = {row["column_name"] for row in rows}
            missing = expected_columns - actual
            if missing:
                failures.append(f"{table} missing columns: {', '.join(sorted(missing))}")

        unique_exists = await conn.fetchval(
            """
            SELECT 1
            FROM pg_constraint c
            JOIN pg_class t ON c.conrelid = t.oid
            WHERE t.relname = 'vault_key_wrappers'
              AND c.contype = 'u'
              AND c.conname LIKE '%user_id%method%wrapper_id%'
            LIMIT 1
            """
        )
        if not unique_exists:
            failures.append(
                "vault_key_wrappers unique(user_id, method, wrapper_id) constraint missing"
            )

        if failures:
            print("Vault schema verification FAILED:")
            for failure in failures:
                print(f" - {failure}")
            return 1

        print("Vault schema verification PASSED")
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
