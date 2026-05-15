#!/usr/bin/env python3
"""Dry-run and execute a guarded Kai/UAT test-account reset by email.

This tool intentionally does not delete Firebase Auth users or browser-local
state. It cleans backend database state for a supplied email/user id so local
and UAT onboarding flows can be retested.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[4]
CONSENT_ROOT = REPO_ROOT / "consent-protocol"
if str(CONSENT_ROOT) not in sys.path:
    sys.path.insert(0, str(CONSENT_ROOT))

from dotenv import load_dotenv  # noqa: E402


EMAIL_LINK_TABLES: dict[str, tuple[str, ...]] = {
    "actor_identity_cache": ("email",),
    "developer_apps": ("owner_email", "contact_email"),
    "developer_applications": ("contact_email",),
    "ria_client_invites": ("target_email",),
}

UID_DISCOVERY_TABLES: dict[str, tuple[str, ...]] = {
    "actor_identity_cache": ("user_id",),
    "developer_apps": ("owner_firebase_uid",),
    "ria_client_invites": ("target_investor_user_id", "accepted_by_user_id"),
}

RESIDUAL_USER_TABLES: dict[str, tuple[str, ...]] = {
    "actor_identity_cache": ("user_id",),
    "actor_profiles": ("user_id",),
    "runtime_persona_state": ("user_id",),
    "vault_keys": ("user_id",),
    "vault_key_wrappers": ("user_id",),
    "pkm_data": ("user_id",),
    "pkm_index": ("user_id",),
    "pkm_blobs": ("user_id",),
    "pkm_manifests": ("user_id",),
    "pkm_manifest_paths": ("user_id",),
    "pkm_scope_registry": ("user_id",),
    "pkm_events": ("user_id",),
    "pkm_migration_state": ("user_id",),
    "pkm_upgrade_runs": ("user_id",),
    "kai_plaid_items": ("user_id",),
    "kai_plaid_refresh_runs": ("user_id",),
    "kai_plaid_link_sessions": ("user_id",),
    "kai_plaid_user_profile_cache": ("user_id",),
    "kai_alpaca_connect_sessions": ("user_id",),
    "kai_alpaca_accounts": ("user_id",),
    "kai_alpaca_positions": ("user_id",),
    "kai_funding_trade_intents": ("user_id",),
    "kai_funding_trade_events": ("user_id",),
    "kai_receipt_memory_artifacts": ("user_id",),
    "gmail_watch_history": ("user_id",),
    "gmail_receipt_sync_runs": ("user_id",),
    "gmail_receipts": ("user_id",),
    "consent_audit": ("user_id",),
    "internal_access_events": ("user_id",),
    "user_push_tokens": ("user_id",),
    "consent_exports": ("user_id",),
    "consent_export_refresh_jobs": ("user_id",),
    "ria_profiles": ("user_id",),
    "ria_firm_memberships": ("user_id",),
    "ria_verification_events": ("user_id",),
    "marketplace_public_profiles": ("user_id",),
    "advisor_investor_relationships": ("advisor_user_id", "investor_user_id"),
    "relationship_share_grants": ("provider_user_id", "receiver_user_id"),
    "relationship_share_grant_audit": ("provider_user_id", "receiver_user_id"),
    "ria_client_invites": ("target_investor_user_id", "accepted_by_user_id"),
    "ria_pick_lists": ("uploaded_by_user_id",),
    "ria_pick_uploads": ("uploaded_by_user_id",),
    "ria_pick_share_artifacts": ("provider_user_id", "receiver_user_id"),
    "developer_apps": ("owner_firebase_uid",),
}

def _preview(value: str) -> str:
    return f"{value[:8]}..." if value else ""


def _quote_ident(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def _load_env() -> None:
    load_dotenv(CONSENT_ROOT / ".env")


def _db_kwargs() -> dict[str, Any]:
    return {
        "host": os.getenv("DB_HOST"),
        "port": int(os.getenv("DB_PORT", "5432")),
        "database": os.getenv("DB_NAME"),
        "user": os.getenv("DB_USER"),
        "password": os.getenv("DB_PASSWORD"),
    }


async def _connect():
    import asyncpg

    return await asyncpg.connect(**_db_kwargs())


async def _table_exists(conn: Any, table: str) -> bool:
    return bool(await conn.fetchval("SELECT to_regclass($1) IS NOT NULL", f"public.{table}"))


async def _existing_columns(conn: Any, table: str, columns: tuple[str, ...]) -> list[str]:
    rows = await conn.fetch(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
          AND column_name = ANY($2::text[])
        """,
        table,
        list(columns),
    )
    found = {row["column_name"] for row in rows}
    return [column for column in columns if column in found]


