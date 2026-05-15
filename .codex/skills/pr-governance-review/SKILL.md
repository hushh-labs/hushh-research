---
name: pr-governance-review
description: Use when reviewing an incoming pull request for north-star alignment, trust-boundary regressions, malicious or low-signal degradation, stale-vs-current CI interpretation, and true merge readiness beyond a green gate.
---

# Hussh PR Governance Review Skill

## Purpose and Trigger

- Primary scope: `pr-governance-review-intake`
- Trigger on incoming pull request review, contributor PR triage, batch planning, approval, maintainer patching, close/request-changes waves, and merge-readiness assessment.
- Avoid overlap with `repo-context`, `repo-operations`, and `quality-contracts` when the task is broad repo discovery, CI infrastructure repair, deployment policy, or test-policy design rather than PR trust review.
- This is the root merge-readiness gate for Hussh PR work. Specialist skills can deepen evidence, but they must not replace this decision layer or downgrade a blocker found here.

## Coverage and Ownership

- Role: `owner`
- Owner family: `pr-governance-review`

Owned repo surfaces:

1. `.codex/skills/pr-governance-review`

Non-owned surfaces:

1. `repo-context`
2. `repo-operations`
3. `quality-contracts`
4. `backend-runtime-governance`
5. `frontend-architecture`
6. `security-audit`

## Do Use

1. Reviewing community or internal PRs where green CI is necessary but not sufficient.
2. Distinguishing stale failed checks from the current head SHA.
3. Detecting duplicate architecture, trust-boundary regressions, low-signal bloat, and false-positive tests.
4. Planning operator batches with per-PR roles, direct links, and executable solution paths.
5. Drafting concise maintainer comments for merge, patch, close, or changes-requested outcomes.

## Do Not Use

1. Do not use for broad repo orientation; use `repo-context`.
2. Do not use for CI infrastructure repair or deployment policy; use `repo-operations`.
3. Do not use for product implementation unless the user explicitly asks for a maintainer patch.
4. Do not use for generic style review without merge-governance implications.

## Read First

Always start with current repo/GitHub truth, not memory:

1. `README.md`
2. `docs/reference/operations/ci.md`
3. `docs/reference/quality/pr-impact-checklist.md`
4. `docs/reference/architecture/api-contracts.md`
5. `.codex/skills/repo-operations/SKILL.md`
6. `.codex/skills/quality-contracts/SKILL.md`
7. `.codex/skills/pr-governance-review/references/review-axes.md`
8. `.codex/skills/pr-governance-review/references/runtime-schematics-contract.md`

Load these only when the decision needs them:

1. `.codex/skills/pr-governance-review/references/operator-batch-output-contract.md`
2. `.codex/skills/pr-governance-review/references/operator-question-fixtures.json`
3. `.codex/skills/pr-governance-review/references/blocker-gates.md`
4. `.codex/skills/pr-governance-review/references/comment-and-report-contract.md`
5. `.codex/skills/pr-governance-review/references/pr-train-review-sop.md`
6. `.codex/skills/pr-governance-review/references/maintainer-harvest-attribution-ledger.md`

## Workflow

### Operating Kernel

1. Lock the current PR head SHA before judging anything.
2. Run the runtime schematic before relying on mental models:
   `python3 .codex/skills/pr-governance-review/scripts/build_runtime_schematics.py --text`
3. Run the checklist:
   - Single PR: `python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo <repo> --pr <number> --text`
   - Batch: `python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo <repo> --prs <n1,n2,...> --text`
   - Live report: `python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo hushh-labs/hushh-research --live-report --scan-mode hybrid --limit 100 --candidate-limit 40 --text --output tmp/pr-governance-live-report.md`
4. Classify the flow mode before any GitHub write:
   - `review_only`
   - `comment_only`
   - `approve_only`
   - `approve_then_merge`
   - `patch_then_merge`
5. Classify each PR into exactly one lane:
   - `merge_now`
   - `patch_then_merge`
   - `block`
   - `harvest_then_close`
   - `close_duplicate`
6. A non-green required `CI Status Gate`, missing required gate, or current
   failing auxiliary check is an intake stop, not a train candidate. Exclude
   that PR from queue cohorts, patch trains, collision trains, decision waves,
   and recommended operator batches unless the explicit task is to fix CI.
   Record it only in the check-failure hold register.
