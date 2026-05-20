# PR Train Review SOP

Use this SOP when a reviewer handles more than one PR, chooses the next batch,
revisits `changes_requested`, or scales throughput without weakening quality.

## Async Train Default

This SOP is the canonical behavior source for multi-PR governance.
Canonical order for every backlog, batch, repass, decision-wave, or scale pass:

1. Reuse a complete live report under `12` hours old when scope matches and no merge/close wave has changed it; otherwise refresh or verify completeness.
2. Move failing, missing, stale, or auxiliary-failing checks into `Check Failure Holds` unless this is CI repair.
3. Build the train graph from hard edges: files, lockfiles, generated contracts, schema/migrations, sensitive runtimes, dirty-file overlap, stacked/conflicting state, and queue/main dependencies.
4. Identify all async trains from that graph, oldest PRs first, not only the next visible batch.
5. Start one read-only evidence lane per independent train family; the writer-lane exception does not make evidence lanes writable.
6. Ask one Pre-Wave Operator Question before any comment, close, patch, queue, merge, or deploy checkpoint.
7. After a wave completes, treat PRs with current standardized maintainer records as handled until their head SHA, CI state, mergeability, or contributor response changes.
8. Run independent trains in parallel through a five-worker train pool; sequence hard-edge PRs oldest-first inside a train and refill a freed worker with the next oldest non-touching train.
9. Treat PR Validation, Queue Validation, and Main Post-Merge Smoke as monitor lanes; while they run, prepare the next independent train or decision wave.
10. Ingest every returned lane into queue, patch, comment/close, hold, or next-refill writes; do not call the set complete until every reviewed PR is linked as acted, terminal, blocked, or remaining.

If this order conflicts with another PR-governance reference, this section wins.

## Live Report Reuse

1. Reuse `tmp/pr-governance-live-report.md` when it is complete, under `12` hours old, and the operator asks to continue from it.
2. Do not regenerate only to rebuild train chains, decision waves, or blocked buckets already present in a fresh complete report.
3. Refresh when a merge/close/comment wave changed the scope, the report is partial, or a selected PR's head/check/mergeability changed.
4. State whether the train set came from a reused report or a refreshed report.

## Preflight

Fetch main, inspect worktree, confirm no dirty local file overlaps a PR under review, and use only a fresh scoped live report. High-volume (`>20` PRs scanned, `>5` acted on, mixed trains, repasses, or throughput maximization) requires the delegation router and read-only lanes.

Record the starting developer branch before any worktree, PR checkout, detached HEAD, or temporary review branch operation. If the parent session switches away, the train is not complete until it returns to that branch or reports the exact blocker.

## Subagent Taskforce And Worker Pool

1. `frontend/UI reachability`
2. `backend/runtime trust`
3. `observability/security`
4. `devex/repo operations`
5. `decision-wave communications`

Add a sixth lane only for a real independent surface such as mobile/native or founder/north-star direction. Every train maps to one evidence lane by default; the parent keeps branches, commits, code patches, secrets, deploys, report refreshes, and final synthesis.

Default active pool size is `5`; when one lane finishes or blocks, immediately assign the next oldest non-touching train. Each lane returns direct PR links, head SHA, files, hard collisions, attach point or `no_attach_point`, accepted value, dropped/deferred pieces, proof, train placement, comment posture, risks, and stop conditions.

## N-Train Parallel Model

Identify every train in the reviewed scope before any state change:

1. One independent hard-edge component becomes one train.
2. One train maps to one read-only evidence subagent lane.
3. Train `1..n` run in parallel when files, runtime families, generated contracts, lockfiles, schema, deploy, and dirty surfaces do not touch.
4. Inside a train, process PRs one after another in ascending PR creation time; fall back to PR number when creation time is unavailable.
5. The subagent owns train evidence and may use only the controlled writer envelope after approval; the parent owns patches, branches, deploys, merge policy, and final synthesis.
6. A train can contain `20+` PRs when homogeneous and same-surface; high-risk writes still use dynamic wave caps.
7. Handoffs list every train, PR links, sequence, lane, action, patch/harvest possibility, attribution, and stop condition.

## Stacked PR Dependency Standard

Large OSS-style contribution queues often contain stacked work. Treat this as a sequencing input, not as automatic drift.

