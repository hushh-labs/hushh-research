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

REQUIRED_OPERATOR_CONTRACT_ALTERNATIVES = [
    ("`Per-PR Role`", "`Per-PR Assessment`"),
]

REQUIRED_OPERATOR_GENERATOR_SECTIONS = [
    "- Research Basis:",
    "_operator_batch_research_basis(batch)",
    "- Solution:",
    "- Decision Questions:",
    "_operator_batch_decision_questions(batch)",
]

REQUIRED_OPERATOR_GENERATOR_ALTERNATIVES = [
    ("- PR roles:", "- Per-PR Assessment:"),
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

REQUIRED_COMMENT_POLICY_PHRASES = [
    "Every PR merged through PR governance gets one post-merge record",
    "Do not post noisy approval comments",
]

REQUIRED_COMMENT_POLICY_ALTERNATIVES = [
    (
        "Post before merge only for `block`, `changes_requested`, `comment_only`, or when contributor action is required.",
        "Before posting, inspect existing maintainer-authored comments and reviews.",
    ),
]


def _missing(text: str, required: list[str]) -> list[str]:
    return [item for item in required if item not in text]


def _missing_alternatives(text: str, alternatives: list[tuple[str, ...]]) -> list[str]:
    return [" or ".join(items) for items in alternatives if not any(item in text for item in items)]


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
        for item in _missing_alternatives(contract_text, REQUIRED_OPERATOR_CONTRACT_ALTERNATIVES):
            errors.append(
                f"{OPERATOR_CONTRACT.relative_to(REPO_ROOT)}: missing one required PR governance section from `{item}`"
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
            for item in _missing_alternatives(operator_body, REQUIRED_OPERATOR_GENERATOR_ALTERNATIVES):
                errors.append(
                    f"{PR_REVIEW_SCRIPT.relative_to(REPO_ROOT)}: operator batch output missing one of `{item}`"
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

        comment_contract = REPO_ROOT / ".codex/skills/pr-governance-review/references/comment-and-report-contract.md"
        if not comment_contract.exists():
            errors.append(
                f"missing PR comment/report contract: {comment_contract.relative_to(REPO_ROOT)}"
            )
        else:
            comment_contract_text = comment_contract.read_text(encoding="utf-8")
            for item in _missing(comment_contract_text, REQUIRED_COMMENT_POLICY_PHRASES):
                errors.append(
                    f"{comment_contract.relative_to(REPO_ROOT)}: missing required PR comment policy `{item}`"
                )
            for item in _missing_alternatives(
                comment_contract_text,
                REQUIRED_COMMENT_POLICY_ALTERNATIVES,
            ):
                errors.append(
                    f"{comment_contract.relative_to(REPO_ROOT)}: missing one required PR comment policy from `{item}`"
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
