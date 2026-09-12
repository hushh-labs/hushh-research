#!/usr/bin/env python3
"""Synchronize Location onboarding authority tables from migration 210."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_NAME = "210_one_location_onboarding_runtime.sql"
MIGRATION_PATH = ROOT / "db" / "migrations" / MIGRATION_NAME
MANIFEST_PATH = ROOT / "db" / "release_migration_manifest.json"
TABLE_NAMES = (
    "one_location_onboarding_drafts",
    "one_location_onboarding_interactions",
    "one_location_pkm_finalize_authorizations",
    "one_location_onboarding_receipts",
)
REQUIRED_FUNCTION = "commit_pkm_domain_mutation_v5"
CONTRACT_LANES = {
    "prod_core_schema.json": "base",
    "dev_minimum_schema.json": "base",
    "uat_integrated_schema.json": "uat",
}
_COLUMN_RE = re.compile(r'^"?([A-Za-z_][A-Za-z0-9_$]*)"?\s+')
_CONSTRAINT_WORDS = frozenset({"constraint", "primary", "foreign", "unique", "check", "exclude"})


def _load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _table_body(sql: str, table: str) -> str:
    match = re.search(
        rf"\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?{table}\s*\(",
        sql,
        re.IGNORECASE,
    )
    if match is None:
        raise ValueError(f"Missing CREATE TABLE statement for {table}.")
    start = match.end()
    depth = 1
    quote: str | None = None
    index = start
    while index < len(sql):
        char = sql[index]
        if quote:
            if char == quote:
                if quote == "'" and index + 1 < len(sql) and sql[index + 1] == "'":
                    index += 2
                    continue
                quote = None
        elif char in {"'", '"'}:
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return sql[start:index]
        index += 1
    raise ValueError(f"Unterminated CREATE TABLE statement for {table}.")


def _definitions(body: str) -> list[str]:
    values: list[str] = []
    start = 0
    depth = 0
    quote: str | None = None
    index = 0
    while index < len(body):
        char = body[index]
        if quote:
            if char == quote:
                if quote == "'" and index + 1 < len(body) and body[index + 1] == "'":
                    index += 2
                    continue
                quote = None
        elif char in {"'", '"'}:
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        elif char == "," and depth == 0:
            values.append(body[start:index])
            start = index + 1
        index += 1
    values.append(body[start:])
    return values


def table_columns(sql: str | None = None) -> dict[str, list[str]]:
    source = sql if sql is not None else MIGRATION_PATH.read_text(encoding="utf-8")
    result: dict[str, list[str]] = {}
    for table in TABLE_NAMES:
        columns: list[str] = []
        for definition in _definitions(_table_body(source, table)):
            match = _COLUMN_RE.match(definition.strip())
            if match and match.group(1).lower() not in _CONSTRAINT_WORDS:
                columns.append(match.group(1))
        if not columns or len(columns) != len(set(columns)):
            raise ValueError(f"Invalid column projection for {table}.")
        result[table] = columns
    return result


def release_heads(manifest: dict[str, Any] | None = None) -> dict[str, int]:
    payload = manifest or _load(MANIFEST_PATH)
    base = payload.get("ordered_migrations")
    overlays = payload.get("environment_overlays")
    if not isinstance(base, list) or MIGRATION_NAME not in base:
        raise ValueError(f"{MIGRATION_NAME} must be in ordered_migrations.")
    if not isinstance(overlays, dict) or not isinstance(overlays.get("uat"), list):
        raise ValueError("Release manifest must declare the UAT overlay list.")

    def version(name: Any) -> int:
        return int(str(name).split("_", 1)[0])

    base_versions = [version(name) for name in base]
    return {
        "base": max(base_versions),
        "uat": max(base_versions + [version(name) for name in overlays["uat"]]),
    }


def expected_contracts() -> dict[Path, dict[str, Any]]:
    projections = table_columns()
    heads = release_heads()
    contracts = ROOT / "db" / "contracts"
    expected: dict[Path, dict[str, Any]] = {}
    for filename, lane in CONTRACT_LANES.items():
        path = contracts / filename
        payload = _load(path)
        required = payload.get("required_tables")
        if not isinstance(required, dict):
            raise ValueError(f"{filename} is missing required_tables.")
        merged = {**required, **projections}
        payload["expected_migration_version"] = heads[lane]
        payload["required_tables"] = {name: merged[name] for name in sorted(merged)}
        functions = payload.get("required_functions")
        if not isinstance(functions, list):
            raise ValueError(f"{filename} is missing required_functions.")
        payload["required_functions"] = [
            *functions,
            *([] if REQUIRED_FUNCTION in functions else [REQUIRED_FUNCTION]),
        ]
        expected[path] = payload
    return expected


def synchronize(*, check: bool = False) -> int:
    stale: list[Path] = []
    for path, payload in expected_contracts().items():
        rendered = json.dumps(payload, indent=2) + "\n"
        if path.read_text(encoding="utf-8") == rendered:
            continue
        if check:
            stale.append(path)
        else:
            path.write_text(rendered, encoding="utf-8")
    if stale:
        print("Location onboarding schema contracts are stale: " + ", ".join(map(str, stale)))
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    return synchronize(check=parser.parse_args().check)


if __name__ == "__main__":
    raise SystemExit(main())
