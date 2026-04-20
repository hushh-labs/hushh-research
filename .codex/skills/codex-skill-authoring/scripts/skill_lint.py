#!/usr/bin/env python3
from __future__ import annotations

import json
import re
from collections import OrderedDict, defaultdict
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[4]
SKILLS_ROOT = REPO_ROOT / ".codex/skills"
WORKFLOWS_ROOT = REPO_ROOT / ".codex/workflows"
REQUIRED_SKILL_SECTIONS = [
    "Purpose and Trigger",
    "Coverage and Ownership",
    "Do Use",
    "Do Not Use",
    "Read First",
    "Workflow",
    "Handoff Rules",
    "Required Checks",
]
REQUIRED_SKILL_MANIFEST_KEYS = [
    "id",
    "role",
    "owner_family",
    "primary_scope",
    "description",
    "owned_paths",
    "non_owned_paths",
    "task_types",
    "required_reads",
    "required_commands",
    "verification_bundles",
    "handoff_targets",
    "adjacent_skills",
    "risk_tags",
]
REQUIRED_WORKFLOW_KEYS = [
    "id",
    "title",
    "goal",
    "owner_skill",
    "default_spoke",
    "task_type",
    "affected_surfaces",
    "required_reads",
    "required_commands",
    "verification_bundle",
    "deliverables",
    "impact_fields",
    "handoff_chain",
    "common_failures",
]
EXPECTED_WORKFLOW_IDS = [
    "repo-orientation",
    "new-feature-tri-flow",
    "api-contract-change",
    "analytics-observability-review",
    "bug-triage",
    "ci-watch-and-heal",
    "pre-pr-readiness",
    "security-consent-audit",
    "mobile-parity-check",
    "release-readiness",
    "docs-sync",
    "skill-authoring",
    "board-update",
    "community-response",
    "autonomous-rca-governance",
    "future-roadmap-plan",
    "mcp-surface-change",
    "oss-license-governance",
    "contributor-onboarding",
    "subtree-upstream-governance",
    "hushh-consent-mcp-ops",
    "security-posture-maintenance",
]
SPECIAL_HANDOFF_TOKENS = {"selected-owner-skill"}
MEANINGFUL_SURFACES = [
    "README.md",
    "bin",
    "scripts",
    "config",
    "deploy",
    "docs",
    "hushh-webapp/app",
    "hushh-webapp/components",
    "hushh-webapp/lib",
    "hushh-webapp/__tests__",
    "hushh-webapp/scripts",
    "hushh-webapp/docs",
    "hushh-webapp/ios",
    "hushh-webapp/android",
    "consent-protocol/api",
    "consent-protocol/hushh_mcp",
    "consent-protocol/tests",
    "consent-protocol/docs",
    "consent-protocol/scripts",
    "packages/hushh-mcp",
    "data",
    ".codex/skills",
]
BROAD_PATTERNS = [
    r"\bany frontend\b",
    r"\ball frontend\b",
    r"\bgeneral coding\b",
    r"\bbroad repo\b",
    r"\beverything\b",
]
PATH_PREFIXES = (
    ".codex/",
    "README.md",
    "docs/",
    "bin/",
    "scripts/",
    "config/",
    "deploy/",
    "data/",
    "hushh-webapp/",
    "consent-protocol/",
    "packages/",
)


def parse_frontmatter(text: str) -> dict[str, str]:
    data = {"name": "", "description": ""}
    in_frontmatter = False
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if line == "---":
            in_frontmatter = not in_frontmatter
            continue
        if not in_frontmatter:
            break
        if line.startswith("name:"):
            data["name"] = line.split(":", 1)[1].strip()
        elif line.startswith("description:"):
            data["description"] = line.split(":", 1)[1].strip()
    return data


def parse_sections(text: str) -> OrderedDict[str, str]:
    sections: OrderedDict[str, list[str]] = OrderedDict()
    current = None
    for raw_line in text.splitlines():
        if raw_line.startswith("## "):
            current = raw_line[3:].strip()
            sections[current] = []
            continue
        if current is not None:
            sections[current].append(raw_line)
    return OrderedDict((key, "\n".join(value).strip()) for key, value in sections.items())


def extract_backticks(text: str) -> list[str]:
    return re.findall(r"(?<!`)`([^`\n]+)`(?!`)", text)


