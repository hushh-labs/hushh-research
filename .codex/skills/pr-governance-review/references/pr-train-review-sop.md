# PR Train Review SOP

Use this SOP when a reviewer handles more than one PR, chooses the next batch,
revisits `changes_requested`, or scales throughput without weakening quality.

## Async Train Default

This SOP is the canonical behavior source for multi-PR governance.
Canonical order for every backlog, batch, repass, decision-wave, or scale pass:

1. Reuse a complete live report under `12` hours old when scope matches and no merge/close wave has changed it; otherwise refresh or verify completeness.
2. Confirm every requested author or surface scope before scanning. If the operator gives rough handles, resolve exact GitHub logins first and do not substitute similarly named users silently.
3. Apply the Actionable Intake Filter before deep review: include unattended PRs, PRs with contributor activity after the latest maintainer `changes_requested` record, and PRs whose head SHA/check/mergeability changed; move unchanged PRs with current standardized maintainer records into `Dormant Current Holds`.
4. Move failing, missing, stale, or auxiliary-failing checks into `Check Failure Holds` unless this is CI repair.
5. Build the train graph from hard edges: exact files, lockfiles, generated contracts, schema/migrations, concrete shared route/runtime surfaces, dirty-file overlap, stacked/conflicting state, and queue/main dependencies. Treat broad sensitive-runtime labels as risk signals unless they share a concrete file, route, schema, generated contract, or explicit dependency edge.
6. Identify all async trains from that graph, oldest PRs first, not only the next visible batch.
7. Start one read-only evidence lane per independent train family; the writer-lane exception does not make evidence lanes writable.
8. Ask one Pre-Wave Operator Question before any comment, close, patch, queue, merge, or deploy checkpoint unless the operator has already given explicit standing approval for this scoped async-train run.
9. After a wave completes, treat PRs with current standardized maintainer records as handled until their head SHA, CI state, mergeability, or contributor response changes.
10. Run independent trains in parallel through a five-worker train pool; sequence hard-edge PRs oldest-first inside a train and refill a freed worker with the next oldest non-touching train.
11. Treat PR Validation, Queue Validation, and Main Post-Merge Smoke as monitor lanes; while they run, prepare the next independent train or decision wave.
12. Ingest every returned lane into queue, patch, comment/close, hold, dormant hold, or next-refill writes; do not call the set complete until every scoped PR is linked as acted, terminal, blocked, dormant-current, or remaining.

If this order conflicts with another PR-governance reference, this section wins.

## Surface-Scoped Async Train Guard

Async trains are parallelism inside the operator-approved surface scope, not permission to act on unrelated green PRs. Build trains only from PRs touching the named scope or hard dependencies; put unrelated green-clean PRs in `out_of_scope_candidates` until a separate checkpoint approves writes. For Location, PKM, vault, consent, KYC, voice, finance, deploy, or branch governance, default to one surface train plus direct hard-edge dependencies.

## Live Report Reuse

1. Reuse `tmp/pr-governance-live-report.md` when it is complete, under `12` hours old, and the operator asks to continue from it.
2. Do not regenerate only to rebuild train chains, decision waves, or blocked buckets already present in a fresh complete report.
3. Refresh when a merge/close/comment wave changed the scope, the report is partial, or a selected PR's head/check/mergeability changed.
4. State whether the train set came from a reused report or a refreshed report.

## Author Scope Confirmation

1. Treat user-supplied contributor handles as untrusted until resolved through GitHub.
2. Confirm exact login, display name, profile URL, and open PR count before building trains.
3. If a handle is misspelled or ambiguous, report the corrected login and exclude the unconfirmed handle from writes.
4. If a mistaken author was scanned, mark that scan as superseded; do not carry those PRs into later waves unless the operator explicitly approves the corrected scope.
5. A GitHub write wave is valid only for PRs in the latest confirmed scope.

## Actionable Intake Filter

