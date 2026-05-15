# Operator Batch Output Contract

Use this when answering "next batch", "plan this batch", or any high-volume PR wave question.
Use `pr-train-review-sop.md` as the standard operating procedure before
producing this dossier. The SOP defines how to scan, graph, classify, execute,
monitor, and refresh PR trains; this contract defines how to present the result.

## Required Chat Shape

Train recommendations must be presented as a deterministic operator dossier, not
as an executive summary. Do not collapse the answer into a short list after
doing the scan. If the user asks for PR trains, the chat answer itself must
show the research, solution flow, actions, comment posture, proof, and landing
sequence in the sections below.

1. `Batch`: one sentence naming the product/runtime purpose.
2. `Research Basis`: concise current truth, recommended path, and risk if accepted blindly.
3. `Delegation Evidence`: router decision, subagent/taskforce lanes used,
   async train-to-subagent map, direct lane handoff summaries,
   skipped/unavailable rationale, and explicit parent-only authority for branch
   switching, commits, GitHub writes, approvals, merges, deploys, and final
   decisions.
4. `Check Failure Holds`: every reviewed PR excluded because the required gate
   is not green, the required gate is missing, or a current auxiliary check is
   failing. These PRs are not train candidates unless the user explicitly asks
   for CI repair.
5. `Input`: every PR with a direct Markdown link and current lane.
6. `Train Simulation`: execution-grade simulation based on the current PR heads:
   - branch evidence: current head SHA, mergeability, CI gate, changed files, exact overlaps, and local dirty-worktree overlap
   - delta summary: files added, edited, deleted, generated, moved, dependencies changed, and routes/contracts touched
   - behavior claim: what the PR claims and whether that behavior is reachable in the current app/backend/package
   - canonical fit: existing surface the change should extend, or `standalone` when no reachable use exists
   - simulated maintainer patch: what Codex expects to keep, normalize, drop, defer, or request from the contributor
   - action outcome: exact operation per PR if approved
   - comment simulation: expected GitHub comment/edit posture and heading
   - verification timeline: local checks, Playwright for UI-visible changes, GitHub gates, smoke, reports
7. `Expected Actions`: table or bullets mapping each PR to one of:
   - `review_only`
   - `hold`
   - `request_changes`
   - `close`
   - `maintainer_harvest`
   - `maintainer_patch_then_merge`
   - `merge_now`
   - `post_merge_monitor`
8. `Comment Plan`: table or bullets mapping each PR to one of:
   - `none_before_merge_then_post_merge_closeout`
   - `edit_existing_maintainer_comment`
   - `new_changes_requested_comment`
   - `new_closed_superseded_comment`
   - `no_comment_review_only`
   Include the intended headline, for example `## Merged: Consent Center State UX`.
9. `Contributor Attribution`: for every maintainer-harvest source PR, state
   whether the landing commit will use `Co-authored-by:` trailers
   (`code_or_test_reused`), public acknowledgement only
   (`idea_or_direction_used`), or no credit because the material is not used.
   Include source PR link, author, accepted value, dropped/deferred pieces, and
   whether GitHub official contributor graph credit is expected.
10. `Per-PR Assessment`: one compact but complete block per PR:
   - direct link
   - lane
   - lean/core risk
   - current head SHA prefix
   - what changed or which surface is touched
   - why it is in the batch
   - `Blind-merge risk`: likely failure mode if accepted blindly
   - planned action: merge, patch/rebase, harvest/close, request changes, or hold
   - comment action: expected public comment/edit behavior
   - `Smallest proof`: smallest authoritative check before that action
11. `Output`: intended end state if the batch is legitimate.
12. `Execution`: exact order, split by merge train, patch train, closure/request-changes wave, and hold/deep-review items.
13. `Decision Questions`: only unresolved user-owned choices, each with current truth, recommended path, risk if accepted blindly, and recommended option first.
14. `Stop Conditions`: what pauses, splits, or blocks the batch.
15. `Verification`: smallest authoritative local and GitHub checks.
16. `After-Merge Kickoff`: how the next independent train will be discovered after report refresh.

Hyperlink rule: any chat answer, execution update, or final handoff generated
from this contract must hyperlink every PR it mentions. Counts-only summaries
are invalid. For large waves, use compact grouped rows such as
`request_changes: [#1](...), [#2](...)`. Bare `#123` references are allowed only
inside copied command output or code blocks.

For live-report-driven train planning, the answer must also include these
deterministic sections, even if some are empty:

