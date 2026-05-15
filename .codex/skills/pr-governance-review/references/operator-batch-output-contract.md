# Operator Batch Output Contract

Use this when answering "next batch", "plan this batch", or any high-volume PR
wave question. `pr-train-review-sop.md` defines behavior; this contract defines
the operator-facing dossier.

## Required Chat Shape

Train recommendations must be deterministic and reviewable without opening the
live report. Use these sections:

1. `Batch`: one sentence naming the product/runtime purpose.
2. `Research Basis`: concise current truth, recommended path, and risk if accepted blindly.
3. `Delegation Evidence`: router decision, taskforce lanes, async train-to-subagent map, skipped/unavailable rationale, and parent-only authority.
4. `Scan Scope`: mode, active limit, candidate limit, open inventory count, reviewed PRs, failed PRs, and completeness.
5. `Hundred-PR Active Pass`: latest-100 reviewed count, terminal count,
   active trains, remaining non-terminal PRs, and whether the pass is complete.
6. `Check Failure Holds`: PRs excluded because current required/auxiliary checks are not clean.
7. `Input`: every PR with a direct Markdown link and current lane.
8. `Train Simulation`: branch evidence, delta summary, behavior claim, canonical fit, simulated patch, action outcome, comment simulation, and verification timeline.
9. `Output`: concise landing decision, async train placement, and next operator-visible artifact.
10. `Expected Actions`: each PR mapped to `review_only`, `hold`, `request_changes`, `close`, `maintainer_harvest`, `maintainer_patch_then_merge`, `merge_now`, or `post_merge_monitor`.
11. `Comment Plan`: each PR mapped to `none_before_merge_then_post_merge_closeout`, `edit_existing_maintainer_comment`, `new_changes_requested_comment`, `new_closed_superseded_comment`, or `no_comment_review_only`.
12. `Contributor Attribution`: co-author trailer, public acknowledgement, internal impact credit, or no credit for each harvest source.
13. `Per-PR Assessment`: direct link, lane, risk, head SHA prefix, changed surface, batch reason, Blind-merge risk, planned action, comment action, and Smallest proof.
14. `Execution`: queue cohort, collision sequence, patch train, decision wave, and hold split.
15. `All Async Trains`: every train in the reviewed scope with exact PR links,
    assigned evidence lane/subagent, non-touching parallel trains, hard-edge
    sequence, and oldest-first execution order.
16. `Question Before Wave`: required before any comment, close, patch, queue,
    or merge checkpoint; include current truth, the complete train set already
    running, recommended path, risk if accepted blindly, decision needed,
    recommended option first, and exact PR links.
17. `Recommended Wave Size`: the dynamic size selected for this wave.
18. `Why This Size`: concise reason based on risk, topic mix, scan freshness, check status, and edit safety.
19. `Exact PR Links`: direct Markdown links for every PR in the selected wave.
20. `Comment/Edit Policy`: edit existing maintainer records when possible; otherwise name the exact new record type.
21. `Decision Questions`: only unresolved choices; include current truth, recommended path, risk if accepted blindly, decision needed, and recommended option first.
22. `Stop Conditions`
23. `Verification`
24. `After-Merge Kickoff`: how Automatic next train discovery happens after report refresh.
25. `After-Wave Handoff`: after any state-changing wave, return the affected
    PR links, maintainer record links, action explanation, refreshed artifacts,
    and recommended next async train in chat.

Each dossier also includes `Reasoned Review Steps`: the ordered checks Codex
performed and how each check affected the decision.

## Hyperlink Rule

Every chat answer, execution update, and final handoff generated from this
contract must hyperlink every PR it mentions. Counts-only summaries are
invalid. Bare `#123` references are allowed only in copied command output or
code blocks.

## Deterministic Rules

1. Use `Recommended Operator Batches` before `Contract Intake Sets`.
2. Exclude PRs with non-green/missing required gates or current failing
   auxiliary checks before building batches.
3. Ask a Pre-Wave Operator Question before every state-changing checkpoint;
   skip only read-only report refreshes.
