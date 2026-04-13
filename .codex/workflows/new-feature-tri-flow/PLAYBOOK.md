# New Feature Tri-Flow

Use this workflow pack when the task matches `new-feature-tri-flow`.

## Goal

Ship a new feature across web, native, backend, docs, and verification surfaces without route or contract drift.

## Steps

1. Start with `frontend` and use `frontend-architecture` as the default narrow path.
2. Open only the required reads listed in `workflow.json` plus the selected skill manifests.
3. Run the required commands first, then the verification bundle.
4. Capture every field listed in `impact_fields` before calling the work complete.
5. Escalate through `handoff_chain` when the task crosses domain boundaries.

## Common Drift Risks

1. shipping web work without native parity review
2. adding fetch calls directly in components
3. forgetting API/route-contract doc updates
4. missing service-layer or proxy alignment
