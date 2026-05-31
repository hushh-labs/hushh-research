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
MASTER_SKILL_MAX_LINES = 110
SPOKE_SKILL_MAX_LINES = 85
REFERENCE_MAX_LINES = 220
READ_FIRST_MAX_ITEMS = 8
REQUIRED_CHECKS_MAX_COMMANDS = 8
REFERENCE_LINE_ALLOWLIST: set[str] = set()
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
    "agent-orchestration-governance",
    "repo-orientation",
    "new-feature-tri-flow",
    "frontend-native-surface-map",
    "frontend-cache-coherence",
    "api-contract-change",
    "pr-governance-review",
    "analytics-observability-review",
    "bug-triage",
    "ci-watch-and-heal",
    "data-model-audit",
    "github-contribution-governance",
    "uat-scoped-deploy",
    "pre-pr-readiness",
    "security-consent-audit",
    "mobile-parity-check",
    "release-readiness",
    "docs-sync",
    "founder-brief-curation",
    "skill-authoring",
    "board-update",
    "community-response",
    "autonomous-rca-governance",
    "future-roadmap-plan",
    "kai-voice-governance",
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
TRUTH_FIRST_REFERENCE = ".codex/skills/codex-skill-authoring/references/truth-first-operating-kernel.md"
TRUTH_FIRST_LABELS = [
    "already_exists",
    "partially_exists",
    "missing",
    "future_state_only",
    "wrong_direction",
    "needs_verification",
]
TRUTH_FIRST_HANDOFF_TOKENS = [
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
TRUTH_FIRST_DOMAIN_PROBES = [
    "Kai Decisions",
    "MCP And Consent Tools",
    "PKM And Vault",
    "Voice And Action Gateway",
    "PR Governance",
    "Founder Wiki North-Star",
    "Frontend",
    "Data Model",
]
FOUNDER_WIKI_REFERENCE = ".codex/skills/codex-skill-authoring/references/founder-wiki-north-star-probe.md"
FOUNDER_WIKI_AUDIT_SCRIPT = ".codex/skills/codex-skill-authoring/scripts/founder_wiki_workspace_audit.py"


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


def line_count(path: Path) -> int:
    return len(path.read_text(encoding="utf-8").splitlines())


def compact_kernel_label(role: str) -> str:
    return "master" if role == "owner" else "spoke"


def compact_kernel_line_budget(role: str) -> int:
    return MASTER_SKILL_MAX_LINES if role == "owner" else SPOKE_SKILL_MAX_LINES


def compact_kernel_budget_errors(
    *,
    origin: str,
    role: str,
    skill_lines: int,
    read_first_count: int,
    required_check_count: int,
) -> list[str]:
    errors: list[str] = []
    max_lines = compact_kernel_line_budget(role)
    if role in {"owner", "spoke"} and skill_lines > max_lines:
        label = compact_kernel_label(role)
        errors.append(
            f"{origin}: {label} compact-kernel budget exceeded: {skill_lines} lines > {max_lines}; move durable detail to references/scripts/workflows"
        )
    if read_first_count > READ_FIRST_MAX_ITEMS:
        errors.append(
            f"{origin}: Read First budget exceeded: {read_first_count} items > {READ_FIRST_MAX_ITEMS}; keep only canonical entrypoints"
        )
    if required_check_count > REQUIRED_CHECKS_MAX_COMMANDS:
        errors.append(
            f"{origin}: Required Checks budget exceeded: {required_check_count} commands > {REQUIRED_CHECKS_MAX_COMMANDS}; move scenarios into smoke scripts"
        )
    return errors


def reference_budget_error(origin: str, reference_lines: int) -> str | None:
    if reference_lines <= REFERENCE_MAX_LINES:
        return None
    return (
        f"{origin}: reference budget exceeded: {reference_lines} lines > {REFERENCE_MAX_LINES}; "
        "split into focused references or move repeatable logic into scripts"
    )


def collect_skill_bodies() -> tuple[list[dict[str, Any]], list[str]]:
    errors: list[str] = []
    skills: list[dict[str, Any]] = []
    for skill_file in sorted(SKILLS_ROOT.glob("*/SKILL.md")):
        rel = skill_file.relative_to(REPO_ROOT)
        text = skill_file.read_text(encoding="utf-8")
        skill_line_count = len(text.splitlines())
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
        read_first_items = extract_backticks(sections["Read First"])
        required_checks = parse_required_checks(sections["Required Checks"])
        errors.extend(
            compact_kernel_budget_errors(
                origin=str(rel),
                role=coverage["role"],
                skill_lines=skill_line_count,
                read_first_count=len(read_first_items),
                required_check_count=len(required_checks),
            )
        )

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
                "required_checks": required_checks,
                "line_count": skill_line_count,
            }
        )
    return skills, errors


