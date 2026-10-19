# Hussh Action Items board (Project 79)

Second board profile supported by `board_ops.py` via `--board action-items`.
Verified live against the GitHub org on 2026-10-12.

## Identity

- Owner: `hushh-labs`
- Project number: **79**
- Project title: **Hussh Action Items**
- Default repo: `hushh-labs/hushh-research`
- Default creation status: `Accepted` (an item created deliberately by an agent or
  teammate is already triaged; `Inbox` is for untriaged intake).

## Status lifecycle

`Inbox → Accepted → In Progress → Ready for QA → Done`

Re-verified live 2026-10-12: there is no `Ready For UAT` option (the helper resolves options
against the live catalog, so re-list the fields before assuming one). Shipped work that still
awaits acceptance sits in `Ready for QA`. Setting `Done` through `board_ops.py` also closes the
issue, so post the completion evidence as a comment in the same pass, or the item closes with
no trace of what proved it.

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

## Concise task presentation

Keep one outcome-focused title, a short acceptance checklist and a link to the
existing evidence owner. Update that checklist as proof changes; avoid repeated
status comments or copying full implementation logs into the board. Preserve
material blockers and release gates rather than shortening away their meaning.
