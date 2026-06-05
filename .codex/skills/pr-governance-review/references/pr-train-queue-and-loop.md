# PR Train Queue And Loop

Use this reference for execution after `pr-train-review-sop.md` and
`pr-train-write-contract.md` classify the train.

## Operating Loop

1. Refresh the live report with oldest-first selection unless explicitly asked for latest.
2. Confirm requested author/surface scope and correct rough handles before selecting PRs.
3. Apply the Actionable Intake Filter; split PRs into actionable trains, `Check Failure Holds`, and `Dormant Current Holds`.
4. Build the complete async train map and train-to-subagent map for actionable PRs.
5. Ignore `Check Failure Holds` unless this is CI repair.
6. Read every queue cohort, collision group, patch train, and decision wave.
7. Assign each independent train to the five-worker evidence pool and refill workers continuously.
8. Convert each returned lane into executable writes by value, age, and collision risk.
9. Produce the operator dossier from `operator-batch-output-contract.md`.
10. Execute approved GitHub writes by editing existing maintainer records first.
11. Exclude PRs just handled by a current standardized maintainer record until fresh contributor or GitHub state changes.
12. Run a post-changes repass train for green PRs with contributor activity after a maintainer changes-requested record.
13. For merges, apply the Exact-Head Queue Safety gate, enqueue only the current verified head SHA, and monitor queue and smoke.
14. Refresh live report and contributor-impact dashboard.
15. Return the parent worktree to the recorded developer branch after temporary checkout, worktree, detached HEAD, or queue-monitoring branch changes.
16. Report active-pass progress with direct PR links.
17. Start the next independent train while unrelated checks run until every approved train is terminal or blocked.

## Queue Cancellation Handling

Main-smoke cancellation from a newer main push is `superseded`; only the latest
non-cancelled current-main smoke is authoritative. Runner/tool setup failures
are `infra_transient`; rerun once after substantive jobs pass, then route to
`repo-operations`. Test, type, secret, freshness, or mergeability failures stop
the PR until corrected.

## Stop Conditions

Stop, split, or rescan on head SHA changes, CI loss, dirty mergeability, new
hard edge, local worktree overlap, missing UI browser proof, unclear trust
boundary, incomplete scan, or lost patch attach point. Green CI never overrides
exact file overlap.

## Exact-Head Queue Safety

Immediately before approving or queueing a PR, the parent session must re-read:

1. head OID/SHA
2. base branch
3. draft state
4. required `CI Status Gate`
5. auxiliary check state
6. mergeability/conflict state
7. review decision and latest maintainer record
8. hard-edge collisions and local dirty-file overlap

Queue only the head that was just verified. If any value differs from the
dossier, abort the write and send the PR through a repass lane.

If parent exact-head proof fails, the proof result overrides subagent lane
recommendations. Downgrade `merge_now` to `request_changes`, `hold`, or
`maintainer_patch_then_merge` based on the smallest safe repair path.

Use CLI fields supported by the installed GitHub CLI. For `gh pr checks`, use
`name,state,bucket,link,completedAt`; do not assume a `conclusion` field is
available. For merge queue state, use GraphQL `isInMergeQueue` and
`mergeQueueEntry { state position }`.
