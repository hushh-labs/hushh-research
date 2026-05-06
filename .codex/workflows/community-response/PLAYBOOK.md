# Community Response

Use this workflow pack when the task matches `community-response`.

## Goal

Draft short public or community responses grounded in shipped repo truth and current technical boundaries.

## Steps

1. Start with `comms-community` and use `owner skill only` as the default narrow path.
2. Open only the required reads listed in `workflow.json` plus the selected skill manifests.
3. Extract and classify material claims with the truth-first operating kernel before drafting.
4. Run the required commands first, then the verification bundle.
5. Capture every field listed in `impact_fields` before calling the work complete.
6. Escalate through `handoff_chain` when the task crosses domain boundaries.
7. For drafted reply/Q&A requests, default to:
   - `Brief reply`
   - `Detailed reply`
   - `Firmer reply` only when correction is materially useful or explicitly requested
8. When citing maintained docs, use full GitHub `blob/main` links, not repo-relative paths.

## Common Drift Risks

1. overstating shipped functionality
2. mixing roadmap with runtime truth
3. answering with repo-relative paths instead of canonical GitHub doc links
4. bloating a Q&A response with unnecessary variants or memo structure
5. treating a contributor premise as truth without claim classification
