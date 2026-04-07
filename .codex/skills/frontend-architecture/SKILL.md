---
name: frontend-architecture
description: Use when changing Hushh frontend structure, package-level conventions, CI frontend checks, or repo-owned UI governance. Keep the architecture map, skills, docs, and verification scripts aligned.
---

# Hushh Frontend Architecture Skill

Use this skill for structural frontend work, not only component styling.

## Canonical inputs

1. `hushh-webapp/package.json`
2. `scripts/ci/web-check.sh`
3. `docs/reference/operations/ci.md`
4. `docs/reference/quality/frontend-ui-architecture-map.md`
5. `.codex/skills/frontend-surface-governance/SKILL.md`

## Architecture rules

1. Keep verification real: if docs mention a command, the command must exist.
2. Keep CI and local package scripts aligned.
3. Prefer one canonical layer and one canonical component path per job.
4. Favor small reusable primitives over repeated class-string composition.
5. Avoid adding repo bloat: every new script or contract should replace ambiguity or repeated manual judgment.
6. Keep the route-container contract centralized in `AppPageShell` / `FullscreenFlowShell` and documented in the quality docs.

## When adding a new rule

1. Update docs.
2. Add or update a verification script.
3. Wire the check into `package.json`.
4. Wire blocking frontend checks into `scripts/ci/web-check.sh` when they define merge quality.
