#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import OrderedDict
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[4]
SKILLS_ROOT = REPO_ROOT / ".codex/skills"
WORKFLOWS_ROOT = REPO_ROOT / ".codex/workflows"


def normalize_name(raw: str) -> str:
    name = raw.strip().lower().replace("_", "-").replace(" ", "-")
    allowed = [ch for ch in name if ch.isalnum() or ch == "-"]
    normalized = "".join(allowed).strip("-")
    if not normalized:
        raise ValueError("Skill name must contain letters or digits")
    return normalized


def build_skill_markdown(
    name: str,
    description: str,
    role: str,
    owner_family: str,
    owned_paths: list[str],
    title: str | None = None,
) -> str:
    heading = title or f"Hushh {name.replace('-', ' ').title()} Skill"
    owned_lines = "\n".join(
        f"{index}. `{path}`" for index, path in enumerate(owned_paths or ["TODO"], start=1)
    )
    non_owned_hint = "`repo-context`" if role == "owner" and name != "repo-context" else f"`{owner_family}`"
    handoff_line = (
        "1. Route broad intake into the correct spoke for this owner family."
        if role == "owner"
        else f"1. If the request is still broad or ambiguous, route it back to `{owner_family}`."
    )
    return f"""---
name: {name}
description: {description}
---

# {heading}

## Purpose and Trigger

- Primary scope: `{name}-scope`
- Trigger on TODO: replace with the narrow trigger surface for this repo-local skill.
- Avoid overlap with `repo-context`.

## Coverage and Ownership

- Role: `{role}`
- Owner family: `{owner_family}`

Owned repo surfaces:

{owned_lines}

Non-owned surfaces:

1. {non_owned_hint}

## Do Use

1. TODO

## Do Not Use

1. TODO

## Read First

1. TODO

## Workflow

1. TODO

## Handoff Rules

{handoff_line}

## Required Checks

```bash
# TODO
```
"""


def build_skill_manifest(
    name: str,
    description: str,
    role: str,
    owner_family: str,
    owned_paths: list[str],
    task_types: list[str],
    verification_bundles: list[str],
) -> dict[str, object]:
    adjacent = [owner_family] if role == "spoke" else ["repo-context"]
    bundle_payload = [
        OrderedDict(
            id=bundle_id,
            commands=["# TODO"],
            tests=[],
        )
        for bundle_id in verification_bundles
    ] or [OrderedDict(id=f"{name}-bundle", commands=["# TODO"], tests=[])]
    return OrderedDict(
        id=name,
        role=role,
        owner_family=owner_family,
        primary_scope=f"{name}-scope",
        description=description,
        owned_paths=owned_paths or ["TODO"],
        non_owned_paths=[owner_family if role == "spoke" else "repo-context"],
        task_types=task_types or [name],
        required_reads=["TODO"],
        required_commands=["# TODO"],
        verification_bundles=bundle_payload,
        handoff_targets=[owner_family] if role == "spoke" else ["repo-context"],
        adjacent_skills=adjacent,
        risk_tags=["TODO"],
    )


def build_workflow_manifest(workflow_id: str, owner_skill: str, default_spoke: str | None, owned_paths: list[str]) -> dict[str, object]:
    return OrderedDict(
        id=workflow_id,
        title=workflow_id.replace("-", " ").title(),
        goal="TODO: replace with the exact workflow goal.",
        owner_skill=owner_skill,
        default_spoke=default_spoke,
        task_type=workflow_id,
        affected_surfaces=owned_paths or ["TODO"],
        required_reads=["TODO"],
        required_commands=["# TODO"],
        verification_bundle=OrderedDict(id=workflow_id, commands=["# TODO"], tests=[]),
        deliverables=["TODO"],
        impact_fields=["Docs updated", "Verification commands executed"],
        handoff_chain=[owner_skill] if owner_skill else ["repo-context"],
        common_failures=["TODO"],
    )


