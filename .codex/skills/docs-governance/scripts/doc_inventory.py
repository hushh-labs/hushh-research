#!/usr/bin/env python3
"""Inventory maintained repo docs and flag stale knowledge candidates."""

from __future__ import annotations

import argparse
from pathlib import Path
from collections import defaultdict

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
    "docs/reference/README.md",
    "docs/reference/architecture/README.md",
    "docs/reference/iam/README.md",
    "docs/reference/one/README.md",
    "docs/reference/kai/README.md",
    "docs/reference/mobile/README.md",
    "docs/reference/operations/README.md",
    "docs/reference/operations/documentation-architecture-map.md",
    "docs/reference/operations/observability-architecture-map.md",
    "docs/reference/quality/README.md",
    "docs/superpowers/README.md",
    "docs/vision/README.md",
    "consent-protocol/docs/README.md",
    "hushh-webapp/docs/README.md",
    "docs/project_context_map.md",
]
EXPLICIT_CLASSIFICATIONS = {
    "README.md": "canonical",
    "getting_started.md": "pointer/index",
    "contributing.md": "canonical",
    "TESTING.md": "pointer/index",
    "SECURITY.md": "canonical",
    "code_of_conduct.md": "canonical",
    "docs/README.md": "canonical",
    "docs/reference/README.md": "pointer/index",
    "docs/guides/README.md": "pointer/index",
    "docs/reference/operations/documentation-architecture-map.md": "canonical",
    "docs/reference/operations/observability-architecture-map.md": "canonical",
    "docs/reference/operations/docs-governance.md": "canonical",
    "docs/superpowers/README.md": "planning-archive",
    "consent-protocol/docs/README.md": "pointer/index",
    "consent-protocol/docs/reference/README.md": "pointer/index",
    "hushh-webapp/docs/README.md": "pointer/index",
}
OVERSIZED_LINE_THRESHOLD = 700
SUPERPOWERS_LINE_THRESHOLD = 300
CURRENT_STATE_DRIFT_MARKERS = (
    "future-state",
    "planning-only",
    "approved design",
    "ready for implementation",
    "implementation plan",
    "execution plan",
)
DRIFT_SCAN_EXEMPTIONS = {
    "docs/reference/architecture/architecture-view-catalog.md",
    "docs/reference/architecture/founder-language-matrix.md",
    "docs/reference/operations/coding-agent-mcp.md",
    "docs/reference/operations/docs-governance.md",
    "docs/reference/operations/documentation-architecture-map.md",
    "docs/reference/operations/hussh-code-persona.md",
}


def doc_home(r: str) -> str:
    if r.startswith("consent-protocol/docs/"):
        return "consent-protocol"
    if r.startswith("hushh-webapp/docs/"):
        return "hushh-webapp"
    if r.startswith("docs/"):
        return "cross-cutting"
    return "root"


def classify_doc(r: str) -> str:
    explicit = EXPLICIT_CLASSIFICATIONS.get(r)
    if explicit:
        return explicit
    if r.startswith("docs/superpowers/plans/") or r.startswith("docs/superpowers/specs/"):
        return "planning-archive"
    if r.startswith("docs/future/"):
        return "pointer/index" if r.endswith("/README.md") or r == "docs/future/README.md" else "future-plan"
    if "historical" in r or "migration-audit" in r:
        return "historical-provenance"
    if r.endswith("/README.md"):
        return "pointer/index"
    return "canonical"


def line_count(path: Path) -> int:
    try:
        return len(path.read_text(encoding="utf-8").splitlines())
    except UnicodeDecodeError:
        return 0


def stale_reasons(path: Path, r: str, classification: str) -> list[str]:
    reasons: list[str] = []
    if classification in {"merge-then-delete", "delete"}:
        reasons.append(classification)
    if r.startswith("docs/superpowers/plans/") or r.startswith("docs/superpowers/specs/"):
        reasons.append("date-stamped-superpowers-artifact")
    if classification == "historical-provenance" and r.startswith("docs/reference/"):
        reasons.append("historical-doc-in-reference")

    lines = line_count(path)
    threshold = SUPERPOWERS_LINE_THRESHOLD if r.startswith("docs/superpowers/") else OVERSIZED_LINE_THRESHOLD
    if lines > threshold:
        reasons.append(f"oversized:{lines}-lines")

    if (
        r.startswith("docs/reference/")
        and classification == "canonical"
        and r not in DRIFT_SCAN_EXEMPTIONS
    ):
        try:
            text = path.read_text(encoding="utf-8").lower()
        except UnicodeDecodeError:
            text = ""
        if any(marker in text for marker in CURRENT_STATE_DRIFT_MARKERS):
            reasons.append("current-reference-with-plan-language")
    return reasons


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
        r = rel(path)
        classification = classify_doc(r)
        home = doc_home(r)
        print(f"{classification}\t{home}\t{r}")


def command_tier_a() -> None:
    for path in TIER_A:
        print(path)


def command_stale_candidates() -> None:
    for path in maintained_docs():
        r = rel(path)
        classification = classify_doc(r)
        reasons = stale_reasons(path, r, classification)
        if reasons:
            print(f"{classification}\t{doc_home(r)}\t{r}\t{','.join(reasons)}")


def command_folders() -> None:
    folders: dict[str, dict[str, object]] = defaultdict(
        lambda: {"docs": 0, "lines": 0, "classes": defaultdict(int)}
    )
    for path in maintained_docs():
        r = rel(path)
        folder = str(Path(r).parent)
        if folder == ".":
            folder = "root"
        classification = classify_doc(r)
        entry = folders[folder]
        entry["docs"] = int(entry["docs"]) + 1
        entry["lines"] = int(entry["lines"]) + line_count(path)
        classes = entry["classes"]
        assert isinstance(classes, defaultdict)
        classes[classification] += 1

    for folder in sorted(folders):
        entry = folders[folder]
        classes = entry["classes"]
        assert isinstance(classes, defaultdict)
        class_summary = ",".join(f"{name}:{classes[name]}" for name in sorted(classes))
        print(f"{folder}\tdocs={entry['docs']}\tlines={entry['lines']}\t{class_summary}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Inventory maintained docs")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("inventory")
    sub.add_parser("stale-candidates")
    sub.add_parser("folders")
    sub.add_parser("tier-a")
    args = parser.parse_args()
    if args.cmd == "inventory":
        command_inventory()
    elif args.cmd == "stale-candidates":
        command_stale_candidates()
    elif args.cmd == "folders":
        command_folders()
    else:
        command_tier_a()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
