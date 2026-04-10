# Skill Authoring Workflow

Use this workflow when adding or retrofitting repo-local skills.

## Default flow

1. Start with `repo-context` if the correct owner family or repo surface is not already obvious.
2. Run `python3 .codex/skills/codex-skill-authoring/scripts/skill_lint.py`.
3. Decide whether the work needs:
   - an owner skill
   - a spoke skill
   - a tighter existing skill instead of a new one
4. Scaffold with `init_skill.py` using explicit `--role`, `--owner-family`, `--owned-path`, task types, verification bundles, and an optional workflow pack.
5. Keep `SKILL.md` thin and put routing metadata in `skill.json` plus `.codex/workflows/<workflow-id>/workflow.json` when the work is task-oriented.
6. Update the repo-context index and agent-facing discoverability docs when a new owner, spoke, or workflow pack becomes an expected entrypoint.
7. Re-run the lint tool after the change.

## New skill decision rule

Create a new skill only when all of these are true:

1. the task recurs enough to deserve its own stable entrypoint
2. the workflow benefits from repo-specific guidance or deterministic tooling
3. the ownership boundary is narrower than the nearest existing owner skill
4. the new skill reduces routing ambiguity instead of adding a second broad entrypoint

## Discoverability rule

When a repo-local skill becomes a supported entrypoint, update:

1. `docs/reference/operations/README.md`
2. `docs/reference/operations/coding-agent-mcp.md`
3. `docs/reference/quality/design-system.md` or `docs/reference/quality/frontend-ui-architecture-map.md` if the skill belongs to the frontend family
4. the matching workflow pack under `.codex/workflows/` when the work is a recurring task shape