7. Green CI never overrides exact file overlap, duplicate product contracts, schema-contract drift, raw-error leakage findings, or current auxiliary check failures introduced by the PR.
8. The checklist fields `contract_set`, `duplicate_group`, `public_comment_policy`, `lane`, and `live_report_action` are decision records, not decoration.
9. Treat app/backend reachability as a merge-readiness input. A PR that adds standalone code, tests, helpers, components, or scripts must prove it is used by a canonical app/backend/package path, or it must be classified as test/devex hygiene rather than product/runtime value.
10. If a PR title/body claims one contract but the changed files touch another, stop the merge path until the PR is retitled/rescoped, patched to the claimed contract, or closed/requested-changes.
11. If a PR says it is stacked, depends on a prior PR, or will have a different diff after another PR lands, do not review it as a merge candidate until it is rebased to `main` or explicitly scoped as a harvest/reference PR.
12. Treat local worktree overlap as a merge blocker. If an open PR touches files with uncommitted maintainer changes, resolve local ownership first: commit/stash/rebase the maintainer branch, harvest only unique PR value, or request a contributor rebase. Do not merge a GitHub-green head over active local governance/product work.
13. Before creating a maintainer-harvest commit, run the contributor
    attribution gate. Prefer direct contributor PR merge when the head is safe.
    If maintainers materially reuse contributor code or tests, add valid
    `Co-authored-by:` trailers to the actual landing commit using public
    GitHub no-reply identities when verified. If only the idea or direction is
    used, do not add a co-author trailer; include a contributor
    acknowledgement in the PR body and source-PR closeout instead. For an
    already-merged maintainer harvest, a transparent follow-up PR with a real,
    non-empty co-authored harvest replay or supplemental harvest patch can add
    external GitHub co-author credit only for that follow-up commit; it must not
    claim to rewrite landing-commit authorship or original additions/deletions.
14. Run the Founder Wiki North-Star Probe for material PRs that touch product direction, One/Kai/Nav, PCHP, BYOA/BYOK, MLX/on-device posture, consent/vault/PKM, World Model, voice/action, Aha Moment, user-facing workflows, or founder-language claims. Use `.codex/skills/codex-skill-authoring/references/founder-wiki-north-star-probe.md` as the contract:
   - repo code/contracts/tests/CI remain current-state truth
   - founder wiki pages define north-star and future-state alignment
   - conflicts are `current_state_vs_north_star_drift`
   - private wiki evidence stays local-only and must not be cited in public GitHub comments
15. For high-volume PR train work, spawn/read from the required read-only
    subagent taskforce before producing the operator dossier. High-volume means
    more than `20` PRs scanned or discussed, more than `5` PRs acted on in one
    session, any mixed frontend/backend/security/devex/observability train, any
    repass of previous `changes_requested`/close/harvest decisions, or any
    request to maximize throughput, scan the backlog, or run async trains.
    Use the delegation router to choose lanes and record whether evidence lanes
    were used:
   `python3 .codex/skills/agent-orchestration-governance/scripts/delegation_router.py --workflow pr-governance-review --phase start --prompt "<request>" --paths "<paths>" --text`
16. If subagents are unavailable, record `Subagent taskforce: unavailable` and
    manually cover the same evidence lanes. If they are available, skipping
    them for high-volume train work is a process violation unless a concrete
    runtime blocker is recorded.
17. Keep final authority local to the parent/governor. Do not delegate branch switching, approval, merge, deploy, credential handling, or final decision.

### Decision Order

Review findings in this order:

1. North-star drift.
2. Duplicate or parallel architecture.
3. Trust-boundary, auth, consent, vault, PKM, or finance-safety regression.
4. Backend/frontend/proxy/generated-contract mismatch.
5. Claimed product/runtime value that is not reachable from the current app, backend, package, route, generated contract, or documented devex entrypoint.
6. Stacked-branch contamination where the current diff includes prior/unrelated PR work.
7. Deploy/runtime/schema/migration reproducibility drift.
8. Tests, docs, and proof gaps.
9. Contributor communication accuracy.

Prefer low-friction maintainer ownership when the direction is aligned, the fix is bounded, and maintainers can safely patch without inventing product intent. Use `patch_then_merge` for that case because it reduces contributor round trips. Use `changes_requested` when the PR needs contributor clarity, a split/rebase, proof the maintainer cannot supply, or a correction that would change the contributor's product intent. Use `block` when the PR needs product decision, rewrite, missing proof, or new architecture approval.

