# Docs Sync

Use this workflow pack when the task matches `docs-sync`.

## Goal

Update canonical docs homes and keep runtime, references, and contributor guidance aligned after changes.

## Steps

1. Start with `docs-governance` and use `owner skill only` as the default narrow path.
2. Open only the required reads listed in `workflow.json` plus the selected skill manifests.
3. Classify each touched doc through the reference-hub model before editing: `canonical`, `pointer/index`, `future-plan`, `planning-archive`, `historical-provenance`, `merge-then-delete`, or `delete`.
4. For recursive restructures, run the folder inventory and apply the recursive knowledge model before splitting pages.
5. Merge durable facts into the canonical owner before deleting stale maintained docs.
6. Run the required commands first, then the verification bundle.
7. Capture every field listed in `impact_fields` before calling the work complete.
8. Escalate through `handoff_chain` when the task crosses domain boundaries.

## Common Drift Risks

1. documenting helper details in the wrong docs home
2. leaving stale doc paths after refactor
3. writing new docs instead of updating canonical docs
4. treating date-stamped Superpowers plans/specs as current reference truth
5. splitting docs by size alone instead of by owner, lifecycle, or workflow
