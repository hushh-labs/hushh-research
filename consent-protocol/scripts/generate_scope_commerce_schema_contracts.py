#!/usr/bin/env python3
"""Derive paid-scope and placement readiness contracts from their registered SQL owners.

SQL owns table shape; the release manifest owns environment heads. Preserve
other owned projections and reject schema drift with ``--check``.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from generate_location_onboarding_runtime_schema_contracts import table_columns

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_NAME = "401_consumer_scope_commerce.sql"
MANIFEST_PATH = ROOT / "db" / "release_migration_manifest.json"
CONTRACT_LANES = {
    "prod_core_schema.json": "base",
    "dev_minimum_schema.json": "base",
    "uat_integrated_schema.json": "uat",
}


def expected_contracts() -> dict[Path, dict]:
    migration = (ROOT / "db" / "migrations" / MIGRATION_NAME).read_text()
    tables = tuple(
        re.findall(
            r"\bCREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(scope_commerce_\w+)\s*\(",
            migration,
            re.IGNORECASE,
        )
    )
    if not tables or len(tables) != len(set(tables)):
        raise ValueError("Invalid scope commerce table declarations")
    projections = table_columns(migration, table_names=tables)
    placement = (ROOT / "db/migrations/404_one_placement_reader_foundation.sql").read_text()
    placement_projections = table_columns(
        placement, table_names=("personal_agent_registry", "byoc_setup_jobs")
    )
    functions = re.findall(
        r"\bCREATE\s+OR\s+REPLACE\s+FUNCTION\s+(scope_commerce_\w+)\s*\(",
        migration,
        re.IGNORECASE,
    )
    binding_migration = "406_stripe_payout_source_binding.sql"
    functions += re.findall(
        r"\bCREATE\s+OR\s+REPLACE\s+FUNCTION\s+(enforce_stripe_payout_source_binding|scope_commerce_payout_account_claims_v1)\s*\(",
        (ROOT / "db/migrations" / binding_migration).read_text(),
        re.IGNORECASE,
    )
    manifest = json.loads(MANIFEST_PATH.read_text())
    base = manifest["ordered_migrations"]
    if MIGRATION_NAME not in base or binding_migration not in base:
        raise ValueError("Scope commerce migration must be registered in the release lane")

    def head(names: list[str]) -> int:
        return max(int(name.split("_", 1)[0]) for name in names)

    heads = {"base": head(base), "uat": head(base + manifest["environment_overlays"]["uat"])}
    result = {}
    for filename, lane in CONTRACT_LANES.items():
        path = ROOT / "db" / "contracts" / filename
        payload = json.loads(path.read_text())
        # This namespace belongs to this migration; removed columns/tables must
        # not survive in a previously generated readiness projection.
        preserved = {
            name: columns
            for name, columns in payload["required_tables"].items()
            if not name.startswith("scope_commerce_")
        }
        payload["required_tables"] = dict(sorted({**preserved, **projections}.items()))
        for table, columns in placement_projections.items():
            payload["required_tables"][table] = sorted(
                set(payload["required_tables"].get(table, [])) | set(columns)
            )
        vault = payload["required_tables"]["vault_keys"]
        for column in (
            "one_hosting_choice",
            "one_hosting_choice_at",
            "one_hosting_legacy_shared_at",
        ):
            if column not in vault:
                vault.append(column)
        payload["required_tables"] = dict(sorted(payload["required_tables"].items()))
        payload["required_functions"] = [
            name
            for name in payload["required_functions"]
            if not name.startswith("scope_commerce_")
            and name != "enforce_stripe_payout_source_binding"
        ] + functions
        payload["expected_migration_version"] = heads[lane]
        payload["expected_schema_head"] = heads[lane]
        result[path] = payload
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    stale = []
    for path, payload in expected_contracts().items():
        encoded = json.dumps(payload, indent=2) + "\n"
        if args.check:
            if path.read_text() != encoded:
                stale.append(str(path.relative_to(ROOT)))
        else:
            path.write_text(encoded)
    if stale:
        print("Stale scope commerce schema contracts: " + ", ".join(stale))
        return 1
    print(
        "Scope commerce schema contracts verified"
        if args.check
        else "Scope commerce schema contracts generated"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
