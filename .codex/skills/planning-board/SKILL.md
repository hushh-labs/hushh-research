---
name: planning-board
description: Use when inspecting, summarizing, creating, triaging, or updating work on the Hushh Engineering Core GitHub board.
---

# Hushh Planning Board Skill

## Purpose and Trigger

- Primary scope: `planning-board-intake`
- Trigger on `Hushh Engineering Core` board summaries, issue-backed board item creation, triage, and field updates.
- Avoid overlap with `repo-operations` and `repo-context`.

## Coverage and Ownership

- Role: `owner`
- Owner family: `planning-board`

Owned repo surfaces:

1. `.codex/skills/planning-board`

Non-owned surfaces:

1. `repo-operations`
2. `repo-context`

## Do Use

1. Summarizing board activity by date window or repository slice.
2. Creating issue-backed board work in `hushh-labs/hushh-research`.
3. Updating required board metadata and verifying the resulting project-item state.

## Do Not Use

1. CI, deploy, branch-protection, or PR-approval workflows.
2. Broad repo-orientation work.
3. Product implementation or docs-home governance.

## Read First

1. `.codex/skills/planning-board/references/engineering-core-board.md`
2. `docs/project_context_map.md`
3. `docs/reference/operations/coding-agent-mcp.md`

## Workflow

1. Resolve the issue and project-item state dynamically instead of assuming cached IDs.
2. Create the GitHub issue first, then attach and update the board item.
3. Re-read the issue and board state after editing to confirm the change stuck.

## Handoff Rules

1. If the task is broad repo orientation, start with `repo-context`.
2. If the task is CI, deploy, or branch protection, use `repo-operations`.
3. If the task becomes product coding or docs governance, route to the correct owner skill for that domain.

## Required Checks

```bash
python3 -m py_compile .codex/skills/planning-board/scripts/board_ops.py
python3 .codex/skills/planning-board/scripts/board_ops.py summary --from 2026-04-01 --to 2026-04-07
```
