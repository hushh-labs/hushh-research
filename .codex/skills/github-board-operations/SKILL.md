---
name: github-board-operations
description: Use when inspecting, summarizing, creating, triaging, or updating work on the Hushh Engineering Core GitHub board. This skill is scoped to hushh-labs project 73 and standardizes issue-backed board items, required field updates, and date-window reporting.
---

# Hushh Engineering Core Board Operations Skill

Use this skill for GitHub board work on `Hushh Engineering Core` only.

## Source of truth

Read these first:

1. `.codex/skills/github-board-operations/references/engineering-core-board.md`
2. `docs/project_context_map.md`
3. `docs/reference/operations/coding-agent-mcp.md`

Use the helper when possible:

```bash
python3 .codex/skills/github-board-operations/scripts/board_ops.py --help
```

## Canonical board contract

1. Owner: `hushh-labs`
2. Project number: `73`
3. Board title: `Hushh Engineering Core`
4. Canonical engineering repo: `hushh-labs/hushh-research`
5. Use issue-backed project items, not draft items.
6. Active work defaults to `In progress`.
7. Required board fields on create/update:
   - `Status`
   - `Sprint`
   - `Start date`
   - `Target date`
8. Assignment belongs on the GitHub issue assignee, not only the project item.

## Workflow

### Summaries

1. Use the helper `summary` command for date-window reporting.
2. Report totals by status and repo first.
3. Then report the focused `hushh-labs/hushh-research` slice.

### Creating work

1. Create the GitHub issue in `hushh-labs/hushh-research`.
2. Attach it to `Hushh Engineering Core`.
3. Apply full board metadata:
   - `Status=In progress`
   - current open sprint
   - `Start date=today` unless provided
   - `Target date=next day` unless provided
4. Verify the resulting board item state after the update.

### Updating work

1. Resolve the issue and current board item dynamically.
2. Update board fields through the project item, not by assuming cached IDs.
3. Re-read the issue/project state after editing to confirm the update stuck.

## Decision rules

1. If the user says “add this task to the board”, create the issue first, then attach/update the board item.
2. If assignee is not provided:
   - default to the authenticated GitHub user only when the task is clearly personal or user-owned
   - otherwise leave it unassigned and state that explicitly
3. Do not introduce labels or milestones unless the user asks.
4. Do not hardcode sprint names; always resolve the current open iteration from the board.

## Required checks

Run these when changing or using the helper:

```bash
python3 -m py_compile .codex/skills/github-board-operations/scripts/board_ops.py
python3 .codex/skills/github-board-operations/scripts/board_ops.py summary --from 2026-04-01 --to 2026-04-07
python3 .codex/skills/github-board-operations/scripts/board_ops.py show-open-work --repo hushh-labs/hushh-research
```
