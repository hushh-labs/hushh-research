---
name: comms-community
description: Use when drafting short community-facing replies for Discord or public chat about hushh-research, Kai, PKM, consent architecture, mobile/native tradeoffs, privacy boundaries, roadmap questions, or repo-based technical Q&A.
---

# Hushh Comms Community Skill

## Purpose and Trigger

- Primary scope: `comms-community-intake`
- Trigger on Discord or public-chat reply drafting where the answer must be grounded in current repo docs and shipped boundaries.
- Avoid overlap with `docs-governance` and `repo-context`.

## Coverage and Ownership

- Role: `owner`
- Owner family: `comms-community`

Owned repo surfaces:

1. `.codex/skills/comms-community`

Non-owned surfaces:

1. `docs-governance`
2. `repo-context`

## Do Use

1. Drafting concise public replies about shipped architecture, trust boundaries, roadmap boundaries, or repo-backed technical answers.
2. Distinguishing clearly between current behavior and future direction.
3. Selecting only the smallest set of evidence-bearing docs needed for the answer.

## Do Not Use

1. Internal docs restructuring or repo-governance work.
2. Product implementation, debugging, or operational workflows.
3. Broad repo-orientation requests that should begin with `repo-context`.

## Read First

1. `.codex/skills/comms-community/references/reply-rules.md`
2. `docs/reference/iam/README.md`
3. `consent-protocol/docs/reference/developer-api.md`

## Workflow

1. Infer the real architectural question before drafting the reply.
2. Read only the minimum repo docs needed to answer that exact question.
3. Start with the direct answer and separate shipped behavior from future direction.

## Handoff Rules

1. If the work becomes docs-home governance, use `docs-governance`.
2. If the question cannot be answered cleanly without first mapping the repo or choosing the right owner family, start with `repo-context`.
3. If the task stops being public communication and becomes product or operational work, route to the correct owner skill.

## Required Checks

```bash
./bin/hushh docs verify
```
