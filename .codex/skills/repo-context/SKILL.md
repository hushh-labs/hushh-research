---
name: repo-context
description: Use when a request starts with scanning the Hushh repository, establishing repo context, mapping code/docs/skills, or deciding which owner skill should own the next step.
---

# Hushh Repo Context Skill

## Purpose and Trigger

- Primary scope: `repo-context-intake`
- Trigger on broad repository scans, cross-domain mapping, surface discovery, and choosing the correct owner skill before implementation work starts.
- Avoid overlap with `frontend`, `backend`, `security-audit`, and `docs-governance`.

## Coverage and Ownership

- Role: `owner`
- Owner family: `repo-context`

Owned repo surfaces:

1. `README.md`
2. `data`

Non-owned surfaces:

1. `frontend`
2. `mobile-native`
3. `backend`
4. `security-audit`
5. `docs-governance`
6. `repo-operations`

## Do Use

1. First-pass repository orientation before any narrower implementation workflow.
2. Mapping the full skill taxonomy and the meaningful repo surface coverage.
3. Routing recurring work into explicit workflow packs and impact bundles.
4. Finding code/docs/skill drift or orphaned areas in the repository map.

## Do Not Use

1. Narrow work that is already clearly inside a domain owner skill.
2. Docs-only governance once the correct docs home is already obvious.
3. Deep product, ops, or security implementation work.

## Read First

1. `.codex/skills/repo-context/references/index-contract.md`
2. `.codex/skills/repo-context/references/ownership-map.md`
3. `docs/project_context_map.md`

## Workflow

1. Run `summary` first to get owners, spokes, surface coverage, and uncovered surfaces.
2. Open exactly one deeper section next: `docs`, `frontend`, `backend`, `skills`, or `commands`.
3. Use `list-workflows` and `route-task <workflow-id>` when the request matches a recurring execution shape.
4. Use `impact <workflow-id>` before implementation when blast radius, docs, or verification scope is unclear.
5. Keep the first pass compact by default; use `--verbose` only when a heavy section such as `skills` or `backend` needs deeper inspection.
6. Use `--text` when a human-readable low-token routing summary is enough.
7. Route the task into the recommended owner skill as soon as the domain is clear.
8. Use `validate` or `audit` when changing the taxonomy, coverage map, workflow packs, or skill-routing docs.

## Handoff Rules

1. Route broad frontend work to `frontend`, native work to `mobile-native`, backend work to `backend`, trust and audit work to `security-audit`, docs work to `docs-governance`, and ops work to `repo-operations`.
2. Route skill-system work to `codex-skill-authoring`.
3. Route board workflows to `planning-board` and public/community reply work to `comms-community`.

## Required Checks

```bash
./bin/hushh codex scan summary
./bin/hushh codex list-workflows
./bin/hushh codex route-task repo-orientation
./bin/hushh codex impact repo-orientation
./bin/hushh codex audit
python3 .codex/skills/repo-context/scripts/repo_scan.py validate
```
