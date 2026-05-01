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
   - Treat the script fields `contract_set`, `duplicate_group`, `author_group`, `exact_file_overlap`, `concept_overlap`, `lane`, `patch_then_merge_reason`, `public_comment_policy`, and `live_report_action` as the minimum decision record.
   - Treat `what_this_is_about` and operator-batch intent as mandatory planning context. Every batch plan must explain the product/runtime purpose before lane mechanics, merge order, or GitHub process.
   - Green CI never overrides exact file overlap, duplicate product contracts, schema-contract drift, or raw-error leakage findings.
4. Respect the project-wide delegation checkpoint in `AGENTS.md`. For large or mixed-domain batch reviews, record the subagent decision using `.codex/skills/agent-orchestration-governance/references/delegation-contract.md`:
   - delegate only when the user explicitly allows subagents or the workflow has an approved delegation step
   - split only independent evidence lanes such as backend contracts, frontend callers/proxies, CI/deploy, security/consent, tests, or docs
   - do not delegate branch switching, approval, merge, deploy, credential handling, or final recommendations
   - if the batch stays local, record the reason briefly in the report or response
5. In batch mode, do not stop at titles and green checks. The minimum overview must include, per PR:
   - what the PR is actually about in product/runtime terms, stated before merge mechanics
   - current head SHA
   - size and changed file count
   - extracted PR summary / issue linkage
   - owned surfaces touched
   - recommended lane
   - lean/core bloat risk (`low`, `medium`, `high`, `duplicate`, or `non-runtime`)
   - whether the PR removes complexity, proves an existing contract, or adds a new product/runtime surface
   - cross-PR file overlap with other PRs in the batch
   - helper-detected main-overlap and parallel-architecture findings when a concept already exists on `main` in a different file family
   - contract-set grouping first: auth/token, account export, voice, PKM/privacy, UI shell, dependency/test, content, or another explicit product/runtime contract
   - file-overlap and sequencing map for shared files, route/proxy pairs, generated contracts, callers, tests, and known main-overlap
   - author-grouping decision after contract grouping, including whether same-author PRs can share a maintainer patch pattern or contributor-facing explanation
   - maintainer patch batch recipe when relevant: canonical outcome, PR order, per-PR write set, shared tests, GitHub reply plan, report-update plan, and split point if any PR fails validation
   - reason not to author-batch when same-author PRs are in unrelated contract lanes or carry different product decisions
   - reason not to PR-set-batch when PRs have conflicting contracts, unsafe file overlap, or trust-boundary decisions that must land separately
   - for account-export/error-leakage batches, explicitly identify the canonical base, duplicate or harvest-only PRs, backend schema-contract mismatches, raw backend/proxy error leakage, service-layer download side effects, and missing happy-path export tests
