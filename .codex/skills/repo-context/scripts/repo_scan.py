#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from collections import OrderedDict, defaultdict
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[4]
SKILLS_ROOT = REPO_ROOT / ".codex/skills"
WORKFLOWS_ROOT = REPO_ROOT / ".codex/workflows"
ENTRYPOINTS = [
    "README.md",
    "docs/README.md",
    "docs/project_context_map.md",
    "docs/reference/operations/README.md",
    "docs/reference/operations/coding-agent-mcp.md",
]
DOCS_HOMES = [
    "docs",
    "consent-protocol/docs",
    "hushh-webapp/docs",
]
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
SECTION_NAMES = ("docs", "frontend", "backend", "skills", "commands")
REQUIRED_OWNER_SKILLS = [
    "repo-context",
    "frontend",
    "mobile-native",
    "backend",
    "security-audit",
    "docs-governance",
    "repo-operations",
    "planning-board",
    "comms-community",
    "codex-skill-authoring",
]
REQUIRED_WORKFLOWS = [
    "repo-orientation",
    "new-feature-tri-flow",
    "api-contract-change",
    "bug-triage",
    "security-consent-audit",
    "mobile-parity-check",
    "release-readiness",
    "docs-sync",
    "skill-authoring",
    "board-update",
    "community-response",
    "mcp-surface-change",
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
COMMAND_PATTERNS = [
    r"^\./bin/hushh\s+",
    r"^\./scripts/ci/",
    r"^cd hushh-webapp && npm run ",
    r"^cd hushh-webapp && npm test",
    r"^cd consent-protocol && python3 ",
    r"^cd consent-protocol && pytest ",
    r"^cd packages/hushh-mcp && npm run ",
    r"^python3 \.codex/",
    r"^python3 -m py_compile ",
    r"^# TODO$",
]


def _load_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(_load_text(path))


def _path_exists(candidate: str) -> bool:
    return (REPO_ROOT / candidate.rstrip("/")).exists()


def _matches_surface(surface: str, candidate: str) -> bool:
    left = surface.rstrip("/")
    right = candidate.rstrip("/")
    return left == right or left.startswith(f"{right}/") or right.startswith(f"{left}/")


def _compact_skill(skill: dict[str, Any]) -> OrderedDict[str, Any]:
    return OrderedDict(
        name=skill["id"],
        path=skill["path"],
        role=skill["role"],
        owner_family=skill["owner_family"],
        primary_scope=skill["primary_scope"],
        task_types=skill["task_types"],
        owned_paths=skill["owned_paths"],
        handoff_targets=skill["handoff_targets"],
    )


def _rel_dirs(base: Path, max_depth: int = 1) -> list[str]:
    if not base.exists():
        return []
    root_depth = len(base.relative_to(REPO_ROOT).parts)
    items = []
    for path in sorted(base.rglob("*")):
        if not path.is_dir():
            continue
        if path.name.startswith(".") or path.name == "__pycache__":
            continue
        depth = len(path.relative_to(REPO_ROOT).parts) - root_depth
        if depth <= max_depth:
            items.append(str(path.relative_to(REPO_ROOT)))
    return items


def _rel_files(base: Path, max_depth: int = 1, suffix: str | None = None) -> list[str]:
    if not base.exists():
        return []
    root_depth = len(base.relative_to(REPO_ROOT).parts)
    items = []
    for path in sorted(base.rglob("*")):
        if not path.is_file():
            continue
        if "__pycache__" in path.parts or any(part.startswith(".") for part in path.parts):
            continue
        depth = len(path.relative_to(REPO_ROOT).parts) - root_depth
        if depth <= max_depth and (suffix is None or path.suffix == suffix):
            items.append(str(path.relative_to(REPO_ROOT)))
    return items


def _load_package_scripts(package_json: Path, keys: list[str]) -> OrderedDict[str, str]:
    data = _load_json(package_json)
    scripts = data.get("scripts", {})
    ordered: OrderedDict[str, str] = OrderedDict()
    for key in keys:
        if key in scripts:
            ordered[key] = scripts[key]
    return ordered


def _uniq(values: list[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            ordered.append(value)
    return ordered


def _doc_like(value: str) -> bool:
    normalized = value.rstrip("/")
    return normalized == "README.md" or normalized.endswith(".md")


def _collect_skill_data() -> list[dict[str, Any]]:
    skills: list[dict[str, Any]] = []
    for manifest_path in sorted(SKILLS_ROOT.glob("*/skill.json")):
        manifest = _load_json(manifest_path)
        manifest["folder"] = manifest_path.parent.name
        manifest["path"] = str(manifest_path.parent.relative_to(REPO_ROOT))
        skills.append(manifest)
    return skills


def _skills_by_id(skills: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {skill["id"]: skill for skill in skills}


def _collect_workflows() -> list[dict[str, Any]]:
    workflows: list[dict[str, Any]] = []
    for workflow_path in sorted(WORKFLOWS_ROOT.glob("*/workflow.json")):
        workflow = _load_json(workflow_path)
        workflow["path"] = str(workflow_path.parent.relative_to(REPO_ROOT))
        workflow["playbook"] = str((workflow_path.parent / "PLAYBOOK.md").relative_to(REPO_ROOT))
        workflows.append(workflow)
    return workflows


def _workflows_by_id(workflows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {workflow["id"]: workflow for workflow in workflows}


def _group_skills(skills: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], OrderedDict[str, list[dict[str, Any]]]]:
    owners = sorted((skill for skill in skills if skill["role"] == "owner"), key=lambda item: item["id"])
    spokes = sorted((skill for skill in skills if skill["role"] == "spoke"), key=lambda item: (item["owner_family"], item["id"]))
    grouped: OrderedDict[str, list[dict[str, Any]]] = OrderedDict((owner["id"], []) for owner in owners)
    for skill in spokes:
        grouped.setdefault(skill["owner_family"], []).append(skill)
    return owners, grouped


def _surface_coverage(skills: list[dict[str, Any]]) -> tuple[OrderedDict[str, Any], list[str]]:
    coverage: OrderedDict[str, Any] = OrderedDict()
    uncovered: list[str] = []
    for surface in MEANINGFUL_SURFACES:
        owner_skills = sorted(
            skill["id"] for skill in skills if skill["role"] == "owner" and surface in skill["owned_paths"]
        )
        specialist_skills = sorted(
            skill["id"]
            for skill in skills
            if skill["role"] == "spoke" and any(_matches_surface(path, surface) for path in skill["owned_paths"])
        )
        coverage[surface] = OrderedDict(
            recommended_entrypoint=owner_skills[0] if owner_skills else None,
            owner_skills=owner_skills,
            specialist_skills=specialist_skills,
        )
        if not owner_skills:
            uncovered.append(surface)
    return coverage, uncovered


def build_summary() -> dict[str, Any]:
    skills = _collect_skill_data()
    owners, grouped = _group_skills(skills)
    coverage, uncovered = _surface_coverage(skills)
    return OrderedDict(
        version=3,
        generated_from=str(REPO_ROOT),
        summary=OrderedDict(
            entrypoints=ENTRYPOINTS,
            docs_homes=DOCS_HOMES,
            owners=[
                OrderedDict(
                    name=skill["id"],
                    primary_scope=skill["primary_scope"],
                    owned_repo_surfaces=skill["owned_paths"],
                    task_types=skill["task_types"],
                )
                for skill in owners
            ],
            spokes_by_owner=OrderedDict(
                (owner, [skill["id"] for skill in grouped.get(owner, [])]) for owner in grouped
            ),
            surface_coverage=coverage,
            uncovered_surfaces=uncovered,
        ),
    )


def build_docs_section() -> dict[str, Any]:
    return OrderedDict(
        docs_homes=DOCS_HOMES,
        root_entrypoints=ENTRYPOINTS,
        domain_indexes=[
            "docs/guides/README.md",
            "docs/reference/architecture/README.md",
            "docs/reference/operations/README.md",
            "docs/reference/quality/README.md",
            "docs/vision/README.md",
            "consent-protocol/docs/README.md",
            "hushh-webapp/docs/README.md",
        ],
        next_reads=[
            "docs/reference/operations/documentation-architecture-map.md",
            "docs/reference/operations/docs-governance.md",
            "docs/project_context_map.md",
        ],
        recommended_entrypoint="docs-governance",
        next_owner_skills=["docs-governance", "repo-context"],
    )


def build_frontend_section() -> dict[str, Any]:
    return OrderedDict(
        package="hushh-webapp",
        route_families=_rel_dirs(REPO_ROOT / "hushh-webapp/app", max_depth=1),
        api_proxy_groups=_rel_dirs(REPO_ROOT / "hushh-webapp/app/api", max_depth=1),
        layer_surfaces=[
            "hushh-webapp/components/ui",
            "hushh-webapp/lib/morphy-ux",
            "hushh-webapp/components/app-ui",
            "hushh-webapp/components",
            "hushh-webapp/lib/navigation",
            "hushh-webapp/app/labs",
        ],
        service_surfaces=[
            "hushh-webapp/lib/services/README.md",
            "hushh-webapp/lib/navigation/routes.ts",
            "hushh-webapp/lib/navigation/app-route-layout.contract.json",
        ],
        verification_commands=_load_package_scripts(
            REPO_ROOT / "hushh-webapp/package.json",
            ["verify:design-system", "verify:docs", "verify:routes", "verify:cache", "typecheck"],
        ),
        next_reads=[
            "docs/reference/quality/design-system.md",
            "docs/reference/quality/frontend-ui-architecture-map.md",
            "hushh-webapp/lib/services/README.md",
        ],
        recommended_entrypoint="frontend",
        next_owner_skills=["frontend", "mobile-native"],
        spoke_skills=["frontend-design-system", "frontend-architecture", "frontend-surface-placement"],
    )


def build_backend_section(verbose: bool = False) -> dict[str, Any]:
    route_files = _rel_files(REPO_ROOT / "consent-protocol/api/routes", max_depth=2, suffix=".py")
    grouped_routes: OrderedDict[str, list[str]] = OrderedDict()
    for route in route_files:
        rel = Path(route).relative_to("consent-protocol/api/routes")
        key = rel.parts[0] if len(rel.parts) > 1 else "root"
        grouped_routes.setdefault(key, []).append(route)
    route_modules: OrderedDict[str, Any] = OrderedDict()
    for key, values in grouped_routes.items():
        route_modules[key] = (
            values
            if verbose
            else OrderedDict(count=len(values), modules=[Path(value).stem for value in values])
        )
    return OrderedDict(
        package="consent-protocol",
        route_modules=route_modules,
        service_surfaces=_rel_dirs(REPO_ROOT / "consent-protocol/hushh_mcp", max_depth=1),
        backend_docs=[
            "consent-protocol/README.md",
            "consent-protocol/docs/README.md",
            "consent-protocol/docs/reference/consent-protocol.md",
            "consent-protocol/docs/reference/personal-knowledge-model.md",
            "consent-protocol/docs/reference/developer-api.md",
        ],
        command_surfaces=[
            "./bin/hushh protocol --help",
            "consent-protocol/bin/consent-protocol --help",
        ],
        next_reads=[
            "docs/project_context_map.md",
            "consent-protocol/docs/README.md",
            "consent-protocol/docs/reference/consent-protocol.md",
        ],
        recommended_entrypoint="backend",
        next_owner_skills=["backend", "security-audit"],
        spoke_skills=[
            "backend-runtime-governance",
            "backend-api-contracts",
            "backend-agents-operons",
            "mcp-developer-surface",
        ],
    )


def build_skills_section(verbose: bool = False) -> dict[str, Any]:
    skills = _collect_skill_data()
    owners, grouped = _group_skills(skills)
    coverage, uncovered = _surface_coverage(skills)
    owners_payload = owners if verbose else [_compact_skill(skill) for skill in owners]
    spokes_payload = OrderedDict(
        (
            owner,
            grouped.get(owner, []) if verbose else [_compact_skill(skill) for skill in grouped.get(owner, [])],
        )
        for owner in grouped
    )
    return OrderedDict(
        owners=owners_payload,
        spokes_by_owner=spokes_payload,
        surface_coverage=coverage,
        uncovered_surfaces=uncovered,
        recommended_entrypoint="repo-context",
        next_reads=[
            ".codex/skills/codex-skill-authoring/references/skill-contract.md",
            ".codex/skills/repo-context/references/ownership-map.md",
        ],
        next_owner_skills=["codex-skill-authoring", "repo-context"],
    )


def build_commands_section() -> dict[str, Any]:
    return OrderedDict(
        repo_commands=[
            "./bin/hushh bootstrap",
            "./bin/hushh doctor --mode uat",
            "./bin/hushh web --mode uat",
            "./bin/hushh docs verify",
            "./bin/hushh ci",
            "./bin/hushh codex onboard",
            "./bin/hushh codex route-task <workflow-id>",
            "./bin/hushh codex impact <workflow-id> [--path <repo-path>]",
            "./bin/hushh codex audit",
        ],
        package_commands=OrderedDict(
            hushh_webapp=_load_package_scripts(
                REPO_ROOT / "hushh-webapp/package.json",
                ["dev", "lint", "typecheck", "verify:design-system", "verify:docs", "verify:routes", "verify:cache"],
            ),
            hushh_mcp=_load_package_scripts(
                REPO_ROOT / "packages/hushh-mcp/package.json",
                ["docs:render", "docs:check", "print-config", "print-codex-toml", "print-remote-config"],
            ),
        ),
        script_surfaces=[
            "bin",
            "scripts/ci",
            "scripts/env",
            "scripts/ops",
            "scripts/runtime",
            "deploy",
            "config",
            "hushh-webapp/scripts/architecture",
            "hushh-webapp/scripts/testing",
        ],
        next_reads=[
            "docs/reference/operations/cli.md",
            "docs/reference/operations/ci.md",
            "README.md",
        ],
        recommended_entrypoint="repo-operations",
        next_owner_skills=["repo-operations", "repo-context"],
    )


def build_workflow_list(verbose: bool = False) -> dict[str, Any]:
    workflows = _collect_workflows()
    skills = _skills_by_id(_collect_skill_data())
    payload = []
    for workflow in workflows:
        if verbose:
            payload.append(workflow)
            continue
        payload.append(
            OrderedDict(
                id=workflow["id"],
                title=workflow["title"],
                owner_skill=workflow["owner_skill"],
                default_spoke=workflow["default_spoke"],
                task_type=workflow["task_type"],
                playbook=workflow["playbook"],
            )
        )
    return OrderedDict(
        workflows=payload,
        recommended_entrypoint="repo-context",
        next_owner_skills=sorted(
            {workflow["owner_skill"] for workflow in workflows if workflow["owner_skill"] in skills}
        ),
    )


def build_route_task(workflow_id: str, verbose: bool = False) -> dict[str, Any]:
    skills = _skills_by_id(_collect_skill_data())
    workflows = _workflows_by_id(_collect_workflows())
    workflow = workflows[workflow_id]
    owner = skills[workflow["owner_skill"]]
    default_spoke = skills.get(workflow["default_spoke"]) if workflow.get("default_spoke") else None
    exact_docs = _uniq(
        [
            value
            for value in workflow["required_reads"] + owner["required_reads"] + (default_spoke["required_reads"] if default_spoke else [])
            if _doc_like(value)
        ]
    )
    adjacent = _uniq(owner["adjacent_skills"] + (default_spoke["adjacent_skills"] if default_spoke else []))
    risks = _uniq(workflow["common_failures"] + owner["risk_tags"] + (default_spoke["risk_tags"] if default_spoke else []))
    payload = OrderedDict(
        workflow_id=workflow_id,
        title=workflow["title"],
        goal=workflow["goal"],
        selected_owner_skill=_compact_skill(owner),
        selected_default_spoke=_compact_skill(default_spoke) if default_spoke and not verbose else default_spoke,
        exact_repo_surfaces=workflow["affected_surfaces"],
        exact_docs_to_open=exact_docs,
        exact_commands_to_run=workflow["required_commands"],
        exact_verification_bundle=workflow["verification_bundle"],
        adjacent_skills=adjacent,
        drift_risks=risks,
        required_deliverables=workflow["deliverables"],
        handoff_chain=workflow["handoff_chain"],
        playbook=workflow["playbook"],
    )
    if verbose:
        payload["workflow"] = workflow
    return payload


def build_impact(workflow_id: str, paths: list[str] | None = None, verbose: bool = False) -> dict[str, Any]:
    skills = _skills_by_id(_collect_skill_data())
    workflows = _workflows_by_id(_collect_workflows())
    workflow = workflows[workflow_id]
    owner = skills[workflow["owner_skill"]]
    default_spoke = skills.get(workflow["default_spoke"]) if workflow.get("default_spoke") else None

    requested_paths = [value.rstrip("/") for value in (paths or [])]
    likely_paths = workflow["affected_surfaces"]
    if requested_paths:
        narrowed = [
            surface
            for surface in workflow["affected_surfaces"]
            if any(_matches_surface(surface, requested) for requested in requested_paths)
        ]
        likely_paths = narrowed or requested_paths

    likely_docs = _uniq(
        [
            value
            for value in workflow["required_reads"] + owner["required_reads"] + (default_spoke["required_reads"] if default_spoke else [])
            if _doc_like(value)
        ]
    )
    likely_commands = _uniq(
        workflow["required_commands"]
        + owner["required_commands"]
        + (default_spoke["required_commands"] if default_spoke else [])
        + workflow["verification_bundle"]["commands"]
    )
    likely_tests = _uniq(workflow["verification_bundle"]["tests"])
    risk_areas = _uniq(workflow["common_failures"] + owner["risk_tags"] + (default_spoke["risk_tags"] if default_spoke else []))

    payload = OrderedDict(
        workflow_id=workflow_id,
        selected_owner_skill=owner["id"],
        selected_default_spoke=default_spoke["id"] if default_spoke else None,
        likely_paths=likely_paths,
        likely_docs=likely_docs,
        likely_commands=likely_commands,
        likely_tests=likely_tests,
        risk_areas=risk_areas,
        handoff_chain=workflow["handoff_chain"],
    )
    if verbose:
        payload["requested_paths"] = requested_paths
        payload["deliverables"] = workflow["deliverables"]
        payload["impact_fields"] = workflow["impact_fields"]
    return payload


def build_onboard() -> dict[str, Any]:
    workflows = _collect_workflows()
    return OrderedDict(
        title="Hushh Codex Onboarding",
        north_stars=[
            "An agent should work for the person whose life it touches.",
            "Your data, your business. Your committee, on-demand.",
        ],
        critical_rules=[
            "BYOK: vault keys stay client-side and ciphertext only crosses the backend boundary.",
            "Consent-first: signed in is not consent; every protected operation must validate scope.",
            "Tri-flow: features must respect web + iOS + Android or declare platform-specific scope explicitly.",
            "Minimal browser storage: sensitive keys and decrypted PKM stay memory-only.",
        ],
        steps=[
            "Run `./bin/hushh codex onboard`.",
            "Read `docs/project_context_map.md` and the required reads for the selected workflow.",
            "Choose one workflow pack from `./bin/hushh codex list-workflows`.",
            "Run `./bin/hushh codex route-task <workflow-id>`.",
            "Run `./bin/hushh codex impact <workflow-id>`.",
            "Execute only the listed docs, commands, and verification bundle.",
        ],
        available_workflows=[
            OrderedDict(id=workflow["id"], title=workflow["title"], owner_skill=workflow["owner_skill"])
            for workflow in workflows
        ],
        recommended_entrypoint="repo-context",
        next_owner_skills=["repo-context"],
    )


def _validate_command_string(command: str) -> bool:
    return any(re.search(pattern, command) for pattern in COMMAND_PATTERNS)


def build_audit() -> dict[str, Any]:
    skills = _collect_skill_data()
    workflows = _collect_workflows()
    skills_by_id = _skills_by_id(skills)
    workflows_by_id = _workflows_by_id(workflows)
    coverage, uncovered = _surface_coverage(skills)

    findings: dict[str, list[str]] = {"high": [], "medium": [], "low": []}

    for skill_md in sorted(SKILLS_ROOT.glob("*/SKILL.md")):
        skill_id = skill_md.parent.name
        if not (skill_md.parent / "skill.json").exists():
            findings["high"].append(f"Missing skill.json for {skill_id}")

    for skill in skills:
        if not skill.get("verification_bundles"):
            findings["medium"].append(f"Missing verification_bundles for {skill['id']}")
        for candidate in skill.get("required_reads", []):
            if candidate.startswith(PATH_PREFIXES) and not _path_exists(candidate):
                findings["medium"].append(f"Stale required_read in {skill['id']}: {candidate}")
        for command in skill.get("required_commands", []):
            if not _validate_command_string(command):
                findings["medium"].append(f"Stale or unknown command shape in {skill['id']}: {command}")
        if skill["role"] == "spoke" and skill["owner_family"] not in skills_by_id:
            findings["high"].append(f"Spoke owner family missing for {skill['id']}: {skill['owner_family']}")

    for workflow_id in REQUIRED_WORKFLOWS:
        workflow_dir = WORKFLOWS_ROOT / workflow_id
        if not (workflow_dir / "workflow.json").exists():
            findings["high"].append(f"Missing workflow.json for {workflow_id}")
        if not (workflow_dir / "PLAYBOOK.md").exists():
            findings["medium"].append(f"Missing PLAYBOOK.md for {workflow_id}")

    for workflow in workflows:
        if not workflow.get("verification_bundle"):
            findings["medium"].append(f"Missing verification_bundle for workflow {workflow['id']}")
        for candidate in workflow.get("required_reads", []):
            if candidate.startswith(PATH_PREFIXES) and not _path_exists(candidate):
                findings["medium"].append(f"Stale required_read in workflow {workflow['id']}: {candidate}")
        for command in workflow.get("required_commands", []) + workflow.get("verification_bundle", {}).get("commands", []):
            if not _validate_command_string(command):
                findings["medium"].append(f"Stale or unknown command shape in workflow {workflow['id']}: {command}")
        if not workflow.get("handoff_chain"):
            findings["high"].append(f"Workflow {workflow['id']} has no handoff_chain")
        required_fields = {"Docs updated", "Verification commands executed"}
        if workflow["id"] in {
            "new-feature-tri-flow",
            "api-contract-change",
            "bug-triage",
            "security-consent-audit",
            "mobile-parity-check",
            "release-readiness",
        } and not required_fields.issubset(set(workflow.get("impact_fields", []))):
            findings["medium"].append(f"Workflow {workflow['id']} is missing required impact_fields")

    if uncovered:
        findings["high"].extend(f"Orphaned meaningful repo surface: {surface}" for surface in uncovered)

    all_task_types = sorted(
        {
            task_type
            for skill in skills
            for task_type in skill.get("task_types", [])
        }
    )
    workflow_task_types = {workflow["task_type"] for workflow in workflows}
    orphaned_task_types = sorted(set(all_task_types) - workflow_task_types)
    findings["medium"].extend(f"Task type has no workflow pack: {task_type}" for task_type in orphaned_task_types)

    coverage_score = max(0, 100 - (len(uncovered) * 10) - (len(findings["high"]) * 2))
    routing_issues = [
        issue for issue in findings["high"] + findings["medium"] if "owner" in issue.lower() or "handoff" in issue.lower() or "workflow pack" in issue.lower()
    ]
    routing_score = max(0, 100 - (len(routing_issues) * 10))
    verification_issues = [
        issue for issue in findings["medium"] if "verification" in issue.lower() or "command" in issue.lower() or "impact_fields" in issue.lower()
    ]
    verification_score = max(0, 100 - (len(verification_issues) * 10))
    onboarding_issues = [
        issue for issue in findings["medium"] + findings["high"] if "PLAYBOOK" in issue or "workflow" in issue.lower()
    ]
    onboarding_score = max(0, 100 - (len(onboarding_issues) * 10))

    return OrderedDict(
        version=3,
        generated_from=str(REPO_ROOT),
        audit=OrderedDict(
            status="attention" if findings["high"] or findings["medium"] else "ok",
            scorecard=OrderedDict(
                coverage=coverage_score,
                routing_integrity=routing_score,
                verification_integrity=verification_score,
                onboarding_readiness=onboarding_score,
            ),
            findings=findings,
            summary=OrderedDict(
                skill_count=len(skills),
                workflow_count=len(workflows),
                uncovered_surfaces=uncovered,
                coverage_map_size=len(coverage),
            ),
        ),
    )


def build_section(name: str, verbose: bool = False) -> dict[str, Any]:
    builders = {
        "docs": build_docs_section,
        "frontend": build_frontend_section,
        "backend": lambda: build_backend_section(verbose=verbose),
        "skills": lambda: build_skills_section(verbose=verbose),
        "commands": build_commands_section,
    }
    if name not in builders:
        raise ValueError(f"Unsupported section: {name}")
    return OrderedDict(version=3, generated_from=str(REPO_ROOT), section=name, data=builders[name]())


def validate_index() -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []

    for path in ENTRYPOINTS + DOCS_HOMES:
        if not (REPO_ROOT / path).exists():
            errors.append(f"Missing required entrypoint: {path}")

    skills = _collect_skill_data()
    for skill_md in sorted(SKILLS_ROOT.glob("*/SKILL.md")):
        if not (skill_md.parent / "skill.json").exists():
            errors.append(f"Missing skill.json: {skill_md.parent.relative_to(REPO_ROOT)}")
    skill_ids = {skill["id"] for skill in skills}
    missing_owners = sorted(set(REQUIRED_OWNER_SKILLS) - {skill["id"] for skill in skills if skill["role"] == "owner"})
    for owner in missing_owners:
        errors.append(f"Missing required owner skill: {owner}")

    coverage, uncovered = _surface_coverage(skills)
    for surface in uncovered:
        errors.append(f"Uncovered meaningful repo surface: {surface}")

    workflows = _collect_workflows()
    workflow_ids = {workflow["id"] for workflow in workflows}
    for workflow_id in sorted(set(REQUIRED_WORKFLOWS) - workflow_ids):
        errors.append(f"Missing required workflow pack: {workflow_id}")

    for skill in skills:
        for value in skill.get("owned_paths", []) + skill.get("required_reads", []):
            if value.startswith(PATH_PREFIXES) and not _path_exists(value):
                errors.append(f"Referenced path not found: {value}")
        for candidate in skill.get("handoff_targets", []):
            if candidate not in skill_ids:
                errors.append(f"Unknown handoff target in {skill['id']}: {candidate}")
        for candidate in skill.get("adjacent_skills", []):
            if candidate not in skill_ids:
                errors.append(f"Unknown adjacent skill in {skill['id']}: {candidate}")

    for workflow in workflows:
        if workflow["owner_skill"] not in skill_ids:
            errors.append(f"Workflow owner_skill not found: {workflow['id']} -> {workflow['owner_skill']}")
        if workflow.get("default_spoke") and workflow["default_spoke"] not in skill_ids:
            errors.append(f"Workflow default_spoke not found: {workflow['id']} -> {workflow['default_spoke']}")
        for value in workflow.get("affected_surfaces", []) + workflow.get("required_reads", []):
            if value.startswith(PATH_PREFIXES) and not _path_exists(value):
                errors.append(f"Workflow path not found: {workflow['id']} -> {value}")

    return OrderedDict(
        version=3,
        generated_from=str(REPO_ROOT),
        validation=OrderedDict(status="ok" if not errors else "error", errors=errors, warnings=warnings),
    )


def _render_summary_text(payload: dict[str, Any]) -> str:
    summary = payload["summary"]
    lines = [
        "Repo Context Summary",
        f"Entrypoints: {', '.join(summary['entrypoints'])}",
        f"Docs homes: {', '.join(summary['docs_homes'])}",
        "Owners:",
    ]
    for owner in summary["owners"]:
        lines.append(f"- {owner['name']}: {', '.join(owner['owned_repo_surfaces'])}")
    lines.append("Spokes by owner:")
    for owner, spokes in summary["spokes_by_owner"].items():
        lines.append(f"- {owner}: {', '.join(spokes) if spokes else '(none)'}")
    lines.append(f"Uncovered surfaces: {', '.join(summary['uncovered_surfaces']) if summary['uncovered_surfaces'] else 'none'}")
    return "\n".join(lines)


def _skill_label(skill: dict[str, Any]) -> str:
    return skill.get("name") or skill.get("id") or skill.get("path") or "unknown"


def _render_section_text(payload: dict[str, Any]) -> str:
    section = payload["section"]
    data = payload["data"]
    lines = [f"Repo Context Section: {section}"]
    if section == "docs":
        lines.append(f"Docs homes: {', '.join(data['docs_homes'])}")
        lines.append(f"Root entrypoints: {', '.join(data['root_entrypoints'])}")
        lines.append(f"Domain indexes: {', '.join(data['domain_indexes'])}")
    elif section == "frontend":
        lines.append(f"Package: {data['package']}")
        lines.append(f"Route families: {', '.join(data['route_families'])}")
        lines.append(f"API proxy groups: {', '.join(data['api_proxy_groups'])}")
        lines.append(f"Spoke skills: {', '.join(data['spoke_skills'])}")
    elif section == "backend":
        lines.append(f"Package: {data['package']}")
        lines.append("Route groups:")
        for key, value in data["route_modules"].items():
            if isinstance(value, dict) and "count" in value:
                lines.append(f"- {key}: {value['count']} modules")
            else:
                lines.append(f"- {key}: {len(value)} modules")
        lines.append(f"Service surfaces: {', '.join(data['service_surfaces'])}")
        lines.append(f"Spoke skills: {', '.join(data['spoke_skills'])}")
    elif section == "skills":
        lines.append(f"Owners: {', '.join(_skill_label(owner) for owner in data['owners'])}")
        lines.append("Spokes by owner:")
        for owner, spokes in data["spokes_by_owner"].items():
            lines.append(f"- {owner}: {', '.join(_skill_label(spoke) for spoke in spokes) if spokes else '(none)'}")
        lines.append(f"Uncovered surfaces: {', '.join(data['uncovered_surfaces']) if data['uncovered_surfaces'] else 'none'}")
    elif section == "commands":
        lines.append(f"Repo commands: {', '.join(data['repo_commands'])}")
        lines.append(f"Script surfaces: {', '.join(data['script_surfaces'])}")
    lines.append(f"Recommended entrypoint: {data['recommended_entrypoint']}")
    lines.append(f"Next owner skills: {', '.join(data['next_owner_skills'])}")
    return "\n".join(lines)


def _render_validation_text(payload: dict[str, Any]) -> str:
    validation = payload["validation"]
    lines = [f"Validation status: {validation['status']}"]
    if validation["errors"]:
        lines.append("Errors:")
        lines.extend(f"- {error}" for error in validation["errors"])
    if validation["warnings"]:
        lines.append("Warnings:")
        lines.extend(f"- {warning}" for warning in validation["warnings"])
    if not validation["errors"] and not validation["warnings"]:
        lines.append("No errors or warnings")
    return "\n".join(lines)


def _render_workflows_text(payload: dict[str, Any]) -> str:
    lines = ["Codex Workflows"]
    for workflow in payload["data"]["workflows"]:
        lines.append(f"- {workflow['id']}: {workflow['title']} [{workflow['owner_skill']}]")
    lines.append(f"Recommended entrypoint: {payload['data']['recommended_entrypoint']}")
    return "\n".join(lines)


def _render_route_task_text(payload: dict[str, Any]) -> str:
    data = payload["data"]
    lines = [
        f"Workflow: {data['workflow_id']}",
        f"Owner skill: {_skill_label(data['selected_owner_skill'])}",
        f"Default spoke: {_skill_label(data['selected_default_spoke']) if data['selected_default_spoke'] else 'none'}",
        f"Repo surfaces: {', '.join(data['exact_repo_surfaces'])}",
        f"Docs to open: {', '.join(data['exact_docs_to_open'])}",
        f"Commands: {', '.join(data['exact_commands_to_run'])}",
        f"Verification bundle: {data['exact_verification_bundle']['id']}",
        f"Deliverables: {', '.join(data['required_deliverables'])}",
    ]
    return "\n".join(lines)


def _render_impact_text(payload: dict[str, Any]) -> str:
    data = payload["data"]
    lines = [
        f"Impact: {data['workflow_id']}",
        f"Likely paths: {', '.join(data['likely_paths'])}",
        f"Likely docs: {', '.join(data['likely_docs'])}",
        f"Likely commands: {', '.join(data['likely_commands'])}",
        f"Likely tests: {', '.join(data['likely_tests']) if data['likely_tests'] else 'none'}",
        f"Risk areas: {', '.join(data['risk_areas'])}",
        f"Handoff chain: {', '.join(data['handoff_chain'])}",
    ]
    return "\n".join(lines)


def _render_onboard_text(payload: dict[str, Any]) -> str:
    data = payload["data"]
    lines = [
        data["title"],
        "North stars:",
    ]
    lines.extend(f"- {item}" for item in data["north_stars"])
    lines.append("Critical rules:")
    lines.extend(f"- {item}" for item in data["critical_rules"])
    lines.append("Steps:")
    lines.extend(f"- {item}" for item in data["steps"])
    lines.append("Available workflows:")
    lines.extend(f"- {item['id']}: {item['title']}" for item in data["available_workflows"])
    return "\n".join(lines)


def _render_audit_text(payload: dict[str, Any]) -> str:
    audit = payload["audit"]
    lines = [
        f"Codex audit status: {audit['status']}",
        (
            "Scorecard: "
            f"coverage={audit['scorecard']['coverage']}, "
            f"routing={audit['scorecard']['routing_integrity']}, "
            f"verification={audit['scorecard']['verification_integrity']}, "
            f"onboarding={audit['scorecard']['onboarding_readiness']}"
        ),
    ]
    for severity in ("high", "medium", "low"):
        items = audit["findings"][severity]
        lines.append(f"{severity.title()} findings: {len(items)}")
        lines.extend(f"- {item}" for item in items[:10])
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Scan Hushh repo context for Codex.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    summary_parser = subparsers.add_parser("summary", help="print the first-pass repo summary")
    summary_parser.add_argument("--json", action="store_true", help="emit JSON")
    summary_parser.add_argument("--text", action="store_true", help="emit concise text")

    section_parser = subparsers.add_parser("section", help="print a deeper repo section")
    section_parser.add_argument("name", choices=SECTION_NAMES, help="section name")
    section_parser.add_argument("--json", action="store_true", help="emit JSON")
    section_parser.add_argument("--text", action="store_true", help="emit concise text")
    section_parser.add_argument("--verbose", action="store_true", help="emit deeper detail for heavy sections")

    validate_parser = subparsers.add_parser("validate", help="validate repo-context index dependencies")
    validate_parser.add_argument("--json", action="store_true", help="emit JSON")
    validate_parser.add_argument("--text", action="store_true", help="emit concise text")

    workflows_parser = subparsers.add_parser("list-workflows", help="list workflow packs")
    workflows_parser.add_argument("--json", action="store_true", help="emit JSON")
    workflows_parser.add_argument("--text", action="store_true", help="emit concise text")
    workflows_parser.add_argument("--verbose", action="store_true", help="emit deeper detail")

    route_parser = subparsers.add_parser("route-task", help="route a workflow pack to owner and spoke skills")
    route_parser.add_argument("workflow_id", choices=REQUIRED_WORKFLOWS, help="workflow id")
    route_parser.add_argument("--json", action="store_true", help="emit JSON")
    route_parser.add_argument("--text", action="store_true", help="emit concise text")
    route_parser.add_argument("--verbose", action="store_true", help="emit deeper detail")

    impact_parser = subparsers.add_parser("impact", help="compute impact for a workflow pack")
    impact_parser.add_argument("workflow_id", choices=REQUIRED_WORKFLOWS, help="workflow id")
    impact_parser.add_argument("--path", action="append", default=[], help="repo path to narrow impact output")
    impact_parser.add_argument("--json", action="store_true", help="emit JSON")
    impact_parser.add_argument("--text", action="store_true", help="emit concise text")
    impact_parser.add_argument("--verbose", action="store_true", help="emit deeper detail")

    onboard_parser = subparsers.add_parser("onboard", help="show the Codex onboarding flow")
    onboard_parser.add_argument("--json", action="store_true", help="emit JSON")
    onboard_parser.add_argument("--text", action="store_true", help="emit concise text")

    audit_parser = subparsers.add_parser("audit", help="run advisory Codex OS audit")
    audit_parser.add_argument("--json", action="store_true", help="emit JSON")
    audit_parser.add_argument("--text", action="store_true", help="emit concise text")

    args = parser.parse_args()
    if args.command == "summary":
        payload = build_summary()
        renderer = _render_summary_text
    elif args.command == "section":
        payload = build_section(args.name, verbose=args.verbose)
        renderer = _render_section_text
    elif args.command == "validate":
        payload = validate_index()
        renderer = _render_validation_text
    elif args.command == "list-workflows":
        payload = OrderedDict(version=3, generated_from=str(REPO_ROOT), data=build_workflow_list(verbose=args.verbose))
        renderer = _render_workflows_text
    elif args.command == "route-task":
        payload = OrderedDict(version=3, generated_from=str(REPO_ROOT), data=build_route_task(args.workflow_id, verbose=args.verbose))
        renderer = _render_route_task_text
    elif args.command == "impact":
        payload = OrderedDict(version=3, generated_from=str(REPO_ROOT), data=build_impact(args.workflow_id, paths=args.path, verbose=args.verbose))
        renderer = _render_impact_text
    elif args.command == "onboard":
        payload = OrderedDict(version=3, generated_from=str(REPO_ROOT), data=build_onboard())
        renderer = _render_onboard_text
    else:
        payload = build_audit()
        renderer = _render_audit_text

    if getattr(args, "text", False):
        print(renderer(payload))
    else:
        print(json.dumps(payload, indent=2))
    if args.command == "validate" and payload["validation"]["status"] != "ok":
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
