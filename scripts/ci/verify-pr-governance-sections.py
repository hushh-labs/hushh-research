#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
PR_REVIEW_SCRIPT = REPO_ROOT / ".codex/skills/pr-governance-review/scripts/pr_review_checklist.py"
OPERATOR_CONTRACT = (
    REPO_ROOT / ".codex/skills/pr-governance-review/references/operator-batch-output-contract.md"
)

REQUIRED_OPERATOR_CONTRACT_SECTIONS = [
    "## Required Chat Shape",
    "`Research Basis`",
    "`Input`",
    "`Per-PR Role`",
    "`Output`",
    "`Execution`",
    "`Decision Questions`",
    "`Stop Conditions`",
    "`Verification`",
    "current truth",
    "recommended path",
    "risk if accepted blindly",
    "recommended option first",
]

REQUIRED_OPERATOR_GENERATOR_SECTIONS = [
    "- Research Basis:",
    "_operator_batch_research_basis(batch)",
    "- PR roles:",
    "- Solution:",
    "- Decision Questions:",
    "_operator_batch_decision_questions(batch)",
]

REQUIRED_COMMENT_SECTIONS = {
    "merge_now": [
        "## Merged:",
        "### What Landed",
        "### Why It Matters",
        "### Outcome",
    ],
    "patch_then_merge": [
        "## Merged:",
        "### What Landed",
        "### Why It Matters",
        "### Maintainer Patch",
        "### Outcome",
    ],
    "close_or_harvest": [
        "## Closed:",
        "### Decision",
        "### What We Kept",
        "### Decision Basis",
        "### Outcome",
    ],
    "changes_requested": [
        "## Changes Requested:",
        "### Direction",
        "### Blocker",
        "### Path To Merge",
        "### Proof Needed",
    ],
}


def _missing(text: str, required: list[str]) -> list[str]:
    return [item for item in required if item not in text]


def _function_body(text: str, function_name: str) -> str:
    marker = f"def {function_name}("
    start = text.find(marker)
    if start == -1:
        return ""
    next_function = text.find("\ndef ", start + len(marker))
    if next_function == -1:
        return text[start:]
    return text[start:next_function]


def main() -> int:
    errors: list[str] = []

    if not OPERATOR_CONTRACT.exists():
        errors.append(f"missing operator batch contract: {OPERATOR_CONTRACT.relative_to(REPO_ROOT)}")
    else:
        contract_text = OPERATOR_CONTRACT.read_text(encoding="utf-8")
        for item in _missing(contract_text, REQUIRED_OPERATOR_CONTRACT_SECTIONS):
            errors.append(
                f"{OPERATOR_CONTRACT.relative_to(REPO_ROOT)}: missing required PR governance section `{item}`"
            )

    if not PR_REVIEW_SCRIPT.exists():
        errors.append(f"missing PR review checklist script: {PR_REVIEW_SCRIPT.relative_to(REPO_ROOT)}")
    else:
        script_text = PR_REVIEW_SCRIPT.read_text(encoding="utf-8")
        operator_body = _function_body(script_text, "_operator_batch_lines")
        if not operator_body:
            errors.append(
                f"{PR_REVIEW_SCRIPT.relative_to(REPO_ROOT)}: missing `_operator_batch_lines` generator"
            )
        else:
            for item in _missing(operator_body, REQUIRED_OPERATOR_GENERATOR_SECTIONS):
                errors.append(
                    f"{PR_REVIEW_SCRIPT.relative_to(REPO_ROOT)}: operator batch output missing `{item}`"
                )

        comment_body = _function_body(script_text, "_communication_markdown")
        if not comment_body:
            errors.append(
                f"{PR_REVIEW_SCRIPT.relative_to(REPO_ROOT)}: missing `_communication_markdown` generator"
            )
        else:
            for lane, required_sections in REQUIRED_COMMENT_SECTIONS.items():
                for item in _missing(comment_body, required_sections):
                    errors.append(
                        f"{PR_REVIEW_SCRIPT.relative_to(REPO_ROOT)}: `{lane}` PR note missing `{item}`"
                    )

    if errors:
        print("ERROR: PR governance section check failed.")
        for error in errors:
            print(f"- {error}")
        return 1

    print("OK: PR governance sections present")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
