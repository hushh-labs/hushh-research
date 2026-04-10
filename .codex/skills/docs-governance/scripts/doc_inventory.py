#!/usr/bin/env python3
"""Inventory maintained repo docs and ignore generated/vendor markdown."""

from __future__ import annotations

import argparse
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
ROOT_DOCS = [
    "README.md",
    "getting_started.md",
    "contributing.md",
    "TESTING.md",
    "SECURITY.md",
    "code_of_conduct.md",
]
DOC_ROOTS = [
    REPO_ROOT / "docs",
    REPO_ROOT / "consent-protocol" / "docs",
    REPO_ROOT / "hushh-webapp" / "docs",
]
IGNORE_PARTS = {
    "node_modules",
    ".next",
    "DerivedData",
    ".pytest_cache",
    ".git",
    ".venv",
    "dist",
    "build",
}
TIER_A = [
    "README.md",
    "docs/README.md",
    "docs/guides/README.md",
    "docs/reference/operations/README.md",
    "docs/reference/operations/documentation-architecture-map.md",
    "docs/reference/quality/README.md",
    "docs/vision/README.md",
    "consent-protocol/docs/README.md",
    "hushh-webapp/docs/README.md",
    "docs/project_context_map.md",
]
CLASSIFICATIONS = {
    "README.md": "canonical",
    "getting_started.md": "pointer/index",
    "contributing.md": "canonical",
    "TESTING.md": "pointer/index",
    "SECURITY.md": "canonical",
    "code_of_conduct.md": "canonical",
    "docs/README.md": "canonical",
    "docs/guides/README.md": "pointer/index",
    "docs/reference/operations/documentation-architecture-map.md": "canonical",
    "docs/reference/operations/docs-governance.md": "canonical",
    "consent-protocol/docs/README.md": "pointer/index",
    "consent-protocol/docs/reference/README.md": "pointer/index",
    "hushh-webapp/docs/README.md": "pointer/index",
}


def is_ignored(path: Path) -> bool:
    return any(part in IGNORE_PARTS for part in path.parts)


def maintained_docs() -> list[Path]:
    out: list[Path] = []
    for rel in ROOT_DOCS:
        p = REPO_ROOT / rel
        if p.exists():
            out.append(p)
    for root in DOC_ROOTS:
        for p in root.rglob("*.md"):
            if not is_ignored(p):
                out.append(p)
    return sorted(set(out))


def rel(path: Path) -> str:
    return str(path.relative_to(REPO_ROOT))


def command_inventory() -> None:
    for path in maintained_docs():
        home = "root"
        r = rel(path)
        classification = CLASSIFICATIONS.get(r, "canonical")
        if r.startswith("docs/"):
            home = "cross-cutting"
        elif r.startswith("consent-protocol/docs/"):
            home = "consent-protocol"
        elif r.startswith("hushh-webapp/docs/"):
            home = "hushh-webapp"
        print(f"{classification}\t{home}\t{r}")


def command_tier_a() -> None:
    for path in TIER_A:
        print(path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Inventory maintained docs")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("inventory")
    sub.add_parser("tier-a")
    args = parser.parse_args()
    if args.cmd == "inventory":
        command_inventory()
    else:
        command_tier_a()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
