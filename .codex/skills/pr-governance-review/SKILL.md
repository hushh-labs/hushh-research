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

## Workflow

### Operating Kernel

1. Lock the current PR head SHA before judging anything.
2. Run the runtime schematic before relying on mental models:
   `python3 .codex/skills/pr-governance-review/scripts/build_runtime_schematics.py --text`
3. Run the checklist:
   - Single PR: `python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo <repo> --pr <number> --text`
   - Batch: `python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo <repo> --prs <n1,n2,...> --text`
   - Live report: `python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo hushh-labs/hushh-research --live-report --text --output tmp/pr-governance-live-report.md`
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
6. Green CI never overrides exact file overlap, duplicate product contracts, schema-contract drift, raw-error leakage findings, or current auxiliary check failures introduced by the PR.
7. The checklist fields `contract_set`, `duplicate_group`, `public_comment_policy`, `lane`, and `live_report_action` are decision records, not decoration.
8. Treat app/backend reachability as a merge-readiness input. A PR that adds standalone code, tests, helpers, components, or scripts must prove it is used by a canonical app/backend/package path, or it must be classified as test/devex hygiene rather than product/runtime value.
9. If a PR title/body claims one contract but the changed files touch another, stop the merge path until the PR is retitled/rescoped, patched to the claimed contract, or closed/requested-changes.
10. If a PR says it is stacked, depends on a prior PR, or will have a different diff after another PR lands, do not review it as a merge candidate until it is rebased to `main` or explicitly scoped as a harvest/reference PR.
11. Treat local worktree overlap as a merge blocker. If an open PR touches files with uncommitted maintainer changes, resolve local ownership first: commit/stash/rebase the maintainer branch, harvest only unique PR value, or request a contributor rebase. Do not merge a GitHub-green head over active local governance/product work.
12. Run the Founder Wiki North-Star Probe for material PRs that touch product direction, One/Kai/Nav, PCHP, BYOA/BYOK, MLX/on-device posture, consent/vault/PKM, World Model, voice/action, Aha Moment, user-facing workflows, or founder-language claims. Use `.codex/skills/codex-skill-authoring/references/founder-wiki-north-star-probe.md` as the contract:
   - repo code/contracts/tests/CI remain current-state truth
   - founder wiki pages define north-star and future-state alignment
   - conflicts are `current_state_vs_north_star_drift`
   - private wiki evidence stays local-only and must not be cited in public GitHub comments
13. For high-risk or mixed-domain batches, run the delegation router and record whether evidence lanes were used:
   `python3 .codex/skills/agent-orchestration-governance/scripts/delegation_router.py --workflow pr-governance-review --phase start --prompt "<request>" --paths "<paths>" --text`
14. Keep final authority local to the parent/governor. Do not delegate branch switching, approval, merge, deploy, credential handling, or final decision.

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
5. `Per-PR Assessment` with a compact block per PR explaining what changed, touched surface, why it belongs in the batch, blind-merge risk, planned action, and smallest proof.
6. `Output` with the intended end state.
7. `Execution` with exact order and merge/patch/close/request-changes/hold split.
8. `Decision Questions` only when user-owned choices remain; each question must include current truth, recommended path, risk if accepted blindly, and recommended option first.
9. `Stop Conditions`.
10. `Verification`.

Do not reduce individual PR handling to a lane JSON blob or one-line purpose. The operator must be able to understand how each PR will be tackled from the chat/report without searching GitHub.
Do not ask "what should we do?" before stating the researched solution path.

Detailed batch output requirements live in `references/operator-batch-output-contract.md`.

### Merge Train Capacity Model

Use trains to maximize throughput without lowering the merge bar:

