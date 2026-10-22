# Anti-Rationalization Guide

How to author `references/anti-rationalization.md` files for high-risk owner and spoke skills. Adapted from the rationalization-table mechanism in addyosmani/agent-skills, fitted to the hushh compact-kernel contract.

## Why this exists

The truth-first operating kernel stops premise drift coming from the USER (claims like "missing", "broken", "ready" that the repo contradicts). Nothing in the contract stops drift coming from the AGENT'S OWN reasoning — the quiet excuses used to skip a required step. AGENTS.md already names the canonical example: "Never skip routing because the task feels familiar. Familiarity is the most common cause of landing in the wrong spoke." That is a rationalization-table row. This mechanism generalizes it per lane.

## Format

Each participating skill owns `references/anti-rationalization.md` with exactly two sections:

```markdown
# <skill-id> — Anti-Rationalization Table

| Rationalization | Reality |
|---|---|
| "<the excuse as the agent would think it>" | <repo-backed rebuttal, citing the gate/contract/incident it violates> |

## Red Flags

- <checkable signal that a rationalization already won>
```

Rules:

1. **Source rows from evidence, not generic advice.** Mine the lane's `common_failures` array in its workflow.json, its evolution-history notes, and real incident history. A row that could appear in any repo's table is a weak row.
2. **Cap at ~10 rows.** Past that, the table becomes noise the agent skims. Route overflow into the owning skill's references or delete the weakest rows.
3. **Reality column must name the violated contract** — a gate, a required check, a doctrine item, or an incident. "Don't do that" is not a rebuttal; "violates the Branch Discipline Gate in AGENTS.md" is.
4. **Red flags must be checkable** — something an agent or reviewer can observe in a transcript or diff ("merged with blocker findings still open"), not a mood ("was careless").
5. **SKILL.md pays one line only.** The table lives in references/; the skill's Read First list gains a single entry. Never inline the table into a skill near its line budget.

## When a skill should have one

Advisory signal (see skill_lint): owner or spoke skills whose risk_tags include any of `trust-boundary-regression`, `merge-readiness-false-positive`, `north-star-drift`, or whose lane holds deploy/release/merge authority. Low-risk lanes do not need one — table sprawl is itself a form of drift.

## Relationship to the truth-first kernel

- Truth-first kernel: verifies the USER's claims against repo evidence before acting.
- Anti-rationalization table: verifies the AGENT's own shortcuts against lane contracts before skipping a step.

Both run in the same intake pass. Neither replaces the other.