The default review set is actionable PRs, not every open PR. This saves reviewer bandwidth and prevents repeated comments on PRs already waiting on contributors.

Include a PR in executable async trains when at least one is true:

1. It is unattended: no current standardized maintainer review/comment exists for the current head.
2. It is a repass: a contributor commit or non-maintainer comment is newer than the latest maintainer `changes_requested` record.
3. It changed materially since the last maintainer record: head SHA, CI Status Gate, mergeability, base branch, conflict state, or touched files changed.
4. It is an operator-selected exception such as a CI repair, security incident, release blocker, or maintainer harvest candidate.

For large queues, the first intake pass must use low-cardinality PR metadata
only: number, title, author, draft state, created/updated time, head SHA, base,
URL, review decision, and latest reviews. Do not request comments or commits
for every open PR in a global scan; that hits GitHub GraphQL traversal limits.
Use `updatedAt` as a conservative coarse repass signal, then inspect comments,
commits, files, checks, and maintainer records during the bounded per-PR
evidence lane.

Move a PR to `Dormant Current Holds` without deep re-review when all are true:

1. The latest maintainer record is standardized and still applies to the current head.
2. No contributor commit or non-maintainer comment is newer than that record.
3. Required checks and mergeability have not improved enough to change the prior decision.
4. The operator did not explicitly ask to repass that PR.

`Dormant Current Holds` must still be listed with direct links and the latest maintainer record status, but they do not consume evidence-lane capacity or decision-wave slots.

## Preflight

Fetch main, inspect worktree, confirm no dirty local file overlaps a PR under review, and use only a fresh scoped live report. High-volume (`>20` PRs scanned, `>5` acted on, mixed trains, repasses, or throughput maximization) requires the delegation router and read-only lanes.

Record the starting developer branch before any worktree, PR checkout, detached HEAD, or temporary review branch operation. If the parent session switches away, the train is not complete until it returns to that branch or reports the exact blocker. Fetch `origin/main` before any state-changing wave or branch switch so decisions are based on current main refs.

## Branch And Worktree Hygiene

1. The operator-approved development branch is the only durable landing branch unless the operator explicitly names another branch.
2. Temporary PR-train, fix, harvest, detached, or smoke branches are temporary by default.
3. Temporary branches must be deleted after their value is merged, harvested, superseded, or abandoned.
4. Temporary worktrees must be removed when the train completes; prunable worktree metadata must be cleaned before the next train wave.
5. Never leave final governance changes only on a temporary branch. Move or replay accepted changes onto the operator-approved development branch before final handoff.
6. Do not switch branches with dirty user work unless that work is first preserved with an explicit stash, commit, or operator-approved worktree handoff.
7. Attempt temporary branch and worktree cleanup before final handoff. If cleanup fails, report the exact branch or worktree, current ref, why it remains, and the next cleanup command.
8. A final handoff after branch operations must state the current branch, whether `origin/main` was fetched, what temporary branches/worktrees remain, and where the accepted changes live.
9. Before final handoff, run a read-only worktree inventory:
   `git worktree list --porcelain`, `git worktree prune --dry-run`, and
   `git -C <worktree> status --short --branch` for non-primary worktrees.
10. If a temporary-looking worktree or branch has local commits ahead of its
    upstream, mark it `preserve_required` and do not delete it until the accepted
    value is moved, merged, or explicitly abandoned.

## Subagent Taskforce And Worker Pool

For approved async PR trains, spawn real read-only subagents when the tool is
available. Do not silently downgrade a multi-train pass into parent-session
sequential review. If subagent spawning is unavailable, say so in the operator
dossier, mark each lane `emulated` or `unavailable`, and still preserve the
five-lane map, train order, refill queue, and parent-only write authority.

1. `frontend/UI reachability`
2. `backend/runtime trust`
3. `observability/security`
4. `devex/repo operations`
5. `decision-wave communications`

Add a sixth lane only for a real independent surface such as mobile/native or founder/north-star direction. Every train maps to one evidence lane by default; the parent keeps branches, commits, code patches, secrets, deploys, report refreshes, and final synthesis.

