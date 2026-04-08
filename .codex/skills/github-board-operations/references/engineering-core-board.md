# Engineering Core Board Reference

This reference documents the canonical GitHub board workflow for this repo.

## Board identity

- Owner: `hushh-labs`
- Project number: `73`
- Project title: `Hushh Engineering Core`
- Default repository for engineering work: `hushh-labs/hushh-research`

## Canonical field usage

- `Status`
  - default for active execution work: `In progress`
- `Sprint`
  - resolve dynamically from the currently open board iteration
- `Start date`
  - defaults to the working day when the task is created or picked up
- `Target date`
  - defaults to the next day for short-turnaround execution tasks unless the user gives a different target

## Task shape

1. Use issue-backed project items.
2. Prefer `hushh-labs/hushh-research` unless the task is explicitly for another repo.
3. Put ownership on the GitHub issue assignee.
4. Avoid draft issues, labels, or milestones unless the user asks for them.

## Reporting conventions

For date-bounded reporting:

1. summarize totals by status
2. summarize totals by repo
3. then show the focused `hushh-research` slice

For personal/user-owned requests:

1. prefer the authenticated GitHub user as assignee
2. use active execution defaults unless the user asks for backlog or review placement

## Helper commands

```bash
python3 .codex/skills/github-board-operations/scripts/board_ops.py summary --from YYYY-MM-DD --to YYYY-MM-DD
python3 .codex/skills/github-board-operations/scripts/board_ops.py create-task --title "..." --body "..." --assignee <login> --start-date YYYY-MM-DD --target-date YYYY-MM-DD
python3 .codex/skills/github-board-operations/scripts/board_ops.py update-task --issue 123 --status "In progress" --start-date YYYY-MM-DD --target-date YYYY-MM-DD
python3 .codex/skills/github-board-operations/scripts/board_ops.py show-open-work --assignee <login>
```
