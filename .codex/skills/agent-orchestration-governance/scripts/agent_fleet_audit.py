#!/usr/bin/env python3
"""Audit repo-scoped Codex agent coverage and update signals."""

from __future__ import annotations

import argparse
import json
import re
from collections import OrderedDict, defaultdict
from pathlib import Path
from typing import Any

try:
    import tomllib
except ModuleNotFoundError as exc:  # pragma: no cover
    raise SystemExit(f"tomllib is required: {exc}") from exc


DEFAULT_ROOT = Path(__file__).resolve().parents[4]
AGENTS_DIR = Path(".codex/agents")
SKILLS_DIR = Path(".codex/skills")
WORKFLOWS_DIR = Path(".codex/workflows")
MIN_AGENT_COUNT = 8
MAX_AGENT_COUNT = 12
ALLOWED_REASONING_EFFORTS = {"high", "xhigh"}
SKILL_BLOCK_HEADER = "Use these repo-local skills when they fit the lane:"
ADVISORY_RULE = "You are advisory-only. Do not self-authorize merge, deploy, release, or governance decisions."
TRUTH_FIRST_HEADER = "Truth-first protocol:"
TRUTH_FIRST_TOKENS = [
    "already_exists",
    "partially_exists",
    "missing",
    "future_state_only",
    "wrong_direction",
    "needs_verification",
    "claim_inspected",
    "classification",
    "evidence_checked",
    "current_repo_truth",
    "real_gap",
    "suggested_boundary",
    "risk_if_prompt_is_accepted_blindly",
    "scope_covered",
    "inspected_surfaces",
    "assumptions",
    "validations_run",
    "unresolved_risks",
]


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _read_toml(path: Path) -> dict[str, Any]:
    return tomllib.loads(path.read_text(encoding="utf-8"))


def _parse_skill_block(text: str) -> list[str]:
    match = re.search(
        rf"{re.escape(SKILL_BLOCK_HEADER)}\n(?P<block>(?:- [^\n]+\n)+)",
        text,
    )
    if not match:
        return []
    return [line[2:].strip() for line in match.group("block").strip().splitlines()]


def _load_skills(root: Path) -> dict[str, dict[str, Any]]:
    skills: dict[str, dict[str, Any]] = {}
    for path in sorted((root / SKILLS_DIR).glob("*/skill.json")):
        data = _read_json(path)
        skill_id = data.get("id")
        if isinstance(skill_id, str) and skill_id:
            skills[skill_id] = {
                "path": str(path.relative_to(root)),
                "owner_family": data.get("owner_family") or data.get("role") or "",
                "role": data.get("role") or "",
            }
    return skills


def _load_agents(root: Path) -> dict[str, dict[str, Any]]:
    agents: dict[str, dict[str, Any]] = OrderedDict()
    for path in sorted((root / AGENTS_DIR).glob("*.toml")):
        data = _read_toml(path)
        name = str(data.get("name") or path.stem)
        instructions = str(data.get("developer_instructions") or "")
        agents[name] = {
            "path": str(path.relative_to(root)),
            "description": data.get("description") or "",
            "sandbox_mode": data.get("sandbox_mode") or "",
            "default_reasoning_effort": data.get("default_reasoning_effort") or "",
            "skills": _parse_skill_block(instructions),
            "has_advisory_rule": name == "governor" or ADVISORY_RULE in instructions,
            "has_truth_first_protocol": TRUTH_FIRST_HEADER in instructions
            and all(token in instructions for token in TRUTH_FIRST_TOKENS),
        }
    return agents


def _load_workflows(root: Path) -> dict[str, dict[str, Any]]:
    workflows: dict[str, dict[str, Any]] = OrderedDict()
    for path in sorted((root / WORKFLOWS_DIR).glob("*/workflow.json")):
        data = _read_json(path)
        workflow_id = str(data.get("id") or path.parent.name)
        policy = data.get("delegation_policy")
        lanes: dict[str, str] = {}
        if not isinstance(policy, dict):
            workflows[workflow_id] = {
                "path": str(path.relative_to(root)),
                "inherits_global_policy": True,
                "lanes": lanes,
            }
            continue
        raw_lanes = policy.get("lanes")
        if isinstance(raw_lanes, dict):
            lanes = {
                str(lane_name): str(lane.get("agent") or "")
                for lane_name, lane in raw_lanes.items()
                if isinstance(lane, dict)
            }
        workflows[workflow_id] = {
            "path": str(path.relative_to(root)),
            "inherits_global_policy": False,
            "lanes": lanes,
        }
    return workflows


