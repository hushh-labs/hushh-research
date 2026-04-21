#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

from __future__ import annotations

import argparse
import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_DIR = REPO_ROOT / "consent-protocol" / "db" / "migrations"
MANIFEST_PATH = REPO_ROOT / "consent-protocol" / "db" / "release_migration_manifest.json"
UAT_CONTRACT_PATH = REPO_ROOT / "consent-protocol" / "db" / "contracts" / "uat_integrated_schema.json"
PROD_CONTRACT_PATH = REPO_ROOT / "consent-protocol" / "db" / "contracts" / "prod_core_schema.json"


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _migration_version(filename: str) -> int:
    return int(filename.split("_", 1)[0])


def build_report() -> dict:
    manifest = _load_json(MANIFEST_PATH)
    uat_contract = _load_json(UAT_CONTRACT_PATH)
    prod_contract = _load_json(PROD_CONTRACT_PATH)

    ordered = manifest.get("ordered_migrations") or []
    migration_versions = sorted(
        _migration_version(path.name)
        for path in MIGRATIONS_DIR.iterdir()
        if path.is_file() and path.name[:3].isdigit() and path.suffix == ".sql"
    )

    violations: list[str] = []

    if not ordered:
        violations.append("release_manifest_missing_ordered_migrations")

    for migration_name in ordered:
        if not (MIGRATIONS_DIR / migration_name).exists():
            violations.append(f"release_manifest_missing_file:{migration_name}")

    manifest_versions = [_migration_version(name) for name in ordered]
    highest_manifest_version = max(manifest_versions) if manifest_versions else None
    highest_repo_version = max(migration_versions) if migration_versions else None

    if highest_manifest_version != highest_repo_version:
        violations.append(
            "release_manifest_not_at_repo_head:"
            f"manifest={highest_manifest_version}:repo={highest_repo_version}"
        )

    if uat_contract.get("migration_version_policy") != "exact":
        violations.append("uat_contract_policy_must_be_exact")
    if uat_contract.get("expected_migration_version") != highest_manifest_version:
        violations.append(
            "uat_contract_version_mismatch:"
            f"contract={uat_contract.get('expected_migration_version')}:manifest={highest_manifest_version}"
        )

    if prod_contract.get("migration_version_policy") != "minimum":
        violations.append("prod_contract_policy_must_be_minimum")

    prod_version = prod_contract.get("expected_migration_version")
    if isinstance(prod_version, int) and isinstance(highest_manifest_version, int):
        if prod_version > highest_manifest_version:
            violations.append(
                "prod_contract_exceeds_release_manifest:"
                f"prod={prod_version}:manifest={highest_manifest_version}"
            )
    else:
        violations.append("prod_contract_expected_migration_version_missing_or_invalid")

    return {
        "status": "ok" if not violations else "error",
        "release_manifest": {
            "path": str(MANIFEST_PATH.relative_to(REPO_ROOT)),
            "migration_count": len(ordered),
            "highest_manifest_version": highest_manifest_version,
            "highest_repo_version": highest_repo_version,
        },
        "contracts": {
            "uat_integrated_schema": {
                "path": str(UAT_CONTRACT_PATH.relative_to(REPO_ROOT)),
                "policy": uat_contract.get("migration_version_policy"),
                "expected_version": uat_contract.get("expected_migration_version"),
            },
            "prod_core_schema": {
                "path": str(PROD_CONTRACT_PATH.relative_to(REPO_ROOT)),
                "policy": prod_contract.get("migration_version_policy"),
                "expected_version": prod_contract.get("expected_migration_version"),
            },
        },
        "violations": violations,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify release migration manifest and contract alignment.")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of text.")
    args = parser.parse_args()

    report = build_report()
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(f"Release manifest highest version: {report['release_manifest']['highest_manifest_version']}")
        print(f"Repo migration head: {report['release_manifest']['highest_repo_version']}")
        print(
            "UAT contract: "
            f"{report['contracts']['uat_integrated_schema']['expected_version']} "
            f"({report['contracts']['uat_integrated_schema']['policy']})"
        )
        print(
            "Prod contract: "
            f"{report['contracts']['prod_core_schema']['expected_version']} "
            f"({report['contracts']['prod_core_schema']['policy']})"
        )
        if report["violations"]:
            for violation in report["violations"]:
                print(f"ERROR: {violation}")
        else:
            print("Release migration manifest and schema contracts are aligned.")
    return 0 if report["status"] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