async def _discover_user_ids(conn: Any, email: str, supplied_user_ids: list[str]) -> tuple[list[str], list[dict[str, Any]]]:
    user_ids = {uid.strip() for uid in supplied_user_ids if uid.strip()}
    hits: list[dict[str, Any]] = []
    for table, email_columns in EMAIL_LINK_TABLES.items():
        if not await _table_exists(conn, table):
            continue
        existing_email_columns = await _existing_columns(conn, table, email_columns)
        existing_uid_columns = await _existing_columns(conn, table, UID_DISCOVERY_TABLES.get(table, ()))
        for email_column in existing_email_columns:
            uid_select = ", ".join(
                f"array_remove(array_agg(DISTINCT {_quote_ident(column)}), NULL) AS {_quote_ident(column)}"
                for column in existing_uid_columns
            )
            query = (
                f"SELECT count(*) AS rows"
                f"{', ' + uid_select if uid_select else ''} "
                f"FROM {_quote_ident(table)} "
                f"WHERE lower({_quote_ident(email_column)}) = lower($1)"
            )
            row = await conn.fetchrow(query, email)
            row_count = int(row["rows"] or 0)
            if row_count <= 0:
                continue
            hit: dict[str, Any] = {
                "table": table,
                "email_column": email_column,
                "rows": row_count,
                "user_id_columns": {},
            }
            for uid_column in existing_uid_columns:
                values = [value for value in (row[uid_column] or []) if value]
                if values:
                    user_ids.update(values)
                    hit["user_id_columns"][uid_column] = [_preview(value) for value in values]
            hits.append(hit)
    return sorted(user_ids), hits


async def _discover_dynamic_link_columns(conn: Any, *, kind: str) -> dict[str, tuple[str, ...]]:
    _ = conn
    if kind == "email":
        return EMAIL_LINK_TABLES
    elif kind == "user_id":
        merged: dict[str, tuple[str, ...]] = dict(RESIDUAL_USER_TABLES)
        for table, columns in UID_DISCOVERY_TABLES.items():
            merged[table] = tuple(dict.fromkeys((*merged.get(table, ()), *columns)))
        return merged
    else:
        raise ValueError(f"Unsupported link column kind: {kind}")


async def _count_linked_rows(
    conn: Any,
    linked_columns: dict[str, tuple[str, ...]],
    values: list[str],
    *,
    kind: str,
) -> list[dict[str, Any]]:
    if not values:
        return []
    results: list[dict[str, Any]] = []
    for table, columns in linked_columns.items():
        if not columns or not await _table_exists(conn, table):
            continue
        existing = await _existing_columns(conn, table, columns)
        if not existing:
            continue
        try:
            if kind == "email":
                where = " OR ".join(f"lower({_quote_ident(column)}::text) = lower($1)" for column in existing)
                row_count = await conn.fetchval(f"SELECT count(*) FROM {_quote_ident(table)} WHERE {where}", values[0])
            elif kind == "user_id":
                where = " OR ".join(f"{_quote_ident(column)} = ANY($1::text[])" for column in existing)
                row_count = await conn.fetchval(f"SELECT count(*) FROM {_quote_ident(table)} WHERE {where}", values)
            else:
                raise ValueError(f"Unsupported linked row count kind: {kind}")
        except Exception as exc:  # noqa: BLE001
            results.append({"table": table, "columns": existing, "rows": None, "error": str(exc).splitlines()[0]})
            continue
        if int(row_count or 0) > 0:
            results.append({"table": table, "columns": existing, "rows": int(row_count)})
    return results


