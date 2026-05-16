#!/usr/bin/env python3
"""DB migration governance guard.

Checks:
1) Migration filename ordering/monotonicity in consent-protocol/db/migrations.
2) Contract version policy compliance (`expected_migration_version` + `migration_version_policy`).
3) Live DB schema drift for the selected environment contract (read-only).

Read-only by default. Exits non-zero on policy violations.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus

import asyncpg


SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = SCRIPT_PATH.parents[2]
DEFAULT_MIGRATIONS_DIR = REPO_ROOT / "consent-protocol" / "db" / "migrations"
DEFAULT_CONTRACT_FILE = (
    REPO_ROOT / "consent-protocol" / "db" / "contracts" / "prod_core_schema.json"
)
MIGRATION_PATTERN = re.compile(r"^(?P<version>\d{3})_[a-z0-9_]+\.sql$")
VALID_VERSION_POLICIES = {"exact", "minimum"}


@dataclass(frozen=True)
class MigrationFile:
    version: int
    filename: str
    path: Path


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_migration_files(migrations_dir: Path) -> tuple[list[MigrationFile], list[str]]:
    violations: list[str] = []
    if not migrations_dir.exists():
        return [], [f"migrations_dir_missing:{migrations_dir}"]

    files = sorted([p for p in migrations_dir.iterdir() if p.is_file()])
    parsed: list[MigrationFile] = []
    seen_versions: set[int] = set()
    for path in files:
        match = MIGRATION_PATTERN.match(path.name)
        if not match:
            continue
        version = int(match.group("version"))
        if version in seen_versions:
            violations.append(f"duplicate_migration_version:{version:03d}")
        seen_versions.add(version)
        parsed.append(MigrationFile(version=version, filename=path.name, path=path))

    if not parsed:
        violations.append("no_versioned_migrations_found")
        return [], violations

    parsed.sort(key=lambda item: (item.version, item.filename))
    prev_version = parsed[0].version
    for item in parsed[1:]:
        if item.version <= prev_version:
            violations.append(
                f"non_monotonic_migration_version:{item.filename}:prev={prev_version:03d}"
            )
        prev_version = item.version

    return parsed, violations


def _load_contract(contract_file: Path) -> tuple[dict[str, Any], list[str]]:
    if not contract_file.exists():
        return {}, [f"contract_file_missing:{contract_file}"]
    try:
        payload = json.loads(contract_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return {}, [f"contract_json_invalid:{exc}"]

    violations: list[str] = []
    expected_version = payload.get("expected_migration_version")
    if not isinstance(expected_version, int):
        violations.append("contract_expected_migration_version_missing_or_invalid")
    version_policy = payload.get("migration_version_policy", "exact")
    if not isinstance(version_policy, str) or version_policy not in VALID_VERSION_POLICIES:
        violations.append("contract_migration_version_policy_invalid")
    required_functions = payload.get("required_functions", [])
    if required_functions:
        if not isinstance(required_functions, list):
            violations.append("contract_required_functions_invalid")
        else:
            for function_name in required_functions:
                if not isinstance(function_name, str) or not function_name.strip():
                    violations.append("contract_required_functions_invalid_name")
                    break
    required_tables = payload.get("required_tables")
    if not isinstance(required_tables, dict) or not required_tables:
        violations.append("contract_required_tables_missing_or_invalid")
    else:
        for table_name, columns in required_tables.items():
            if not isinstance(table_name, str) or not table_name.strip():
                violations.append("contract_required_tables_invalid_table_name")
                continue
            if not isinstance(columns, list) or not columns:
                violations.append(f"contract_required_columns_missing:{table_name}")
                continue
            for column_name in columns:
                if not isinstance(column_name, str) or not column_name.strip():
                    violations.append(f"contract_invalid_column_name:{table_name}")
                    break

    return payload, violations


def _build_database_url_from_env() -> str:
    db_user = os.getenv("DB_USER", "").strip()
    db_password = os.getenv("DB_PASSWORD", "").strip()
    db_host = os.getenv("DB_HOST", "").strip()
    db_socket = os.getenv("DB_UNIX_SOCKET", "").strip()
    db_port = os.getenv("DB_PORT", "5432").strip()
    db_name = os.getenv("DB_NAME", "postgres").strip()

    if not db_user or not db_password or not (db_host or db_socket):
        raise RuntimeError(
            "DB credentials missing. Required: DB_USER, DB_PASSWORD, and one of DB_HOST/DB_UNIX_SOCKET."
        )

    if db_socket:
        return f"postgresql://{quote_plus(db_user)}:{quote_plus(db_password)}@/{quote_plus(db_name)}?host={quote_plus(db_socket)}"

    return (
        f"postgresql://{quote_plus(db_user)}:{quote_plus(db_password)}@"
        f"{db_host}:{db_port}/{quote_plus(db_name)}"
    )


def _database_ssl_from_env() -> str | None:
    if os.getenv("DB_UNIX_SOCKET"):
        return None
    db_host = os.getenv("DB_HOST", "")
    if "supabase.com" in db_host or "pooler.supabase" in db_host:
        return "require"
    return None


async def _fetch_columns(conn: asyncpg.Connection, table_name: str) -> set[str]:
    rows = await conn.fetch(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        """,
        table_name,
    )
    return {str(row["column_name"]) for row in rows}


