# Hussh Action Items board (Project 79)

Second board profile supported by `board_ops.py` via `--board action-items`.
Verified live against the GitHub org on 2026-09-01.

## Identity

- Owner: `hushh-labs`
- Project number: **79**
- Project title: **Hussh Action Items**
- Default repo: `hushh-labs/hushh-research`
- Default creation status: `Accepted` (an item created deliberately by an agent or
  teammate is already triaged; `Inbox` is for untriaged intake).

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
