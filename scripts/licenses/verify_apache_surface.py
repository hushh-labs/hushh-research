#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def fail(message: str) -> None:
    raise SystemExit(f"ERROR: {message}")


def ensure_contains(path: Path, needle: str) -> None:
    if needle not in path.read_text(encoding="utf-8"):
        fail(f"{path.relative_to(REPO_ROOT)} is missing expected content: {needle}")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    root_license = REPO_ROOT / "LICENSE"
    root_notice = REPO_ROOT / "NOTICE"
    root_reuse = REPO_ROOT / "REUSE.toml"
    root_third_party = REPO_ROOT / "THIRD_PARTY_NOTICES.md"
    apache_license_text = REPO_ROOT / "LICENSES" / "Apache-2.0.txt"

    protocol_license = REPO_ROOT / "consent-protocol" / "LICENSE"
    protocol_notice = REPO_ROOT / "consent-protocol" / "NOTICE"
    protocol_third_party = REPO_ROOT / "consent-protocol" / "THIRD_PARTY_NOTICES.md"

    for path in (
        root_license,
        root_notice,
        root_reuse,
        root_third_party,
        apache_license_text,
        protocol_license,
        protocol_notice,
        protocol_third_party,
    ):
        if not path.exists():
            fail(f"missing required Apache artifact: {path.relative_to(REPO_ROOT)}")

    ensure_contains(root_license, "Apache License")
    ensure_contains(apache_license_text, "Apache License")
    ensure_contains(protocol_license, "Apache License")
    ensure_contains(root_notice, "Hushh")
    ensure_contains(protocol_notice, "Hushh Consent Protocol")
    ensure_contains(root_third_party, "Third-Party Notices")
    ensure_contains(protocol_third_party, "Third-Party Notices")

    hushh_webapp = load_json(REPO_ROOT / "hushh-webapp" / "package.json")
    if hushh_webapp.get("license") != "Apache-2.0":
        fail("hushh-webapp/package.json must declare Apache-2.0")

    hushh_mcp = load_json(REPO_ROOT / "packages" / "hushh-mcp" / "package.json")
    if hushh_mcp.get("license") != "Apache-2.0":
        fail("packages/hushh-mcp/package.json must declare Apache-2.0")

    pyproject = (REPO_ROOT / "consent-protocol" / "pyproject.toml").read_text(encoding="utf-8")
    if 'license = "Apache-2.0"' not in pyproject:
        fail("consent-protocol/pyproject.toml must declare Apache-2.0")
    if "[dependency-groups]" not in pyproject:
        fail("consent-protocol/pyproject.toml must define dependency-groups for uv")

    requirements = (REPO_ROOT / "consent-protocol" / "requirements.txt").read_text(encoding="utf-8")
    if "Generated from pyproject.toml + uv.lock" not in requirements:
        fail("consent-protocol/requirements.txt must be marked as a generated artifact")
    requirements_dev = (
        REPO_ROOT / "consent-protocol" / "requirements-dev.txt"
    ).read_text(encoding="utf-8")
    if "Generated from pyproject.toml + uv.lock" not in requirements_dev:
        fail("consent-protocol/requirements-dev.txt must be marked as a generated artifact")

    print("Apache surface verification passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