6. Batch helper output is intake, not final merge authority. Before recommending consolidation or merge order, manually verify:
   - whether `main` already contains part of the behavior
   - whether the PR overlaps tasks already closed on the board
   - whether the change is product-semantic rather than purely code-local
   - whether an apparently isolated PR still changes a trust boundary, user-visible truth model, or external ingress surface
   - whether a voice-like UI change adds another microphone, speech, dictation, transcript, or command-input path while Kai realtime voice already exists; treat this as product-surface duplication unless the PR explicitly proves it is a deliberate accessibility fallback integrated with the same vault/voice availability state
   - whether the PR only says `dictation`, `fallback`, or `adapter` while still adding a user-visible voice/mic affordance; technical adapter status is not enough to merge if users see a second voice entry point
   - whether the helper found a concept-level overlap that requires `patch_then_merge` or `block` even when exact file overlap is zero
   - whether the PR adds or changes files under `consent-protocol/db/migrations/`, DB schema contracts, or `release_migration_manifest.json`; these require a DB release-contract review before merge and a live UAT schema guard before any UAT-ready claim
   - whether a migration PR updates all three DB release surfaces together when the live contract changes: SQL migration, release manifest ordering/grouping, and the checked-in schema contract for the affected environment
   - whether the migration is idempotent or narrowly safe to run against UAT, and whether the operator plan says exactly when to run `./bin/hushh db verify-release-contract`, live `./bin/hushh db verify-uat-schema`, and any required migration apply step
   - whether the PR is overbuilt relative to the core repo model: small contributor surface, consent-first access, BYOK/zero-knowledge boundaries, canonical routes, and meaningful tests
   - whether the PR blurs Hussh / One / Kai / Nav ownership by making Hussh speak as a character, treating Kai as the full platform identity, using One as a shipped-runtime claim without proof, or using `nav.*` for ordinary navigation
   - whether founder-copy updates preserve the canonical ontology: Hussh as platform, One as personal agent, Kai as finance specialist, and Nav as privacy/consent guardian
   - whether the PR imports retired founder-draft wording such as `Hussh is your personal MCP server and AI agent`, `One has two faces`, or `Kai is the One who remembers`
   - whether `hu_ssh`, `SSH for humans`, or `Ask. Approve. Audit.` are mapped back to Human Secure Socket Host and the current Consent Protocol instead of replacing implementation truth
   - whether BYO AI, portable One memory, no platform-controlled recovery, or user-private receipt claims are supported by checked-in runtime docs and tests before being described as shipped
   - whether same-file overlap is true duplicate work or only a shared-file sequence; same file is not enough to close a PR as duplicate
   - whether two PRs have the same product/runtime outcome, not just the same edited file, before using `harvest_then_close` or public duplicate language
   - when two PRs solve the same product contract, whether the selected canonical PR is actually stronger on implementation quality, not merely smaller; for UI duplicates compare scope containment, design-system primitives, accessibility, layout safety, contract preservation, and type/test readiness before using diff size as a tie-breaker
   - whether a shared service-file batch should land as sequential runtime evolution, with each PR rebased onto the previous one, instead of treating later PRs as superseded
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
   - Playwright/browser route tests that claim Next.js navigation, memory, cache, or vault continuity while only using `page.goto(...)`, skipping through protected routes directly, or missing a sequential UI-navigation lane with a JS-context/same-session probe
   - Playwright config where `baseURL`, `webServer.url`, and dev-server port can drift from each other, making browser evidence ambiguous
   - DB migration files without a matching `release_migration_manifest.json` update
   - DB schema contract changes without a matching SQL migration
   - migration PRs that claim UAT readiness without live UAT schema verification, especially when the deployed runtime would call a new table, column, index, trigger, or function
   - a new agent, service, reducer, export path, ingestion path, or PKM write surface without explicit consent-scope and caller-contract proof
   - a public ingress surface that lacks explicit rollout, abuse-control, or authority-model proof
   - ordinary route navigation introduced under `nav.*` instead of `route.*`
   - browser SpeechRecognition, dictation, or microphone UI added outside the canonical Kai realtime voice surface without product approval, shared vault/voice availability gating, and current voice UX copy
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
   - `harvest_then_close`
   - `close_duplicate`
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
19. Avoid noisy approval comments. For `merge_now`, `approve_then_merge`, and `patch_then_merge`, keep the contributor-facing note in the working report or turn output until the merge path reaches a terminal state. Do not post a separate approval comment or approval-body note unless the user explicitly asks for `comment_only` or the PR cannot proceed without contributor action.
20. Default GitHub write policy:
   - post before merge only for `block`, `changes_requested`, `comment_only`, or when a contributor must act before the PR can continue
   - after approval/merge, post one post-merge record only when it adds real contributor value: maintainer patch explanation, superseded/related PR closure, unusual verification evidence, or explicit user request
   - prefer editing the latest maintainer-authored unresolved comment over adding another comment when the PR remains open and the decision changed
   - never post both an approval explanation and a post-merge explanation for the same ordinary merge
21. GitHub replies for state-changing PR work must use a compact head/body structure. The first line must be a markdown headline (`## <Decision>: <contract or outcome>`), not a loose status sentence. Body sections use `###` headings so the comment scans like a maintainer decision record, not a chat message.
22. Use these required reply sections by lane:
   - `merge_now`: headline `## Approved: <contract or outcome>`, then `### What Landed`, `### Why This Is Safe`, and `### Proof`.
   - `patch_then_merge`: headline `## Approved With Maintainer Patch: <contract or outcome>`, then `### What Landed`, `### Maintainer Patch`, `### Why This Path`, and `### Proof`.
   - `block` or `changes_requested`: headline `## Changes Requested: <blocker>`, then `### Direction`, `### Blocker`, `### Path To Merge`, and `### Proof Needed`.
   - superseded or opposite-decision close: headline `## Closed: <reason>`, then `### Decision`, `### What We Kept`, and `### Proof`.
   - post-merge record: headline `## Merged: <contract or outcome>`, then `### What Landed`, optional `### Maintainer Patch`, optional `### Documentation Updated`, `### Proof`, and `### Outcome`.
