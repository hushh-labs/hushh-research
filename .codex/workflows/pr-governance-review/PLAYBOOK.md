# PR Governance Review

Use this workflow pack when reviewing an incoming pull request for true merge readiness.

## Goal

Review the current PR head, not stale history, and decide whether the change is actually safe to merge against Hussh north stars and trust boundaries.

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
9. Choose exactly one action flow before writing to GitHub:
   - `review_only`: analyze and report, no GitHub write.
   - `comment_only`: post or edit a comment/review, no approval or merge.
   - `approve_only`: approve the current head, then stop before merge.
   - `approve_then_merge`: approve, trigger merge/auto-merge/merge queue, then monitor through terminal state.
   - `patch_then_merge`: patch first, rerun checks, then approve and merge only after the updated head is clean.
10. Do not infer merge from approval. "Approve" means `approve_only`; "merge", "land", "queue", or "complete the PR job end-to-end" means `approve_then_merge` when the lane is `merge_now`.
11. If the lane is `patch_then_merge`, do not merge the contributor head directly. Apply the smallest maintainer integration patch first, rerun checks, then communicate the adopted fix back to the author.
12. Prefer patching the contributor branch directly when maintainers are allowed to modify it. Use a short-lived `temp/pr-<number>-patch` branch only when direct patching is not possible or isolated maintainer staging is safer.
13. In a batch, do not recommend “merge all healthy PRs” unless the review explicitly proves there is no meaningful overlap or ordering dependency between them.
14. Before triggering merge, auto-merge, or merge-queue entry, produce the contributor-facing note for the selected lane. Do not post it yet.
15. When replying on the PR, use natural, concise, founder-facing technical language. For low-risk approvals, prefer two or three compact paragraphs: approval SHA, what was accepted, why it matters, current gate/mergeability/lean-risk/overlap status, and the recheck condition if the branch moves.
16. Use fuller sections only when they help future readers understand a patch, blocker, trust boundary, or related surface.
17. Once the action flow is finalized, do not ask for a second confirmation before posting the contributor-facing note. The note should be posted automatically after the monitored merge result reaches the required terminal state when the selected flow includes merge.
18. Do not stop monitoring after `gh pr merge`, `gh pr merge --auto`, queue entry, or green PR checks. Stay attached until the authoritative workflow chain is terminal for that PR:
   - `Queue Validation` terminal when merge queue is involved
   - `Main Post-Merge Smoke` terminal if the PR lands on `main`
19. Before the final response, update the active working report when one exists. For `tmp/pr-governance-live-report.md`, this means updating the progress ledger, per-PR register entries, head SHAs, lanes, batch counts, recommended next order, and terminal queue/smoke evidence.
20. If the working report has a live update checklist, execute it before closing the turn.
21. Treat early stop as process drift. Codex should not need a user reminder to continue monitoring or refresh the working record once it initiated the merge path.
22. Hand off only when the blocker lives inside another owner family.
23. Do not imply approval or recommend merge while blocker findings remain on the current merge candidate.

## Common Drift Risks

1. stale maintainer comments misleading the current review
2. repo-side CI bugs being mistaken for contributor code bugs, or vice versa
3. auth or runtime tightening that breaks current callers
4. performance claims that silently alter streaming or user-visible semantics
5. merging or queueing a PR without preparing the contributor-facing acknowledgment draft
6. posting the acknowledgment before the monitored merge outcome is actually known
7. stopping at queue entry or green PR checks instead of monitoring through post-merge authority
8. treating an `approve_only` request as implicit merge authority
9. using rigid template comments where a concise technical approval note would be clearer
10. updating only the summary ledger while leaving per-PR register entries stale after merge, close, or supersede