1. Review every PR against current `main`, then check whether it has a proven predecessor in the open PR set.
2. Proven stack evidence includes explicit dependency language in the PR title/body, branch ancestry, imports/callers that point to files introduced by another open PR, or tests that only make sense after a named predecessor lands.
3. Hints such as same author, similar title, nearby creation time, or same broad theme are not enough by themselves.
4. If a follow-up PR depends on a predecessor, put both in one sequential train, set `must_wait_for`, and process the initializer first.
5. Do not mark the follow-up as an unattached helper solely because the caller is in its predecessor PR.
6. If the predecessor is outside the reviewed scope, stale, failing CI, conflicting, or unmerged, hold the dependent PR with `needs_predecessor_repass` rather than approving it.
7. If no predecessor can be proven, apply the normal current-main reachability gate.

## Controlled Writer-Lane Envelope

Allowed after operator approval: edit/post standardized maintainer reviews or comments, request changes, close superseded PRs, acknowledge harvest, and queue exact-head PRs when green, clean, non-draft, and edge-free. Not allowed: branch switching, commits, pushes, code patches, secrets, deploys, direct merge to `main`, product-policy changes, or merging unsafe contributor heads. Drift, stale heads, new conflicts, failing checks, or lost attach points return to the parent/governor.

## Wave Means Checkpoint

`Wave` means the next operator-approved state-changing checkpoint across already running trains, not "only work on this small batch."

1. `Train`: the full hard-edge PR sequence for one surface; one evidence lane, oldest-first internally.
2. `Parallel train set`: all non-touching trains running across lanes/subagents.
3. `Wave`: bounded GitHub writes, maintainer patches, queue actions, closes, or merges inside the approved train set.

Approval applies to the reviewed train set, not just the first train. Waves are state-changing checkpoints for safe GitHub writes while all lanes continue. While the operator answers, unrelated lanes keep scanning, proving attach points, drafting patch plans, and preparing the next checkpoint.

## Scan Modes

1. `active`: latest window only.
2. `hybrid`: default; all-open inventory plus latest `100` and up to `40` older high-signal candidates.
3. `full`: audit mode only; attempt every open PR with timeout.

If scanning fails, state inventoried/reviewed/failed PRs and whether the result is complete, partial, or fallback-only.

## Hundred-PR Active Pass Standard

For 400+ PR backlogs, the default pass is the oldest `100` reviewable PRs plus hybrid high-signal candidates. A queue cohort is progress, not completion.
Report open/reviewed counts, trains, terminal PRs by action, and non-terminal train/blocker/next action until all reviewed PRs are terminal or blocked.

## Check Failure Intake Filter

Exclude PRs from executable trains when `CI Status Gate` is missing, pending, skipped, cancelled, failing, unknown, or green while a current auxiliary check fails. Show them only in `Check Failure Holds` unless this is CI repair.

## Post-Changes Repass Train

Contributor commits or non-maintainer comments newer than the latest maintainer `changes_requested` record create a repass train. Re-enter only PRs with a current green `CI Status Gate`; failing/missing gates stay in holds. Build trains from current files/surfaces, re-review the current head SHA, and output `approve_or_queue`, `maintainer_patch_or_harvest`, `updated_changes_requested`, or `still_blocked_with_reason`.

## Train Graph

1. exact file overlap
2. lockfile overlap
3. schema, migration, or generated-contract overlap
4. same sensitive runtime family
5. same public route, backend route, auth, consent, vault, PKM, voice, finance, KYC, deploy, or CI authority surface
6. local dirty-file overlap
7. stacked, conflicting, or stale branch state

Soft edges such as same author, broad theme, similar title, or nearby UI area do not block parallelism by themselves.

## Lanes

This is the Merge Train Capacity Model.

1. `Queue Cohort`: independent `merge_now` PRs, default `4`; larger only when homogeneous, low-risk, and exact-head verified.
2. `Sequential Collision Train`: hard-edge PRs, one at a time.
3. `Parallel Patch Train`: disjoint maintainer patches with proven attach
   points, max `3` by default.
4. `Decision Wave`: changes-requested or closure comments while queue
   validation runs.
5. `Hold/Rebase`: conflicts, stale branches, unclear intent, or missing proof.
6. `Check Failure Hold`: non-green required gate or failing auxiliary check.