async def _delete_linked_rows(
    conn: Any,
    linked_columns: dict[str, tuple[str, ...]],
    values: list[str],
    *,
    kind: str,
) -> list[dict[str, Any]]:
    if not values:
        return []
    results: list[dict[str, Any]] = []
    for table, columns in linked_columns.items():
        if not columns or not await _table_exists(conn, table):
            continue
        existing = await _existing_columns(conn, table, columns)
        if not existing:
            continue
        if kind == "email":
            where = " OR ".join(f"lower({_quote_ident(column)}::text) = lower($1)" for column in existing)
            command = f"DELETE FROM {_quote_ident(table)} WHERE {where}"
            args: tuple[Any, ...] = (values[0],)
        elif kind == "user_id":
            where = " OR ".join(f"{_quote_ident(column)} = ANY($1::text[])" for column in existing)
            command = f"DELETE FROM {_quote_ident(table)} WHERE {where}"
            args = (values,)
        else:
            raise ValueError(f"Unsupported linked row delete kind: {kind}")
        try:
            status = await conn.execute(command, *args)
        except Exception as exc:  # noqa: BLE001
            results.append({"table": table, "by": kind, "columns": existing, "error": str(exc).splitlines()[0]})
            continue
        if status != "DELETE 0":
            results.append({"table": table, "by": kind, "columns": existing, "status": status})
    return results


async def _delete_by_email(conn: Any, email: str) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for table, columns in EMAIL_LINK_TABLES.items():
        if not await _table_exists(conn, table):
            continue
        existing = await _existing_columns(conn, table, columns)
        if not existing:
            continue
        where = " OR ".join(f"lower({_quote_ident(column)}) = lower($1)" for column in existing)
        command = f"DELETE FROM {_quote_ident(table)} WHERE {where}"
        status = await conn.execute(command, email)
        results.append({"table": table, "by": "email", "status": status})
    return results


async def _delete_residual_user_rows(conn: Any, user_ids: list[str]) -> list[dict[str, Any]]:
    if not user_ids:
        return []
    results: list[dict[str, Any]] = []
    # Several tables cascade from vault_keys/actor_profiles. This residual sweep
    # is intentionally best-effort and runs after AccountService deletion.
    for _ in range(3):
        changed = False
        for table, columns in RESIDUAL_USER_TABLES.items():
            if not await _table_exists(conn, table):
                continue
            existing = await _existing_columns(conn, table, columns)
            if not existing:
                continue
            where = " OR ".join(f"{_quote_ident(column)} = ANY($1::text[])" for column in existing)
            try:
                status = await conn.execute(f"DELETE FROM {_quote_ident(table)} WHERE {where}", user_ids)
            except Exception as exc:  # noqa: BLE001
                results.append({"table": table, "by": "user_id", "error": str(exc).splitlines()[0]})
                continue
            if status != "DELETE 0":
                changed = True
                results.append({"table": table, "by": "user_id", "status": status})
        if not changed:
            break
    return results


async def _run_account_service_delete(user_ids: list[str]) -> list[dict[str, Any]]:
    from hushh_mcp.services.account_service import AccountService

    service = AccountService()
    results: list[dict[str, Any]] = []
    for user_id in user_ids:
        result = await service.delete_account(user_id, target="both")
        results.append(
            {
                "user_id_preview": _preview(user_id),
                "success": bool(result.get("success")),
                "deleted_target": result.get("deleted_target"),
                "account_deleted": result.get("account_deleted"),
                "error": result.get("error"),
                "details": result.get("details"),
            }
        )
    return results