Default active pool size is `5`; when one lane finishes or blocks, immediately assign the next oldest non-touching train. If there are `20` trains, workers start trains `1-5`, then refill with `6`, `7`, `8`, `9`, and so on as each worker returns. Never idle a worker while an actionable non-touching train remains and no pre-wave decision is needed for that worker. Each lane returns direct PR links, head SHA, files, hard collisions, attach point or `no_attach_point`, accepted value, dropped/deferred pieces, proof, train placement, comment posture, risks, and stop conditions.

If the subagent tool reports a thread or agent limit while completed lanes are
still open, close completed agents immediately and retry the refill. A completed
subagent counts as evidence captured, not as an active worker slot.

The parent session must name which immediate task remains local before
delegating. Keep approvals, comments, code patches, branch switching, pushes,
queueing, merges, deploys, report refreshes, and final synthesis in the parent
session unless a later SOP explicitly grants a writer envelope.

## N-Train Parallel Model

Identify every train in the reviewed scope before any state change:

1. One independent hard-edge component becomes one train envelope, but do not
   serialize every PR in that envelope by transitive closure alone. Split large
   connected components into direct-edge mini-trains, identify bridge PRs that
   weld otherwise unrelated surfaces, and let disjoint mini-trains keep running
   in parallel while bridge PRs are held, split, patched, or harvested.
2. One train maps to one read-only evidence subagent lane.
3. Train `1..n` run in parallel when files, runtime families, generated contracts, lockfiles, schema, deploy, and dirty surfaces do not touch.
4. Inside a train, process PRs one after another in ascending PR creation time; fall back to PR number when creation time is unavailable.
5. The subagent owns train evidence only. All GitHub writes, approvals, queue actions, merges, branch operations, code patches, pushes, deploys, report refreshes, and final synthesis stay in the parent session.
6. A train can contain `20+` PRs when homogeneous and same-surface; high-risk writes still use dynamic wave caps.
7. The train queue is continuous: active worker slots refill from the next oldest actionable non-touching train until no actionable train remains.
8. Handoffs list every train, PR links, sequence, lane, action, patch/harvest possibility, attribution, dormant-current holds, and stop condition.

## Stacked PR Dependency Standard

Large OSS-style contribution queues often contain stacked work. Treat this as a sequencing input, not as automatic drift.

1. Review every PR against current `main`, then check whether it has a proven predecessor in the open PR set.
2. Proven stack evidence includes explicit dependency language in the PR title/body, branch ancestry, imports/callers that point to files introduced by another open PR, or tests that only make sense after a named predecessor lands.
3. Hints such as same author, similar title, nearby creation time, or same broad theme are not enough by themselves.
4. If a follow-up PR depends on a predecessor, put both in one sequential train, set `must_wait_for`, and process the initializer first.
5. Do not mark the follow-up as an unattached helper solely because the caller is in its predecessor PR.
6. If the predecessor is outside the reviewed scope, stale, failing CI, conflicting, or unmerged, hold the dependent PR with `needs_predecessor_repass` rather than approving it.
7. If no predecessor can be proven, apply the normal current-main reachability gate.

## Write, Queue, And Reporting Detail

Use these focused references after this SOP builds the train set:

1. `pr-train-write-contract.md` for operator approval, scan modes, waves, patch
   gates, attribution, and contributor feedback.
2. `pr-train-queue-and-loop.md` for operating loop, cancellation handling, stop
   conditions, and exact-head queue safety.

Compact markers retained here because this SOP is the linter entrypoint:
`Dynamic Decision Wave Sizing`, `Merge Train Capacity Model`, `app/backend reachability`, `title/body claims one contract but the changed files touch another`, `local worktree overlap`, and `Green CI never overrides exact file overlap`.

Before requesting changes, explicitly evaluate whether the useful contribution
can be harvested or patched into a current canonical surface.