1. Keep at most one shared-file or runtime-sensitive merge train actively merging.
2. Treat CI/Queue Validation/Main Post-Merge Smoke as an asynchronous monitor lane. Do not idle the whole operator loop while checks run.
3. While that train is in PR Validation, Queue Validation, or Main Post-Merge Smoke, immediately review the next independent operator batch.
4. Closure waves and changes-requested waves can run in parallel with queue monitoring when they do not touch the active train's files or runtime contract.
5. Do not start merging a dependent train until the previous train has passed Main Post-Merge Smoke and the live report has been refreshed.
6. Treat "automatic next train" as automatic next-train discovery and review preparation, not blind approval or merge.
7. A PR can enter a merge train only after current head, current required gate, mergeability, lane, overlap, and smallest proof are rechecked.
8. Large-scale rhythm:
   - mass classify open PRs
   - close/request changes for clear drifts in waves
   - queue small proven merge trains
   - monitor PR Validation/queue/smoke asynchronously
   - review the next independent batch while the queue runs
   - refresh reports and contributor impact after every state change

After every successful merge/smoke cycle, run the next-train kickoff:

```bash
git fetch origin main
python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo hushh-labs/hushh-research --live-report --text --output tmp/pr-governance-live-report.md
python3 .codex/skills/pr-governance-review/scripts/contributor_impact_report.py --repo hushh-labs/hushh-research --days 7 --text > tmp/contributor-impact-dashboard.md
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
4. Before posting a new GitHub comment, inspect existing maintainer-authored comments/reviews on that PR. Edit the existing current-lane record when possible; do not create duplicate or contradictory maintainer records.
5. Post before merge only for `block`, `changes_requested`, `comment_only`, or when contributor action is required.
6. If a PR can be corrected safely by maintainers without changing product intent, prefer `patch_then_merge` over contributor round trips. Use a `## Changes Requested` record when the change needs contributor clarity, split/rebase, proof, or direction correction.
7. Public duplicate language is allowed only for exact or manually confirmed semantic duplicates. Shared files alone mean sequencing/rebase, not duplicate.
8. Maintainer patches must be explained in the post-merge note: who patched, what changed, why this was the smallest safe path, and what happened to related PRs.
9. Do not include a separate successful-merge evidence section such as `### Merge Confidence`, `### Proof`, or `### Verification`; GitHub already shows checks. Use `### Why It Matters` in post-merge comments.
10. Do not publish maintainer-only sequencing, CI dumps, or report bookkeeping in GitHub comments.
11. Final handoffs for state-changing PR work must include direct links to affected PRs and any maintainer-authored merge/patch/closure comment links.

Detailed comment/report format lives in `references/comment-and-report-contract.md`.

### Report Hygiene

After any merge, close, requested-changes, maintainer patch, or revert:

1. Refresh `tmp/pr-governance-live-report.md`.
2. Refresh `tmp/contributor-impact-dashboard.md`:
   `python3 .codex/skills/pr-governance-review/scripts/contributor_impact_report.py --repo hushh-labs/hushh-research --days 7 --text > tmp/contributor-impact-dashboard.md`
3. Keep live reports live-only. Merged/closed evidence belongs in GitHub comments, final handoff, or separate audit artifacts.
4. Include contributor-impact delta when the PR materially affects trust/security, consent/vault, One/Kai/Nav direction, PKM/memory, user utility, runtime quality, or proof/test posture.

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
python3 -m py_compile .codex/skills/pr-governance-review/scripts/build_runtime_schematics.py
python3 -m py_compile .codex/skills/agent-orchestration-governance/scripts/delegation_router.py
python3 .codex/skills/agent-orchestration-governance/scripts/delegation_router.py --workflow pr-governance-review --phase start --prompt "review a PR touching voice, vault, and CI" --paths "hushh-webapp/lib/voice/foo.ts,hushh-webapp/lib/vault/foo.ts,.github/workflows/ci.yml" --text
python3 .codex/skills/pr-governance-review/scripts/build_runtime_schematics.py --text
python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo hushh-labs/hushh-research --prs 498,505,444 --text
python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo hushh-labs/hushh-research --prs 531,529,435 --text
python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo hushh-labs/hushh-research --prs 488,489 --text
python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo hushh-labs/hushh-research --live-report --text --output tmp/pr-governance-live-report.md
python3 -m py_compile .codex/skills/pr-governance-review/scripts/contributor_impact_report.py
python3 .codex/skills/pr-governance-review/scripts/contributor_impact_report.py --repo hushh-labs/hushh-research --days 7 --text
./bin/hushh codex audit --text
./bin/hushh docs verify
```
