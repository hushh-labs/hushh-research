# Docs Sync

Use this workflow pack when the task matches `docs-sync`.

## Goal

Update canonical docs homes and keep runtime, references, and contributor guidance aligned after changes.

## Steps

1. Start with `docs-governance` and use `owner skill only` as the default narrow path.
2. Open only the required reads listed in `workflow.json` plus the selected skill manifests.
3. Run the required commands first, then the verification bundle.
4. Capture every field listed in `impact_fields` before calling the work complete.
5. Escalate through `handoff_chain` when the task crosses domain boundaries.

## Common Drift Risks

1. documenting helper details in the wrong docs home
2. leaving stale doc paths after refactor
3. writing new docs instead of updating canonical docs
