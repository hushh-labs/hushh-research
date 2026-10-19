# Skill Authoring

Use this workflow pack when the task matches `skill-authoring`.

## Goal

Create or retrofit skills, manifests, workflows, and routing metadata for the Codex operating system.

## Steps

1. Start with `codex-skill-authoring` and use `owner skill only` as the default narrow path.
2. Open only the required reads listed in `workflow.json` plus the selected skill manifests.
3. Run the required commands first, then the verification bundle.
4. Capture every field listed in `impact_fields` before calling the work complete.
5. Escalate through `handoff_chain` when the task crosses domain boundaries.

## Common Drift Risks

1. adding markdown-only skills without manifest metadata
2. creating overlapping task types
3. forgetting onboarding or audit updates