Before issuing or reaffirming `changes_requested`, explicitly evaluate the
maintainer-patch path. A PR should move to `changes_requested` only after Codex
cannot name a safe accepted value, canonical attach point, maintainer write set,
dropped/deferred pieces, and smallest proof command. If those can be named, the
operator answer must classify it as `maintainer_patch_then_merge` or
`maintainer_harvest`, not a generic contributor round trip.

Every review answer must be research driven. Before recommending a lane, include a compact `Research Basis` and `Reasoned Review Steps`:

1. `Research Basis`: current PR head, CI freshness, mergeability, touched surfaces, canonical repo contracts checked, overlap/duplicate evidence, and trust/runtime risks.
2. `Reasoned Review Steps`: the ordered checks Codex performed and how each check affected the decision. Include founder wiki pages checked and `current_state_vs_north_star_drift` only when the Founder Wiki North-Star Probe materially affected the review.
3. `Decision`: the lane and operator action derived from those checks.
4. `Verification`: the smallest authoritative checks needed before merge, patch, close, or request-changes.

Do not present a review as only a conclusion such as "safe", "aligned", "green", or "mergeable". Those are outputs of research, not the review itself.

### Batch Rules

When the user asks for a batch, select from `## Recommended Operator Batches` in `tmp/pr-governance-live-report.md` first. Use `Contract Intake Sets` only to pick a domain for deeper review when no executable operator batch exists.

Every next-batch answer must include:

1. Batch name and purpose.
2. Direct PR hyperlinks for every PR.
3. `Research Basis` with current repo/GitHub truth, recommended path, and risk if accepted blindly.
4. `Input` with each PR and current lane.
5. `Expected Actions` with each PR's exact operational outcome: `review_only`, `hold`, `request_changes`, `close`, `maintainer_harvest`, `maintainer_patch_then_merge`, `merge_now`, or `post_merge_monitor`.
6. `Comment Plan` with the expected GitHub write for each PR:
   - `none_before_merge_then_post_merge_closeout`
   - `edit_existing_maintainer_comment`
   - `new_changes_requested_comment`
   - `new_closed_superseded_comment`
   - `no_comment_review_only`
   Include the heading that will be used, such as `## Merged: Consent Center State UX` or `## Changes Requested: Reachability`.
7. `Per-PR Assessment` with a compact block per PR explaining what changed, touched surface, why it belongs in the batch, blind-merge risk, planned action, comment action, and smallest proof.
8. `Output` with the intended end state.
9. `Execution` with exact order and merge/patch/close/request-changes/hold split.
10. `Decision Questions` only when user-owned choices remain; each question must include current truth, recommended path, risk if accepted blindly, and recommended option first.
11. `Stop Conditions`.
12. `Verification`.

Do not reduce individual PR handling to a lane JSON blob or one-line purpose. The operator must be able to understand how each PR will be tackled from the chat/report without searching GitHub.
Do not ask "what should we do?" before stating the researched solution path.
Do not give counts-only PR wave summaries. If a response mentions a PR, it must
use a direct Markdown hyperlink. If a wave has more than ten PRs, group them by
action and still list every PR as a hyperlink in compact rows. Bare `#123`
references are allowed only inside code/log excerpts, never in operator
recommendations, action summaries, or final handoffs.
When revisiting a previous maintainer decision, edit the existing
maintainer-authored review or comment whenever GitHub allows it. Post a new
record only when no existing maintainer record exists, the old record cannot be
edited, or the new record is required to resolve a distinct review state. The
handoff must link both the PR and the edited record.

Detailed batch output requirements live in `references/operator-batch-output-contract.md`.

### Train Simulation Standard

Before asking the operator to approve a PR train, simulate the train as an execution plan grounded in the current PR heads. The simulation is not a promise to merge; it is the review pathway that Codex would execute if approved.

Each train simulation must include:

1. `Branch Evidence`: PR head SHA, mergeability, CI Status Gate, changed files, exact shared-file overlaps, and local dirty-worktree overlap.
2. `Delta Summary`: files added, edited, deleted, generated, or moved for every PR. Call out new exports, new routes, new package/runtime dependencies, and checked-in artifacts.
3. `Behavior Claim`: what behavior the PR claims to change and whether that behavior is reachable from a current app, backend, package, route, generated contract, test, or documented devex entrypoint.
4. `Canonical Fit`: the existing repo surface the change should extend. If none exists, classify as standalone utility/devex/test-only, not product/runtime value.
5. `Simulated Maintainer Patch`: the exact normalization Codex expects to make, including what original PR value is kept, converted into existing surfaces, dropped, deferred, or sent back.
6. `Action Outcome`: the exact operation that should happen to each PR if the train is approved, including branch update, maintainer patch, merge, hold, request-changes, close, report refresh, or impact update.
7. `Comment Simulation`: whether Codex will edit an existing maintainer comment or post a new comment, which heading contract applies, and the short public text intent. Do not wait until execution to decide comment posture.
8. `Execution Timeline`: one PR at a time, with the expected rebase/patch/merge/comment/report sequence and the stop condition after each step.
9. `Verification Timeline`: smallest local checks, GitHub checks, Queue Validation, Main Post-Merge Smoke, report refresh, and contributor-impact refresh.
10. `Operator Questions`: only unresolved choices that cannot be derived from repo truth. The recommended answer comes first.