1. `Scan Scope`: scan mode, active limit, candidate limit, all-open inventory
   count when known, reviewed PRs, failed PRs, and completeness.
2. `Subagent Taskforce`: evidence lanes started before train selection,
   including lane owner, inspected surfaces, PR links, current head SHA
   freshness, hard collisions, canonical attach points, unresolved risks, and
   whether subagents were used, unavailable, or blocked. For high-volume train
   work, this section is mandatory and cannot be replaced by a parent-only
   summary unless the runtime cannot spawn subagents. The dossier must map each
   async train to exactly one read-only subagent lane unless that train is a
   low-volume single-surface exception or the runtime cannot spawn subagents.
3. `Check Failure Holds`: PRs removed from train consideration because current
   required or auxiliary checks are not clean.
4. `Queue Cohort`: independent `merge_now` PRs that can be queued together,
   capped at the configured cohort size.
5. `Collision Groups`: hard-edge groups and the required sequence.
6. `Parallel Patch Trains`: disjoint maintainer patch trains with attachment
   point, patch files, dropped/deferred pieces, and proof.
7. `Decision Waves`: PRs ready for changes-requested or closure records while
   queue validation runs.

Decision waves must list the exact linked PRs in the wave and the exact public
comment/review link after execution. Do not summarize a completed wave as only
`N reviews posted`.

## Deterministic Dossier Rules

Every PR train recommendation must include these details in the chat response,
even when the report already exists on disk:

1. Scan scope: exact report or command used, open PR count if known, limit/cap
   caveat, and whether any scanner timeout or GitHub API failure affected
   completeness.
2. North-star audit: repo-current truth first, then founder/north-star
   alignment classification when the PR touches One, Kai, Nav, PCHP, consent,
   vault, PKM, voice/action, finance, KYC, signatures, or a new product root.
   Private wiki evidence remains local-only and must not be cited in public PR
   comments.
3. Solution flow: why this train is the next executable train, what can land
   unchanged, what must be patched, what is held, and what is converted into a
   changes-requested or closure wave.
4. Landing mechanics: exact merge order, whether branches are merged directly
   or maintainer-patched, which checks run before and after merge, and when the
   live report plus contributor-impact dashboard are refreshed.
5. Public communication: for every PR, state whether there is no pre-merge
   comment, a post-merge closeout, a changes-requested comment, a closed
   superseded comment, or an edited maintainer record.
   Repass/correction waves must prefer edited maintainer records over new
   comments. If a new comment is needed, state why the previous maintainer
   record could not be edited.
6. Contributor attribution: maintainer-harvest batches must distinguish
   official GitHub commit credit from public acknowledgement and internal
   dashboard credit. Do not promise GitHub contributor graph credit unless the
   actual landing commit contains valid `Co-authored-by:` trailers.
7. Check-failure intake filter: PRs with non-green/missing required gates or
   current failing auxiliary checks are excluded from train planning and should
   appear only under `Check Failure Holds` unless this is a CI repair pass.
8. Stop conditions: stale head, lost CI Status Gate, conflict, exact-file
   overlap, new trust-boundary finding, missing caller/reachability proof,
   Playwright gap for UI-visible changes, or north-star drift.
9. Train graph: every PR must expose `collision_group_id`,
   `collision_reasons`, `can_queue_with`, `must_wait_for`,
   `queue_cohort_id`, `parallel_patch_train_id`, patch attachment fields, and
   whether a north-star probe is required.
10. Subagent taskforce: for high-volume train work, every dossier must state the
   read-only evidence lanes used before the recommendation. The default lanes
   are frontend/UI reachability, backend/runtime trust, observability/security,
   devex/repo operations, and decision-wave communications. If a lane was not
   spawned, state the concrete blocker; "not needed" is valid only for
   single-surface or low-volume work.
11. Train-to-subagent map: every async train must name its subagent evidence
   lane, the PRs included in that train, which PRs are parallel outside the
   train, which PRs are sequential inside the train, and which hard edge forces
   the sequence. If two trains need the same files/runtime family, they are not
   independent trains.

If the evidence is incomplete, say exactly what is incomplete and present only
the train subset that is safe from the verified evidence. Do not imply the whole
open PR queue was audited when a scanner limit or timeout prevented that.
Do not omit PR hyperlinks in the final synthesis just because the detailed
report exists on disk; the chat handoff must remain reviewable on its own.

## Batch Selection Rules

