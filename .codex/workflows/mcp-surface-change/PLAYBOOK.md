# MCP Surface Change

Use this workflow pack when the task matches `mcp-surface-change`.

## Goal

Change the Hushh MCP package, server surface, or developer onboarding contract without breaking docs or setup parity.

## Steps

1. Start with `backend` and use `mcp-developer-surface` as the default narrow path.
2. Open only the required reads listed in `workflow.json` plus the selected skill manifests.
3. Run the required commands first, then the verification bundle.
4. Capture every field listed in `impact_fields` before calling the work complete.
5. Escalate through `handoff_chain` when the task crosses domain boundaries.

## Common Drift Risks

1. changing package behavior without docs updates
2. breaking remote vs local MCP parity
3. forgetting developer API contract sync
