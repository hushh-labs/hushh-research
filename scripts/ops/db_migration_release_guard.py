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
from collections import Counter
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
from dotenv import load_dotenv


SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = SCRIPT_PATH.parents[2]
DEFAULT_MIGRATIONS_DIR = REPO_ROOT / "consent-protocol" / "db" / "migrations"
DEFAULT_CONTRACT_FILE = (
    REPO_ROOT / "consent-protocol" / "db" / "contracts" / "prod_core_schema.json"
)
DEFAULT_MANIFEST_FILE = (
    REPO_ROOT / "consent-protocol" / "db" / "release_migration_manifest.json"
)
load_dotenv(REPO_ROOT / "consent-protocol" / ".env")
MIGRATION_PATTERN = re.compile(r"^(?P<version>\d{3})_[a-z0-9_]+\.sql$")
VALID_VERSION_POLICIES = {"exact", "minimum"}
RELEASE_ENVIRONMENTS = {"production", "uat"}


@dataclass(frozen=True)
class MigrationFile:
    version: int
    filename: str
    path: Path


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_migration_files(
    migrations_dir: Path,
) -> tuple[list[MigrationFile], list[str]]:
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
    if (
        not isinstance(version_policy, str)
        or version_policy not in VALID_VERSION_POLICIES
    ):
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


