# OSS License Governance

Use this workflow pack when the task matches `oss-license-governance`.

## Goal

Keep Apache-2.0 licensing, SPDX/REUSE coverage, package metadata, and third-party notices aligned across hushh-research and consent-protocol.

## Steps

1. Start with `oss-license-governance` and use `owner skill only` as the default narrow path.
2. Open only the required reads listed in `workflow.json` plus the touched package or subtree manifests.
3. Regenerate notice artifacts before verification when dependency or package metadata changes.
4. Run the verification bundle twice for root-plus-subtree changes.
5. Escalate through `handoff_chain` when the work crosses into repo operations, docs placement, or subtree policy.

## Common Drift Risks

1. changing the public license story without fixing package manifests
2. leaving generated notice artifacts stale
3. updating only root or only subtree licensing surfaces
