# Engineering Core Board Reference

This reference documents the canonical GitHub board workflow for this repo.

## Board identity

- Owner: `hushh-labs`
- Project number: `73`
- Project title: `Hushh Engineering Core`
- Default repository for engineering work: `hushh-labs/hushh-research`

## Canonical field usage

- `Status`
  - `Backlog`: valid work that is not committed to the current execution window
  - `Ready`: ready to pick up, with enough context to execute
  - `In progress`: active execution work
  - `In review`: implementation or board work is complete, but PR review, UAT proof, dashboard acceptance, founder sign-off, or another external acceptance step remains
  - `Done`: accepted completion with matching issue state or explicit acceptance evidence
- `Sprint`
  - resolve dynamically from the currently open board iteration
- `Start date`
  - defaults to the working day when the task is created or picked up
- `Target date`
  - defaults to the next day for short-turnaround execution tasks unless the user gives a different target
- update existing tasks without changing dates or sprint unless the user explicitly asks for that metadata to move

## Task shape

1. Use issue-backed project items.
2. Prefer `hushh-labs/hushh-research` unless the task is explicitly for another repo.
3. Put ownership on the GitHub issue assignee.
4. Avoid draft issues, labels, or milestones unless the user asks for them.
5. When the user asks for labels, update them explicitly and verify the final label set on the issue.
6. If a task is duplicate or redundant, consolidate its remaining scope into the canonical issue, add a traceability comment, and remove the duplicate project item from the board. Preserve GitHub issue history unless the user explicitly asks for destructive issue deletion.
7. Do not mark duplicate or redundant tasks as `Done` unless the duplicated task itself was actually delivered and accepted.

## Board hygiene SOP

Use the audit command before and after board cleanup:

```bash
python3 .codex/skills/planning-board/scripts/board_ops.py audit-state
```

Resolve drift with these rules:

1. Closed issue not `Done`: set the project item to `Done` unless it is duplicate/redundant, in which case remove the project item.
2. Open issue in `Done`: close it only when completion evidence exists; otherwise move it back to `In review` or `In progress`.
3. Duplicate/redundant issue: keep one canonical issue on the board, comment the consolidation, then remove the duplicate project item.
4. Verification-blocked work: use `In review` when the code/task is done but acceptance evidence is still pending.
5. Source-of-truth blockers, such as BigQuery export materialization or dashboard acceptance, keep the canonical issue open until the blocker is verified.

## Reporting conventions

For date-bounded reporting:

1. summarize totals by status
2. summarize totals by repo
3. then show the focused `hushh-research` slice

For personal/user-owned requests:

1. prefer the authenticated GitHub user as assignee
2. use active execution defaults unless the user asks for backlog or review placement
3. present tasks as `#<number> <title>` in summaries and change logs
4. do not use bare issue numbers when the title is available

## Helper commands

```bash
python3 .codex/skills/planning-board/scripts/board_ops.py summary --from YYYY-MM-DD --to YYYY-MM-DD
python3 .codex/skills/planning-board/scripts/board_ops.py create-task --title "..." --body "..." --assignee <login> --start-date YYYY-MM-DD --target-date YYYY-MM-DD --labels enhancement
python3 .codex/skills/planning-board/scripts/board_ops.py update-task --issue 123 --status "In progress" --labels enhancement,learning/research
python3 .codex/skills/planning-board/scripts/board_ops.py update-task --issue 123 --sync-current-sprint --start-date YYYY-MM-DD --target-date YYYY-MM-DD
python3 .codex/skills/planning-board/scripts/board_ops.py audit-state
python3 .codex/skills/planning-board/scripts/board_ops.py remove-task --issue 123
python3 .codex/skills/planning-board/scripts/board_ops.py show-open-work --assignee <login>
```
