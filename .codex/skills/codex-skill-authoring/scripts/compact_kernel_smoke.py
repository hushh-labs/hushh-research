#!/usr/bin/env python3
"""Smoke-test compact-kernel lint budgets without mutating the repo."""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
LINT_PATH = SCRIPT_DIR / "skill_lint.py"


def _load_linter():
    spec = importlib.util.spec_from_file_location("skill_lint", LINT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {LINT_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _has_error(errors: list[str], token: str) -> bool:
    return any(token in error for error in errors)


def main() -> int:
    lint = _load_linter()
    cases = [
        (
            "owner budget pass",
            lint.compact_kernel_budget_errors(
                origin="fixture-owner",
                role="owner",
                skill_lines=lint.MASTER_SKILL_MAX_LINES,
                read_first_count=lint.READ_FIRST_MAX_ITEMS,
                required_check_count=lint.REQUIRED_CHECKS_MAX_COMMANDS,
            ),
            None,
        ),
        (
            "master line budget fail",
            lint.compact_kernel_budget_errors(
                origin="fixture-owner",
                role="owner",
                skill_lines=lint.MASTER_SKILL_MAX_LINES + 1,
                read_first_count=1,
                required_check_count=1,
            ),
            "master compact-kernel budget exceeded",
        ),
        (
            "spoke line budget fail",
            lint.compact_kernel_budget_errors(
                origin="fixture-spoke",
                role="spoke",
                skill_lines=lint.SPOKE_SKILL_MAX_LINES + 1,
                read_first_count=1,
                required_check_count=1,
            ),
            "spoke compact-kernel budget exceeded",
        ),
        (
            "read budget fail",
            lint.compact_kernel_budget_errors(
                origin="fixture-reads",
                role="owner",
                skill_lines=1,
                read_first_count=lint.READ_FIRST_MAX_ITEMS + 1,
                required_check_count=1,
            ),
            "Read First budget exceeded",
        ),
        (
            "check budget fail",
            lint.compact_kernel_budget_errors(
                origin="fixture-checks",
                role="owner",
                skill_lines=1,
                read_first_count=1,
                required_check_count=lint.REQUIRED_CHECKS_MAX_COMMANDS + 1,
            ),
            "Required Checks budget exceeded",
        ),
    ]
    failures: list[str] = []
    for name, errors, expected in cases:
        if expected is None and errors:
            failures.append(f"{name}: expected pass, got {errors}")
        if expected is not None and not _has_error(errors, expected):
            failures.append(f"{name}: expected error containing {expected!r}, got {errors}")

    if lint.reference_budget_error("fixture.md", lint.REFERENCE_MAX_LINES):
        failures.append("reference exact budget should pass")
    if not lint.reference_budget_error("fixture.md", lint.REFERENCE_MAX_LINES + 1):
        failures.append("reference overflow should fail")
    if not any(re.search(pattern, "any frontend task") for pattern in lint.BROAD_PATTERNS):
        failures.append("spoke broad-trigger pattern should catch broad intake wording")

    pr_skill = lint.SKILLS_ROOT / "pr-governance-review" / "SKILL.md"
    pr_text = pr_skill.read_text(encoding="utf-8")
    if "Default PR-Train Mode" not in pr_text:
        failures.append("PR governance skill should keep async train defaults visible")

    if failures:
        print("Compact-kernel smoke failed:")
        for failure in failures:
            print(f"- {failure}")
        return 1
    print("Compact-kernel smoke passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
