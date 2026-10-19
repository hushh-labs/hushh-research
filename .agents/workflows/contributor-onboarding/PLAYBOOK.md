# Contributor Onboarding

Use this workflow pack when the task matches `contributor-onboarding`.

## Goal

Keep the contributor-first-run path lean, deterministic, and aligned across monorepo bootstrap and standalone consent-protocol setup.

## Steps

1. Start with `contributor-onboarding` and use `owner skill only` as the default narrow path.
2. Open only the required reads listed in `workflow.json` plus the touched env/bootstrap scripts.
3. Verify the direct scripts first, then verify the same path through the canonical repo entrypoint.
4. Capture which contributor path was changed: monorepo, standalone upstream, or both.
5. Escalate through `handoff_chain` when the work crosses into docs placement, repo operations, or subtree policy.

## Common Drift Risks

1. leaving old `pip` or venv instructions alongside `uv`
2. letting standalone upstream setup diverge from the monorepo quality contract
3. treating devcontainer config as separate from the bootstrap contract