def parse_coverage(section_text: str) -> dict[str, object]:
    role_match = re.search(r"Role:\s*`([^`]+)`", section_text)
    family_match = re.search(r"Owner family:\s*`([^`]+)`", section_text)
    owned_match = re.search(r"Owned repo surfaces:\s*(.*?)(?:\n\s*Non-owned surfaces:|\Z)", section_text, re.S)
    non_owned_match = re.search(r"Non-owned surfaces:\s*(.*)$", section_text, re.S)
    return {
        "role": role_match.group(1) if role_match else "",
        "owner_family": family_match.group(1) if family_match else "",
        "owned_surfaces": extract_backticks(owned_match.group(1)) if owned_match else [],
        "non_owned_surfaces": extract_backticks(non_owned_match.group(1)) if non_owned_match else [],
    }


def extract_code_paths(text: str) -> list[str]:
    paths = []
    for value in extract_backticks(text):
        if value.startswith(PATH_PREFIXES) or value.endswith(".md"):
            paths.append(value)
    return paths


def parse_required_checks(section_text: str) -> list[str]:
    lines: list[str] = []
    in_block = False
    for raw_line in section_text.splitlines():
        stripped = raw_line.strip()
        if stripped == "```bash":
            in_block = True
            continue
        if in_block and stripped == "```":
            break
        if in_block and stripped:
            lines.append(stripped)
    return lines


def path_exists(candidate: str) -> bool:
    normalized = candidate.rstrip("/")
    return (REPO_ROOT / normalized).exists()


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def validate_verification_bundle(value: Any, origin: str, errors: list[str]) -> None:
    if not isinstance(value, dict):
        errors.append(f"{origin}: verification bundle must be an object")
        return
    for key in ("id", "commands", "tests"):
        if key not in value:
            errors.append(f"{origin}: verification bundle missing `{key}`")
    commands = value.get("commands", [])
    tests = value.get("tests", [])
    if not isinstance(commands, list) or not all(isinstance(item, str) and item for item in commands):
        errors.append(f"{origin}: verification bundle `commands` must be a non-empty string list")
    if not isinstance(tests, list) or not all(isinstance(item, str) and item for item in tests):
        errors.append(f"{origin}: verification bundle `tests` must be a string list")


def collect_skill_bodies() -> tuple[list[dict[str, Any]], list[str]]:
    errors: list[str] = []
    skills: list[dict[str, Any]] = []
    for skill_file in sorted(SKILLS_ROOT.glob("*/SKILL.md")):
        rel = skill_file.relative_to(REPO_ROOT)
        text = skill_file.read_text(encoding="utf-8")
        frontmatter = parse_frontmatter(text)
        sections = parse_sections(text)

        if not frontmatter["description"].startswith("Use when "):
            errors.append(f"{rel}: description must start with 'Use when '")
        if list(sections.keys()) != REQUIRED_SKILL_SECTIONS:
            errors.append(f"{rel}: sections must match the canonical contract exactly")
            continue

        purpose = sections["Purpose and Trigger"]
        coverage = parse_coverage(sections["Coverage and Ownership"])
        primary_scope_match = re.search(r"Primary scope:\s*`([^`]+)`", purpose)
        if not primary_scope_match:
            errors.append(f"{rel}: missing `Primary scope:` in Purpose and Trigger")
        if not re.search(r"Trigger on ", purpose):
            errors.append(f"{rel}: missing 'Trigger on' guidance in Purpose and Trigger")
        if not re.search(r"Avoid overlap with\s+.+\.", purpose):
            errors.append(f"{rel}: missing 'Avoid overlap with' guidance in Purpose and Trigger")
        if not coverage["role"]:
            errors.append(f"{rel}: missing `Role:` in Coverage and Ownership")
        if not coverage["owner_family"]:
            errors.append(f"{rel}: missing `Owner family:` in Coverage and Ownership")
        if not coverage["owned_surfaces"]:
            errors.append(f"{rel}: Coverage and Ownership must declare owned repo surfaces")
        if not coverage["non_owned_surfaces"]:
            errors.append(f"{rel}: Coverage and Ownership must declare non-owned surfaces")
        if "1." not in sections["Do Not Use"]:
            errors.append(f"{rel}: Do Not Use must contain at least one numbered item")

        for candidate in extract_code_paths(text):
            if candidate.startswith("npm run "):
                continue
            if candidate.startswith(PATH_PREFIXES) and not path_exists(candidate):
                errors.append(f"{rel}: referenced path does not exist: {candidate}")

        skills.append(
            {
                "file": str(rel),
                "name": frontmatter["name"] or skill_file.parent.name,
                "folder": skill_file.parent.name,
                "description": frontmatter["description"],
                "primary_scope": primary_scope_match.group(1) if primary_scope_match else "",
                "sections": sections,
                "role": coverage["role"],
                "owner_family": coverage["owner_family"],
                "owned_surfaces": [value.rstrip("/") for value in coverage["owned_surfaces"]],
                "non_owned_surfaces": [value.rstrip("/") for value in coverage["non_owned_surfaces"]],
                "required_checks": parse_required_checks(sections["Required Checks"]),
            }
        )
    return skills, errors


