#!/usr/bin/env python3
"""Synchronize CapabilityRunV1 schema-contract projections from migration 209.

The release contracts are runtime readiness projections, not a second source of
truth for table DDL.  This small generator derives the durable-run columns from
the checked-in migration and derives each lane head from the canonical release
manifest.  ``--check`` is suitable for CI and rejects a manually stale or
incomplete projection.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

CONSENT_PROTOCOL_ROOT = Path(__file__).resolve().parents[1]
MIGRATION_NAME = "209_one_capability_runs.sql"
MIGRATION_PATH = CONSENT_PROTOCOL_ROOT / "db" / "migrations" / MIGRATION_NAME
MANIFEST_PATH = CONSENT_PROTOCOL_ROOT / "db" / "release_migration_manifest.json"
TABLE_NAME = "one_capability_runs"
CONTRACT_LANES = {
    "prod_core_schema.json": "base",
    "dev_minimum_schema.json": "base",
    "uat_integrated_schema.json": "uat",
}
_CREATE_TABLE_RE = re.compile(
    rf"\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?{TABLE_NAME}\s*\(",
    re.IGNORECASE,
)
_COLUMN_NAME_RE = re.compile(r'^"?([A-Za-z_][A-Za-z0-9_$]*)"?\s+')
_TABLE_CONSTRAINTS = frozenset({"constraint", "primary", "foreign", "unique", "check", "exclude"})


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _find_create_table_body(sql: str) -> str:
    """Return the balanced parenthesized body for the migration's table DDL."""
    match = _CREATE_TABLE_RE.search(sql)
    if match is None:
        raise ValueError(f"Missing CREATE TABLE statement for {TABLE_NAME}.")

    depth = 1
    quote: str | None = None
    index = match.end()
    body_start = index
    while index < len(sql):
        character = sql[index]
        if quote is not None:
            if character == quote:
                if quote == "'" and index + 1 < len(sql) and sql[index + 1] == "'":
                    index += 2
                    continue
                quote = None
            index += 1
            continue
        if character in {"'", '"'}:
            quote = character
        elif character == "(":
            depth += 1
        elif character == ")":
            depth -= 1
            if depth == 0:
                return sql[body_start:index]
        index += 1
    raise ValueError(f"Unterminated CREATE TABLE statement for {TABLE_NAME}.")


def _split_top_level_definitions(body: str) -> list[str]:
    """Split SQL definitions on commas outside nested expressions and strings."""
    definitions: list[str] = []
    start = 0
    depth = 0
    quote: str | None = None
    index = 0
    while index < len(body):
        character = body[index]
        if quote is not None:
            if character == quote:
                if quote == "'" and index + 1 < len(body) and body[index + 1] == "'":
                    index += 2
                    continue
                quote = None
            index += 1
            continue
        if character in {"'", '"'}:
            quote = character
        elif character == "(":
            depth += 1
        elif character == ")":
            depth -= 1
        elif character == "," and depth == 0:
            definitions.append(body[start:index])
            start = index + 1
        index += 1
    definitions.append(body[start:])
    return definitions


def capability_run_columns(migration_text: str | None = None) -> list[str]:
    """Extract top-level table columns from migration 209, preserving DDL order."""
    sql = (
        migration_text if migration_text is not None else MIGRATION_PATH.read_text(encoding="utf-8")
    )
    columns: list[str] = []
    for definition in _split_top_level_definitions(_find_create_table_body(sql)):
        match = _COLUMN_NAME_RE.match(definition.strip())
        if match is None:
            continue
        name = match.group(1)
        if name.lower() not in _TABLE_CONSTRAINTS:
            columns.append(name)
    if not columns or len(columns) != len(set(columns)):
        raise ValueError(f"Invalid column projection for {TABLE_NAME}.")
    return columns


def _migration_version(name: str) -> int:
    return int(name.split("_", 1)[0])


def release_lane_heads(manifest: dict[str, Any] | None = None) -> dict[str, int]:
    """Return base and UAT release heads from the canonical manifest."""
    release_manifest = manifest or _load_json(MANIFEST_PATH)
    base_names = release_manifest.get("ordered_migrations")
    overlays = release_manifest.get("environment_overlays")
    if not isinstance(base_names, list) or MIGRATION_NAME not in base_names:
        raise ValueError(f"{MIGRATION_NAME} must be declared in ordered_migrations.")
    if not isinstance(overlays, dict) or not isinstance(overlays.get("uat"), list):
        raise ValueError("Release manifest must declare the UAT overlay list.")
    base_versions = [_migration_version(str(name)) for name in base_names]
    uat_versions = base_versions + [_migration_version(str(name)) for name in overlays["uat"]]
    return {"base": max(base_versions), "uat": max(uat_versions)}


def _with_capability_run_projection(
    contract: dict[str, Any],
    *,
    columns: list[str],
    expected_migration_version: int,
) -> dict[str, Any]:
    required_tables = contract.get("required_tables")
    if not isinstance(required_tables, dict):
        raise ValueError("Schema contract must contain required_tables.")

    projected_tables: dict[str, Any] = {}
    inserted = False
    for table_name, table_columns in required_tables.items():
        if table_name == TABLE_NAME:
            continue
        if not inserted and TABLE_NAME < table_name:
            projected_tables[TABLE_NAME] = columns
            inserted = True
        projected_tables[table_name] = table_columns
    if not inserted:
        projected_tables[TABLE_NAME] = columns

    projected_contract = dict(contract)
    projected_contract["expected_migration_version"] = expected_migration_version
    projected_contract["required_tables"] = projected_tables
    return projected_contract


def expected_contracts() -> dict[Path, dict[str, Any]]:
    """Build all derived contract payloads without writing them."""
    columns = capability_run_columns()
    lane_heads = release_lane_heads()
    contracts_dir = CONSENT_PROTOCOL_ROOT / "db" / "contracts"
    return {
        contracts_dir / filename: _with_capability_run_projection(
            _load_json(contracts_dir / filename),
            columns=columns,
            expected_migration_version=lane_heads[lane],
        )
        for filename, lane in CONTRACT_LANES.items()
    }


def synchronize(*, check: bool = False) -> int:
    """Write projections, or return non-zero if ``--check`` finds drift."""
    stale_paths: list[Path] = []
    for path, payload in expected_contracts().items():
        rendered = json.dumps(payload, indent=2) + "\n"
        if path.read_text(encoding="utf-8") == rendered:
            continue
        if check:
            stale_paths.append(path)
        else:
            path.write_text(rendered, encoding="utf-8")
    if stale_paths:
        print(
            "CapabilityRunV1 schema-contract projections are stale: "
            + ", ".join(str(path.relative_to(CONSENT_PROTOCOL_ROOT)) for path in stale_paths)
        )
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Synchronize CapabilityRunV1 schema-contract projections from migration 209."
    )
    parser.add_argument(
        "--check", action="store_true", help="Fail instead of writing stale contracts."
    )
    args = parser.parse_args()
    return synchronize(check=args.check)


if __name__ == "__main__":
    raise SystemExit(main())
