# Release Readiness

Use this workflow pack when the task matches `release-readiness`.

## Goal

Run the canonical repo checks, advisory checks, and release-focused audits before shipping or cutting a release.

## Steps

1. Start with `repo-operations` and use `owner skill only` as the default narrow path.
2. Run the repo-operations Branch Preservation Gate before checking out release SHAs, dispatching deploys, or creating hotfix branches.
3. Open only the required reads listed in `workflow.json` plus the selected skill manifests.
4. Run the required commands first, then the verification bundle.
5. If a release fix lands on `main`, back-sync the landed `origin/main` commits into the preserved developer branch before handoff.
6. Capture every field listed in `impact_fields` before calling the work complete.
7. Escalate through `handoff_chain` when the task crosses domain boundaries.

## Common Drift Risks

1. treating advisory findings as invisible
2. shipping without docs parity
3. skipping native checks when mobile surfaces changed
4. dispatching or fixing from a temporary branch without restoring the preserved developer branch
5. letting `main` hotfixes drift away from the active development branch