For frontend or UI-visible PRs:

1. Inspect the exact branch/diff before claiming UI behavior.
2. Use `hushh-webapp/playwright.config.ts` for route-level behavior when the PR changes reachable pages, shell chrome, layout, navigation, consent center, marketplace, Kai, profile, KYC, or route APIs that affect UI.
3. Prefer existing Playwright specs under `hushh-webapp/e2e/`; add or run the smallest route-specific Playwright check only when the branch changes visible behavior that unit tests cannot prove.
4. If Playwright cannot be run during planning, mark UI behavior as `needs_playwright_verification` and do not present it as visually verified.

For backend or trust-runtime PRs:

1. Simulate the request/runtime path through the canonical route, middleware, service, schema, generated contract, or tests.
2. Name the trust boundary that would fail if the PR is accepted blindly.
3. Do not treat a helper or test addition as runtime value unless a reachable path or authoritative contract uses it.

### Changes-Requested Repass Taskforce

For a high-volume repass of previous `changes_requested` decisions, use
read-only evidence lanes when delegation is available. This is mandatory for
mass repasses, async PR trains, and backlog-scale train construction; the
parent session keeps final authority and performs any GitHub writes.

Default lanes:

1. `frontend/UI reachability`: route/component callers, app-ui ownership,
   Playwright-needed cases, exact-file collisions, and harvest candidates.
2. `runtime/helper reachability`: frontend/backend helpers, service callers,
   generated contracts, trust/runtime boundaries, and canonical attach points.
3. `root/tooling governance`: new roots, CI/workflow changes, contributor
   setup paths, repo-governance scripts, checked-in reports, and devex attach
   points.
4. `observability/security`: diagnostic logging, analytics payload boundaries,
   secret-scan risk, data minimization, and public-comment safety.
5. `decision-wave communications`: existing maintainer records, edit-vs-new
   comment posture, closure/request-changes headings, and public hyperlink
   completeness.

Each lane must return direct PR links, current head SHA, changed files,
reachability evidence, canonical attach point if any, accepted value,
dropped/deferred pieces, smallest proof, async train placement, and whether the
existing maintainer review should be edited as maintainer-patch candidate,
maintainer-harvest, or still blocked. Lanes do not switch branches, push,
approve, merge, or post/edit comments.

### Merge Train Capacity Model

Use trains to maximize throughput without lowering the merge bar:

For developer-facing train review, follow the standard operating procedure in
`references/pr-train-review-sop.md`. That SOP is the reusable review loop for
mass scanning, train graph construction, async queue/patch/decision lanes,
GitHub write posture, and post-state-change report refreshes.

1. For high-volume train work, start the required read-only subagent taskforce
   before selecting trains. The default taskforce covers frontend/UI
   reachability, backend/runtime trust, observability/security, devex/repo
   operations, and decision-wave communications. Add a sixth lane only for a
   real independent surface such as mobile/native parity or founder/north-star
   direction. Do not create one subagent per PR.
2. Map every async train to a dedicated read-only subagent lane by default.
   The train, not the individual PR, is the delegation unit. Independent trains
   run in parallel through separate lanes; same-file or same-runtime PRs remain
   sequential inside their train. If two proposed trains need the same
   subagent because they share a hard edge, merge them into one collision train
   instead of pretending they are parallel.
3. Default live-report scan mode is `hybrid`: cheap all-open inventory, then deep review of the latest `100` PRs plus up to `40` older high-signal candidates. Use `active` for fastest latest-window reviews and `full` only for audits.
4. Use four work lanes at the same time:
   - `Queue Cohort`: up to `4` independent `merge_now` PRs with exact head SHA match, green `CI Status Gate`, `MERGEABLE` state, no hard collision edges, and no local dirty-file overlap.
   - `Sequential Collision Train`: PRs with hard edges from exact files, lockfiles, schema/migrations, generated contracts, sensitive runtime families, or local dirty-file overlap. Only one PR from the group moves at a time.
   - `Parallel Patch Trains`: maintainer patches with disjoint write sets and disjoint runtime families. Default maximum is `3`.
   - `Decision Waves`: changes-requested or closure records for clearly blocked PRs. These can run while queue validation is pending.
