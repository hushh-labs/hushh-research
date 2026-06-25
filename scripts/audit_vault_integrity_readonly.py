#!/usr/bin/env python3
"""Read-only vault metadata integrity audit.

This script checks structural vault consistency only. It never decrypts vault
material and cannot prove whether a user's passphrase still unwraps their key.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from dataclasses import dataclass
from typing import Iterable

import asyncpg
from dotenv import load_dotenv

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(PROJECT_ROOT, ".env"))

sys.path.insert(0, PROJECT_ROOT)
from db.connection import get_database_ssl, get_database_url  # noqa: E402


@dataclass(frozen=True)
class VaultIssue:
    code: str
    user_id: str
    detail: str


def _mask_user_id(user_id: str) -> str:
    if not user_id:
        return "<unknown>"
    if len(user_id) <= 8:
        return user_id
    return f"{user_id[:4]}...{user_id[-4:]}"


def _user_label(user_id: str, *, show_user_ids: bool) -> str:
    return user_id if show_user_ids else _mask_user_id(user_id)


async def _query_issues(conn: asyncpg.Connection, code: str, sql: str) -> list[VaultIssue]:
    rows = await conn.fetch(sql)
    return [
        VaultIssue(
            code=code,
            user_id=str(row["user_id"] or ""),
            detail=str(row["detail"] or code),
        )
        for row in rows
    ]


async def _fetch_issues(conn: asyncpg.Connection) -> list[VaultIssue]:
    checks: list[tuple[str, str]] = [
        (
            "ACTIVE_MISSING_KEY_FIELDS",
            """
            SELECT
              user_id,
              'active vault is missing vault key hash or recovery wrapper fields' AS detail
            FROM vault_keys
            WHERE COALESCE(vault_status, 'active') = 'active'
              AND (
                NULLIF(BTRIM(COALESCE(vault_key_hash, '')), '') IS NULL
                OR NULLIF(BTRIM(COALESCE(recovery_encrypted_vault_key, '')), '') IS NULL
                OR NULLIF(BTRIM(COALESCE(recovery_salt, '')), '') IS NULL
                OR NULLIF(BTRIM(COALESCE(recovery_iv, '')), '') IS NULL
              )
            ORDER BY user_id
            """,
        ),
        (
            "ACTIVE_MISSING_PASSPHRASE_WRAPPER",
            """
            SELECT
              vk.user_id,
              'active vault has no default passphrase wrapper' AS detail
            FROM vault_keys vk
            WHERE COALESCE(vk.vault_status, 'active') = 'active'
              AND NOT EXISTS (
                SELECT 1
                FROM vault_key_wrappers vkw
                WHERE vkw.user_id = vk.user_id
                  AND vkw.method = 'passphrase'
                  AND COALESCE(NULLIF(BTRIM(vkw.wrapper_id), ''), 'default') = 'default'
              )
            ORDER BY vk.user_id
            """,
        ),
        (
            "ACTIVE_PRIMARY_WRAPPER_MISSING",
            """
            SELECT
              vk.user_id,
              'active vault primary method/wrapper is not enrolled' AS detail
            FROM vault_keys vk
            WHERE COALESCE(vk.vault_status, 'active') = 'active'
              AND NOT EXISTS (
                SELECT 1
                FROM vault_key_wrappers vkw
                WHERE vkw.user_id = vk.user_id
                  AND vkw.method = vk.primary_method
                  AND COALESCE(NULLIF(BTRIM(vkw.wrapper_id), ''), 'default')
                    = COALESCE(NULLIF(BTRIM(vk.primary_wrapper_id), ''), 'default')
              )
            ORDER BY vk.user_id
            """,
        ),
        (
            "DUPLICATE_WRAPPER_PAIR",
            """
            SELECT
              user_id,
              'duplicate method/wrapper_id pair exists in vault_key_wrappers' AS detail
            FROM vault_key_wrappers
            GROUP BY user_id, method, COALESCE(NULLIF(BTRIM(wrapper_id), ''), 'default')
            HAVING COUNT(*) > 1
            ORDER BY user_id
            """,
        ),
        (
            "ORPHAN_WRAPPER",
            """
            SELECT DISTINCT
              vkw.user_id,
              'vault wrapper exists without a vault_keys row' AS detail
            FROM vault_key_wrappers vkw
            LEFT JOIN vault_keys vk ON vk.user_id = vkw.user_id
            WHERE vk.user_id IS NULL
            ORDER BY vkw.user_id
            """,
        ),
        (
            "PLACEHOLDER_WITH_KEY_MATERIAL",
            """
            SELECT
              vk.user_id,
              'placeholder vault row has key hash, recovery fields, or wrappers' AS detail
            FROM vault_keys vk
            WHERE COALESCE(vk.vault_status, 'active') = 'placeholder'
              AND (
                NULLIF(BTRIM(COALESCE(vk.vault_key_hash, '')), '') IS NOT NULL
                OR NULLIF(BTRIM(COALESCE(vk.recovery_encrypted_vault_key, '')), '') IS NOT NULL
                OR NULLIF(BTRIM(COALESCE(vk.recovery_salt, '')), '') IS NOT NULL
                OR NULLIF(BTRIM(COALESCE(vk.recovery_iv, '')), '') IS NOT NULL
                OR EXISTS (
                  SELECT 1 FROM vault_key_wrappers vkw WHERE vkw.user_id = vk.user_id
                )
              )
            ORDER BY vk.user_id
            """,
        ),
        (
            "PKM_BLOBS_WITH_UNUSABLE_VAULT_METADATA",
            """
            SELECT DISTINCT
              pb.user_id,
              'PKM blobs exist but active passphrase vault metadata is missing' AS detail
            FROM pkm_blobs pb
            LEFT JOIN vault_keys vk ON vk.user_id = pb.user_id
            WHERE vk.user_id IS NULL
              OR COALESCE(vk.vault_status, 'active') <> 'active'
              OR NOT EXISTS (
                SELECT 1
                FROM vault_key_wrappers vkw
                WHERE vkw.user_id = pb.user_id
                  AND vkw.method = 'passphrase'
                  AND COALESCE(NULLIF(BTRIM(vkw.wrapper_id), ''), 'default') = 'default'
              )
            ORDER BY pb.user_id
            """,
        ),
    ]

    issues: list[VaultIssue] = []
    for code, sql in checks:
        issues.extend(await _query_issues(conn, code, sql))
    return issues


def _print_summary(issues: Iterable[VaultIssue], *, show_user_ids: bool) -> None:
    issues = list(issues)
    if not issues:
        print("Vault integrity audit passed: no structural issues found.")
        return

    counts: dict[str, int] = {}
    for issue in issues:
        counts[issue.code] = counts.get(issue.code, 0) + 1

    print(f"Vault integrity audit found {len(issues)} structural issue(s).")
    for code in sorted(counts):
        print(f"- {code}: {counts[code]}")
    print("")
    for issue in issues:
        print(
            f"- {issue.code} user={_user_label(issue.user_id, show_user_ids=show_user_ids)} "
            f"detail={issue.detail}"
        )


async def main() -> None:
    parser = argparse.ArgumentParser(description="Read-only vault metadata integrity audit.")
    parser.add_argument(
        "--show-user-ids",
        action="store_true",
        help="Print raw user ids instead of masked ids.",
    )
    parser.add_argument(
        "--no-fail-on-issues",
        action="store_true",
        help="Exit 0 even when structural issues are found.",
    )
    args = parser.parse_args()

    conn = await asyncpg.connect(get_database_url(), ssl=get_database_ssl())
    try:
        issues = await _fetch_issues(conn)
    finally:
        await conn.close()

    _print_summary(issues, show_user_ids=args.show_user_ids)
    if issues and not args.no_fail_on_issues:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