1. Use `Recommended Operator Batches` before `Contract Intake Sets`.
2. Exclude PRs with non-green/missing required gates or current failing
   auxiliary checks before building batches. Do not let them shape collision
   groups or recommended operator batches unless the task is CI repair.
3. Exact file overlap creates sequencing, not duplicate closure.
4. Same broad contract label is not enough to batch.
5. Same author is a convenience only after product/runtime contract grouping.
6. Batch can mean merge train, patch train, close wave, request-changes wave, or deep-review wave.
7. Do not mix independent high-risk runtime decisions just to increase throughput.
8. A merge train can proceed while the next independent batch is reviewed, but two dependent trains must not merge concurrently.
9. "Automatic next train" means automatic next-train discovery and review preparation; approval, merge, deploy, and close decisions remain explicit operator actions.

## Good Output Standard

The operator should understand:

1. what this batch is actually about
2. why each PR is present
3. what changed in each PR at the surface/contract level
4. how each PR will be tackled
5. what will be tested
6. what would make Codex stop
7. how the live report and contributor-impact dashboard will be updated
8. which next-train review can start while queue/smoke is running
9. exactly what Codex will do on GitHub for each PR
10. what public comment or edited maintainer record will exist after the action

Avoid generic phrasing such as "review these together" without per-PR roles.
Avoid one-line PR summaries that hide the actual review path.
Do not ask the operator to choose before showing the researched solution path.
Do not say "patch then merge" without naming the expected patch and the post-merge comment headline.
Do not claim UI behavior is verified unless Codex inspected the exact PR branch/diff and ran the relevant unit/Playwright evidence. Use `needs_playwright_verification` when the plan is based on code review but not browser proof.
Do not call a new helper/component/package "product value" unless it is wired into a reachable current route, runtime, package, generated contract, test contract, or documented devex entrypoint.

## Train Throughput Standard

Use this rhythm for scale:

1. Mass classify open PRs through the live report. Default to hybrid scan:
   cheap all-open inventory plus the latest `100` deep reviews and up to `40`
   older high-signal deep reviews.
2. Move current check failures into `Check Failure Holds`; do not spend
   train-planning or subagent time on them unless the operator asks for CI
   repair.
3. Build an async train map, then start one read-only subagent lane per
   independent train before final train selection. Use broad lanes, not one
   subagent per PR. If the train has same-file or same-runtime collisions, the
   subagent analyzes the full collision group and returns the required internal
   sequence.
4. Convert clear drifts into closure or changes-requested waves.
5. Queue independent `merge_now` PRs as a cohort, capped at `4`.
6. While PR Validation, Queue Validation, or Main Post-Merge Smoke runs, review the next independent operator batch.
7. After smoke passes, refresh the live report and contributor-impact dashboard.
8. Select the next independent `Recommended Operator Batches` item and produce a fresh `Per-PR Assessment`.

Never let throughput hide dependency order. Shared files, lockfiles, shared
runtime contracts, generated contracts, schema/migration surfaces,
auth/consent/vault/PKM/voice/finance, deploy paths, and local dirty-file
overlap require sequential handling. Same author, broad theme, or nearby title
does not create a hard edge by itself.

## Frontend Evidence Standard

For UI-visible PRs, include one of these in the train simulation:

1. `Playwright-ready`: list the exact route and command to run, such as `cd hushh-webapp && npx playwright test e2e/navigation.spec.ts --project=chromium`.
2. `Playwright-run`: include the route/spec actually run and the result.
3. `needs_playwright_verification`: planning used branch diff/static tests only; do not merge until browser evidence is collected.

Use existing Playwright config at `hushh-webapp/playwright.config.ts` and existing specs under `hushh-webapp/e2e/` before creating new proof.

## Comment Simulation Standard

Before GitHub writes, inspect existing maintainer-authored comments and reviews. The train plan must state:

1. Whether Codex expects to edit an existing maintainer comment or post a new one.
2. Which heading contract applies:
   - `## Merged: <contract or outcome>`
   - `## Changes Requested: <blocker>`
   - `## Closed: <reason>`
3. For maintainer patches, what the public closeout will explain:
   - useful original value kept
   - conversion into existing canonical surface
   - dropped/deferred pieces
   - why maintainer patch was lower friction
   - final accepted location
4. For holds/review-only, why no public comment is posted yet.

For a repass of a prior wave, update the existing maintainer-authored review or
comment whenever GitHub allows it. Do not stack a second `Changes Requested`
record just to correct wording, patchability, hyperlinks, or train placement.
