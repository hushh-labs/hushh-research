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
5. Detecting "right direction, wrong size" PRs where the idea is aligned but the implementation adds duplicate paths, broad dependencies, false-positive tests, or extra product surface.
6. Drafting concise maintainer-ready markdown that acknowledges the contributor, explains what was adopted or patched, and keeps blocker reasoning explicit.

## Do Not Use

1. Broad feature implementation or fixing the contributor PR directly unless the user explicitly asks for a maintainer patch.
2. CI workflow repair when the failing root cause is inside repo operations rather than the PR itself.
3. Generic style-only review without merge-governance implications.

## Read First

1. `README.md`
2. `docs/reference/operations/ci.md`
3. `docs/reference/quality/pr-impact-checklist.md`
4. `docs/reference/architecture/api-contracts.md`
5. `.codex/skills/repo-operations/SKILL.md`
6. `.codex/skills/quality-contracts/SKILL.md`
7. `.codex/skills/pr-governance-review/references/review-axes.md`

## Workflow

1. Lock review to the current PR head SHA first; do not reason from stale runs or old maintainer comments.
2. Start with `python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo <repo> --pr <number> --text` to summarize current head status, changed surfaces, and automatic drift flags.
3. For batched contributor review or merge-train planning, use `python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo <repo> --prs <n1,n2,...> --text` first. This batch mode is the default when the user asks for “all healthy PRs by contributor”, “review these PRs together”, or “tell me how these relate”.
4. Respect the project-wide delegation checkpoint in `AGENTS.md`. For large or mixed-domain batch reviews, record the subagent decision using `.codex/skills/agent-orchestration-governance/references/delegation-contract.md`:
   - delegate only when the user explicitly allows subagents or the workflow has an approved delegation step
   - split only independent evidence lanes such as backend contracts, frontend callers/proxies, CI/deploy, security/consent, tests, or docs
   - do not delegate branch switching, approval, merge, deploy, credential handling, or final recommendations
   - if the batch stays local, record the reason briefly in the report or response
5. In batch mode, do not stop at titles and green checks. The minimum overview must include, per PR:
   - current head SHA
   - size and changed file count
   - extracted PR summary / issue linkage
   - owned surfaces touched
   - recommended lane
   - lean/core bloat risk (`low`, `medium`, `high`, `duplicate`, or `non-runtime`)
   - whether the PR removes complexity, proves an existing contract, or adds a new product/runtime surface
   - cross-PR file overlap with other PRs in the batch
   - helper-detected main-overlap and parallel-architecture findings when a concept already exists on `main` in a different file family
6. Batch helper output is intake, not final merge authority. Before recommending consolidation or merge order, manually verify:
   - whether `main` already contains part of the behavior
   - whether the PR overlaps tasks already closed on the board
   - whether the change is product-semantic rather than purely code-local
   - whether an apparently isolated PR still changes a trust boundary, user-visible truth model, or external ingress surface
   - whether the helper found a concept-level overlap that requires `patch_then_merge` or `block` even when exact file overlap is zero
   - whether the PR is overbuilt relative to the core repo model: small contributor surface, consent-first access, BYOK/zero-knowledge boundaries, canonical routes, and meaningful tests
   - whether the PR blurs Hussh / One / Kai / Nav ownership by making Hussh speak as a character, treating Kai as the full platform identity, using One as a shipped-runtime claim without proof, or using `nav.*` for ordinary navigation
7. For every lane, perform two explicit verification passes and say which pass you are in:
   - Pass 1: repo and product verification against current `main`, current head SHA, changed surfaces, and architectural truth
   - Pass 2: authoritative workflow verification after action, including current PR checks, merge queue validation, and post-merge smoke where applicable
8. Review findings in this order:
   - north-star drift
   - lean/core bloat or duplicate architecture
   - trust-boundary or auth regression
   - backend/frontend/proxy contract mismatch
   - deploy/runtime reproducibility drift
   - tests/docs/proof gaps
   - contributor communication accuracy
9. Treat these patterns as merge blockers until disproven:
   - tightening or widening auth without matching caller changes
   - backend route or payload changes without caller/proxy/test changes
   - deploy/runtime changes that introduce unpinned or undocumented dependencies
   - `.gitignore`, secret, or credential-surface changes that can hide risk
   - event-stream or async changes that alter user-visible semantics while claiming performance gains
   - a second product or component architecture path for a concept already implemented on `main`
   - broad package, dependency, or platform updates without install/build/runtime smoke tied to the changed surface
   - tests that cannot fail, duplicate production logic inside tests, or proof that only exercises mocks while claiming contract coverage
   - a new agent, service, reducer, export path, ingestion path, or PKM write surface without explicit consent-scope and caller-contract proof
   - a public ingress surface that lacks explicit rollout, abuse-control, or authority-model proof
   - ordinary route navigation introduced under `nav.*` instead of `route.*`
   - Nav, consent, vault, deletion, privacy, or scope-review behavior without matching trust-boundary proof