def validate_reference_budgets(errors: list[str]) -> None:
    for path in sorted(SKILLS_ROOT.glob("*/references/*.md")):
        rel = str(path.relative_to(REPO_ROOT))
        if rel in REFERENCE_LINE_ALLOWLIST:
            continue
        count = line_count(path)
        error = reference_budget_error(rel, count)
        if error:
            errors.append(error)


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


def validate_special_skill_contracts(errors: list[str]) -> None:
    comms_skill = SKILLS_ROOT / "comms-community" / "SKILL.md"
    reply_rules = SKILLS_ROOT / "comms-community" / "references" / "reply-rules.md"
    community_playbook = WORKFLOWS_ROOT / "community-response" / "PLAYBOOK.md"
    community_workflow = WORKFLOWS_ROOT / "community-response" / "workflow.json"
    pr_governance_skill = SKILLS_ROOT / "pr-governance-review" / "SKILL.md"
    pr_operator_contract = (
        SKILLS_ROOT / "pr-governance-review" / "references" / "operator-batch-output-contract.md"
    )
    pr_comment_contract = (
        SKILLS_ROOT / "pr-governance-review" / "references" / "comment-and-report-contract.md"
    )
    pr_train_sop = (
        SKILLS_ROOT / "pr-governance-review" / "references" / "pr-train-review-sop.md"
    )
    pr_workflow_playbook = WORKFLOWS_ROOT / "pr-governance-review" / "PLAYBOOK.md"
    pr_operator_question_fixtures = (
        SKILLS_ROOT / "pr-governance-review" / "references" / "operator-question-fixtures.json"
    )
    pr_review_script = SKILLS_ROOT / "pr-governance-review" / "scripts" / "pr_review_checklist.py"
    future_planner_skill = SKILLS_ROOT / "future-planner" / "SKILL.md"
    founder_brief_skill = SKILLS_ROOT / "founder-brief-curation" / "SKILL.md"
    orchestration_skill = SKILLS_ROOT / "agent-orchestration-governance" / "SKILL.md"
    delegation_contract = (
        SKILLS_ROOT / "agent-orchestration-governance" / "references" / "delegation-contract.md"
    )

    if comms_skill.exists():
        skill_text = comms_skill.read_text(encoding="utf-8")
        required_skill_phrases = [
            "default to exactly two named outputs",
            "`Brief reply`",
            "`Detailed reply`",
            "canonical GitHub markdown doc links on `main`, not repo-relative paths",
            "maintained top-level doc first",
            "Founder Wiki North-Star Probe",
            "Private wiki evidence must not be cited or exposed",
        ]
        for phrase in required_skill_phrases:
            if phrase not in skill_text:
                errors.append(
                    f"{comms_skill.relative_to(REPO_ROOT)}: missing comms-community contract phrase `{phrase}`"
                )

    if reply_rules.exists():
        rules_text = reply_rules.read_text(encoding="utf-8")
        required_rules_phrases = [
            "All public links must be full GitHub URLs on `main`",
            "default output must include exactly:",
            "`Brief reply`",
            "`Detailed reply`",
            "`Firmer reply`",
            "Do not answer with repo-relative paths unless the user explicitly wants repo-local references.",
            "Keep normal Q&A lean",
            "Founder Wiki North-Star Probe",
            "Private wiki evidence stays local-only",
        ]
        for phrase in required_rules_phrases:
            if phrase not in rules_text:
                errors.append(
                    f"{reply_rules.relative_to(REPO_ROOT)}: missing comms-community reply rule phrase `{phrase}`"
                )

    if community_playbook.exists():
        playbook_text = community_playbook.read_text(encoding="utf-8")
        required_playbook_phrases = [
            "For drafted reply/Q&A requests, default to:",
            "full GitHub `blob/main` links",
        ]
        for phrase in required_playbook_phrases:
            if phrase not in playbook_text:
                errors.append(
                    f"{community_playbook.relative_to(REPO_ROOT)}: missing community-response playbook phrase `{phrase}`"
                )

    if community_workflow.exists():
        workflow = load_json(community_workflow)
        deliverables = workflow.get("deliverables", [])
        impact_fields = workflow.get("impact_fields", [])
        common_failures = workflow.get("common_failures", [])
        expected_deliverables = {
            "Brief reply",
            "Detailed reply",
            "claim classification for material premise corrections",
            "repo-backed GitHub doc citations",
        }
        for value in expected_deliverables:
            if value not in deliverables:
                errors.append(
                    f"{community_workflow.relative_to(REPO_ROOT)}: missing community-response deliverable `{value}`"
                )
        expected_impacts = {"GitHub doc links used", "Claim classification used", "Reply variants provided"}
        for value in expected_impacts:
            if value not in impact_fields:
                errors.append(
                    f"{community_workflow.relative_to(REPO_ROOT)}: missing community-response impact field `{value}`"
                )
        expected_failures = {
            "repo-relative paths instead of canonical GitHub doc links",
            "accepting contributor wording as repo truth",
            "bloated drafted-reply variants beyond Brief/Detailed without need",
        }
        for value in expected_failures:
            if value not in common_failures:
                errors.append(
                    f"{community_workflow.relative_to(REPO_ROOT)}: missing community-response failure mode `{value}`"
                )
        forbidden_values = {
            "default reply variant",
            "detailed reply variant",
            "missing required drafted-reply variants",
        }
        for value in forbidden_values:
            if value in deliverables or value in common_failures:
                errors.append(
                    f"{community_workflow.relative_to(REPO_ROOT)}: stale community-response workflow value `{value}`"
                )

    if pr_governance_skill.exists():
        pr_skill_text = pr_governance_skill.read_text(encoding="utf-8")
        pr_reference_paths = [
            pr_operator_contract,
            pr_comment_contract,
            pr_train_sop,
            SKILLS_ROOT / "pr-governance-review" / "references" / "blocker-gates.md",
            SKILLS_ROOT / "pr-governance-review" / "references" / "review-axes.md",
        ]
        pr_contract_text = pr_skill_text + "\n" + "\n".join(
            path.read_text(encoding="utf-8")
            for path in pr_reference_paths
            if path.exists()
        )
        required_pr_skill_phrases = [
            "Default PR-Train Mode",
            "Use the async PR-train method as the default",
            "Run the delegation router at intake",
        ]
        for phrase in required_pr_skill_phrases:
            if phrase not in pr_skill_text:
                errors.append(
                    f"{pr_governance_skill.relative_to(REPO_ROOT)}: missing PR governance skill phrase `{phrase}`"
                )
        required_pr_phrases = [
            "contract_set",
            "duplicate_group",
            "public_comment_policy",
            "Research Basis",
            "Reasoned Review Steps",
            "Per-PR Assessment",
            "Decision Questions",
            "Merge Train Capacity Model",
            "automatic next-train discovery",
            "app/backend reachability",
            "title/body claims one contract but the changed files touch another",
            "stacked",
            "local worktree overlap",
            "Do not include a separate successful-merge evidence section",
            "### Why It Matters",
            "Every PR merged through this governance workflow must get one post-merge closeout",
            "Every GitHub write must use the lane-specific heading contract",
            "Edit the existing current-lane record when possible",
            "prefer `patch_then_merge` over contributor round trips",
            "Final handoffs for state-changing PR work must include direct links",
            "Green CI never overrides exact file overlap",
            "Founder Wiki North-Star Probe",
            "current_state_vs_north_star_drift",
            "private wiki evidence stays local-only",
        ]
        for phrase in required_pr_phrases:
            if phrase not in pr_contract_text:
                errors.append(
                    f"{pr_governance_skill.relative_to(REPO_ROOT)} references: missing PR governance contract phrase `{phrase}`"
                )

    if pr_train_sop.exists():
        train_sop_text = pr_train_sop.read_text(encoding="utf-8")
        required_train_sop_phrases = [
            "Async Train Default",
            "This SOP is the canonical behavior source for multi-PR governance",
            "Move failing, missing, stale, or auxiliary-failing checks into",
            "Start one read-only evidence lane per independent train family",
            "Run independent trains in parallel",
            "N-Train Parallel Model",
            "process PRs one after another in ascending PR creation time",
            "Before requesting changes, explicitly evaluate whether the useful contribution",
            "Pre-Wave Operator Question",
            "Dynamic Decision Wave Sizing",
            "If this order conflicts with another PR-governance reference",
        ]
        for phrase in required_train_sop_phrases:
            if phrase not in train_sop_text:
                errors.append(
                    f"{pr_train_sop.relative_to(REPO_ROOT)}: missing PR train SOP phrase `{phrase}`"
                )

    if pr_workflow_playbook.exists():
        playbook_text = pr_workflow_playbook.read_text(encoding="utf-8")
        required_pr_playbook_phrases = [
            "Run the delegation router before final review selection",
            "Spawn/read the returned read-only evidence lanes",
            "For batched, backlog, repass, or train review",
            "Exclude PRs with failing, missing, stale, or auxiliary-failing checks",
            "Run independent trains in parallel through broad evidence lanes",
            "writer-lane exception does not make evidence lanes writable",
            "use the lane-to-comment map",
        ]
        for phrase in required_pr_playbook_phrases:
            if phrase not in playbook_text:
                errors.append(
                    f"{pr_workflow_playbook.relative_to(REPO_ROOT)}: missing PR workflow playbook phrase `{phrase}`"
                )

    if pr_operator_contract.exists():
        operator_text = pr_operator_contract.read_text(encoding="utf-8")
        required_operator_phrases = [
            "Research Basis",
            "All Async Trains",
            "Question Before Wave",
            "Recommended Wave Size",
            "Why This Size",
            "Exact PR Links",
            "Comment/Edit Policy",
            "Decision Questions",
            "current truth",
            "recommended path",
            "risk if accepted blindly",
            "recommended option first",
            "Pre-Wave Operator Question",
            "Dynamic acknowledgement sizing",
            "Blind-merge risk",
            "Smallest proof",
            "After-Merge Kickoff",
            "After-Wave Handoff",
            "Automatic next train",
            "Train-to-subagent map",
            "Check Failure Holds",
            "Repass/correction waves must normalize editable maintainer records",
            "Independent trains run in parallel through separate evidence lanes",
            "Maintainer patch or harvest is evaluated before requested changes",
        ]
        for phrase in required_operator_phrases:
            if phrase not in operator_text:
                errors.append(
                    f"{pr_operator_contract.relative_to(REPO_ROOT)}: missing operator-batch contract phrase `{phrase}`"
                )

    if pr_comment_contract.exists():
        comment_text = pr_comment_contract.read_text(encoding="utf-8")
        required_comment_phrases = [
            "Prefer low-friction maintainer patching",
            "Edit the current maintainer record when possible",
            "Repass/correction waves must normalize editable maintainer records",
            "Use changes-requested when the PR needs contributor clarity",
            "A maintainer harvest is not a merge approval",
            "Lane To Comment Map",
            "`merge_now`",
            "`patch_then_merge`",
            "`review_only`",
            "`### Proof Needed` is allowed only inside `## Changes Requested`",
            "Every `## Changes Requested` record must include exactly these public sections",
            "After every state-changing wave, the chat handoff must include",
            "## Changes Requested: <blocker>",
            "## Merged: <contract or outcome>",
            "## Closed: <reason>",
        ]
        for phrase in required_comment_phrases:
            if phrase not in comment_text:
                errors.append(
                    f"{pr_comment_contract.relative_to(REPO_ROOT)}: missing PR comment contract phrase `{phrase}`"
                )

    if pr_operator_question_fixtures.exists():
        fixtures_doc = load_json(pr_operator_question_fixtures)
        fixtures = fixtures_doc.get("fixtures", [])
        fixture_required_fields = [
            "id",
            "operator_prompt",
            "evidence_sources",
            "current_truth",
            "recommended_path",
            "risk_if_accepted_blindly",
            "decision_needed",
            "options",
        ]
        if fixtures_doc.get("schema_version") != "operator-question-fixtures.v1":
            errors.append(
                f"{pr_operator_question_fixtures.relative_to(REPO_ROOT)}: unexpected schema_version"
            )
        if not isinstance(fixtures, list) or not fixtures:
            errors.append(
                f"{pr_operator_question_fixtures.relative_to(REPO_ROOT)}: must define at least one fixture"
            )
        for index, fixture in enumerate(fixtures):
            origin = f"{pr_operator_question_fixtures.relative_to(REPO_ROOT)} fixture[{index}]"
            if not isinstance(fixture, dict):
                errors.append(f"{origin}: must be an object")
                continue
            for field in fixture_required_fields:
                if field not in fixture:
                    errors.append(f"{origin}: missing `{field}`")
            for field in [
                "id",
                "operator_prompt",
                "current_truth",
                "recommended_path",
                "risk_if_accepted_blindly",
                "decision_needed",
            ]:
                value = fixture.get(field)
                if not isinstance(value, str) or not value.strip():
                    errors.append(f"{origin}: `{field}` must be a non-empty string")
            evidence_sources = fixture.get("evidence_sources")
            if not isinstance(evidence_sources, list) or not evidence_sources:
                errors.append(f"{origin}: `evidence_sources` must be a non-empty list")
            else:
                for source in evidence_sources:
                    if not isinstance(source, str) or not source.strip():
                        errors.append(f"{origin}: each evidence source must be a non-empty string")
                    elif not path_exists(source):
                        errors.append(f"{origin}: evidence source `{source}` does not exist")
            options = fixture.get("options")
            if not isinstance(options, list) or len(options) < 2:
                errors.append(f"{origin}: `options` must include at least two choices")
                continue
            recommended_count = sum(
                1
                for option in options
                if isinstance(option, dict) and option.get("recommended") is True
            )
            if recommended_count != 1:
                errors.append(f"{origin}: exactly one option must be recommended")
            if not isinstance(options[0], dict) or options[0].get("recommended") is not True:
                errors.append(f"{origin}: recommended option must appear first")
            for option_index, option in enumerate(options):
                option_origin = f"{origin} option[{option_index}]"
                if not isinstance(option, dict):
                    errors.append(f"{option_origin}: must be an object")
                    continue
                for field in ["label", "expected_output"]:
                    value = option.get(field)
                    if not isinstance(value, str) or not value.strip():
                        errors.append(f"{option_origin}: `{field}` must be a non-empty string")
                if not isinstance(option.get("recommended"), bool):
                    errors.append(f"{option_origin}: `recommended` must be a boolean")

    if pr_review_script.exists():
        script_text = pr_review_script.read_text(encoding="utf-8")
        for phrase in [
            "Research Basis",
            "Reasoned Review Steps",
            "Decision Questions",
            "Risk if accepted blindly",
            "After-Merge Kickoff",
            "All Async Trains",
            "train_to_subagent_map",
            "pr_claim_changed_surface_mismatch",
            "new_export_without_app_or_backend_caller",
            "stacked_branch_diff_not_reviewable",
        ]:
            if phrase not in script_text:
                errors.append(
                    f"{pr_review_script.relative_to(REPO_ROOT)}: generated review output missing `{phrase}`"
                )
        forbidden_template_headings = [
            '"## Acknowledgment"',
            '"## Approved:"',
            '"## Approved With Maintainer Patch:"',
            '"### Why This Is Safe"',
            '"### Why This Path"',
            '"### Merge Confidence"',
            '"### Proof"',
            '"### Verification"',
            '"## Next"',
            '"### Next"',
        ]
        for heading in forbidden_template_headings:
            if heading in script_text:
                errors.append(
                    f"{pr_review_script.relative_to(REPO_ROOT)}: generated PR comment template still contains forbidden heading {heading}"
                )
        if "post_merge_only_if_useful" in script_text:
            errors.append(
                f"{pr_review_script.relative_to(REPO_ROOT)}: merge_now policy must require post-merge closeout after smoke"
            )
        if "post_merge_comment_only_if_maintainer_patch_lands" in script_text:
            errors.append(
                f"{pr_review_script.relative_to(REPO_ROOT)}: patch_then_merge policy must require explicit maintainer ownership and closeout"
            )
        if "operator_explicit_maintainer_patch_only" not in script_text:
            errors.append(
                f"{pr_review_script.relative_to(REPO_ROOT)}: missing explicit maintainer-patch policy marker"
            )

    for path in [future_planner_skill, founder_brief_skill, orchestration_skill, delegation_contract]:
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        for phrase in ["Founder Wiki North-Star Probe", "current_state_vs_north_star_drift"]:
            if phrase not in text:
                errors.append(
                    f"{path.relative_to(REPO_ROOT)}: missing founder wiki governance phrase `{phrase}`"
                )