23. Public duplicate language is allowed only for `exact_duplicate`, `semantic_duplicate`, or manually confirmed duplicate product outcomes. If PRs merely share files, describe the issue as sequencing, rebase, or maintainer integration work.
24. For every maintainer patch, the post-merge GitHub note must state who patched, what surface changed, why the patch was the smallest merge-safe path, which tests or checks prove it, and whether related PRs were merged, superseded, or left blocked. Do not bury patching inside a generic approval paragraph.
25. If durable docs changed, include `### Documentation Updated` in the post-merge note with direct Markdown links to the canonical docs or files changed. Omit this section when no durable docs changed.
26. `### Proof` is the only evidence heading for public GitHub comments. Do not use `### Verification` in new or edited PR comments except when preserving old quoted text.
27. `### Outcome` must explain the product, architecture, trust-boundary, or operational consequence of the landed change. It should not merely repeat that the PR merged. If a boundary remains intentionally partial, state that boundary plainly.
28. Keep GitHub sections external-facing. Do not publish maintainer-only bookkeeping such as `Next: this is canonical`, `future PRs should...`, batch sequencing, report status, or internal governance reminders. Put that in the working report or final Codex response instead. The GitHub comment should explain the outcome, why it happened, what proof passed, and, only for open blocked PRs, what the contributor can change to get merged.
29. Keep sections short. Each section should add evidence or contributor-actionable context; omit ceremonial acknowledgments unless they clarify contributor ownership or why the landed path differs from the submitted branch.
30. After the merge path is monitored to the required terminal state, post or update one contributor-facing post-merge note only when the write policy above says it is useful. Do not treat the merge trigger or queue entry itself as the posting point.
31. Monitoring is part of execution, not an optional follow-up. Once Codex triggers merge, auto-merge, or queue entry, it must stay attached to the workflow chain until the required terminal state is known. Stopping at queue placement, green PR checks, or "already queued" is workflow failure unless the user explicitly limited the task to queue placement only.
32. Before any maintainer patch push, merge repair push, or force-push to a PR branch, rerun the repo-operations DCO gate with `bash scripts/ci/check-dco-signoff.sh origin/main HEAD`. This is required after subtree sync, branch merge, rebase, signed squash, or queue repair because those operations can create new commits after the earlier pre-PR check.
33. After any PR state-changing action, update the active working report before final response when one exists, especially `tmp/pr-governance-live-report.md`. Reports named `live` must stay live-only:
   - update the timestamp and live query scope
   - include a clickable `## Index` with anchors for the live summary, live risk matrix, recommended PR sets, operator batches, individual PR assessments, cross-PR overlaps, and each active PR assessment
   - keep `## Live Risk Matrix` first, `## Recommended PR Sets` second, `## Operator Batches` third, and `## Individual PR Assessments` fourth so high-volume review starts with scan-level triage, then broad intake grouping, then execution-sized batches, then PR-level detail
   - group recommended PR sets by product/runtime contract first and annotate lane plus lean/core risk before applying author convenience; treat these as broad intake buckets, not automatically mergeable batches
   - derive operator batches from exact file overlap, duplicate groups, or narrow adjacent contract groups; these are the merge/close planning units
   - add explicit `Do Not Batch Yet` operator warnings when PRs share a broad contract label but do not share files, risk shape, or a real implementation dependency
   - include one SOP-shaped assessment per live PR: head SHA, contract set, lane, lean/core risk, summary, findings, overlap, related surfaces, decision rationale, live-report action, public-comment policy, and next proof
   - update each affected per-PR register entry, not just the top summary
   - replace stale head SHA, gate, mergeability, lane, and patch-plan language
   - remove non-open or no-longer-green PRs from the live active list
   - keep terminal merge/smoke evidence in GitHub comments, final handoff, or a separate audit ledger, not in the live report
   - refresh the live PR list or explicitly mark the list as not refreshed when the task is comment-only
   - add newly green PRs and update both the recommended PR sets and the operator batches
   - record contributor pushes that changed head SHA or review decision after a maintainer comment
   - update batch counts and recommended next order
   - record terminal queue/smoke evidence only in GitHub comments, final handoff, or a separate non-live audit ledger
