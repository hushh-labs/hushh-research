---
name: future-planner
description: Use when evaluating future roadmap ideas, creating planning-only architecture docs, or assessing R&D concepts against Hussh north stars, trust boundaries, and current repo reality.
---

# Hussh Future Planner Skill

## Purpose and Trigger

- Primary scope: `future-roadmap-plan-intake`
- Trigger on future roadmap concepts, R&D architecture notes, assistant-evolution ideas, external trend fit questions, and planning-only concept docs that must stay separate from `vision` and active implementation.
- Avoid overlap with `planning-board`, `docs-governance`, and `repo-context`.

## Coverage and Ownership

- Role: `owner`
- Owner family: `future-planner`

Owned repo surfaces:

1. `docs/future`
2. `.codex/skills/future-planner`
3. `.codex/workflows/future-roadmap-plan`

Non-owned surfaces:

1. `docs-governance`
2. `planning-board`
3. `repo-context`
4. `docs/vision`

## Do Use

1. Deciding whether an idea belongs in north-star vision, future roadmap, or active execution.
2. Creating or refining planning-only docs under `docs/future/`.
3. Assessing future concepts against trust boundaries, PKM, consent, delegation, connector access, UX clarity, and operational complexity.
4. Turning vague future ideas into explicit R&D notes with promotion criteria.

## Do Not Use

1. Active implementation work or execution-owned technical specs.
2. GitHub board updates that belong to `planning-board`.
3. Broad repo scanning when the correct owner family is still unknown.
4. Rewriting durable vision docs unless the product thesis itself is changing.

## Read First

1. `docs/vision/README.md`
2. `docs/future/README.md`
3. `docs/reference/operations/documentation-architecture-map.md`
4. `consent-protocol/docs/reference/personal-knowledge-model.md`

## Workflow

1. Ground the idea in current repo reality before planning future behavior.
2. Classify the request explicitly as `vision`, `future roadmap`, or `execution`.
3. Assess edge cases before writing:
   - trust and authority boundaries
   - BYOK and zero-knowledge compatibility
   - PKM vs runtime-memory separation
   - A2A or delegated-execution implications
   - connector permissions and on-demand consent
   - user-facing trust-state clarity
4. Record what already exists, what is missing, what needs new primitives, and what should stay out of scope.
5. Place the output in `docs/future/` unless the work is already approved for execution or belongs in `docs/vision/`.
6. Add explicit status and promotion criteria to every future-state concept doc.

## Handoff Rules

1. If the task is broad repo orientation first, start with `repo-context`.
2. If the task becomes documentation-home governance, hand off to `docs-governance`.
3. If the task becomes issue or board planning, hand off to `planning-board`.
4. If the concept is approved and becomes active work, hand off to the correct execution owner skill instead of keeping implementation detail in `future-planner`.

## Required Checks

```bash
python3 .codex/skills/codex-skill-authoring/scripts/skill_lint.py
./bin/hushh docs verify
./bin/hushh codex audit
```
