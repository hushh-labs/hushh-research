# Subtree Upstream Governance

Use this workflow pack when the task matches `subtree-upstream-governance`.

## Goal

Keep the monorepo-authoritative, optional-mirror policy and maintainer-only subtree operations stable between consent-protocol and hushh-research.

## Steps

1. Start with `subtree-upstream-governance` and use `owner skill only` as the default narrow path.
2. Open only the required reads listed in `workflow.json` plus the touched root and subtree contract files.
3. Run docs and governance checks after every policy edit; run subtree sync only when a maintainer elects to update the optional mirror.
4. For changes that affect licensing or onboarding at both root and subtree scope, verify both contracts before calling the work complete.
5. Escalate through `handoff_chain` when the change crosses into repo operations, docs placement, licensing, or onboarding.

## Common Drift Risks

1. hiding important subtree policy in PR-only context instead of the maintainer doc
2. making subtree knowledge part of ordinary contributor onboarding
3. leaving root and subtree contract surfaces out of sync
4. treating optional mirror drift or mirror CI as a monorepo release gate
