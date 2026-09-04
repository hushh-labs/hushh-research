#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_DIR = REPO_ROOT / "consent-protocol" / "db" / "migrations"
MANIFEST_PATH = (
    REPO_ROOT / "consent-protocol" / "db" / "release_migration_manifest.json"
)
UAT_CONTRACT_PATH = (
    REPO_ROOT / "consent-protocol" / "db" / "contracts" / "uat_integrated_schema.json"
)
PROD_CONTRACT_PATH = (
    REPO_ROOT / "consent-protocol" / "db" / "contracts" / "prod_core_schema.json"
)
DEV_CONTRACT_PATH = (
    REPO_ROOT / "consent-protocol" / "db" / "contracts" / "dev_minimum_schema.json"
)


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _migration_version(filename: str) -> int:
    return int(filename.split("_", 1)[0])


def _migration_names(value: object, *, label: str, violations: list[str]) -> list[str]:
    if not isinstance(value, list) or not value:
        violations.append(f"release_manifest_missing_{label}")
        return []
    names = [str(item).strip() for item in value]
    if any(not name for name in names):
        violations.append(f"release_manifest_blank_entry:{label}")
    return [name for name in names if name]


def _versions(names: list[str], *, label: str, violations: list[str]) -> list[int]:
    versions: list[int] = []
    for name in names:
        try:
            versions.append(_migration_version(name))
        except (ValueError, IndexError):
            violations.append(f"release_manifest_non_numeric_entry:{label}:{name}")
    if versions != sorted(versions) or len(versions) != len(set(versions)):
        violations.append(f"release_manifest_non_monotonic_lane:{label}")
    return versions


def build_report() -> dict:
    manifest = _load_json(MANIFEST_PATH)
    uat_contract = _load_json(UAT_CONTRACT_PATH)
    prod_contract = _load_json(PROD_CONTRACT_PATH)
    dev_contract = _load_json(DEV_CONTRACT_PATH)

    violations: list[str] = []
    ordered = _migration_names(
        manifest.get("ordered_migrations"),
        label="ordered_migrations",
        violations=violations,
    )
    raw_overlays = manifest.get("environment_overlays")
    if not isinstance(raw_overlays, dict):
        violations.append("release_manifest_missing_environment_overlays")
        raw_overlays = {}
    unexpected_overlays = sorted(set(raw_overlays) - {"uat"})
    if unexpected_overlays:
        violations.append(
            "release_manifest_unsupported_environment_overlays:"
            + ",".join(unexpected_overlays)
        )
    uat_overlay = _migration_names(
        raw_overlays.get("uat"), label="environment_overlays.uat", violations=violations
    )

    canonical_entries = sorted(
        ordered + uat_overlay,
        key=_migration_version,
    )
    duplicate_entries = sorted(
        name for name, count in Counter(canonical_entries).items() if count != 1
    )
    if duplicate_entries:
        violations.append(
            "release_manifest_duplicate_canonical_entries:"
            + ",".join(duplicate_entries)
        )

    groups = manifest.get("groups")
    if not isinstance(groups, dict):
        violations.append("release_manifest_groups_missing_or_invalid")
        groups = {}
    base_set = set(ordered)
    for group_name, group_entries in groups.items():
        if not isinstance(group_entries, list):
            violations.append(f"release_manifest_group_invalid:{group_name}")
            continue
        outside_base = sorted(set(group_entries) - base_set)
        if outside_base:
            violations.append(
                f"release_manifest_group_outside_base:{group_name}:"
                + ",".join(outside_base)
            )

    migration_versions = sorted(
        _migration_version(path.name)
        for path in MIGRATIONS_DIR.iterdir()
        if path.is_file() and path.name[:3].isdigit() and path.suffix == ".sql"
    )
    for migration_name in canonical_entries:
        if not (MIGRATIONS_DIR / migration_name).exists():
            violations.append(f"release_manifest_missing_file:{migration_name}")

    base_versions = _versions(ordered, label="production", violations=violations)
    uat_versions = _versions(canonical_entries, label="uat", violations=violations)
    canonical_versions = _versions(
        canonical_entries, label="canonical_union", violations=violations
    )
    production_head = max(base_versions) if base_versions else None
    uat_head = max(uat_versions) if uat_versions else None
    highest_repo_version = max(migration_versions) if migration_versions else None

    if highest_repo_version not in set(canonical_versions):
        violations.append(
            "release_manifest_repo_head_unaccounted:"
            f"canonical={max(canonical_versions) if canonical_versions else None}:"
            f"repo={highest_repo_version}"
        )

    if uat_contract.get("migration_version_policy") != "exact":
        violations.append("uat_contract_policy_must_be_exact")
    if uat_contract.get("expected_migration_version") != uat_head:
        violations.append(
            "uat_contract_version_mismatch:"
            f"contract={uat_contract.get('expected_migration_version')}:lane={uat_head}"
        )

    if prod_contract.get("migration_version_policy") != "exact":
        violations.append("prod_contract_policy_must_be_exact")
    prod_version = prod_contract.get("expected_migration_version")
    if not isinstance(prod_version, int):
        violations.append("prod_contract_expected_migration_version_missing_or_invalid")
    elif prod_version != production_head:
        violations.append(
            "prod_contract_version_mismatch:"
            f"contract={prod_version}:lane={production_head}"
        )

    if dev_contract.get("migration_version_policy") != "minimum":
        violations.append("dev_contract_policy_must_be_minimum")
    dev_version = dev_contract.get("expected_migration_version")
    if not isinstance(dev_version, int):
        violations.append("dev_contract_expected_migration_version_missing_or_invalid")
    elif dev_version != production_head:
        violations.append(
            "dev_contract_version_mismatch:"
            f"contract={dev_version}:lane={production_head}"
        )

    return {
        "status": "ok" if not violations else "error",
        "release_manifest": {
            "path": str(MANIFEST_PATH.relative_to(REPO_ROOT)),
            "base_migration_count": len(ordered),
            "uat_overlay_migration_count": len(uat_overlay),
            "canonical_migration_count": len(canonical_entries),
            "migration_count": len(canonical_entries),
            "highest_manifest_version": uat_head,
            "production_head": production_head,
            "uat_head": uat_head,
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
            "dev_minimum_schema": {
                "path": str(DEV_CONTRACT_PATH.relative_to(REPO_ROOT)),
                "policy": dev_contract.get("migration_version_policy"),
                "expected_version": dev_contract.get("expected_migration_version"),
            },
        },
        "violations": violations,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify release migration manifest and contract alignment."
    )
    parser.add_argument(
        "--json", action="store_true", help="Emit JSON instead of text."
    )
    args = parser.parse_args()

    report = build_report()
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(
            f"Production release head: {report['release_manifest']['production_head']}"
        )
        print(f"UAT release head: {report['release_manifest']['uat_head']}")
        print(
            f"Repo migration head: {report['release_manifest']['highest_repo_version']}"
        )
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
        print(
            "Dev contract: "
            f"{report['contracts']['dev_minimum_schema']['expected_version']} "
            f"({report['contracts']['dev_minimum_schema']['policy']})"
        )
        if report["violations"]:
            for violation in report["violations"]:
                print(f"ERROR: {violation}")
        else:
            print("Release migration manifest and schema contracts are aligned.")
    return 0 if report["status"] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
