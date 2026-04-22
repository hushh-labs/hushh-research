# PR Governance Review

Use this workflow pack when reviewing an incoming pull request for true merge readiness.

## Goal

Review the current PR head, not stale history, and decide whether the change is actually safe to merge against Hushh north stars and trust boundaries.

## Steps

1. Start with `pr-governance-review`.
2. Run `python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo <repo> --pr <number> --text`.
3. For batched review, run `python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo <repo> --prs <n1,n2,...> --text` first and use that output to identify overlap, duplication, and safe batching boundaries before looking at merge order.
4. Treat helper-detected main-overlap and parallel-architecture findings as first-class review inputs, not optional notes. Exact file overlap is not the only duplication signal that matters.
5. Lock the review to the current head SHA and current `CI Status Gate` result.
6. Use a two-pass review model on every lane:
   - Pass 1: verify against current `main`, the current PR head, and product architecture truth before taking action
   - Pass 2: verify the authoritative workflow chain after action, including PR validation, queue validation, and main post-merge smoke where applicable
7. Assess findings in blocker-first order:
   - north-star drift
   - trust-boundary regression
   - caller/proxy/backend mismatch
   - deploy/runtime reproducibility drift
   - proof gaps
   - main-overlap / parallel-architecture drift
8. Choose exactly one lane:
   - `merge_now`
   - `patch_then_merge`
   - `block`
9. If the lane is `patch_then_merge`, do not merge the contributor head directly. Apply the smallest maintainer integration patch first, rerun checks, then communicate the adopted fix back to the author.
10. Prefer patching the contributor branch directly when maintainers are allowed to modify it. Use a short-lived `temp/pr-<number>-patch` branch only when direct patching is not possible or isolated maintainer staging is safer.
11. In a batch, do not recommend “merge all healthy PRs” unless the review explicitly proves there is no meaningful overlap or ordering dependency between them.
12. Before triggering merge, auto-merge, or merge-queue entry, produce the contributor-facing markdown draft for the selected lane. Do not post it yet.
13. When replying on the PR, use a brief markdown note with:
   - `## Acknowledgment`
   - `## What We Adopted`
   - `## Merge Decision`, `## Maintainer Patch`, or `## Blockers`
   - `## Related Surfaces` when the merge touched a trust boundary, product boundary, or reusable subsystem and future readers need the higher-level repo context; prefer clickable GitHub links to repo files and docs and include a one-line explanation for each entry
   - `## Why`
   - `## Next` only when there is real follow-up to communicate
14. Once the policy is finalized, do not ask for a second confirmation before posting the contributor-facing note. The note should be posted automatically after the monitored merge result reaches the required terminal state for that lane.
15. Do not stop monitoring after `gh pr merge`, `gh pr merge --auto`, queue entry, or green PR checks. Stay attached until the authoritative workflow chain is terminal for that PR:
   - `Queue Validation` terminal when merge queue is involved
   - `Main Post-Merge Smoke` terminal if the PR lands on `main`
16. Treat early stop as process drift. Codex should not need a user reminder to continue monitoring once it initiated the merge path.
17. Hand off only when the blocker lives inside another owner family.
18. Do not imply approval or recommend merge while blocker findings remain on the current merge candidate.

## Common Drift Risks

1. stale maintainer comments misleading the current review
2. repo-side CI bugs being mistaken for contributor code bugs, or vice versa
3. auth or runtime tightening that breaks current callers
4. performance claims that silently alter streaming or user-visible semantics
5. merging or queueing a PR without preparing the contributor-facing acknowledgment draft
6. posting the acknowledgment before the monitored merge outcome is actually known
7. stopping at queue entry or green PR checks instead of monitoring through post-merge authority
