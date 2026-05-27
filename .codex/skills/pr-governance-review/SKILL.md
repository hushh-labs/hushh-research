---
name: pr-governance-review
description: Use when reviewing an incoming pull request for north-star alignment, trust-boundary regressions, malicious or low-signal degradation, stale-vs-current CI interpretation, and true merge readiness beyond a green gate.
---

# PR Governance Review Skill

## Purpose and Trigger

- Primary scope: `pr-governance-review-intake`
- Trigger on PR review, merge readiness, maintainer patching, backlog train planning, PR governance reports, or contributor-facing PR decisions.
- Avoid overlap with `repo-operations`, `quality-contracts`, `backend-runtime-governance`, `frontend-architecture`, and `security-audit`.

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

1. Current-head PR review beyond green CI.
2. Async PR-train planning, queue cohorts, collision groups, patch trains, and decision waves.
3. Maintainer patch/harvest decisions, contributor acknowledgement, and lane-specific GitHub comment posture.
4. Review for north-star drift, trust-boundary regression, stale CI, duplicate architecture, or unreachable helpers.

## Do Not Use

1. Broad repo orientation before a PR or owner surface is known.
2. CI root-cause repair after a check failure is already classified.
3. Domain implementation work after a PR has been handed to an owner skill.

## Read First

1. `docs/reference/operations/ci.md`
2. `docs/reference/quality/pr-impact-checklist.md`
3. `.codex/skills/repo-operations/SKILL.md`
4. `.codex/skills/pr-governance-review/references/review-axes.md`
5. `.codex/skills/pr-governance-review/references/operator-batch-output-contract.md`
6. `.codex/skills/pr-governance-review/references/blocker-gates.md`
7. `.codex/skills/pr-governance-review/references/comment-and-report-contract.md`
8. `.codex/skills/pr-governance-review/references/pr-train-review-sop.md`

## Workflow

### Default PR-Train Mode

Use the async PR-train method as the default for multi-PR work.

1. Lock the current PR head SHA, current `CI Status Gate`, mergeability, draft state, and review state before judging.
2. Run the delegation router at intake; use read-only evidence lanes for non-trivial, high-risk, or multi-PR work.
3. Run the PR checklist or hybrid live report and treat `contract_set`, `duplicate_group`, `public_comment_policy`, `lane`, and `live_report_action` as decision records.
4. Use the async PR-train method as the default for more than one PR: first lock the operator-approved surface scope, identify only trains inside that scope or its hard dependencies, run scoped non-touching trains in parallel through evidence lanes, sequence touching PRs oldest-first inside each train, queue independent green PRs together, run disjoint patch trains, and run decision waves asynchronously. Unrelated green-clean PRs stay in `out_of_scope_candidates` until a separate operator checkpoint approves a broader sweep.
5. Exclude PRs with failing/missing/stale required checks or failing auxiliary checks from executable trains unless the task is CI repair.
6. Apply blocker gates before merge: north-star drift, duplicate architecture, trust-boundary regression, caller/proxy/backend mismatch, unreachable helpers, stacked diff, proof gaps, and local dirty-file overlap.
7. Prefer `patch_then_merge` or maintainer harvest over contributor round trips when an attachment plan names accepted value, canonical attach point, write set, dropped/deferred pieces, proof, and co-author attribution when code/tests are materially reused.
8. Use `comment-and-report-contract.md` for every GitHub write; edit existing maintainer records first and post one post-merge closeout after smoke.
9. Keep branch switching, commits, GitHub writes, approvals, merges, deploys, report refreshes, and final decisions in the parent session.

## Handoff Rules

1. CI, queue, deploy, or branch-protection authority routes to `repo-operations`.
2. Test placement or verification policy routes to `quality-contracts`.
3. Backend runtime boundaries route to `backend-runtime-governance`.
4. Frontend caller/route contracts route to `frontend-architecture`.
5. IAM, consent, vault, PKM, or sensitive data boundaries route to `security-audit`.

## Required Checks

```bash
python3 -m py_compile .codex/skills/pr-governance-review/scripts/pr_review_checklist.py .codex/skills/pr-governance-review/scripts/test_pr_review_checklist.py .codex/skills/pr-governance-review/scripts/build_runtime_schematics.py .codex/skills/pr-governance-review/scripts/contributor_impact_report.py
python3 .codex/skills/pr-governance-review/scripts/test_pr_review_checklist.py
python3 .codex/skills/agent-orchestration-governance/scripts/agent_router_smoke.py
python3 .codex/skills/pr-governance-review/scripts/build_runtime_schematics.py --text
python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo hushh-labs/hushh-research --live-report --scan-mode hybrid --selection-order oldest --limit 100 --candidate-limit 40 --text --output tmp/pr-governance-live-report.md
python3 .codex/skills/pr-governance-review/scripts/test_contributor_impact_report.py
./bin/hushh codex audit --text
./bin/hushh docs verify
```
