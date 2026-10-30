# Bug Triage

Use this workflow pack when the task matches `bug-triage`.

## Goal

Reproduce, bound blast radius, pick the right owner skill, and run the minimal verification bundle needed to fix a bug safely.

## Steps

1. Start with `repo-context` and use `owner skill only` as the default narrow path.
2. Open only the required reads listed in `workflow.json` plus the selected skill manifests.
3. Run the required commands first, then the verification bundle.
4. Capture every field listed in `impact_fields` before calling the work complete.
5. Escalate through `handoff_chain` when the task crosses domain boundaries.

## Common Drift Risks

1. jumping into a subsystem before bounding blast radius
2. fixing symptoms without docs/tests updates
3. running oversized verification instead of targeted checks
