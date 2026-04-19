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
4. Drafting repo-backed internal Q&A replies where the question may reference files, test failures, or implementation concerns that need verification before answering.

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
4. For repo-backed Q&A, verify the premise first:
   - confirm the referenced file, module, or test surface exists in the current tree
   - confirm the reported concern is actually visible in the current repo state when feasible
   - if the premise is not grounded, say that directly before suggesting any fix
5. When the user asks for response variants, provide:
   - `default`: short and evidence-backed
   - `firmer`: corrective and decision-oriented
   - `detailed`: explains the reasoning and next action clearly
6. Choose evidence format by audience:
   - public/community: prefer canonical GitHub markdown doc links only
   - internal repo Q&A: file links or GitHub issue/PR links are allowed when they directly prove the point
7. Do not invent certainty from a vague teammate report. If the concern is branch-local or not present in the current tree, say so and ask for the exact path, log, or PR.

## Handoff Rules

1. If the work becomes docs-home governance, use `docs-governance`.
2. If the question cannot be answered cleanly without first mapping the repo or choosing the right owner family, start with `repo-context`.
3. If the task stops being public communication and becomes product or operational work, route to the correct owner skill.

## Required Checks

```bash
./bin/hushh docs verify
```