def _load_release_lane(
    manifest_file: Path,
    *,
    release_environment: str,
    migration_files: list[MigrationFile],
) -> tuple[list[str], dict[str, Any], list[str]]:
    """Load one governed lane and verify the canonical base/overlay union."""
    if not manifest_file.exists():
        return [], {}, [f"release_manifest_missing:{manifest_file}"]
    try:
        payload = json.loads(manifest_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return [], {}, [f"release_manifest_json_invalid:{exc}"]

    violations: list[str] = []
    base = payload.get("ordered_migrations")
    overlays = payload.get("environment_overlays")
    groups = payload.get("groups")
    if not isinstance(base, list) or not base:
        violations.append("release_manifest_ordered_migrations_missing_or_invalid")
        base = []
    if not isinstance(overlays, dict):
        violations.append("release_manifest_environment_overlays_missing_or_invalid")
        overlays = {}
    if set(overlays) != {"uat"}:
        violations.append("release_manifest_environment_overlays_must_define_only_uat")
    uat_overlay = overlays.get("uat")
    if not isinstance(uat_overlay, list) or not uat_overlay:
        violations.append("release_manifest_uat_overlay_missing_or_invalid")
        uat_overlay = []

    base_names = [str(name).strip() for name in base if str(name).strip()]
    overlay_names = [str(name).strip() for name in uat_overlay if str(name).strip()]
    canonical_names = base_names + overlay_names
    duplicates = sorted(
        name for name, count in Counter(canonical_names).items() if count != 1
    )
    if duplicates:
        violations.append("release_manifest_duplicate_entries:" + ",".join(duplicates))

    available_names = {item.filename for item in migration_files}
    for name in canonical_names:
        if name not in available_names:
            violations.append(f"release_manifest_missing_file:{name}")

    if migration_files and migration_files[-1].filename not in set(canonical_names):
        violations.append(
            f"release_manifest_repo_head_unaccounted:{migration_files[-1].filename}"
        )

    base_set = set(base_names)
    if not isinstance(groups, dict):
        violations.append("release_manifest_groups_missing_or_invalid")
    else:
        for group_name, entries in groups.items():
            if not isinstance(entries, list):
                violations.append(f"release_manifest_group_invalid:{group_name}")
                continue
            outside_base = sorted(set(entries) - base_set)
            if outside_base:
                violations.append(
                    f"release_manifest_group_outside_base:{group_name}:"
                    + ",".join(outside_base)
                )

    selected_names = base_names
    if release_environment == "uat":
        selected_names = base_names + overlay_names
    selected_versions: list[int] = []
    for name in selected_names:
        match = MIGRATION_PATTERN.match(name)
        if match is None:
            violations.append(f"release_manifest_invalid_filename:{name}")
            continue
        selected_versions.append(int(match.group("version")))
    if selected_versions != sorted(selected_versions) or len(selected_versions) != len(
        set(selected_versions)
    ):
        violations.append(f"release_manifest_non_monotonic_lane:{release_environment}")

    metadata = {
        "path": str(manifest_file),
        "release_environment": release_environment,
        "base_count": len(base_names),
        "uat_overlay_count": len(overlay_names),
        "canonical_count": len(canonical_names),
        "selected_count": len(selected_names),
        "selected_head": max(selected_versions) if selected_versions else None,
    }
    return selected_names, metadata, violations


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
    # Cloud SQL is reached over the Auth Proxy (loopback) or the Unix socket,
    # both already secured, so no explicit sslmode is required.
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


async def _run_db_contract_check(
    contract: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
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
            regclass = await conn.fetchval(
                "SELECT to_regclass($1)", f"public.{table_name}"
            )
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
                violations.append(
                    f"missing_columns:{table_name}:{','.join(missing_columns)}"
                )

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
    manifest_file = Path(args.manifest_file).resolve()
    started_at = datetime.now(timezone.utc)

    migration_files, violations = _parse_migration_files(migrations_dir)
    selected_migrations, manifest_metadata, manifest_violations = _load_release_lane(
        manifest_file,
        release_environment=args.release_environment,
        migration_files=migration_files,
    )
    violations.extend(manifest_violations)
    contract_payload, contract_violations = _load_contract(contract_file)
    violations.extend(contract_violations)

    selected_versions = [
        int(match.group("version"))
        for name in selected_migrations
        if (match := MIGRATION_PATTERN.match(name)) is not None
    ]
    selected_lane_head = max(selected_versions) if selected_versions else None
    highest_repo_version = migration_files[-1].version if migration_files else None
    expected_contract_version = contract_payload.get("expected_migration_version")
    version_policy = contract_payload.get("migration_version_policy", "exact")
    if isinstance(selected_lane_head, int) and isinstance(
        expected_contract_version, int
    ):
        if (
            version_policy == "exact"
            and selected_lane_head != expected_contract_version
        ):
            violations.append(
                "contract_version_mismatch:"
                f"policy=exact:selected_lane={selected_lane_head:03d}:"
                f"expected={expected_contract_version:03d}"
            )
        elif (
            version_policy == "minimum"
            and selected_lane_head < expected_contract_version
        ):
            violations.append(
                "contract_version_mismatch:"
                f"policy=minimum:selected_lane={selected_lane_head:03d}:"
                f"expected_min={expected_contract_version:03d}"
            )

    db_check_results: dict[str, Any] | None = None
    if not args.skip_db_check and not contract_violations:
        try:
            db_check_results, db_violations = asyncio.run(
                _run_db_contract_check(contract_payload)
            )
            violations.extend(db_violations)
        except Exception as exc:  # noqa: BLE001
            violations.append(f"db_contract_check_failed:{exc}")

    report = {
        "checked_at": _now_iso(),
        "status": "ok" if not violations else "error",
        "policy": {
            "skip_db_check": bool(args.skip_db_check),
            "migrations_dir": str(migrations_dir),
            "manifest_file": str(manifest_file),
            "release_environment": args.release_environment,
            "contract_file": str(contract_file),
            "migration_version_policy": version_policy,
        },
        "release_manifest": manifest_metadata,
        "migrations": {
            "count": len(migration_files),
            "versions": [item.version for item in migration_files],
            "files": [item.filename for item in migration_files],
            "highest_local_version": highest_repo_version,
            "highest_repo_version": highest_repo_version,
            "selected_lane_count": len(selected_migrations),
            "selected_lane_head": selected_lane_head,
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
        "--manifest-file",
        default=str(DEFAULT_MANIFEST_FILE),
        help=f"Path to release migration manifest (default: {DEFAULT_MANIFEST_FILE}).",
    )
    parser.add_argument(
        "--release-environment",
        choices=sorted(RELEASE_ENVIRONMENTS),
        default="production",
        help=(
            "Select the manifest lane used for the contract version check. "
            "Defaults to the production-safe base lane."
        ),
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
