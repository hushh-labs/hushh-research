# Hussh Action Items board (Project 79)

Second board profile supported by `board_ops.py` via `--board action-items`.
Initial profile verified on 2026-10-12; Environment options rechecked on 2026-11-11.

## Identity

- Owner: `hushh-labs`
- Project number: **79**
- Project title: **Hussh Action Items**
- Default repo: `hushh-labs/hushh-research`
- Default creation status: `Inbox`. Creating an item is intake, not acceptance,
  including work entered by founders, the CTO, or coding agents. Move to
  `Accepted` only when the user explicitly requests or confirms triage acceptance.
- New intake has no automatic dates. Open-ended work stays unassigned, with
  `Lead`, `Owner`, and `Target Fix Date` unset unless the user specifies them.

## Status lifecycle

`Inbox → Accepted → In Progress → Ready for QA → Done`

Re-verified live 2026-10-12: there is no `Ready For UAT` option (the helper resolves options
against the live catalog, so re-list the fields before assuming one). Shipped work that still
awaits acceptance sits in `Ready for QA`. Setting `Done` through `board_ops.py` also closes the
issue, so record completion evidence in its description or one appropriate comment
before closing. Respect edit-only/no-comment instructions.

Side states: `Needs Triage`, `Blocked`, `Duplicate`, `Won't Fix`. The duplicate rule from
the Engineering Core board applies unchanged: consolidate scope into the canonical issue,
record traceability in the canonical issue (use its description when comments are
disallowed), remove the duplicate item; never mark a duplicate `Done`.

## Fields (differ from Project 73)

| Field | Type | Notes |
|---|---|---|
| `Status` | single-select | lifecycle above |
| `Severity` | single-select | `P0 Critical`, `P1 High`, `P2 Medium`, `P3 Low` |
| `Lead` | single-select | `Kushal`, `Ankit` |
| `Owner` | single-select | `Jhumma`, `Kushal`, `Ankit`, `Akshat`, `Neelesh`, `Gautam` |
| `Sector` | single-select | `Hussh Research`, `HusshTech`, `Hussh AI`, `Hussh One` |
| `Environment` | single-select | `Production`, `UAT`, `Local`, `GitHub/CI`, `Dev` |
| `Target Fix Date` | date | `--target-date` maps here automatically |

There is **no** `Sprint`, `Hierarchy`, or `Start date` field. `board_ops.py` resolves
every field against the live catalog, so those absences degrade to warnings, never
errors. Extra single-selects are set with the repeatable `--field 'Name=Option'` flag.

If the actual environment has no option, do not substitute another environment.
When a catalog change is already authorized, add the exact option while preserving
existing option IDs, names, colors and descriptions, then read back the item.
Otherwise report the catalog mismatch without inventing a selection.

## Example

```bash
python3 .agents/skills/planning-board/scripts/board_ops.py --board action-items \
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

Use [task handoffs](task-handoff.md) for one canonical issue. `For humans` explains
the findings, chosen direction, reasons, phase outcomes and visible references;
`For coding agents` gives detailed implementation mechanics. Keep the owner's next
action clear without hiding human decisions in the agent section.
Update the issue/checklist in place rather than repeating summaries in comments.
Keep sensitive receipts in approved evidence artifacts; preserve material blockers,
unverified work and release gates.
Include a brief current status and clear owner next action. Keep source/build
identity and detailed receipts with their evidence owner, linked for agents and
reviewers rather than copied into the human decision brief.
