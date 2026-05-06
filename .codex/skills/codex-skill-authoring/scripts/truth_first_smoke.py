#!/usr/bin/env python3
"""Smoke-check the repo truth-first governance kernel."""

from __future__ import annotations

import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[4]
KERNEL = REPO_ROOT / ".codex/skills/codex-skill-authoring/references/truth-first-operating-kernel.md"
AGENTS_MD = REPO_ROOT / "AGENTS.md"
SKILL_CONTRACT = REPO_ROOT / ".codex/skills/codex-skill-authoring/references/skill-contract.md"
DELEGATION_CONTRACT = (
    REPO_ROOT / ".codex/skills/agent-orchestration-governance/references/delegation-contract.md"
)
COMMS_RULES = REPO_ROOT / ".codex/skills/comms-community/references/reply-rules.md"
COMMUNITY_WORKFLOW = REPO_ROOT / ".codex/workflows/community-response/workflow.json"
AGENTS_DIR = REPO_ROOT / ".codex/agents"

CLAIM_LABELS = [
    "already_exists",
    "partially_exists",
    "missing",
    "future_state_only",
    "wrong_direction",
    "needs_verification",
]
HANDOFF_TOKENS = [
    "claim_inspected",
    "classification",
    "evidence_checked",
    "current_repo_truth",
    "real_gap",
    "suggested_boundary",
    "risk_if_prompt_is_accepted_blindly",
]
DOMAIN_PROBES = [
    "Kai Decisions",
    "MCP And Consent Tools",
    "PKM And Vault",
    "Voice And Action Gateway",
    "PR Governance",
    "Frontend",
    "Data Model",
]


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _require_text(path: Path, phrases: list[str], errors: list[str]) -> None:
    if not path.exists():
        errors.append(f"missing file: {path.relative_to(REPO_ROOT)}")
        return
    text = _read(path)
    for phrase in phrases:
        if phrase not in text:
            errors.append(f"{path.relative_to(REPO_ROOT)}: missing `{phrase}`")


def _check_kernel(errors: list[str]) -> None:
    required = [
        "derive facts from the repo before accepting the prompt",
        "Evidence Order",
        "Default Answer Shape",
        "Agent Evidence Handoff",
        "Community Q&A Contract",
        "price is missing",
        "make MCP tools dynamic by consent",
        "add voice mic",
        "store LLM wiki as markdown",
        "green CI means merge",
        *CLAIM_LABELS,
        *HANDOFF_TOKENS,
        *DOMAIN_PROBES,
    ]
    _require_text(KERNEL, required, errors)


def _check_contract_links(errors: list[str]) -> None:
    reference = ".codex/skills/codex-skill-authoring/references/truth-first-operating-kernel.md"
    for path in [AGENTS_MD, SKILL_CONTRACT, DELEGATION_CONTRACT]:
        _require_text(path, [reference, *CLAIM_LABELS], errors)


def _check_comms(errors: list[str]) -> None:
    _require_text(
        COMMS_RULES,
        [
            "`Brief reply`",
            "`Detailed reply`",
            "Keep normal Q&A lean",
            "realtime quote data is already part of the analysis provider path",
            "dynamic per-user scopes already exist",
            "do not accept \"price is missing\"",
        ],
        errors,
    )
    if not COMMUNITY_WORKFLOW.exists():
        errors.append(f"missing file: {COMMUNITY_WORKFLOW.relative_to(REPO_ROOT)}")
        return
    workflow = json.loads(COMMUNITY_WORKFLOW.read_text(encoding="utf-8"))
    deliverables = workflow.get("deliverables", [])
    common_failures = workflow.get("common_failures", [])
    for value in ["Brief reply", "Detailed reply", "claim classification for material premise corrections"]:
        if value not in deliverables:
            errors.append(f"{COMMUNITY_WORKFLOW.relative_to(REPO_ROOT)}: missing deliverable `{value}`")
    stale = {
        "default reply variant",
        "detailed reply variant",
        "missing required drafted-reply variants",
    }
    for value in stale:
        if value in deliverables or value in common_failures:
            errors.append(f"{COMMUNITY_WORKFLOW.relative_to(REPO_ROOT)}: stale community workflow value `{value}`")


def _check_agents(errors: list[str]) -> None:
    if not AGENTS_DIR.exists():
        errors.append(f"missing directory: {AGENTS_DIR.relative_to(REPO_ROOT)}")
        return
    for path in sorted(AGENTS_DIR.glob("*.toml")):
        text = _read(path)
        required = ["Truth-first protocol:", *CLAIM_LABELS, *HANDOFF_TOKENS]
        for phrase in required:
            if phrase not in text:
                errors.append(f"{path.relative_to(REPO_ROOT)}: missing `{phrase}`")


def main() -> int:
    errors: list[str] = []
    _check_kernel(errors)
    _check_contract_links(errors)
    _check_comms(errors)
    _check_agents(errors)

    if errors:
        print("Truth-first smoke failed:")
        for error in errors:
            print(f"- {error}")
        return 1

    print("Truth-first smoke passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
