#!/usr/bin/env python3
"""Report compact-kernel status and agent/subagent activation paths per skill."""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter, OrderedDict, defaultdict
from pathlib import Path
from typing import Any

try:
    import tomllib
except ModuleNotFoundError as exc:  # pragma: no cover
    raise SystemExit(f"tomllib is required: {exc}") from exc


REPO_ROOT = Path(__file__).resolve().parents[4]
SKILLS_ROOT = REPO_ROOT / ".codex/skills"
WORKFLOWS_ROOT = REPO_ROOT / ".codex/workflows"
AGENTS_ROOT = REPO_ROOT / ".codex/agents"
MASTER_SKILL_MAX_LINES = 110
SPOKE_SKILL_MAX_LINES = 85
REFERENCE_MAX_LINES = 220
READ_FIRST_MAX_ITEMS = 8
REQUIRED_CHECKS_MAX_COMMANDS = 8
SKILL_BLOCK_HEADER = "Use these repo-local skills when they fit the lane:"


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _read_toml(path: Path) -> dict[str, Any]:
    return tomllib.loads(path.read_text(encoding="utf-8"))


def _line_count(path: Path) -> int:
    return len(path.read_text(encoding="utf-8").splitlines())


def _parse_skill_block(text: str) -> list[str]:
    match = re.search(
        rf"{re.escape(SKILL_BLOCK_HEADER)}\n(?P<block>(?:- [^\n]+\n)+)",
        text,
    )
    if not match:
        return []
    return [line[2:].strip() for line in match.group("block").strip().splitlines()]


def _load_agent_skill_map() -> dict[str, list[str]]:
    agent_map: dict[str, list[str]] = OrderedDict()
    for path in sorted(AGENTS_ROOT.glob("*.toml")):
        data = _read_toml(path)
        agent_name = str(data.get("name") or path.stem)
        instructions = str(data.get("developer_instructions") or "")
        agent_map[agent_name] = _parse_skill_block(instructions)
    return agent_map


def _load_workflows() -> dict[str, dict[str, Any]]:
    workflows: dict[str, dict[str, Any]] = OrderedDict()
    for path in sorted(WORKFLOWS_ROOT.glob("*/workflow.json")):
        data = _read_json(path)
        workflow_id = str(data.get("id") or path.parent.name)
        policy = data.get("delegation_policy")
        lanes: dict[str, str] = {}
        if isinstance(policy, dict):
            raw_lanes = policy.get("lanes")
            if isinstance(raw_lanes, dict):
                lanes = {
                    str(lane): str(config.get("agent") or "")
                    for lane, config in raw_lanes.items()
                    if isinstance(config, dict)
                }
        workflows[workflow_id] = {
            "path": str(path.relative_to(REPO_ROOT)),
            "owner_skill": data.get("owner_skill"),
            "default_spoke": data.get("default_spoke"),
            "task_type": data.get("task_type"),
            "delegation_policy": "explicit" if isinstance(policy, dict) else "repo-global",
            "lanes": lanes,
        }
    return workflows


