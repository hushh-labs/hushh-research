# Hussh portable skills

`skills/` is the behavior source of truth shared by every supported coding-agent host.
Platform folders contain discovery bridges only; they must point here instead of copying
procedures that can drift.

| Skill | Canonical behavior | Platform bridges |
| --- | --- | --- |
| Verify before claim | [verify-before-claim](./verify-before-claim/SKILL.md) | `.claude/skills/verify-before-claim/` |
| Context refresh | [context-refresh](./context-refresh/SKILL.md) | host discovery only where installed |
| Portable PDF artifacts | [pdf-artifact-generation](./pdf-artifact-generation/SKILL.md) — including monthly executive calendar reports | `.codex` governed pointer; `.claude/skills/pdf-artifact-generation/` |

For a platform bridge, copy the canonical frontmatter verbatim, then instruct the host to
read the canonical file. Do not put behavioral rules, renderers, asset bundles, or tokens
inside a bridge.
