#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[4]
REPORT_SCRIPT = REPO_ROOT / ".codex/skills/pr-governance-review/scripts/contributor_impact_report.py"
PDF_SCRIPT = REPO_ROOT / ".codex/skills/pr-governance-review/scripts/export_contributor_impact_pdf.mjs"


def _run(args: list[str]) -> None:
    subprocess.run(args, cwd=REPO_ROOT, check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Refresh the canonical Hussh contributor impact dashboard artifacts.")
    parser.add_argument("--repo", default="hushh-labs/hushh-research")
    parser.add_argument("--days", type=int, default=14)
    parser.add_argument("--mode", choices=("fast", "full"), default="fast")
    parser.add_argument("--prefix", default="tmp/contributor-impact-dashboard")
    parser.add_argument("--include-files", action="store_true")
    parser.add_argument("--include-all-time-discussions", action="store_true")
    parser.add_argument("--skip-pdf", action="store_true")
    args = parser.parse_args()
    if args.mode == "fast" and args.include_files:
        parser.error("--include-files requires --mode full")

    prefix = Path(args.prefix)
    markdown_path = prefix.with_suffix(".md")
    json_path = prefix.with_suffix(".json")

    report_cmd = [
        sys.executable,
        str(REPORT_SCRIPT),
        "--repo",
        args.repo,
        "--days",
        str(args.days),
        "--text-output",
        str(markdown_path),
        "--json-output",
        str(json_path),
    ]
    if args.mode == "fast":
        report_cmd.append("--fast")
    if args.include_files:
        report_cmd.append("--include-files")
    if args.include_all_time_discussions:
        report_cmd.append("--include-all-time-discussions")
    _run(report_cmd)

    if args.skip_pdf:
        return 0

    for theme in ("light", "dark"):
        _run(
            [
                "node",
                str(PDF_SCRIPT),
                "--input",
                str(markdown_path),
                "--output",
                str(prefix.with_name(f"{prefix.name}-{theme}").with_suffix(".pdf")),
                "--html",
                str(prefix.with_name(f"{prefix.name}-{theme}").with_suffix(".html")),
                "--theme",
                theme,
            ]
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
