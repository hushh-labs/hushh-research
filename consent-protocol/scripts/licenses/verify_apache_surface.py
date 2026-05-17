#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def fail(message: str) -> None:
    raise SystemExit(f"ERROR: {message}")


def ensure_contains(path: Path, needle: str) -> None:
    if needle not in path.read_text(encoding="utf-8"):
        fail(f"{path.relative_to(ROOT)} is missing expected content: {needle}")


def main() -> int:
    for relative in ("LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"):
        path = ROOT / relative
        if not path.exists():
            fail(f"missing required Apache artifact: {relative}")

    ensure_contains(ROOT / "LICENSE", "Apache License")
    ensure_contains(ROOT / "NOTICE", "Hushh Consent Protocol")
    ensure_contains(ROOT / "THIRD_PARTY_NOTICES.md", "Third-Party Notices")

    pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    if 'license = "Apache-2.0"' not in pyproject:
        fail("pyproject.toml must declare Apache-2.0")
    if "[dependency-groups]" not in pyproject:
        fail("pyproject.toml must define dependency-groups for uv")

    requirements = (ROOT / "requirements.txt").read_text(encoding="utf-8")
    requirements_dev = (ROOT / "requirements-dev.txt").read_text(encoding="utf-8")
    for name, content in {
        "requirements.txt": requirements,
        "requirements-dev.txt": requirements_dev,
    }.items():
        if "Generated from pyproject.toml + uv.lock" not in content:
            fail(f"{name} must be marked as a generated artifact")

    print("Consent-protocol Apache surface verification passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
