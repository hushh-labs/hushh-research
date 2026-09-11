# Hussh Action Items board (Project 79)

Second board profile supported by `board_ops.py` via `--board action-items`.
Verified live against the GitHub org on 2026-09-01.

## Identity

- Owner: `hushh-labs`
- Project number: **79**
- Project title: **Hussh Action Items**
- Default repo: `hushh-labs/hushh-research`
- Default creation status: `Inbox` for new, untriaged proposals. Classify from the
  existing conversation before creating: an approved plan awaiting execution is
  `Accepted`; approved work already being implemented is `In Progress`.
  Recording existing work does not restart intake or require approval again.
- New intake has no automatic dates. Open-ended work stays unassigned, with
  `Lead`, `Owner`, and `Target Fix Date` unset unless established by user context.
  For personal tracking, carry the explicit owner or supplied view's assignee into
  the GitHub issue assignment. Do not infer ownership from who runs the tool.

## Status lifecycle

`Inbox → Accepted → In Progress → Ready for QA → Ready For UAT → Done`

Side states: `Needs Triage`, `Blocked`, `Duplicate`, `Won't Fix`. The duplicate rule from
the Engineering Core board applies unchanged: consolidate scope into the canonical issue,
leave a traceability comment, remove the duplicate item; never mark a duplicate `Done`.

## Fields (differ from Project 73)

| Field | Type | Notes |
|---|---|---|
| `Status` | single-select | lifecycle above |
| `Severity` | single-select | `P0 Critical`, `P1 High`, `P2 Medium`, `P3 Low` |
| `Lead` | single-select | `Kushal`, `Ankit` |
| `Owner` | single-select | `Jhumma`, `Kushal`, `Ankit`, `Akshat`, `Neelesh`, `Gautam` |
| `Sector` | single-select | `Hussh Research`, `HusshTech`, `Hussh AI`, `Hussh One` |
| `Environment` | single-select | `Production`, `UAT`, `Local`, `GitHub/CI` |
| `Target Fix Date` | date | `--target-date` maps here automatically |

There is **no** `Sprint`, `Hierarchy`, or `Start date` field. `board_ops.py` resolves
every field against the live catalog, so those absences degrade to warnings, never
errors. Extra single-selects are set with the repeatable `--field 'Name=Option'` flag.

## Example

```bash
python3 .codex/skills/planning-board/scripts/board_ops.py --board action-items \
  create-task \
  --title "P0: Example item" \
  --body "..." \
  --assignee kushaltrivedi5 \
  --target-date 2026-09-05 \
  --field "Severity=P0 Critical" \
  --field "Lead=Kushal" \
  --field "Owner=Kushal" \
  --field "Sector=Hussh One" \
  --field "Environment=Local"
```

All Engineering Core invariants (issue-backed items only, create issue first, resolve
IDs dynamically, re-read after mutation, `#<number> <title>` reporting) apply to this
board identically.

## Execution cadence

- At creation/resumption: find the existing issue, resolve the requested board and
  view filter, retain established assignee/ownership, and set status from evidence.
- At a meaningful checkpoint: update the same issue with changed scope, commit or
  branch link, checks, next action and concrete blockers. Avoid per-command comments.
- While code is unfinished: `In Progress`. Use `Blocked` only for a dependency that
  actually prevents progress, naming the dependency and the next owner action.
- When implementation is ready for verification: `Ready for QA`; use `Ready For UAT`
  only when the required QA evidence supports that handoff. Do not use Engineering
  Core's `In review` spelling on this board; resolve live options.
- Use `Done` only when the agreed acceptance evidence is complete. A pushed branch,
  local tests or completed documentation alone cannot close a product journey.
- After each mutation: bypass cached snapshots and verify the live issue assignment,
  project membership and status. For a supplied filter, check every predicate;
  a project Owner field does not satisfy GitHub's `assignee:` filter.
- Preserve dates and sprint unless requested. Board status never grants permission
  to merge, deploy or submit to a marketplace. Keep publication target explicit.
