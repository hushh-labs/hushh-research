# Skills — the canonical, platform-neutral skill center

This directory is the **single source of truth** for skills that are not specific to any
one AI platform. A skill lives here once. Every platform — Claude Code, Codex, or anything
adopted later — reaches it through a thin **bridge** in that platform's own directory.

The rule in one line: **bridges carry routing metadata; the canonical file carries
behaviour.** Never copy instructions into a platform folder.

## Why this exists

Before this directory, a skill had to be written into `.claude/skills/` to be usable by
Claude Code and into `.codex/skills/` to be usable by Codex. Two copies of the same
instructions drift the moment one is edited, and drift in an instruction file is invisible
— nothing fails, the two platforms simply start behaving differently. Centralising the
behaviour makes that class of divergence impossible rather than merely discouraged.

## What belongs here, and what does not

| Put it here | Leave it where it is |
|---|---|
| Practice and discipline that is true regardless of which agent is running (verification standards, review bars, context recovery) | Platform-mechanical skills — anything that drives one tool's specific runtime |
| Anything two or more platforms would otherwise duplicate | Skills carrying a governed `skill.json` manifest with `owned_paths`, `required_commands`, and routing metadata — those stay in `.codex/skills/` (see below) |

**`.codex/skills/` is not simply "Codex's copy."** It is a governed routing brain: 46 skills,
each with a `skill.json` declaring owned paths, required reads, verification bundles, and
risk tags, validated by `skill_lint.py` and three orchestration checks. Its manifests
reference `.codex/skills/...` paths directly. Do not bulk-migrate it — see *Migration* below.

## The canonical skill contract

```
skills/<skill-name>/
  SKILL.md          required — YAML frontmatter + body
  references/       optional — supporting docs the skill tells the agent to read
  scripts/          optional — executable helpers
```

`SKILL.md` frontmatter, matching the format both existing trees already use:

```yaml
---
name: <skill-name>            # must equal the directory name
description: <one paragraph>  # what it does AND when to invoke it — this drives triggering
---
```

Write the `description` to carry **both** explicit trigger phrases and the situations the
skill owns, so a platform matching on keywords and one matching on intent both resolve it.

## How to build a bridge for a new platform

A bridge is a real skill file in the platform's own directory whose body's first instruction
is to read the canonical file. Three requirements:

1. **Copy the frontmatter verbatim** from the canonical `SKILL.md`. This is the one
   permitted duplication — it is the platform's index entry, not behaviour.
2. **The body must not restate the skill.** It points at the canonical path and stops.
3. **Never edit the bridge to change behaviour.** Edit the canonical file; every platform
   picks the change up on its next invocation with no sync step.

The Claude Code bridge at `.claude/skills/verify-before-claim/SKILL.md` is the reference
implementation — copy its shape.

For a platform whose skill format differs, the bridge translates the *frontmatter* into that
platform's manifest shape and still points its body at the canonical file. The contract that
must hold is only this: **discovery may be platform-specific; behaviour must be canonical.**

## Registry

| Skill | Purpose | Bridges |
|---|---|---|
| [`verify-before-claim`](./verify-before-claim/SKILL.md) | The engineering bar — verify against the running artifact, reproduce gates locally, never suppress a control | Claude Code |
| [`context-refresh`](./context-refresh/SKILL.md) | Rebuild an accurate picture of a workstream after time away, from live state rather than memory | Claude Code |

## Migration

Moving an existing skill here is three steps: move the directory, replace the original with
a bridge, then grep the repository for the old path and update any references. Check for a
`skill.json` first — if one exists, the skill is wired into the Codex routing graph and
moving it means updating `owned_paths` and any `required_commands` that reference its path.
Skills without a manifest move freely.

## Sources

- Operating kernel and the bridge contract: `AGENTS.md`
- Skill authoring rules and the linter: `.codex/skills/codex-skill-authoring/`
