#!/usr/bin/env python3
"""Verify that canonical runtime profile env files share one supported key shape."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
ASSIGN_RE = re.compile(r"^([A-Z0-9_]+)=")

BACKEND_TEMPLATE_FILES = (
    Path("consent-protocol/.env.example"),
)

FRONTEND_TEMPLATE_FILES = (
    Path("hushh-webapp/.env.local.local.example"),
    Path("hushh-webapp/.env.uat.local.example"),
    Path("hushh-webapp/.env.prod.local.example"),
)

BACKEND_RUNTIME_FILES = (
    Path("consent-protocol/.env"),
)

FRONTEND_RUNTIME_FILES = (
    Path("hushh-webapp/.env.local.local"),
    Path("hushh-webapp/.env.uat.local"),
    Path("hushh-webapp/.env.prod.local"),
    Path("hushh-webapp/.env.local"),
)


def parse_keys(path: Path) -> set[str]:
    keys: set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        match = ASSIGN_RE.match(line)
        if match:
            keys.add(match.group(1))
    return keys


def compare_group(label: str, paths: tuple[Path, ...]) -> list[str]:
    failures: list[str] = []
    existing = [path for path in paths if (REPO_ROOT / path).exists()]
    if not existing:
        failures.append(f"{label}: no files found")
        return failures

    baseline = parse_keys(REPO_ROOT / existing[0])
    for path in existing[1:]:
        current = parse_keys(REPO_ROOT / path)
        missing = sorted(baseline - current)
        extra = sorted(current - baseline)
        if missing or extra:
            if missing:
                failures.append(f"{path}: missing keys {', '.join(missing)}")
            if extra:
                failures.append(f"{path}: unexpected extra keys {', '.join(extra)}")
    return failures


def compare_runtime_to_templates(label: str, template_paths: tuple[Path, ...], runtime_paths: tuple[Path, ...]) -> list[str]:
    failures: list[str] = []
    template_contract = parse_keys(REPO_ROOT / template_paths[0])
    for path in runtime_paths:
        abs_path = REPO_ROOT / path
        if not abs_path.exists():
            failures.append(f"{path}: missing runtime file")
            continue
        current = parse_keys(abs_path)
        missing = sorted(template_contract - current)
        extra = sorted(current - template_contract)
        if missing or extra:
            if missing:
                failures.append(f"{path}: missing keys {', '.join(missing)}")
            if extra:
                failures.append(f"{path}: unexpected extra keys {', '.join(extra)}")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--include-runtime",
        action="store_true",
        help="Also verify the local canonical runtime env files and active env files.",
    )
    args = parser.parse_args()

    failures: list[str] = []
    failures.extend(compare_group("backend templates", BACKEND_TEMPLATE_FILES))
    failures.extend(compare_group("frontend templates", FRONTEND_TEMPLATE_FILES))

    if args.include_runtime:
        failures.extend(compare_runtime_to_templates("backend runtime", BACKEND_TEMPLATE_FILES, BACKEND_RUNTIME_FILES))
        failures.extend(compare_runtime_to_templates("frontend runtime", FRONTEND_TEMPLATE_FILES, FRONTEND_RUNTIME_FILES))

    if failures:
        print("Runtime profile env shape check failed:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1

    print("Runtime profile env shape check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