async def _run_db_contract_check(contract: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    required_tables: dict[str, list[str]] = contract["required_tables"]
    required_functions: list[str] = contract.get("required_functions", [])
    violations: list[str] = []
    table_results: dict[str, Any] = {}
    function_results: dict[str, bool] = {}

    db_url = _build_database_url_from_env()
    ssl = _database_ssl_from_env()
    conn = await asyncpg.connect(db_url, ssl=ssl)
    try:
        for table_name, required_columns in required_tables.items():
            regclass = await conn.fetchval("SELECT to_regclass($1)", f"public.{table_name}")
            if regclass is None:
                violations.append(f"missing_table:{table_name}")
                table_results[table_name] = {
                    "exists": False,
                    "missing_columns": required_columns,
                }
                continue

            actual_columns = await _fetch_columns(conn, table_name)
            missing_columns = sorted(
                [column for column in required_columns if column not in actual_columns]
            )
            if missing_columns:
                violations.append(f"missing_columns:{table_name}:{','.join(missing_columns)}")

            table_results[table_name] = {
                "exists": True,
                "missing_columns": missing_columns,
                "column_count": len(actual_columns),
            }

        for function_name in required_functions:
            exists = await conn.fetchval(
                """
                SELECT EXISTS (
                  SELECT 1
                  FROM pg_proc p
                  JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = $1
                )
                """,
                function_name,
            )
            present = bool(exists)
            function_results[function_name] = present
            if not present:
                violations.append(f"missing_function:{function_name}")
    finally:
        await conn.close()

    return {"tables": table_results, "functions": function_results}, violations


def _run(args: argparse.Namespace) -> int:
    migrations_dir = Path(args.migrations_dir).resolve()
    contract_file = Path(args.contract_file).resolve()
    started_at = datetime.now(timezone.utc)

    migration_files, violations = _parse_migration_files(migrations_dir)
    contract_payload, contract_violations = _load_contract(contract_file)
    violations.extend(contract_violations)

    highest_local_version = migration_files[-1].version if migration_files else None
    expected_contract_version = contract_payload.get("expected_migration_version")
    version_policy = contract_payload.get("migration_version_policy", "exact")
    if isinstance(highest_local_version, int) and isinstance(expected_contract_version, int):
        if version_policy == "exact" and highest_local_version != expected_contract_version:
            violations.append(
                "contract_version_mismatch:"
                f"policy=exact:highest_local={highest_local_version:03d}:expected={expected_contract_version:03d}"
            )
        elif version_policy == "minimum" and highest_local_version < expected_contract_version:
            violations.append(
                "contract_version_mismatch:"
                f"policy=minimum:highest_local={highest_local_version:03d}:expected_min={expected_contract_version:03d}"
            )

    db_check_results: dict[str, Any] | None = None
    if not args.skip_db_check and not contract_violations:
        try:
            db_check_results, db_violations = asyncio.run(_run_db_contract_check(contract_payload))
            violations.extend(db_violations)
        except Exception as exc:  # noqa: BLE001
            violations.append(f"db_contract_check_failed:{exc}")

    report = {
        "checked_at": _now_iso(),
        "status": "ok" if not violations else "error",
        "policy": {
            "skip_db_check": bool(args.skip_db_check),
            "migrations_dir": str(migrations_dir),
            "contract_file": str(contract_file),
            "migration_version_policy": version_policy,
        },
        "migrations": {
            "count": len(migration_files),
            "versions": [item.version for item in migration_files],
            "files": [item.filename for item in migration_files],
            "highest_local_version": highest_local_version,
            "expected_contract_version": expected_contract_version,
        },
        "db_contract": db_check_results,
        "violations": violations,
        "duration_ms": round(
            (datetime.now(timezone.utc) - started_at).total_seconds() * 1000.0, 2
        ),
    }

    if args.report_path:
        report_path = Path(args.report_path)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    if args.print_json:
        print(json.dumps(report, indent=2))
    else:
        print(f"migration guard status={report['status']} violations={len(violations)}")

    return 0 if not violations else 1


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Guard production migration governance and DB schema drift."
    )
    parser.add_argument(
        "--migrations-dir",
        default=str(DEFAULT_MIGRATIONS_DIR),
        help=f"Path to migration SQL directory (default: {DEFAULT_MIGRATIONS_DIR}).",
    )
    parser.add_argument(
        "--contract-file",
        default=str(DEFAULT_CONTRACT_FILE),
        help=f"Path to schema contract JSON (default: {DEFAULT_CONTRACT_FILE}).",
    )
    parser.add_argument(
        "--skip-db-check",
        action="store_true",
        help="Skip live DB schema contract check (ordering/contract checks still run).",
    )
    parser.add_argument(
        "--report-path",
        default="",
        help="Optional JSON report output path.",
    )
    parser.add_argument(
        "--print-json",
        action="store_true",
        default=True,
        help="Print JSON report to stdout (default: true).",
    )
    return parser.parse_args()


if __name__ == "__main__":
    sys.exit(_run(_parse_args()))
