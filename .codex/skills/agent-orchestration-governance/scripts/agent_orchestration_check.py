#!/usr/bin/env python3
"""Validate repo-scoped Codex agent orchestration surfaces."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError as exc:  # pragma: no cover
    raise SystemExit(f"tomllib is required: {exc}") from exc


DEFAULT_ROOT = Path(__file__).resolve().parents[4]
CONFIG_RELATIVE_PATH = Path(".codex/config.toml")
AGENTS_RELATIVE_PATH = Path(".codex/agents")
SKILLS_RELATIVE_PATH = Path(".codex/skills")

EXPECTED_AGENTS = {
    "governor",
    "reviewer",
    "repo_operator",
    "rca_investigator",
    "frontend_architect",
    "backend_architect",
    "security_consent_auditor",
    "voice_systems_architect",
}
REQUIRED_KEYS = {"name", "description", "developer_instructions", "sandbox_mode"}
READ_ONLY_BASELINE = EXPECTED_AGENTS
NICKNAME_RE = re.compile(r"^[A-Za-z0-9 _-]+$")
SKILL_BLOCK_HEADER = "Use these repo-local skills when they fit the lane:"
GOVERNOR_AUTHORITY_RULE = "only you may produce final merge, deploy, or plan recommendations"
NON_GOVERNOR_AUTHORITY_RULE = "You are advisory-only. Do not self-authorize merge, deploy, release, or governance decisions."


def load_toml(path: Path) -> dict:
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # pragma: no cover - surfaced directly to CLI
        raise ValueError(f"{path}: failed to parse TOML: {exc}") from exc


def load_skill_ids(root: Path) -> set[str]:
    skill_ids: set[str] = set()
    for manifest_path in (root / SKILLS_RELATIVE_PATH).glob("*/skill.json"):
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception as exc:  # pragma: no cover - surfaced directly to CLI
            raise ValueError(f"{manifest_path}: failed to parse JSON: {exc}") from exc
        skill_id = manifest.get("id")
        if isinstance(skill_id, str) and skill_id:
            skill_ids.add(skill_id)
    return skill_ids


def validate_config(root: Path, errors: list[str]) -> None:
    config_path = root / CONFIG_RELATIVE_PATH
    if not config_path.exists():
        errors.append(f"missing config file: {config_path}")
        return
    config = load_toml(config_path)
    agents = config.get("agents")
    if not isinstance(agents, dict):
        errors.append(f"{config_path}: missing [agents] table")
        return
    if agents.get("max_threads") != 6:
        errors.append(f"{config_path}: agents.max_threads must equal 6")
    if agents.get("max_depth") != 1:
        errors.append(f"{config_path}: agents.max_depth must equal 1")


def parse_skill_block(path: Path, instructions: str, errors: list[str]) -> list[str]:
    match = re.search(
        rf"{re.escape(SKILL_BLOCK_HEADER)}\n(?P<block>(?:- [^\n]+\n)+)",
        instructions,
    )
    if not match:
        errors.append(f"{path}: developer_instructions must include the standardized skill block header")
        return []

    block = match.group("block").strip().splitlines()
    skills = []
    for line in block:
        if not line.startswith("- "):
            errors.append(f"{path}: malformed skill line in developer_instructions: {line}")
            continue
        skills.append(line[2:].strip())
    return skills


def validate_agent_file(path: Path, skill_ids: set[str], seen_names: set[str], errors: list[str]) -> None:
    agent = load_toml(path)
    missing = sorted(REQUIRED_KEYS - agent.keys())
    if missing:
        errors.append(f"{path}: missing required keys: {', '.join(missing)}")
        return

    name = agent["name"]
    if not isinstance(name, str) or not name:
        errors.append(f"{path}: name must be a non-empty string")
        return
    description = agent["description"]
    if not isinstance(description, str) or not description.strip():
        errors.append(f"{path}: description must be a non-empty string")
    instructions = agent["developer_instructions"]
    if not isinstance(instructions, str) or not instructions.strip():
        errors.append(f"{path}: developer_instructions must be a non-empty string")
        return
    sandbox_mode = agent["sandbox_mode"]
    if not isinstance(sandbox_mode, str) or not sandbox_mode.strip():
        errors.append(f"{path}: sandbox_mode must be a non-empty string")
        return

    if path.stem != name:
        errors.append(f"{path}: filename stem must match name '{name}'")

    if name in seen_names:
        errors.append(f"{path}: duplicate agent name '{name}'")
    seen_names.add(name)

    if sandbox_mode != "read-only" and name in READ_ONLY_BASELINE:
        errors.append(f"{path}: wave-1 baseline agent '{name}' must use sandbox_mode = \"read-only\"")

    referenced_skills = parse_skill_block(path, instructions, errors)
    for skill_id in referenced_skills:
        if skill_id not in skill_ids:
            errors.append(f"{path}: referenced repo-local skill does not exist: {skill_id}")

    instructions_lower = instructions.lower()
    if name == "governor":
        if GOVERNOR_AUTHORITY_RULE not in instructions_lower:
            errors.append(f"{path}: governor must explicitly contain the final-authority rule")
    else:
        if NON_GOVERNOR_AUTHORITY_RULE not in instructions:
            errors.append(f"{path}: non-governor baseline agents must explicitly contain the advisory-only rule")

    nicknames = agent.get("nickname_candidates")
    if nicknames is not None:
        if not isinstance(nicknames, list) or not nicknames:
            errors.append(f"{path}: nickname_candidates must be a non-empty list when present")
        else:
            if len(set(nicknames)) != len(nicknames):
                errors.append(f"{path}: nickname_candidates must be unique")
            for nickname in nicknames:
                if not isinstance(nickname, str) or not NICKNAME_RE.fullmatch(nickname):
                    errors.append(f"{path}: invalid nickname '{nickname}'")


def validate_agents(root: Path, errors: list[str]) -> None:
    agents_dir = root / AGENTS_RELATIVE_PATH
    if not agents_dir.exists():
        errors.append(f"missing agents directory: {agents_dir}")
        return
    files = sorted(agents_dir.glob("*.toml"))
    if not files:
        errors.append(f"{agents_dir}: no custom agent files found")
        return

    skill_ids = load_skill_ids(root)
    seen_names: set[str] = set()
    for path in files:
        validate_agent_file(path, skill_ids, seen_names, errors)

    missing_expected = sorted(EXPECTED_AGENTS - seen_names)
    if missing_expected:
        errors.append(
            f"{agents_dir}: missing required baseline agents: {', '.join(missing_expected)}"
        )
    extra_agents = sorted(seen_names - EXPECTED_AGENTS)
    if extra_agents:
        errors.append(
            f"{agents_dir}: unexpected repo-scoped agents outside the curated wave-1 baseline: {', '.join(extra_agents)}"
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate repo-scoped Codex agent orchestration surfaces.")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT, help="repo root to validate")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    errors: list[str] = []
    validate_config(root, errors)
    validate_agents(root, errors)

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    config_path = root / CONFIG_RELATIVE_PATH
    agent_files = sorted(p.name for p in (root / AGENTS_RELATIVE_PATH).glob("*.toml"))
    print("Agent orchestration surfaces valid.")
    print(f"Config: {config_path.relative_to(root)}")
    print(f"Agents: {', '.join(agent_files)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
