---
name: pr-governance-review
description: Use when reviewing an incoming pull request for north-star alignment, trust-boundary regressions, malicious or low-signal degradation, stale-vs-current CI interpretation, and true merge readiness beyond a green gate.
---

# Hussh PR Governance Review Skill

## Purpose and Trigger

- Primary scope: `pr-governance-review-intake`
- Trigger on incoming pull request review, contributor PR triage, merge-readiness assessment, or any case where CI may be green but the change could still erode Hussh north stars, trust boundaries, runtime contracts, or repo quality.
- Avoid overlap with `repo-context`, `repo-operations`, and `quality-contracts` when the task is broad repo discovery, CI repair, or test-policy design rather than PR trust review.

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

1. Reviewing community or internal PRs where “green CI” is necessary but not sufficient.
2. Distinguishing stale failed checks from the current head SHA before judging a contributor response.
3. Flagging backend contract changes that do not carry matching caller, proxy, docs, or test updates.
4. Flagging auth, vault, consent, runtime, deploy, Docker, `.gitignore`, or secret-surface changes that could quietly degrade the repo.
5. Drafting concise maintainer-ready markdown that acknowledges the contributor, explains what was adopted or patched, and keeps blocker reasoning explicit.

## Do Not Use

1. Broad feature implementation or fixing the contributor PR directly unless the user explicitly asks for a maintainer patch.
2. CI workflow repair when the failing root cause is inside repo operations rather than the PR itself.
3. Generic style-only review without merge-governance implications.

## Read First

1. `README.md`
2. `docs/reference/operations/ci.md`
3. `.codex/skills/repo-operations/SKILL.md`
4. `.codex/skills/quality-contracts/SKILL.md`
5. `.codex/skills/pr-governance-review/references/review-axes.md`

## Workflow

1. Lock review to the current PR head SHA first; do not reason from stale runs or old maintainer comments.
2. Start with `python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo <repo> --pr <number> --text` to summarize current head status, changed surfaces, and automatic drift flags.
3. For batched contributor review or merge-train planning, use `python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo <repo> --prs <n1,n2,...> --text` first. This batch mode is the default when the user asks for “all healthy PRs by contributor”, “review these PRs together”, or “tell me how these relate”.
4. In batch mode, do not stop at titles and green checks. The minimum overview must include, per PR:
   - current head SHA
   - size and changed file count
   - extracted PR summary / issue linkage
   - owned surfaces touched
   - recommended lane
   - cross-PR file overlap with other PRs in the batch
   - helper-detected main-overlap and parallel-architecture findings when a concept already exists on `main` in a different file family
5. Batch helper output is intake, not final merge authority. Before recommending consolidation or merge order, manually verify:
   - whether `main` already contains part of the behavior
   - whether the PR overlaps tasks already closed on the board
   - whether the change is product-semantic rather than purely code-local
   - whether an apparently isolated PR still changes a trust boundary, user-visible truth model, or external ingress surface
   - whether the helper found a concept-level overlap that requires `patch_then_merge` or `block` even when exact file overlap is zero
6. For every lane, perform two explicit verification passes and say which pass you are in:
   - Pass 1: repo and product verification against current `main`, current head SHA, changed surfaces, and architectural truth
   - Pass 2: authoritative workflow verification after action, including current PR checks, merge queue validation, and post-merge smoke where applicable
7. Review findings in this order:
   - north-star drift
   - trust-boundary or auth regression
   - backend/frontend/proxy contract mismatch
   - deploy/runtime reproducibility drift
   - tests/docs/proof gaps
   - contributor communication accuracy
8. Treat these patterns as merge blockers until disproven:
   - tightening or widening auth without matching caller changes
   - backend route or payload changes without caller/proxy/test changes
   - deploy/runtime changes that introduce unpinned or undocumented dependencies
   - `.gitignore`, secret, or credential-surface changes that can hide risk
   - event-stream or async changes that alter user-visible semantics while claiming performance gains
   - a second product or component architecture path for a concept already implemented on `main`
   - a public ingress surface that lacks explicit rollout, abuse-control, or authority-model proof
9. If the PR touches multiple domains, hand off to the right owner skills for deeper verification, but keep this skill as the merge-readiness authority.
10. Classify the result into one lane only:
   - `merge_now`
   - `patch_then_merge`
   - `block`
11. Use `patch_then_merge` when the direction is good but the current head is not merge-safe. In that lane, do not merge the contributor head directly; integrate the smallest maintainer patch first, rerun checks, then communicate clearly with the author.
12. When a maintainer patch is needed, prefer patching the contributor branch directly if `maintainerCanModify=true`. Only create a short-lived `temp/pr-<number>-patch` branch when direct patching is not possible or the fix needs isolated maintainer staging. Delete the temp branch after the merge path is resolved.
13. Do not imply approval or recommend merge while blocker findings remain on the current merge candidate. A short acknowledgment of the contributor or the good direction is fine, but it must not soften or hide blocker findings.
14. Before Codex triggers merge, auto-merge, or merge-queue entry, prepare a contributor-facing markdown draft for the current lane. Keep that draft in the turn output for operator visibility, but do not wait for separate posting confirmation once the policy is finalized.
15. When communicating back on a PR, prefer this concise markdown shape:
   - `## Acknowledgment`
   - `## What We Adopted`
   - `## Merge Decision`, `## Maintainer Patch`, or `## Blockers`
   - `## Related Surfaces` when concrete file and higher-level doc references materially help future readers understand the landed boundary; use clickable GitHub links and add a one-line note per entry so future readers know why each file or doc matters
   - `## Why`
   - `## Next` only when there is still contributor action or maintainer follow-up to explain
16. After the merge path is monitored to the required terminal state, post the contributor-facing note automatically. Do not treat the merge trigger or queue entry itself as the posting point.
17. Monitoring is part of execution, not an optional follow-up. Once Codex triggers merge, auto-merge, or queue entry, it must stay attached to the workflow chain until the required terminal state is known. Stopping at queue placement, green PR checks, or "already queued" is workflow failure unless the user explicitly limited the task to queue placement only.
18. If the user asks for a batch, produce a comprehensive overview before recommending any merge order. The overview must make overlap, duplication, domain boundaries, and isolation strategy explicit enough that the merge plan is auditable.
19. If the PR is clear, say why it is safe in concrete terms: current head SHA, current gate result, blocker count, chosen lane, the result of both verification passes, and any remaining residual risk.

## Handoff Rules

1. Use `repo-operations` when the real blocker is CI design, workflow permissions, branch protection, or deployment policy.
2. Use `quality-contracts` when the problem is missing or misplaced proof, contract tests, or release gating.
3. Use `backend-runtime-governance` when backend route placement or runtime ownership is the real issue.
4. Use `frontend-architecture` when a frontend/proxy caller contract is implicated.
5. Use `security-audit` when the PR touches IAM, consent, vault, PKM, or sensitive data boundaries.

## Required Checks

```bash
python3 -m py_compile .codex/skills/pr-governance-review/scripts/pr_review_checklist.py
python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo hushh-labs/hushh-research --pr 437 --text
./bin/hushh codex audit --text
./bin/hushh docs verify
```
