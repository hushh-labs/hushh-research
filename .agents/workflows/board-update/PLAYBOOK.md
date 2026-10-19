# Board Update

Use this workflow pack when the task matches `board-update`.

## Goal

Summarize, create, or update Hussh Engineering Core or Hussh Action Items board items with consistent project metadata.

## Steps

1. Start with `planning-board` and use `owner skill only` as the default narrow path.
2. Open only the required reads listed in `workflow.json` plus the selected skill manifests.
3. Run the required commands first, then the verification bundle.
4. Capture every field listed in `impact_fields` before calling the work complete.
5. Escalate through `handoff_chain` when the task crosses domain boundaries.
6. For Action Items intake, use `Inbox` and the selected board reference's ownership and scheduling rules. Item creation does not imply acceptance.

## Common Drift Risks

1. creating draft work without issue backing
2. updating board without status and date hygiene
