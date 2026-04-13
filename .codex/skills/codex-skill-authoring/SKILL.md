---
name: codex-skill-authoring
description: Use when creating, renaming, retrofitting, linting, or scaffolding repo-local Codex skills for hushh-research.
---

# Hushh Codex Skill Authoring Skill

## Purpose and Trigger

- Primary scope: `codex-skill-authoring-intake`
- Trigger on creating or renaming repo-local skills, tightening the skill contract, adding skill tooling, or evolving the owner/spoke taxonomy.
- Avoid overlap with `repo-context` and `docs-governance`.

## Coverage and Ownership

- Role: `owner`
- Owner family: `codex-skill-authoring`

Owned repo surfaces:

1. `.codex/skills`

Non-owned surfaces:

1. `repo-context`
2. `docs-governance`

## Do Use

1. Creating new owner or spoke skills under `.codex/skills`.
2. Enforcing the shared local skill contract, `skill.json` manifests, and workflow-pack contracts.
3. Scaffolding skills, manifests, and workflow packs and validating the fleet for drift, overlap, or orphaned surfaces.

## Do Not Use

1. Broad repo-orientation work that should start with `repo-context`.
2. Product implementation or subsystem-specific work that already belongs to another owner skill.
3. Docs-home governance outside the skill system itself.

## Read First

1. `.codex/skills/codex-skill-authoring/references/skill-contract.md`
2. `.codex/skills/codex-skill-authoring/references/authoring-workflow.md`
3. `.codex/skills/repo-context/references/index-contract.md`

## Workflow

1. Run the skill linter before changing the skill fleet so the current drift and coverage state are explicit.
2. Decide whether the work needs a new owner, a new spoke, or a tighter existing skill.
3. Scaffold with `init_skill.py` using explicit role, owner family, owned repo surfaces, task types, verification bundles, and optional workflow packs.
4. Update the repo-context index, workflow packs, and agent-facing docs when a new entrypoint or rename becomes canonical.

## Handoff Rules

1. If the task begins with broad repo discovery or choosing the correct owner family, start with `repo-context`.
2. If the task is docs-home governance outside the skill system, use `docs-governance`.
3. After skill creation or retrofit, hand off to the correct owner skill for the actual domain work.

## Required Checks

```bash
python3 .codex/skills/codex-skill-authoring/scripts/skill_lint.py
python3 .codex/skills/codex-skill-authoring/scripts/init_skill.py --name example-owner --role owner --owner-family example-owner --owned-path README.md --task-type repo-orientation --verification-bundle example-owner --workflow-pack example-owner --dry-run
./bin/hushh codex audit
python3 -m py_compile .codex/skills/codex-skill-authoring/scripts/skill_lint.py .codex/skills/codex-skill-authoring/scripts/init_skill.py
```
