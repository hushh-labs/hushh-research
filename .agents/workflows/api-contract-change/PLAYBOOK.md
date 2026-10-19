# API Contract Change

Use this workflow pack when the task matches `api-contract-change`.

## Goal

Change a backend or proxy contract while keeping request/response, auth, docs, and verification in sync.

## Steps

1. Start with `backend` and use `backend-api-contracts` as the default narrow path.
2. Open only the required reads listed in `workflow.json` plus the selected skill manifests.
3. Run the required commands first, then the verification bundle.
4. Capture every field listed in `impact_fields` before calling the work complete.
5. Escalate through `handoff_chain` when the task crosses domain boundaries.

## Common Drift Risks

1. changing backend response shape without proxy/service updates
2. updating runtime without contract docs
3. missing auth or consent boundary review