def audit(root: Path) -> OrderedDict[str, Any]:
    skills = _load_skills(root)
    agents = _load_agents(root)
    workflows = _load_workflows(root)
    hard_findings: list[str] = []
    watchlist: list[str] = []

    if len(agents) < MIN_AGENT_COUNT:
        hard_findings.append(
            f"agent count {len(agents)} is below the curated minimum {MIN_AGENT_COUNT}"
        )
    if len(agents) > MAX_AGENT_COUNT:
        hard_findings.append(
            f"agent count {len(agents)} exceeds the curated maximum {MAX_AGENT_COUNT}"
        )

    agent_skill_matrix: dict[str, list[str]] = OrderedDict()
    covered_skill_ids: set[str] = set()
    for agent_name, agent in agents.items():
        if agent["sandbox_mode"] != "read-only":
            hard_findings.append(f"{agent['path']}: agent must be read-only")
        if agent["default_reasoning_effort"] not in ALLOWED_REASONING_EFFORTS:
            hard_findings.append(f"{agent['path']}: reasoning effort must be high or xhigh")
        if not agent["has_advisory_rule"]:
            hard_findings.append(f"{agent['path']}: missing advisory-only authority rule")
        if not agent["has_truth_first_protocol"]:
            hard_findings.append(f"{agent['path']}: missing complete truth-first protocol")
        if not agent["skills"]:
            hard_findings.append(f"{agent['path']}: missing standardized skill block")
        for skill_id in agent["skills"]:
            if skill_id not in skills:
                hard_findings.append(f"{agent['path']}: unknown skill reference {skill_id}")
            else:
                covered_skill_ids.add(skill_id)
        agent_skill_matrix[agent_name] = agent["skills"]

    known_agents = set(agents)
    for workflow_id, workflow in workflows.items():
        for lane_name, agent_name in workflow["lanes"].items():
            if agent_name not in known_agents:
                hard_findings.append(
                    f".codex/workflows/{workflow_id}/workflow.json: lane {lane_name} references unknown agent {agent_name}"
                )

    owner_to_skills: dict[str, list[str]] = defaultdict(list)
    covered_owner_families: set[str] = set()
    for skill_id, skill in skills.items():
        owner = str(skill["owner_family"] or "unknown")
        owner_to_skills[owner].append(skill_id)
        if skill_id in covered_skill_ids:
            covered_owner_families.add(owner)

    parent_skill_only_families = OrderedDict(
        (owner, sorted(skill_ids))
        for owner, skill_ids in sorted(owner_to_skills.items())
        if owner not in covered_owner_families
    )
    if parent_skill_only_families:
        watchlist.append(
            "some owner families are intentionally parent-skill-only; add an agent only after repeated high-risk drift"
        )

    workflow_agent_coverage = OrderedDict(
        (workflow_id, sorted(set(workflow["lanes"].values())))
        for workflow_id, workflow in workflows.items()
        if workflow["lanes"]
    )
    inherited_global_workflows = [
        workflow_id
        for workflow_id, workflow in workflows.items()
        if workflow["inherits_global_policy"]
    ]
    if inherited_global_workflows:
        watchlist.append(
            "workflows without explicit delegation_policy inherit the repo-global router policy"
        )
    global_agent_pool = sorted(agents)

    workflow_policy_summary = OrderedDict(
        (workflow_id, "repo-global" if workflow["inherits_global_policy"] else "explicit")
        for workflow_id, workflow in workflows.items()
    )

    return OrderedDict(
        schema_version="agent-fleet-audit.v1",
        agent_count=len(agents),
        curated_min=MIN_AGENT_COUNT,
        curated_max=MAX_AGENT_COUNT,
        update_required=bool(hard_findings),
        review_recommended=bool(watchlist),
        hard_findings=hard_findings,
        watchlist=watchlist,
        agents=agents,
        agent_skill_matrix=agent_skill_matrix,
        workflow_agent_coverage=workflow_agent_coverage,
        workflow_policy_summary=workflow_policy_summary,
        inherited_global_workflows=inherited_global_workflows,
        global_agent_pool=global_agent_pool,
        covered_owner_families=sorted(covered_owner_families),
        parent_skill_only_families=parent_skill_only_families,
    )


def _text(payload: dict[str, Any]) -> str:
    lines = [
        "Agent Fleet Audit",
        f"Agent count: {payload['agent_count']} (curated range {payload['curated_min']}-{payload['curated_max']})",
        f"Update required: {payload['update_required']}",
        f"Review recommended: {payload['review_recommended']}",
        "Hard findings:",
    ]
    if payload["hard_findings"]:
        lines.extend(f"- {finding}" for finding in payload["hard_findings"])
    else:
        lines.append("- none")
    lines.append("Watchlist:")
    if payload["watchlist"]:
        lines.extend(f"- {item}" for item in payload["watchlist"])
    else:
        lines.append("- none")
    lines.append("Agent skill matrix:")
    for agent_name, skills in payload["agent_skill_matrix"].items():
        lines.append(f"- {agent_name}: {', '.join(skills) if skills else 'none'}")
    lines.append("Workflow agent coverage:")
    if payload["workflow_agent_coverage"]:
        for workflow_id, agents in payload["workflow_agent_coverage"].items():
            lines.append(f"- {workflow_id}: {', '.join(agents) if agents else 'none'}")
    else:
        lines.append("- none")
    lines.append("Repo-global workflow inheritance:")
    if payload["inherited_global_workflows"]:
        lines.append(f"- inherited workflows: {len(payload['inherited_global_workflows'])}")
        lines.append(f"- global agent pool: {', '.join(payload['global_agent_pool'])}")
    else:
        lines.append("- none")
    if payload["parent_skill_only_families"]:
        lines.append("Parent-skill-only owner families:")
        for owner, skills in payload["parent_skill_only_families"].items():
            lines.append(f"- {owner}: {', '.join(skills)}")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit repo-scoped Codex agent fleet coverage.")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--text", action="store_true")
    args = parser.parse_args()

    payload = audit(args.root.resolve())
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(_text(payload))
    return 1 if payload["update_required"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
