#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

from __future__ import annotations

import argparse
import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
PROD_CONTRACT_PATH = (
    REPO_ROOT / "consent-protocol" / "db" / "contracts" / "prod_core_schema.json"
)
INTEGRATED_CONTRACT_PATH = (
    REPO_ROOT / "consent-protocol" / "db" / "contracts" / "uat_integrated_schema.json"
)
MANIFEST_PATH = (
    REPO_ROOT / "consent-protocol" / "db" / "release_migration_manifest.json"
)
UAT_ONLY_TABLES = {
    "hushh_tech_launch_authorizations",
    "hushh_tech_account_links",
    "hushh_tech_link_events",
    "hushh_tech_shadow_records",
    "hushh_tech_migration_runs",
    "hushh_tech_migration_events",
}


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def build_report(prod_contract_path: Path, integrated_contract_path: Path) -> dict:
    prod = _load_json(prod_contract_path)
    integrated = _load_json(integrated_contract_path)
    manifest = _load_json(MANIFEST_PATH)

    prod_tables = prod.get("required_tables", {})
    integrated_tables = integrated.get("required_tables", {})
    prod_functions = set(prod.get("required_functions", []))
    integrated_functions = set(integrated.get("required_functions", []))

    missing_tables = sorted(
        name for name in integrated_tables if name not in prod_tables
    )
    shared_table_column_gaps = {}
    for table_name, integrated_columns in integrated_tables.items():
        prod_columns = set(prod_tables.get(table_name, []))
        if not prod_columns:
            continue
        missing_columns = [
            column for column in integrated_columns if column not in prod_columns
        ]
        if missing_columns:
            shared_table_column_gaps[table_name] = missing_columns

    missing_functions = sorted(integrated_functions - prod_functions)
    base = manifest.get("ordered_migrations") or []
    uat_overlay = (manifest.get("environment_overlays") or {}).get("uat") or []
    base_head = int(base[-1].split("_", 1)[0]) if base else None
    uat_head = int(uat_overlay[-1].split("_", 1)[0]) if uat_overlay else base_head
    expected_overlay_tables = sorted(UAT_ONLY_TABLES)
    overlay_is_exact = missing_tables == expected_overlay_tables
    versions_match_lanes = (
        prod.get("expected_migration_version") == base_head
        and integrated.get("expected_migration_version") == uat_head
    )
    at_parity = (
        overlay_is_exact
        and versions_match_lanes
        and not shared_table_column_gaps
        and not missing_functions
    )

    return {
        "status": "ok" if at_parity else "error",
        "policy": "production_base_with_exact_uat_overlay",
        "prod_contract": {
            "path": str(prod_contract_path.relative_to(REPO_ROOT)),
            "expected_migration_version": prod.get("expected_migration_version"),
            "migration_version_policy": prod.get("migration_version_policy"),
        },
        "integrated_reference": {
            "path": str(integrated_contract_path.relative_to(REPO_ROOT)),
            "expected_migration_version": integrated.get("expected_migration_version"),
            "migration_version_policy": integrated.get("migration_version_policy"),
        },
        "parity_gaps": {
            "tables_not_in_prod_contract": missing_tables,
            "expected_uat_only_tables": expected_overlay_tables,
            "overlay_is_exact": overlay_is_exact,
            "versions_match_manifest_lanes": versions_match_lanes,
            "shared_table_missing_columns": shared_table_column_gaps,
            "functions_not_in_prod_contract": missing_functions,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify the production base contract and exact declared UAT overlay."
    )
    parser.add_argument(
        "--json", action="store_true", help="Emit JSON instead of text."
    )
    parser.add_argument(
        "--prod-contract",
        default=str(PROD_CONTRACT_PATH),
        help="Production contract file.",
    )
    parser.add_argument(
        "--integrated-contract",
        default=str(INTEGRATED_CONTRACT_PATH),
        help="Integrated reference contract file.",
    )
    args = parser.parse_args()

    report = build_report(Path(args.prod_contract), Path(args.integrated_contract))
    exit_code = 0 if report["status"] == "ok" else 1
    if args.json:
        print(json.dumps(report, indent=2))
        return exit_code

    print(
        "Production posture: "
        + (
            "base and UAT overlay aligned"
            if exit_code == 0
            else "unexpected contract drift"
        )
    )
    print(
        f"Prod contract: v{report['prod_contract']['expected_migration_version']} "
        f"({report['prod_contract']['migration_version_policy']})"
    )
    print(
        f"Integrated reference: v{report['integrated_reference']['expected_migration_version']} "
        f"({report['integrated_reference']['migration_version_policy']})"
    )
    print("")
    print("Tables isolated to the UAT overlay:")
    for table_name in report["parity_gaps"]["tables_not_in_prod_contract"] or [
        "(none)"
    ]:
        print(f"- {table_name}")
    print("")
    print("Shared tables with integrated-only columns:")
    if report["parity_gaps"]["shared_table_missing_columns"]:
        for table_name, columns in report["parity_gaps"][
            "shared_table_missing_columns"
        ].items():
            print(f"- {table_name}: {', '.join(columns)}")
    else:
        print("- (none)")
    print("")
    print("Functions absent from prod contract (expected none):")
    for function_name in report["parity_gaps"]["functions_not_in_prod_contract"] or [
        "(none)"
    ]:
        print(f"- {function_name}")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
