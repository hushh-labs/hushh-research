# Subtree Upstream Governance

Use this workflow pack when the task matches `subtree-upstream-governance`.

## Goal

Keep upstream-first sync rules, maintainer-only subtree policy, and cross-repo metadata alignment stable between consent-protocol and hushh-research.

## Steps

1. Start with `subtree-upstream-governance` and use `owner skill only` as the default narrow path.
2. Open only the required reads listed in `workflow.json` plus the touched root and subtree contract files.
3. Run the subtree sync and docs checks after every policy edit.
4. For changes that affect licensing or onboarding at both root and subtree scope, verify both contracts before calling the work complete.
5. Escalate through `handoff_chain` when the change crosses into repo operations, docs placement, licensing, or onboarding.

## Common Drift Risks

1. hiding important subtree policy in PR-only context instead of the maintainer doc
2. making subtree knowledge part of ordinary contributor onboarding
3. leaving root and subtree contract surfaces out of sync