34. If a working report contains its own update checklist, treat that checklist as part of the action flow. Do not end the turn while the checklist is stale.
35. If the user asks for a batch, produce a comprehensive overview before recommending any merge order. The overview must make product/runtime purpose, overlap, duplication, domain boundaries, lean/core bloat risk, subagent-delegation decision, flow mode, isolation strategy, contract-set grouping, author-grouping decision, and maintainer-patch batching plan explicit enough that the merge plan is auditable.
36. For DB migration or schema-contract PRs, use this migration-release gate:
   - `merge_now` is allowed only when the SQL migration, release manifest, checked-in schema contract, and local release-contract verification move together
   - `patch_then_merge` is required when a migration exists but the manifest or contract evidence is incomplete
   - `block` is required when the SQL is unsafe for UAT, destructive without an explicit operator plan, or changes a live runtime contract without tests/proof
   - after merge, do not call UAT ready until live `./bin/hushh db verify-uat-schema` is green; if it fails, apply only the missing ordered migration and rerun the guard
   - GitHub comments should keep merge proof and UAT execution proof separate: a PR can be merged to `main` while UAT still needs the runtime DB migration step before deployment is complete
37. Use `#498/#505/#444` as the calibration batch for account export and error-leakage governance:
   - `#498` must classify as `frontend-error-safety` and `patch_then_merge` when `403` permission failures are categorized as authentication.
   - `#505` must classify as `account-export` and `patch_then_merge` when export SQL drifts from checked-in DB contracts, backend/proxy errors leak raw detail, or schema-happy-path tests are missing.
   - `#444` must classify as `account-export` and `harvest_then_close` or `close_duplicate` when `#505` is the smaller canonical base for the same route/service/proxy/frontend contract.
38. Use `#531/#529/#435` as the calibration batch for same-file sequencing governance:
   - `#531` must classify as `merge_now` for Kai chat startup performance unless current checks regress.
   - `#529` must classify as `patch_then_merge` when it schedules background attribute extraction without explicit exception logging.
   - `#435` must remain a sequential Kai chat safety PR, not a duplicate closure, unless the response-validation behavior already landed on `main`.
   - The operator batch title must explain the purpose as Kai chat service evolution, not a harvest cluster.
39. Use `#446` as the calibration case for voice product-surface duplication:
   - A browser SpeechRecognition/dictation mic in the command palette must classify as `block` while the canonical Kai realtime voice flow already exists.
   - Do not downgrade this to `patch_then_merge` merely because the code only fills a search box; the user-visible product surface still duplicates voice entry.
   - A future accessibility fallback can be considered only after explicit product approval and proof that it shares the canonical vault, voice availability, route eligibility, and copy boundaries.
40. If the PR is clear, say why it is safe in concrete terms: current head SHA, current gate result, blocker count, chosen lane, flow mode, lean/core risk, the result of both verification passes, report-update status, and any remaining residual risk.
41. When explaining this skill to the team in Discord or an internal channel, route the wording through `comms-community` and keep the explanation operator-facing:
   - state that `tmp/pr-governance-live-report.md` is generated in ignored `tmp/` and is a live workspace artifact, not a durable audit ledger
   - show the three report layers: `Index`, `Live Risk Matrix`, and `Individual PR Assessments`
   - explain the merge philosophy: green CI is intake, not authority; authority comes from contract safety, non-duplication, lean/core fit, proof, and monitored merge outcome
   - include the command surface for refresh: `python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo hushh-labs/hushh-research --live-report --text > tmp/pr-governance-live-report.md`
   - avoid publishing maintainer-only sequencing details or PR-specific decisions that are not ready for the full channel

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
python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo hushh-labs/hushh-research --prs 498,505,444 --text
python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo hushh-labs/hushh-research --prs 531,529,435 --text
python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo hushh-labs/hushh-research --prs 488,489 --text
python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo hushh-labs/hushh-research --live-report --text
./bin/hushh codex audit --text
./bin/hushh docs verify
```