## Pre-Wave Operator Question

Before every state-changing checkpoint, ask one researched operator question:

1. `Current truth`: scan freshness, reviewed/open counts, wave type, PR links, and excluded check-failure holds.
2. `Recommended path`: train set, checkpoint size, comment/edit posture, and expected artifact.
3. `Risk if accepted blindly`: stale heads, changed CI, unsafe edits, noisy comments, or unfair attribution.
4. `Decision needed`: approve the checkpoint, reduce/split it, or refresh first.

Do not ask the operator to find facts Codex can verify.

## Dynamic Decision Wave Sizing

1. `5` PRs for high-risk mixed runtime, security, consent, vault, PKM, voice,
   finance, or policy waves.
2. `10` PRs for mixed-topic acknowledgement/comment waves.
3. `20` PRs for normal homogeneous acknowledgement or changes-requested waves.
4. `40` PRs only for low-risk, same-template, same-surface acknowledgement
   waves with clean current evidence.
5. `0` PRs when the live report is stale, the selected wave scan is incomplete,
   or existing maintainer records cannot be edited safely.

## Maintainer Patch Gate

Prefer maintainer patch over contributor round trip when direction is aligned
and the patch is bounded. Patch is allowed only with accepted value, canonical
attach point, exact write set, dropped/deferred pieces, and smallest proof.
Before requesting changes, explicitly evaluate whether the useful contribution
can be harvested or patched into a current canonical surface. Do not ask for
changes when a maintainer can safely resolve the gap without inventing product
intent.
Standalone code used only by its own tests defaults to changes requested unless
a reachable app/backend/package route, generated contract, test contract, or
documented devex entrypoint is named. Treat app/backend reachability as a
merge-readiness input.

If a PR title/body claims one contract but the changed files touch another,
stop the merge path until it is retitled, rescoped, patched to the claim, or
requested-changes.

## Attribution Gate

Prefer direct contributor PR merge when safe. For maintainer harvests, add
`Co-authored-by:` only when code or tests are materially reused in the landing
commit. Ideas/direction get public acknowledgement and internal dashboard
credit, not official GitHub commit credit. When a maintainer patch materially
uses a contributor's code direction, tests, or implementation shape, the landing
commit must include the contributor as a co-author whenever GitHub identity is
available. Never rewrite `main` for retroactive co-author credit.

## Operating Loop

1. Refresh the live report with oldest-first selection unless explicitly asked for latest.
2. Build the complete async train map and train-to-subagent map.
3. Ignore `Check Failure Holds` unless this is CI repair.
4. Read every queue cohort, collision group, patch train, and decision wave.
5. Assign each independent train to its evidence lane and prepare trains in parallel.
6. Convert each returned lane into executable writes by value, age, and collision risk.
7. Produce the operator dossier from `operator-batch-output-contract.md`; one approval starts the full reviewed train set, not a single train.
8. Execute approved GitHub writes by editing existing maintainer records first.
9. Exclude PRs just handled by a current standardized maintainer record until fresh contributor or GitHub state changes.
10. Run a post-changes repass train for green PRs with contributor activity
    after a maintainer changes-requested record.
11. For merges, enqueue exact head SHA and monitor queue and smoke.
12. Refresh live report and contributor-impact dashboard.
13. Return the parent worktree to the recorded developer branch after temporary PR checkout, worktree, detached HEAD, or queue-monitoring branch changes.
14. Report active-pass progress in chat: `reviewed`, `acted`, `terminal`, `blocked`, `remaining`, `merged`, `patched`, `commented`, and direct links.
15. Start the next independent train while unrelated checks run; continue until every train in the approved set is terminal or blocked with links/reasons.

## Queue Cancellation Handling

Main-smoke cancellation from a newer main push is `superseded`; only the latest
non-cancelled current-main smoke is authoritative. Runner/tool setup failures
are `infra_transient`; rerun once after substantive jobs pass, then route to
`repo-operations`. Test, type, secret, freshness, or mergeability failures stop
the PR until corrected.

## Stop Conditions

Stop, split, or rescan on head SHA changes, CI loss, dirty mergeability, new hard edge, local worktree overlap, missing UI browser proof, unclear trust boundary, incomplete scan, or lost patch attach point.
Green CI never overrides exact file overlap.