def build_workflow_playbook(workflow_id: str, owner_skill: str, default_spoke: str | None) -> str:
    default_line = default_spoke or "owner skill only"
    title = workflow_id.replace("-", " ").title()
    return f"""# {title}

Use this workflow pack when the task matches `{workflow_id}`.

## Goal

TODO: replace with the exact workflow goal.

## Steps

1. Start with `{owner_skill}` and use `{default_line}` as the default narrow path.
2. Open only the required reads listed in `workflow.json` plus the selected skill manifests.
3. Run the required commands first, then the verification bundle.
4. Capture every field listed in `impact_fields` before calling the work complete.
5. Escalate through `handoff_chain` when the task crosses domain boundaries.

## Common Drift Risks

1. TODO
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="Scaffold a repo-local Codex skill and optional workflow pack.")
    parser.add_argument("--name", required=True, help="skill folder name")
    parser.add_argument("--description", default="Use when TODO: replace with a narrow trigger description.", help="frontmatter description")
    parser.add_argument("--title", help="markdown title override")
    parser.add_argument("--role", required=True, choices=["owner", "spoke"], help="skill role")
    parser.add_argument("--owner-family", help="owner family name; defaults to the skill name for owner skills")
    parser.add_argument("--owned-path", action="append", default=[], help="owned repo surface path; may be repeated")
    parser.add_argument("--task-type", action="append", default=[], help="task type handled by this skill; may be repeated")
    parser.add_argument("--verification-bundle", action="append", default=[], help="verification bundle id; may be repeated")
    parser.add_argument("--workflow-pack", help="optional workflow pack id to scaffold alongside the skill")
    parser.add_argument("--dry-run", action="store_true", help="print the scaffold without writing files")
    args = parser.parse_args()

    name = normalize_name(args.name)
    owner_family = normalize_name(args.owner_family) if args.owner_family else name
    if args.role == "spoke" and not args.owner_family:
        raise SystemExit("--owner-family is required for spoke skills")
    if args.role == "owner" and owner_family != name:
        raise SystemExit("owner skills must have --owner-family equal to --name")

    task_types = [normalize_name(value) for value in args.task_type]
    verification_bundles = [normalize_name(value) for value in args.verification_bundle]
    workflow_pack = normalize_name(args.workflow_pack) if args.workflow_pack else ""

    skill_dir = SKILLS_ROOT / name
    skill_md = build_skill_markdown(
        name=name,
        description=args.description,
        role=args.role,
        owner_family=owner_family,
        owned_paths=args.owned_path,
        title=args.title,
    )
    skill_manifest = build_skill_manifest(
        name=name,
        description=args.description,
        role=args.role,
        owner_family=owner_family,
        owned_paths=args.owned_path,
        task_types=task_types,
        verification_bundles=verification_bundles,
    )

    workflow_dir = WORKFLOWS_ROOT / workflow_pack if workflow_pack else None
    workflow_manifest = (
        build_workflow_manifest(
            workflow_id=workflow_pack,
            owner_skill=name if args.role == "owner" else owner_family,
            default_spoke=name if args.role == "spoke" else None,
            owned_paths=args.owned_path,
        )
        if workflow_pack
        else None
    )
    workflow_playbook = (
        build_workflow_playbook(
            workflow_id=workflow_pack,
            owner_skill=name if args.role == "owner" else owner_family,
            default_spoke=name if args.role == "spoke" else None,
        )
        if workflow_pack
        else None
    )

    if args.dry_run:
        print(f"Would create: {skill_dir / 'SKILL.md'}")
        print(f"Would create: {skill_dir / 'skill.json'}")
        print(f"Would create: {skill_dir / 'references'}")
        print(f"Would create: {skill_dir / 'scripts'}")
        if workflow_dir is not None:
            print(f"Would create: {workflow_dir / 'workflow.json'}")
            print(f"Would create: {workflow_dir / 'PLAYBOOK.md'}")
        print()
        print(skill_md)
        print(json.dumps(skill_manifest, indent=2))
        if workflow_manifest is not None and workflow_playbook is not None:
            print()
            print(json.dumps(workflow_manifest, indent=2))
            print()
            print(workflow_playbook)
        return 0

    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "references").mkdir(exist_ok=True)
    (skill_dir / "scripts").mkdir(exist_ok=True)
    (skill_dir / "SKILL.md").write_text(skill_md, encoding="utf-8")
    (skill_dir / "skill.json").write_text(json.dumps(skill_manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Created {skill_dir / 'SKILL.md'}")
    print(f"Created {skill_dir / 'skill.json'}")

    if workflow_dir is not None and workflow_manifest is not None and workflow_playbook is not None:
        workflow_dir.mkdir(parents=True, exist_ok=True)
        (workflow_dir / "workflow.json").write_text(json.dumps(workflow_manifest, indent=2) + "\n", encoding="utf-8")
        (workflow_dir / "PLAYBOOK.md").write_text(workflow_playbook, encoding="utf-8")
        print(f"Created {workflow_dir / 'workflow.json'}")
        print(f"Created {workflow_dir / 'PLAYBOOK.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