10. For batch reports, include a lean/core section before the per-PR register:
   - the core baseline used from `README.md`, PR impact checklist, and API contracts
   - a bloat risk matrix for every green-gate PR
   - a lean-first merge rule
   - an overkill watchlist for duplicate solutions, new trust surfaces, broad dependencies, and product-surface drift
11. When a PR is directionally right but overbuilt, do not call it `merge_now`. Use `patch_then_merge` if the excess surface is bounded and maintainer-fixable; use `block` when it requires a product decision, split, or duplicate closure.
12. If the PR touches multiple domains, hand off to the right owner skills for deeper verification, but keep this skill as the merge-readiness authority.
13. Classify the formal merge result into one lane only:
   - `merge_now`
   - `patch_then_merge`
   - `block`
14. Resolve the requested operator action into exactly one flow mode before writing to GitHub:
   - `review_only`: analyze and report, no GitHub write.
   - `comment_only`: post or edit a review/comment, no approval or merge.
   - `approve_only`: approve the current head and stop before merge. Use this when the user says "approve" or "approve all" without "merge", "land", or "queue".
   - `approve_then_merge`: approve, trigger merge/auto-merge/merge queue, and monitor to the required terminal state. Use only when the user explicitly says "merge", "land", "queue", or asks to complete the PR job end-to-end.
   - `patch_then_merge`: patch first, rerun checks, then approve and merge only after the updated head is clean.
15. Do not infer merge authority from approval language. Approval is a review state; merge, queue, and auto-merge are separate actions that require explicit user intent or a baked workflow that says `approve_then_merge`.
16. Use `patch_then_merge` when the direction is good but the current head is not merge-safe. In that lane, do not merge the contributor head directly; integrate the smallest maintainer patch first, rerun checks, then communicate clearly with the author.
17. When a maintainer patch is needed, prefer patching the contributor branch directly if `maintainerCanModify=true`. Only create a short-lived `temp/pr-<number>-patch` branch when direct patching is not possible or the fix needs isolated maintainer staging. Delete the temp branch after the merge path is resolved.
18. Do not imply approval or recommend merge while blocker findings remain on the current merge candidate. A short acknowledgment of the contributor or the good direction is fine, but it must not soften or hide blocker findings.
19. Before Codex triggers merge, auto-merge, or merge-queue entry, prepare the contributor-facing note for the current lane. Keep that note in the turn output or working report for operator visibility, but do not wait for separate posting confirmation once the action mode is finalized.
20. GitHub comment style should be natural, concise, founder-facing, and technical. Avoid rigid ceremony on low-risk approvals. For a low-risk `merge_now` approval, use two or three compact paragraphs:
   - `Approved on <sha>.`
   - what was accepted and why it matters
   - current gate, mergeability, lean/core risk, overlap status, and the recheck condition if the branch moves
21. Use fuller sections such as `Acknowledgment`, `What We Adopted`, `Merge Decision`, `Maintainer Patch`, `Blockers`, `Related Surfaces`, `Why`, and `Next` only when complexity, patching, blocking, or trust-boundary context makes the structure useful.
22. After the merge path is monitored to the required terminal state, post or update the contributor-facing note automatically. Do not treat the merge trigger or queue entry itself as the posting point.
23. Monitoring is part of execution, not an optional follow-up. Once Codex triggers merge, auto-merge, or queue entry, it must stay attached to the workflow chain until the required terminal state is known. Stopping at queue placement, green PR checks, or "already queued" is workflow failure unless the user explicitly limited the task to queue placement only.
24. After any PR state-changing action, update the active working report before final response when one exists, especially `tmp/pr-governance-live-report.md`:
   - update progress ledger and timestamp
   - update each affected per-PR register entry, not just the top summary
   - replace stale head SHA, gate, mergeability, lane, and patch-plan language
   - mark merged PRs as `resolved_merged` or move them into a resolved section
   - update batch counts and recommended next order
   - record terminal queue/smoke evidence for landed PRs
25. If a working report contains its own update checklist, treat that checklist as part of the action flow. Do not end the turn while the checklist is stale.
26. If the user asks for a batch, produce a comprehensive overview before recommending any merge order. The overview must make overlap, duplication, domain boundaries, lean/core bloat risk, subagent-delegation decision, flow mode, and isolation strategy explicit enough that the merge plan is auditable.
27. If the PR is clear, say why it is safe in concrete terms: current head SHA, current gate result, blocker count, chosen lane, flow mode, lean/core risk, the result of both verification passes, report-update status, and any remaining residual risk.

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