4. A stale or incomplete scan, unsafe edit target, or unverified existing
   maintainer record makes the recommended wave size `0`.
5. Dynamic acknowledgement sizing is `5` for high-risk mixed runtime/security
   waves, `10` for mixed-topic waves, `20` for normal homogeneous waves, and
   `40` only for low-risk same-template same-surface waves with clean evidence.
6. Exact file overlap creates sequencing, not duplicate closure.
7. Same broad contract label or same author is not enough to batch.
8. Do not mix independent high-risk runtime decisions just to increase
   throughput.
9. A merge train can proceed while the next independent batch is reviewed, but
   dependent trains must not merge concurrently.
10. "Automatic next train" means automatic next-train discovery and preparation;
   approval, merge, deploy, and close remain explicit operator actions.
11. Every PR must expose `collision_group_id`, `collision_reasons`,
   `can_queue_with`, `must_wait_for`, `queue_cohort_id`,
   `parallel_patch_train_id`, patch attachment fields, and whether a north-star
   probe is required.
12. Train-to-subagent map: every async train names its evidence lane, included
   PRs, parallel outside trains, sequential inside train, and hard edge.
13. Decision waves must list the exact linked PRs and exact public
   comment/review link after execution; never summarize as only `N reviews
   posted`.
14. Repass/correction waves must normalize editable maintainer records to the
    lane-specific comment template before marking the wave complete.
15. Always identify all trains in the reviewed scope before selecting a wave.
    Independent trains run in parallel through separate evidence lanes; PRs
    inside one train execute oldest-first.
16. Maintainer patch or harvest is evaluated before requested changes. If code,
    tests, or implementation shape are materially reused, the landing commit
    must use valid `Co-authored-by:` trailers when GitHub identity is known.
17. A wave is only a bounded state-change checkpoint. It must not shrink the
    active train set or stop unrelated subagents from preparing complete
    non-touching trains in parallel.
18. On a 400+ PR backlog, default chat handoff must answer in active-pass
    terms: `reviewed 100 PRs`, train count, terminal count, links for every
    state-changed PR, and the next unresolved train. A small merge cohort is
    progress, not the whole pass.

## Research And Review Standard

Every dossier includes:

1. current repo/GitHub truth before recommendation
2. north-star audit when PRs touch One, Kai, Nav, PCHP, consent, vault, PKM,
   voice/action, finance, KYC, signatures, or new product roots
3. solution flow: what lands unchanged, what is patched, what is held, and what
   becomes changes-requested or closure
4. landing mechanics: merge order, direct vs maintainer-patched, checks before
   and after merge, and report/dashboard refresh
5. public communication posture for every PR
6. contributor attribution with no GitHub graph-credit promise unless the
   landing commit contains valid `Co-authored-by:` trailers
7. stop conditions: stale head, lost CI gate, conflict, file overlap, trust
   boundary, missing reachability, Playwright gap, or north-star drift

## Good Output Standard

The operator should understand what the batch is, why each PR is present, what
changed, how each PR will be tackled, what will be tested, what would stop
Codex, how reports refresh, which next train can start while checks run, and
what GitHub write will exist after action.

Do not say "patch then merge" without naming the expected patch and post-merge
comment headline. Do not claim UI behavior is verified unless exact branch/diff
and relevant unit/browser evidence were inspected. Use
`needs_playwright_verification` when planning is static-only.

## Frontend Evidence

For UI-visible PRs, include one of:

1. `Playwright-ready`: exact route and command to run.
2. `Playwright-run`: route/spec and result.
3. `needs_playwright_verification`: no merge until browser evidence is collected.

## Comment Simulation

Before GitHub writes, inspect existing maintainer-authored comments and reviews.
State whether Codex edits an existing maintainer record or posts a new one, and
which heading from `comment-and-report-contract.md` applies. Repass/correction
waves must prefer edited maintainer records over new comments.

Founder Wiki North-Star Probe evidence stays private; private wiki evidence stays local-only and public comments use repo-current truth.