def _reference_rows(skill_dir: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in sorted((skill_dir / "references").glob("*.md")):
        rows.append(
            {
                "path": str(path.relative_to(REPO_ROOT)),
                "lines": _line_count(path),
                "status": "pass" if _line_count(path) <= REFERENCE_MAX_LINES else "fail",
            }
        )
    return rows


def _scripts(skill_dir: Path) -> list[str]:
    scripts_dir = skill_dir / "scripts"
    if not scripts_dir.exists():
        return []
    return sorted(
        str(path.relative_to(REPO_ROOT))
        for path in scripts_dir.glob("*")
        if path.is_file() and path.suffix in {".py", ".sh", ".ts", ".js"}
    )


def _budget_status(role: str, lines: int, read_count: int, command_count: int) -> str:
    max_lines = MASTER_SKILL_MAX_LINES if role == "owner" else SPOKE_SKILL_MAX_LINES
    if lines > max_lines:
        return "fail:skill-lines"
    if read_count > READ_FIRST_MAX_ITEMS:
        return "fail:read-first"
    if command_count > REQUIRED_CHECKS_MAX_COMMANDS:
        return "fail:required-checks"
    return "pass"


def _duplication_signals(
    *,
    role: str,
    lines: int,
    reference_rows: list[dict[str, Any]],
    read_count: int,
    command_count: int,
) -> list[str]:
    max_lines = MASTER_SKILL_MAX_LINES if role == "owner" else SPOKE_SKILL_MAX_LINES
    signals: list[str] = []
    if lines >= int(max_lines * 0.9):
        signals.append("near-skill-budget")
    if read_count >= READ_FIRST_MAX_ITEMS - 1:
        signals.append("near-read-budget")
    if command_count >= REQUIRED_CHECKS_MAX_COMMANDS - 1:
        signals.append("near-check-budget")
    if len(reference_rows) >= 6:
        signals.append("many-references")
    large_refs = [row["path"] for row in reference_rows if row["lines"] >= int(REFERENCE_MAX_LINES * 0.85)]
    if large_refs:
        signals.append("near-reference-budget:" + ",".join(large_refs))
    return signals


def _refinement_action(row: dict[str, Any]) -> str:
    signals = set(row["duplication_signals"])
    if row["budget_status"] != "pass":
        return "split before merge"
    if row["lane_label"] == "spoke" and "near-skill-budget" in signals:
        return "spoke refinement candidate: extract narrow rules or route broad language back to master"
    if "near-skill-budget" in signals:
        return "master refinement candidate: extract durable detail into focused references"
    if "near-check-budget" in signals:
        return "check refinement candidate: collapse scenarios into smoke scripts"
    if "near-read-budget" in signals:
        return "read refinement candidate: keep only canonical entrypoints"
    if "many-references" in signals:
        return "reference routing candidate: keep SOP index clear and avoid duplicate rules"
    return "stable"


def audit() -> OrderedDict[str, Any]:
    agent_skill_map = _load_agent_skill_map()
    workflows = _load_workflows()
    skill_to_agents: dict[str, list[str]] = defaultdict(list)
    for agent, skills in agent_skill_map.items():
        for skill in skills:
            skill_to_agents[skill].append(agent)

    workflow_by_skill: dict[str, list[dict[str, Any]]] = defaultdict(list)
    task_type_to_workflow: dict[str, list[str]] = defaultdict(list)
    for workflow_id, workflow in workflows.items():
        for skill_key in ("owner_skill", "default_spoke"):
            skill_id = workflow.get(skill_key)
            if skill_id:
                workflow_by_skill[str(skill_id)].append(
                    {
                        "id": workflow_id,
                        "role": skill_key,
                        "delegation_policy": workflow["delegation_policy"],
                        "agents": sorted(set(workflow["lanes"].values())),
                    }
                )
        task_type = workflow.get("task_type")
        if task_type:
            task_type_to_workflow[str(task_type)].append(workflow_id)

    rows: list[dict[str, Any]] = []
    read_counter: Counter[str] = Counter()
    for manifest_path in sorted(SKILLS_ROOT.glob("*/skill.json")):
        skill_dir = manifest_path.parent
        skill_md = skill_dir / "SKILL.md"
        manifest = _read_json(manifest_path)
        skill_id = str(manifest["id"])
        role = str(manifest.get("role") or "")
        lane_label = "master" if role == "owner" else "spoke"
        max_lines = MASTER_SKILL_MAX_LINES if role == "owner" else SPOKE_SKILL_MAX_LINES
        required_reads = list(manifest.get("required_reads") or [])
        required_commands = list(manifest.get("required_commands") or [])
        references = _reference_rows(skill_dir)
        scripts = _scripts(skill_dir)
        lines = _line_count(skill_md)
        for read in required_reads:
            read_counter[read] += 1

        workflows_for_skill = list(workflow_by_skill.get(skill_id, []))
        task_workflows = sorted(
            {
                workflow_id
                for task_type in manifest.get("task_types", [])
                for workflow_id in task_type_to_workflow.get(str(task_type), [])
            }
        )
        direct_workflow_ids = {workflow["id"] for workflow in workflows_for_skill}
        for workflow_id in task_workflows:
            if workflow_id not in direct_workflow_ids:
                workflow = workflows[workflow_id]
                workflows_for_skill.append(
                    {
                        "id": workflow_id,
                        "role": "task_type",
                        "delegation_policy": workflow["delegation_policy"],
                        "agents": sorted(set(workflow["lanes"].values())),
                    }
                )

        agents = sorted(skill_to_agents.get(skill_id, []))
        explicit_workflows = [item for item in workflows_for_skill if item["delegation_policy"] == "explicit"]
        repo_global_workflows = [item for item in workflows_for_skill if item["delegation_policy"] == "repo-global"]
        mechanisms: list[str] = []
        if agents:
            mechanisms.append("agent-skill-block")
        if explicit_workflows:
            mechanisms.append("workflow-explicit-delegation")
        if repo_global_workflows:
            mechanisms.append("repo-global-delegation-router")
        if not mechanisms:
            mechanisms.append("parent-skill-trigger-only")

        rows.append(
            OrderedDict(
                skill_id=skill_id,
                lane_label=lane_label,
                role=role,
                owner_family=manifest.get("owner_family"),
                skill_path=str(skill_md.relative_to(REPO_ROOT)),
                line_count=lines,
                max_lines=max_lines,
                budget_status=_budget_status(role, lines, len(required_reads), len(required_commands)),
                required_read_count=len(required_reads),
                required_check_count=len(required_commands),
                reference_count=len(references),
                script_count=len(scripts),
                references=references,
                scripts=scripts,
                agents=agents,
                workflows=workflows_for_skill,
                detection_mechanisms=mechanisms,
                subagent_detection=(
                    f"agents={','.join(agents) if agents else 'none'}; "
                    f"workflows={','.join(item['id'] for item in workflows_for_skill) if workflows_for_skill else 'none'}; "
                    f"mechanisms={','.join(mechanisms)}"
                ),
                duplication_signals=_duplication_signals(
                    role=role,
                    lines=lines,
                    reference_rows=references,
                    read_count=len(required_reads),
                    command_count=len(required_commands),
                ),
            )
        )

    for row in rows:
        row["refinement_action"] = _refinement_action(row)

    family_map: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        family_map[str(row["owner_family"])].append(row)
    family_breakdown: OrderedDict[str, Any] = OrderedDict()
    for family, family_rows in sorted(family_map.items()):
        master_rows = [row for row in family_rows if row["lane_label"] == "master"]
        spoke_rows = [row for row in family_rows if row["lane_label"] == "spoke"]
        family_breakdown[family] = OrderedDict(
            master=[row["skill_id"] for row in sorted(master_rows, key=lambda item: item["skill_id"])],
            spokes=[row["skill_id"] for row in sorted(spoke_rows, key=lambda item: item["skill_id"])],
            agent_coverage=sorted(
                {
                    agent
                    for row in family_rows
                    for agent in row["agents"]
                }
            ),
            refinement_focus=[
                {
                    "skill_id": row["skill_id"],
                    "lane": row["lane_label"],
                    "action": row["refinement_action"],
                }
                for row in sorted(
                    family_rows,
                    key=lambda item: (
                        item["refinement_action"] == "stable",
                        item["lane_label"],
                        item["skill_id"],
                    ),
                )
            ],
        )

    repeated_reads = OrderedDict(
        (read, count) for read, count in sorted(read_counter.items()) if count >= 4
    )
    failures = [row for row in rows if row["budget_status"] != "pass"]
    return OrderedDict(
        schema_version="skill-fleet-audit.v1",
        skill_count=len(rows),
        compact_kernel_label="owner role is reported as master; manifest role remains owner",
        update_required=bool(failures),
        budget_failures=[row["skill_id"] for row in failures],
        repeated_required_reads=repeated_reads,
        family_breakdown=family_breakdown,
        skills=rows,
    )


def _text(payload: dict[str, Any]) -> str:
    lines = [
        "Skill Fleet Audit",
        f"Skills: {payload['skill_count']}",
        f"Compact label: {payload['compact_kernel_label']}",
        f"Update required: {payload['update_required']}",
        "Budget failures:",
    ]
    if payload["budget_failures"]:
        lines.extend(f"- {item}" for item in payload["budget_failures"])
    else:
        lines.append("- none")
    lines.append("Repeated required reads:")
    if payload["repeated_required_reads"]:
        lines.extend(
            f"- {read}: {count}"
            for read, count in payload["repeated_required_reads"].items()
        )
    else:
        lines.append("- none")
    lines.append("Master/spoke family breakdown:")
    for family, summary in payload["family_breakdown"].items():
        master = ", ".join(summary["master"]) or "none"
        spokes = ", ".join(summary["spokes"]) or "none"
        agents = ", ".join(summary["agent_coverage"]) or "none"
        lines.append(f"- {family}: master={master}; spokes={spokes}; agents={agents}")
        for item in summary["refinement_focus"]:
            if item["action"] != "stable":
                lines.append(f"  - refine {item['lane']} {item['skill_id']}: {item['action']}")
    lines.append("Skill lanes:")
    for row in payload["skills"]:
        signals = ", ".join(row["duplication_signals"]) or "none"
        workflows = ", ".join(item["id"] for item in row["workflows"]) or "none"
        agents = ", ".join(row["agents"]) or "none"
        lines.append(
            f"- {row['lane_label']} {row['skill_id']}: "
            f"lines={row['line_count']}/{row['max_lines']} "
            f"reads={row['required_read_count']}/{READ_FIRST_MAX_ITEMS} "
            f"checks={row['required_check_count']}/{REQUIRED_CHECKS_MAX_COMMANDS} "
            f"refs={row['reference_count']} scripts={row['script_count']} "
            f"status={row['budget_status']} agents={agents} workflows={workflows} "
            f"mechanisms={','.join(row['detection_mechanisms'])} duplication={signals} "
            f"refinement={row['refinement_action']}"
        )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit compact-kernel status across repo-local Codex skills.")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--text", action="store_true")
    args = parser.parse_args()
    payload = audit()
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(_text(payload))
    return 1 if payload["update_required"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