5. Do not wait for one independent PR to complete before preparing or queueing unrelated PRs. Wait only when a PR depends on the base/result of another PR or shares a hard edge.
6. Treat CI/Queue Validation/Main Post-Merge Smoke as an asynchronous monitor lane. Do not idle the whole operator loop while checks run.
7. Do not start merging a dependent train until the previous train has passed Main Post-Merge Smoke and the live report has been refreshed.
8. Treat "automatic next train" as automatic next-train discovery and review preparation, not blind approval or merge.
9. A PR can enter a merge train only after current head, current required gate, mergeability, lane, overlap, collision group, and smallest proof are rechecked.
10. A PR with non-green required gate, missing required gate, or current failing auxiliary check cannot enter any executable train. Do not spend train-planning time on it; list it under check-failure holds and revisit only after checks are clean or the operator explicitly asks to repair CI.
11. Reports must state scan scope and completeness. If inventory, GitHub, or per-PR scanning fails, name the exact reviewed subset and failed PRs.
12. Large-scale rhythm:
   - mass classify open PRs
   - build an async train map
   - start specialist read-only evidence lanes for each independent train
   - close/request changes for clear drifts in waves
   - queue independent proven cohorts
   - sequence only hard collision groups
   - run disjoint patch trains when attachment plans exist
   - monitor PR Validation/queue/smoke asynchronously
   - review the next independent batch while the queue runs
   - refresh reports and contributor impact after every state change

After every successful merge/smoke cycle, run the next-train kickoff:

```bash
git fetch origin main
python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo hushh-labs/hushh-research --live-report --scan-mode hybrid --limit 100 --candidate-limit 40 --text --output tmp/pr-governance-live-report.md
python3 .codex/skills/pr-governance-review/scripts/contributor_impact_report.py --repo hushh-labs/hushh-research --days 14 --text > tmp/contributor-impact-dashboard.md
```

Then select the first independent `Recommended Operator Batches` item that does not depend on the train that just landed. Present the researched path with `Per-PR Assessment` before asking for approval to act.

### Blocker Gate

Before recommending merge, check the relevant domain gates in `references/blocker-gates.md`.

Default blockers include:

1. Parallel runtime for an existing capability.
2. New auth, consent, vault, PKM, voice, finance, route, or public ingress path without canonical caller/contract proof.
3. Migration/schema changes without SQL, release manifest, schema contract, and UAT-readiness plan.
4. Browser dictation or microphone UI outside canonical Kai realtime voice.
5. Cloud PKM metadata treated as memory source of truth instead of sync/discovery projection.
6. Fake consent/audit records on authenticated routes.
7. Direct trading-action language or performance promises without a regulated-advice contract.
8. Tests that cannot fail, only test mocks while claiming contract proof, or bypass sequential route/vault continuity.
9. CI Status Gate green while a current auxiliary check introduced by the PR is failing.

### GitHub Write Policy

1. No noisy approval comments. Every PR merged through this governance workflow must get one post-merge closeout after `Main Post-Merge Smoke` is green.
2. There is no simple-merge exception. Direct `merge_now` PRs still require the closeout record after smoke passes.
3. Every GitHub write must use the lane-specific heading contract from `references/comment-and-report-contract.md`.
4. Before posting a new GitHub comment, inspect existing maintainer-authored comments/reviews on that PR. Edit the existing current-lane record when possible; do not create duplicate or contradictory maintainer records. Repass or correction waves must use `edit_existing_maintainer_comment` unless that is impossible.
5. Post before merge only for `block`, `changes_requested`, `comment_only`, or when contributor action is required.
6. If a PR can be corrected safely by maintainers without changing product intent, prefer `patch_then_merge` over contributor round trips. Use a `## Changes Requested` record when the change needs contributor clarity, split/rebase, proof, or direction correction.
7. Public duplicate language is allowed only for exact or manually confirmed semantic duplicates. Shared files alone mean sequencing/rebase, not duplicate.
8. Maintainer patches must be explained in the post-merge note: who patched, what changed, what original PR value was kept, what was converted into existing canonical docs/scripts/runtime surfaces, what was dropped or deferred, why this was the smallest safe path, and what happened to related PRs.
9. Maintainer-harvest PR bodies must include `## Contributor Acknowledgements`
   with source PR links, source authors, accepted value, dropped/deferred
   pieces, and whether official GitHub commit credit is expected through
   `Co-authored-by:` trailers. The source PR closeout must use contributor-
   enabling language: "your contribution was harvested into..." rather than
   implying discarded work.