def validate_skill_manifests(skills: list[dict[str, Any]], errors: list[str]) -> dict[str, dict[str, Any]]:
    manifests: dict[str, dict[str, Any]] = {}
    scopes: dict[str, str] = {}

    for skill in skills:
        rel = skill["file"]
        folder = skill["folder"]
        manifest_path = SKILLS_ROOT / folder / "skill.json"
        if not manifest_path.exists():
            errors.append(f"{rel}: missing skill.json")
            continue
        manifest = load_json(manifest_path)
        manifests[folder] = manifest

        for key in REQUIRED_SKILL_MANIFEST_KEYS:
            if key not in manifest:
                errors.append(f"{manifest_path.relative_to(REPO_ROOT)}: missing `{key}`")

        if manifest.get("id") != folder:
            errors.append(f"{manifest_path.relative_to(REPO_ROOT)}: `id` must equal skill folder name")
        if manifest.get("description") != skill["description"]:
            errors.append(f"{manifest_path.relative_to(REPO_ROOT)}: description must match SKILL.md frontmatter")
        if manifest.get("primary_scope") != skill["primary_scope"]:
            errors.append(f"{manifest_path.relative_to(REPO_ROOT)}: primary_scope must match SKILL.md")
        if manifest.get("role") != skill["role"]:
            errors.append(f"{manifest_path.relative_to(REPO_ROOT)}: role must match SKILL.md")
        if manifest.get("owner_family") != skill["owner_family"]:
            errors.append(f"{manifest_path.relative_to(REPO_ROOT)}: owner_family must match SKILL.md")
        if manifest.get("owned_paths", []) != skill["owned_surfaces"]:
            errors.append(f"{manifest_path.relative_to(REPO_ROOT)}: owned_paths must match SKILL.md")
        if manifest.get("required_reads", []) != [value.rstrip("/") for value in extract_backticks(skill["sections"]["Read First"])]:
            errors.append(f"{manifest_path.relative_to(REPO_ROOT)}: required_reads must match SKILL.md Read First")
        if manifest.get("required_commands", []) != skill["required_checks"]:
            errors.append(f"{manifest_path.relative_to(REPO_ROOT)}: required_commands must match SKILL.md Required Checks")

        primary_scope = manifest.get("primary_scope", "")
        if primary_scope:
            other = scopes.get(primary_scope)
            if other:
                errors.append(f"{manifest_path.relative_to(REPO_ROOT)}: primary scope `{primary_scope}` already used by {other}")
            else:
                scopes[primary_scope] = str(manifest_path.relative_to(REPO_ROOT))

        role = manifest.get("role", "")
        owner_family = manifest.get("owner_family", "")
        if role not in {"owner", "spoke"}:
            errors.append(f"{manifest_path.relative_to(REPO_ROOT)}: role must be `owner` or `spoke`")
        if role == "owner" and owner_family != folder:
            errors.append(f"{manifest_path.relative_to(REPO_ROOT)}: owner skills must have owner_family equal to folder name")
        if not isinstance(manifest.get("task_types"), list) or not manifest["task_types"]:
            errors.append(f"{manifest_path.relative_to(REPO_ROOT)}: task_types must be a non-empty list")
        if not isinstance(manifest.get("required_commands"), list) or not manifest["required_commands"]:
            errors.append(f"{manifest_path.relative_to(REPO_ROOT)}: required_commands must be a non-empty list")
        if not isinstance(manifest.get("handoff_targets"), list) or not manifest["handoff_targets"]:
            errors.append(f"{manifest_path.relative_to(REPO_ROOT)}: handoff_targets must be a non-empty list")
        if not isinstance(manifest.get("adjacent_skills"), list) or not manifest["adjacent_skills"]:
            errors.append(f"{manifest_path.relative_to(REPO_ROOT)}: adjacent_skills must be a non-empty list")
        if not isinstance(manifest.get("risk_tags"), list) or not manifest["risk_tags"]:
            errors.append(f"{manifest_path.relative_to(REPO_ROOT)}: risk_tags must be a non-empty list")

        bundles = manifest.get("verification_bundles", [])
        if not isinstance(bundles, list) or not bundles:
            errors.append(f"{manifest_path.relative_to(REPO_ROOT)}: verification_bundles must be a non-empty list")
        else:
            for index, bundle in enumerate(bundles):
                validate_verification_bundle(bundle, f"{manifest_path.relative_to(REPO_ROOT)}[{index}]", errors)

    owner_names = {folder for folder, manifest in manifests.items() if manifest.get("role") == "owner"}
    for skill in skills:
        rel = skill["file"]
        text = " ".join([skill["description"], skill["sections"]["Purpose and Trigger"], skill["sections"]["Do Use"]]).lower()
        manifest = manifests.get(skill["folder"])
        if manifest is None:
            continue
        role = manifest["role"]
        owner_family = manifest["owner_family"]
        if role == "spoke":
            if owner_family not in owner_names:
                errors.append(f"{rel}: spoke owner family `{owner_family}` does not map to an owner skill")
            for pattern in BROAD_PATTERNS:
                if re.search(pattern, text):
                    errors.append(f"{rel}: spoke contains overly broad trigger language matching /{pattern}/")
            if owner_family not in manifest["handoff_targets"]:
                errors.append(f"{rel}: spoke manifest must hand broad intake back to `{owner_family}`")

        for candidate in manifest.get("owned_paths", []):
            if candidate.startswith(PATH_PREFIXES) and not path_exists(candidate):
                errors.append(f"{rel}: owned path does not exist: {candidate}")
        for candidate in manifest.get("required_reads", []):
            if candidate.startswith(PATH_PREFIXES) and not path_exists(candidate):
                errors.append(f"{rel}: required_read does not exist: {candidate}")
        for candidate in manifest.get("non_owned_paths", []):
            if candidate in manifests:
                continue
            if candidate.startswith(PATH_PREFIXES) and not path_exists(candidate):
                errors.append(f"{rel}: non_owned_path does not exist: {candidate}")
        for candidate in manifest.get("handoff_targets", []):
            if candidate not in manifests:
                errors.append(f"{rel}: handoff target does not exist: {candidate}")
        for candidate in manifest.get("adjacent_skills", []):
            if candidate not in manifests:
                errors.append(f"{rel}: adjacent skill does not exist: {candidate}")

    owner_surface_map: defaultdict[str, list[str]] = defaultdict(list)
    for folder, manifest in manifests.items():
        if manifest.get("role") == "owner":
            for owned in manifest.get("owned_paths", []):
                owner_surface_map[owned].append(folder)
    for surface in MEANINGFUL_SURFACES:
        if not owner_surface_map.get(surface):
            errors.append(f"orphaned meaningful repo surface: {surface}")

    return manifests


