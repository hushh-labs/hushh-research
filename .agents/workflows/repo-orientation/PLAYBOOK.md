# Repo Orientation

Use this workflow pack when the task matches `repo-orientation`.

## Goal

Establish repo context, choose the correct owner skill, and avoid cross-domain drift before implementation starts.

## Steps

1. Start with `repo-context` and use `owner skill only` as the default narrow path.
2. Open only the required reads listed in `workflow.json` plus the selected skill manifests.
3. Run the required commands first, then the verification bundle.
4. Capture every field listed in `impact_fields` before calling the work complete.
5. Escalate through `handoff_chain` when the task crosses domain boundaries.

## Common Drift Risks

1. choosing a spoke before routing through the owner skill
2. loading broad repo context too early
3. skipping north-star invariants before execution