async def run(args: argparse.Namespace) -> dict[str, Any]:
    _load_env()
    conn = await _connect()
    try:
        await conn.execute("SET statement_timeout = '1000ms'")
        user_ids, email_hits = await _discover_user_ids(conn, args.email, args.user_id or [])
        dynamic_user_columns = await _discover_dynamic_link_columns(conn, kind="user_id")
        dynamic_email_columns = await _discover_dynamic_link_columns(conn, kind="email")
        if args.execute or not args.include_counts:
            user_id_row_counts = []
            email_row_counts = []
        else:
            user_id_row_counts = await _count_linked_rows(
                conn,
                dynamic_user_columns,
                user_ids,
                kind="user_id",
            )
            email_row_counts = await _count_linked_rows(
                conn,
                dynamic_email_columns,
                [args.email],
                kind="email",
            )
        payload: dict[str, Any] = {
            "mode": "execute" if args.execute else "dry_run",
            "email": args.email,
            "matched_user_ids_preview": [_preview(user_id) for user_id in user_ids],
            "matched_user_ids_count": len(user_ids),
            "email_hits": email_hits,
            "linked_user_id_row_counts": user_id_row_counts,
            "linked_email_row_counts": email_row_counts,
            "firebase_auth_deleted": False,
            "browser_local_state_deleted": False,
            "row_counts_included": bool(args.include_counts and not args.execute),
        }
        if not args.execute:
            payload["planned_operations"] = [
                "AccountService.delete_account(target='both') for each matched user_id",
                "Best-effort residual cleanup for known user_id columns",
                "Bounded cleanup for app-owned user_id and firebase_uid columns",
                "Email-linked cleanup for actor_identity_cache, developer apps/applications, and RIA invites",
            ]
            payload["execute_command"] = (
                f"{sys.executable} .codex/skills/kai-test-account-reset/scripts/reset_kai_test_account.py "
                f"--email {args.email} --execute --confirm-email {args.email}"
            )
            return payload
        if args.confirm_email != args.email:
            raise SystemExit("--execute requires --confirm-email with the exact email value.")
    finally:
        await conn.close()

    account_results = await _run_account_service_delete(user_ids)
    conn = await _connect()
    try:
        await conn.execute("SET statement_timeout = '5000ms'")
        residual_results = await _delete_residual_user_rows(conn, user_ids)
        email_results = await _delete_by_email(conn, args.email)
        dynamic_user_columns = await _discover_dynamic_link_columns(conn, kind="user_id")
        dynamic_email_columns = await _discover_dynamic_link_columns(conn, kind="email")
        dynamic_user_results = await _delete_linked_rows(
            conn,
            dynamic_user_columns,
            user_ids,
            kind="user_id",
        )
        dynamic_email_results = await _delete_linked_rows(
            conn,
            dynamic_email_columns,
            [args.email],
            kind="email",
        )
        remaining_user_id_row_counts = await _count_linked_rows(
            conn,
            dynamic_user_columns,
            user_ids,
            kind="user_id",
        )
        remaining_email_row_counts = await _count_linked_rows(
            conn,
            dynamic_email_columns,
            [args.email],
            kind="email",
        )
    finally:
        await conn.close()

    return {
        "mode": "execute",
        "email": args.email,
        "matched_user_ids_preview": [_preview(user_id) for user_id in user_ids],
        "matched_user_ids_count": len(user_ids),
        "account_service_results": account_results,
        "residual_results": residual_results,
        "email_cleanup_results": email_results,
        "dynamic_user_id_cleanup_results": dynamic_user_results,
        "dynamic_email_cleanup_results": dynamic_email_results,
        "remaining_user_id_row_counts": remaining_user_id_row_counts,
        "remaining_email_row_counts": remaining_email_row_counts,
        "firebase_auth_deleted": False,
        "browser_local_state_deleted": False,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--email", required=True, help="User-authored email to reset.")
    parser.add_argument("--user-id", action="append", default=[], help="Optional explicit Firebase UID.")
    parser.add_argument("--include-counts", action="store_true", help="Include bounded row counts. Can be slow on large UAT tables.")
    parser.add_argument("--execute", action="store_true", help="Perform deletion. Omit for dry run.")
    parser.add_argument("--confirm-email", default="", help="Required with --execute; must equal --email.")
    return parser.parse_args()


def main() -> None:
    result = asyncio.run(run(parse_args()))
    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