def validate_workflows(skill_manifests: dict[str, dict[str, Any]], errors: list[str]) -> None:
    found_ids: list[str] = []
    all_task_types = {
        task_type
        for manifest in skill_manifests.values()
        for task_type in manifest.get("task_types", [])
    }
    issue_sections: dict[str, str] = {}

    for workflow_dir in sorted(path for path in WORKFLOWS_ROOT.iterdir() if path.is_dir()):
        workflow_path = workflow_dir / "workflow.json"
        playbook_path = workflow_dir / "PLAYBOOK.md"
        rel = workflow_dir.relative_to(REPO_ROOT)
        found_ids.append(workflow_dir.name)

        if not workflow_path.exists():
            errors.append(f"{rel}: missing workflow.json")
            continue
        if not playbook_path.exists():
            errors.append(f"{rel}: missing PLAYBOOK.md")
        workflow = load_json(workflow_path)
        for key in REQUIRED_WORKFLOW_KEYS:
            if key not in workflow:
                errors.append(f"{workflow_path.relative_to(REPO_ROOT)}: missing `{key}`")

        if workflow.get("id") != workflow_dir.name:
            errors.append(f"{workflow_path.relative_to(REPO_ROOT)}: `id` must equal workflow folder name")
        if workflow.get("task_type") != workflow_dir.name:
            errors.append(f"{workflow_path.relative_to(REPO_ROOT)}: task_type must equal workflow id for deterministic routing")
        owner_skill = workflow.get("owner_skill")
        default_spoke = workflow.get("default_spoke")
        if owner_skill not in skill_manifests:
            errors.append(f"{workflow_path.relative_to(REPO_ROOT)}: owner_skill `{owner_skill}` does not exist")
        elif skill_manifests[owner_skill].get("role") != "owner":
            errors.append(f"{workflow_path.relative_to(REPO_ROOT)}: owner_skill `{owner_skill}` must be an owner skill")
        if default_spoke is not None:
            if default_spoke not in skill_manifests:
                errors.append(f"{workflow_path.relative_to(REPO_ROOT)}: default_spoke `{default_spoke}` does not exist")
            elif skill_manifests[default_spoke].get("role") != "spoke":
                errors.append(f"{workflow_path.relative_to(REPO_ROOT)}: default_spoke `{default_spoke}` must be a spoke")

        if workflow.get("task_type") not in all_task_types:
            errors.append(f"{workflow_path.relative_to(REPO_ROOT)}: task_type is not claimed by any skill manifest")
        if owner_skill in skill_manifests and workflow.get("task_type") not in skill_manifests[owner_skill].get("task_types", []):
            errors.append(f"{workflow_path.relative_to(REPO_ROOT)}: owner_skill `{owner_skill}` must declare task_type `{workflow['task_type']}`")
        if default_spoke and default_spoke in skill_manifests and workflow.get("task_type") not in skill_manifests[default_spoke].get("task_types", []):
            errors.append(f"{workflow_path.relative_to(REPO_ROOT)}: default_spoke `{default_spoke}` must declare task_type `{workflow['task_type']}`")

        for field in ("affected_surfaces", "required_reads", "required_commands", "deliverables", "impact_fields", "handoff_chain", "common_failures"):
            value = workflow.get(field)
            if not isinstance(value, list) or not value:
                errors.append(f"{workflow_path.relative_to(REPO_ROOT)}: `{field}` must be a non-empty list")

        for candidate in workflow.get("affected_surfaces", []):
            if candidate.startswith(PATH_PREFIXES) and not path_exists(candidate):
                errors.append(f"{workflow_path.relative_to(REPO_ROOT)}: affected surface does not exist: {candidate}")
        for candidate in workflow.get("required_reads", []):
            if candidate.startswith(PATH_PREFIXES) and not path_exists(candidate):
                errors.append(f"{workflow_path.relative_to(REPO_ROOT)}: required read does not exist: {candidate}")

        validate_verification_bundle(workflow.get("verification_bundle"), str(workflow_path.relative_to(REPO_ROOT)), errors)

        for candidate in workflow.get("handoff_chain", []):
            if candidate in SPECIAL_HANDOFF_TOKENS:
                continue
            if candidate not in skill_manifests:
                errors.append(f"{workflow_path.relative_to(REPO_ROOT)}: handoff_chain item does not map to a skill: {candidate}")

    missing = sorted(set(EXPECTED_WORKFLOW_IDS) - set(found_ids))
    extras = sorted(set(found_ids) - set(EXPECTED_WORKFLOW_IDS))
    for workflow_id in missing:
        errors.append(f"missing required workflow pack: {workflow_id}")
    for workflow_id in extras:
        errors.append(f"unexpected workflow pack without contract entry: {workflow_id}")


def main() -> int:
    skills, errors = collect_skill_bodies()
    skill_manifests = validate_skill_manifests(skills, errors)
    validate_workflows(skill_manifests, errors)

    if errors:
        print("Skill lint failed:")
        for item in errors:
            print(f"- {item}")
        return 1

    print("Skill lint passed")
    print(
        f"Validated {len(skills)} skills, {len(skill_manifests)} skill manifests, "
        f"{len(EXPECTED_WORKFLOW_IDS)} workflow packs, and {len(MEANINGFUL_SURFACES)} meaningful repo surfaces"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