def validate_truth_first_contract(errors: list[str]) -> None:
    truth_reference = REPO_ROOT / TRUTH_FIRST_REFERENCE
    founder_wiki_reference = REPO_ROOT / FOUNDER_WIKI_REFERENCE
    founder_wiki_audit_script = REPO_ROOT / FOUNDER_WIKI_AUDIT_SCRIPT
    agents_md = REPO_ROOT / "AGENTS.md"
    skill_contract = SKILLS_ROOT / "codex-skill-authoring" / "references" / "skill-contract.md"
    delegation_contract = (
        SKILLS_ROOT / "agent-orchestration-governance" / "references" / "delegation-contract.md"
    )
    community_workflow = WORKFLOWS_ROOT / "community-response" / "workflow.json"

    if not truth_reference.exists():
        errors.append(f"missing truth-first operating kernel: {TRUTH_FIRST_REFERENCE}")
        return
    if not founder_wiki_reference.exists():
        errors.append(f"missing founder wiki north-star probe: {FOUNDER_WIKI_REFERENCE}")
        return
    if not founder_wiki_audit_script.exists():
        errors.append(f"missing founder wiki workspace audit script: {FOUNDER_WIKI_AUDIT_SCRIPT}")
        return

    truth_text = truth_reference.read_text(encoding="utf-8")
    founder_wiki_text = founder_wiki_reference.read_text(encoding="utf-8")
    founder_wiki_audit_text = founder_wiki_audit_script.read_text(encoding="utf-8")
    required_truth_phrases = [
        "derive facts from the repo before accepting the prompt",
        "Evidence Order",
        "Default Answer Shape",
        "Planning Question Contract",
        "Founder Wiki North-Star Probe",
        FOUNDER_WIKI_REFERENCE,
        "current_state_vs_north_star_drift",
        "Current truth",
        "Recommended path",
        "Risk if accepted blindly",
        "Decision needed",
        "recommended option first",
        "Agent Evidence Handoff",
        "Community Q&A Contract",
        "price is missing",
        "make MCP tools dynamic by consent",
        "add voice mic",
        "store LLM wiki as markdown",
        "green CI means merge",
        *TRUTH_FIRST_LABELS,
        *TRUTH_FIRST_HANDOFF_TOKENS,
        *TRUTH_FIRST_DOMAIN_PROBES,
    ]
    for phrase in required_truth_phrases:
        if phrase not in truth_text:
            errors.append(f"{TRUTH_FIRST_REFERENCE}: missing truth-first phrase `{phrase}`")

    required_founder_wiki_phrases = [
        "Authority Order",
        "Default Product Canon",
        "Product Boundaries",
        "Privacy And Citation Rules",
        "PR Governance Trigger",
        "current_state_vs_north_star_drift",
        "Public GitHub PR comments must not cite private wiki pages",
        "wiki/concepts/openclaw.md",
        "wiki/concepts/hu-ssh.md",
        "wiki/concepts/signature-vault.md",
        "wiki/concepts/north-star-user-persona.md",
        "wiki/concepts/one-lens.md",
        "wiki/concepts/pchp-brand-side-endpoint.md",
        "wiki/products/ibrokerage.md",
        "wiki/projects/one-email-kyc-wiki-integration.md",
    ]
    for phrase in required_founder_wiki_phrases:
        if phrase not in founder_wiki_text:
            errors.append(f"{FOUNDER_WIKI_REFERENCE}: missing founder wiki probe phrase `{phrase}`")
        if phrase.startswith("wiki/") and phrase not in founder_wiki_audit_text:
            errors.append(f"{FOUNDER_WIKI_AUDIT_SCRIPT}: missing product canon page `{phrase}`")

    required_founder_wiki_audit_phrases = [
        "HUSHH_FOUNDER_WIKI_MCP_TOKEN",
        "tools/list",
        "resources/list",
        "wiki_list",
        "wiki_search",
        "wiki_read",
        "wiki_lint",
        "ANONYMOUS_PUBLIC_PAGE_COUNT",
        "ANONYMOUS_TOOL_COUNT",
        "Raw HCT omitted",
        "Private page bodies omitted",
    ]
    for phrase in required_founder_wiki_audit_phrases:
        if phrase not in founder_wiki_audit_text:
            errors.append(f"{FOUNDER_WIKI_AUDIT_SCRIPT}: missing audit phrase `{phrase}`")

    for path in [agents_md, skill_contract, delegation_contract]:
        if not path.exists():
            errors.append(f"missing truth-first linked contract: {path.relative_to(REPO_ROOT)}")
            continue
        text = path.read_text(encoding="utf-8")
        if TRUTH_FIRST_REFERENCE not in text:
            errors.append(f"{path.relative_to(REPO_ROOT)}: must reference `{TRUTH_FIRST_REFERENCE}`")
        for label in TRUTH_FIRST_LABELS:
            if label not in text:
                errors.append(f"{path.relative_to(REPO_ROOT)}: missing truth-first label `{label}`")

    planning_question_phrases = [
        "Current truth",
        "Recommended path",
        "Risk if accepted blindly",
        "Decision needed",
    ]
    for path in [agents_md, skill_contract]:
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        for phrase in planning_question_phrases:
            if phrase not in text:
                errors.append(
                    f"{path.relative_to(REPO_ROOT)}: missing planning-question contract phrase `{phrase}`"
                )

    for agent_path in sorted((REPO_ROOT / ".codex/agents").glob("*.toml")):
        text = agent_path.read_text(encoding="utf-8")
        if "Truth-first protocol:" not in text:
            errors.append(f"{agent_path.relative_to(REPO_ROOT)}: missing truth-first protocol block")
        for token in [*TRUTH_FIRST_LABELS, *TRUTH_FIRST_HANDOFF_TOKENS]:
            if token not in text:
                errors.append(f"{agent_path.relative_to(REPO_ROOT)}: missing truth-first token `{token}`")

    if community_workflow.exists():
        workflow = load_json(community_workflow)
        deliverables = workflow.get("deliverables", [])
        if "Brief reply" not in deliverables or "Detailed reply" not in deliverables:
            errors.append(
                f"{community_workflow.relative_to(REPO_ROOT)}: community workflow must use Brief/Detailed reply outputs"
            )


def main() -> int:
    skills, errors = collect_skill_bodies()
    skill_manifests = validate_skill_manifests(skills, errors)
    validate_workflows(skill_manifests, errors)
    validate_reference_budgets(errors)
    validate_special_skill_contracts(errors)
    validate_truth_first_contract(errors)

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