10. Do not include a separate successful-merge evidence section such as `### Merge Confidence`, `### Proof`, or `### Verification`; GitHub already shows checks. Use `### Why It Matters` in post-merge comments.
11. Do not publish maintainer-only sequencing, CI dumps, or report bookkeeping in GitHub comments.
12. Final handoffs for state-changing PR work must include direct links to every affected PR and any maintainer-authored merge/patch/closure/comment links. Counts are allowed only after the linked PR list; never replace the list with a count.

Detailed comment/report format lives in `references/comment-and-report-contract.md`.

### Maintainer Patch Gate

`patch_then_merge` is allowed only when Codex can name an attachment plan:

1. Accepted value.
2. Canonical app/backend/package/generated-contract/test-contract/devex surface to attach to.
3. Files Codex will patch.
4. Pieces Codex will drop or defer.
5. Smallest proof command.

Standalone helpers, exports, components, agents, or runtime roots that are only used by their own tests default to changes requested. Do not invent product intent or wire code into a future-state path just to save a PR.

### Report Hygiene

After any merge, close, requested-changes, maintainer patch, or revert:

1. Refresh `tmp/pr-governance-live-report.md`.
2. Refresh `tmp/contributor-impact-dashboard.md`:
   `python3 .codex/skills/pr-governance-review/scripts/contributor_impact_report.py --repo hushh-labs/hushh-research --days 14 --text > tmp/contributor-impact-dashboard.md`
3. Keep live reports live-only. Merged/closed evidence belongs in GitHub comments, final handoff, or separate audit artifacts.
4. Include contributor-impact delta when the PR materially affects trust/security, consent/vault, One/Kai/Nav direction, PKM/memory, user utility, runtime quality, or proof/test posture.
5. Past maintainer harvests must not rewrite `main` for retroactive GitHub
   graph credit. Preserve public acknowledgement and ensure the dashboard
   records `harvested_source` internal impact credit for every source PR whose
   value landed through a maintainer patch.

## Handoff Rules

Use the adjacent owner only to deepen proof:

1. `repo-operations`: CI, branch protection, merge queue, deployment, environment parity.
2. `quality-contracts`: proof placement, test policy, release gates.
3. `backend-runtime-governance`: backend ownership, route placement, service boundaries.
4. `frontend-architecture`: frontend/proxy/caller contracts.
5. `security-audit`: IAM, consent, vault, PKM, sensitive data boundaries.

## Required Checks

```bash
python3 -m py_compile .codex/skills/pr-governance-review/scripts/pr_review_checklist.py
python3 -m py_compile .codex/skills/pr-governance-review/scripts/test_pr_review_checklist.py
python3 .codex/skills/pr-governance-review/scripts/test_pr_review_checklist.py
python3 -m py_compile .codex/skills/pr-governance-review/scripts/build_runtime_schematics.py
python3 -m py_compile .codex/skills/agent-orchestration-governance/scripts/delegation_router.py
python3 .codex/skills/agent-orchestration-governance/scripts/delegation_router.py --workflow pr-governance-review --phase start --prompt "review a PR touching voice, vault, and CI" --paths "hushh-webapp/lib/voice/foo.ts,hushh-webapp/lib/vault/foo.ts,.github/workflows/ci.yml" --text
python3 .codex/skills/pr-governance-review/scripts/build_runtime_schematics.py --text
python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo hushh-labs/hushh-research --prs 498,505,444 --text
python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo hushh-labs/hushh-research --prs 531,529,435 --text
python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo hushh-labs/hushh-research --prs 488,489 --text
python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo hushh-labs/hushh-research --live-report --scan-mode hybrid --limit 100 --candidate-limit 40 --text --output tmp/pr-governance-live-report.md
python3 -m py_compile .codex/skills/pr-governance-review/scripts/contributor_impact_report.py
python3 .codex/skills/pr-governance-review/scripts/test_contributor_impact_report.py
python3 .codex/skills/pr-governance-review/scripts/contributor_impact_report.py --repo hushh-labs/hushh-research --days 14 --text
./bin/hushh codex audit --text
./bin/hushh docs verify
```
