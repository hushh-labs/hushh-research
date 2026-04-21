#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

from __future__ import annotations

import argparse
import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
PROD_CONTRACT_PATH = REPO_ROOT / "consent-protocol" / "db" / "contracts" / "prod_core_schema.json"
INTEGRATED_CONTRACT_PATH = REPO_ROOT / "consent-protocol" / "db" / "contracts" / "uat_integrated_schema.json"


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def build_report(prod_contract_path: Path, integrated_contract_path: Path) -> dict:
    prod = _load_json(prod_contract_path)
    integrated = _load_json(integrated_contract_path)

    prod_tables = prod.get("required_tables", {})
    integrated_tables = integrated.get("required_tables", {})
    prod_functions = set(prod.get("required_functions", []))
    integrated_functions = set(integrated.get("required_functions", []))

    frozen_tables = sorted(name for name in integrated_tables if name not in prod_tables)
    shared_table_column_gaps = {}
    for table_name, integrated_columns in integrated_tables.items():
        prod_columns = set(prod_tables.get(table_name, []))
        if not prod_columns:
            continue
        missing_columns = [column for column in integrated_columns if column not in prod_columns]
        if missing_columns:
            shared_table_column_gaps[table_name] = missing_columns

    return {
        "status": "ok",
        "policy": "production_frozen_by_contract",
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
        "intentional_gaps": {
            "tables_not_in_prod_contract": frozen_tables,
            "shared_table_missing_columns": shared_table_column_gaps,
            "functions_not_in_prod_contract": sorted(integrated_functions - prod_functions),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Report the intentional delta between prod core and integrated UAT DB contracts.")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of text.")
    parser.add_argument("--prod-contract", default=str(PROD_CONTRACT_PATH), help="Production frozen contract file.")
    parser.add_argument("--integrated-contract", default=str(INTEGRATED_CONTRACT_PATH), help="Integrated reference contract file.")
    args = parser.parse_args()

    report = build_report(Path(args.prod_contract), Path(args.integrated_contract))
    if args.json:
        print(json.dumps(report, indent=2))
        return 0

    print("Production posture: frozen by policy")
    print(
        f"Prod contract: v{report['prod_contract']['expected_migration_version']} "
        f"({report['prod_contract']['migration_version_policy']})"
    )
    print(
        f"Integrated reference: v{report['integrated_reference']['expected_migration_version']} "
        f"({report['integrated_reference']['migration_version_policy']})"
    )
    print("")
    print("Tables intentionally absent from prod contract:")
    for table_name in report["intentional_gaps"]["tables_not_in_prod_contract"] or ["(none)"]:
        print(f"- {table_name}")
    print("")
    print("Shared tables with integrated-only columns:")
    if report["intentional_gaps"]["shared_table_missing_columns"]:
        for table_name, columns in report["intentional_gaps"]["shared_table_missing_columns"].items():
            print(f"- {table_name}: {', '.join(columns)}")
    else:
        print("- (none)")
    print("")
    print("Functions intentionally absent from prod contract:")
    for function_name in report["intentional_gaps"]["functions_not_in_prod_contract"] or ["(none)"]:
        print(f"- {function_name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
