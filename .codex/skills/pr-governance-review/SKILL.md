---
name: pr-governance-review
description: Use when reviewing an incoming pull request for north-star alignment, trust-boundary regressions, malicious or low-signal degradation, stale-vs-current CI interpretation, and true merge readiness beyond a green gate.
---

# Hussh PR Governance Review Skill

## Purpose and Trigger

- Primary scope: `pr-governance-review-intake`
- Trigger on incoming pull request review, contributor PR triage, merge-readiness assessment, or any case where CI may be green but the change could still erode Hussh north stars, trust boundaries, runtime contracts, or repo quality.
- Avoid overlap with `repo-context`, `repo-operations`, and `quality-contracts` when the task is broad repo discovery, CI repair, or test-policy design rather than PR trust review.
- This skill is the root merge-readiness gate for the whole repo. Specialist skills such as voice, PKM, frontend, backend, IAM, or repo-operations may add deeper review constraints, but they must not replace this skill and must not downgrade a blocker found here.

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
8. `.codex/skills/pr-governance-review/references/runtime-schematics-contract.md`

## Workflow

1. Lock review to the current PR head SHA first; do not reason from stale runs or old maintainer comments.
2. Build the current repo schematic before judging the PR: `python3 .codex/skills/pr-governance-review/scripts/build_runtime_schematics.py --text`.
   - Treat the schematic as the first source of truth for required CI gate name, runtime families, owner skills, generated contracts, DB release surfaces, route-shell contracts, and verification commands.
   - If the schematic builder cannot read a canonical source, classify the PR review as under-evidenced instead of filling the gap from memory.
3. Start with `python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo <repo> --pr <number> --text` to summarize current head status, changed surfaces, current review decision, schematic provenance, and automatic drift flags.
3. For batched contributor review or merge-train planning, use `python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo <repo> --prs <n1,n2,...> --text` first. This batch mode is the default when the user asks for “all healthy PRs by contributor”, “review these PRs together”, or “tell me how these relate”.
   - Treat the script fields `contract_set`, `duplicate_group`, `author_group`, `exact_file_overlap`, `concept_overlap`, `lane`, `patch_then_merge_reason`, `public_comment_policy`, and `live_report_action` as the minimum decision record.
   - Treat `what_this_is_about` and operator-batch intent as mandatory planning context. Every batch plan must explain the product/runtime purpose before lane mechanics, merge order, or GitHub process.
   - Green CI never overrides exact file overlap, duplicate product contracts, schema-contract drift, or raw-error leakage findings.
4. Respect the project-wide delegation checkpoint in `AGENTS.md`. For large, high-stakes, or mixed-domain batch reviews, this workflow has an approved read-only delegation step when the checkpoint passes. Record the subagent decision using `.codex/skills/agent-orchestration-governance/references/delegation-contract.md`:
   - run `python3 .codex/skills/agent-orchestration-governance/scripts/delegation_router.py --workflow pr-governance-review --phase start --prompt "<user request>" --paths "<changed paths>" --text` when intent or path ownership is not obvious
   - spawn the relevant evidence lanes automatically when the PR touches a specialist-owned runtime family and the parent can continue non-overlapping work
   - use high reasoning as the minimum; use extra-high reasoning for governor synthesis, reviewer regression review, security/consent/vault audits, and voice/action-runtime audits
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
   - whether the PR is adding a surface for an existing capability instead of extending the canonical implementation already in the repo
   - whether a changed frontend component is actually reachable from a current route, app shell, service caller, or another live component; if no current import path exists, do not describe the PR as a live app improvement
   - whether the current repo has a canonical runtime, service, generated contract, component family, route, or docs contract for the same product noun; if yes, review the PR as integration against that existing capability before assigning `merge_now`
   - whether the PR touches one of the project runtime families below; if yes, inspect the canonical surfaces first even when the PR title or changed-file set looks narrow:
     - voice/action runtime: `.voice-action-contract.json`, generated Kai action gateway, voice manifest, voice orchestrator, voice dispatcher, backend voice intent service, realtime voice UI, and any browser speech/dictation adapter
     - auth/token/session runtime: Firebase auth, Apple/Google/phone linking, recaptcha, session cookies, bearer extraction, DB-backed revocation validation, and Next proxy auth forwarding
     - PKM/vault/runtime memory: encrypted vault state, vault unlock guards, PKM metadata projection, local/native PKM bridges, account export, and consent-scoped vault-owner tokens
     - consent/IAM/relationship runtime: consent center, VAULT_OWNER tokens, scope bundles, RIA access, marketplace handshakes, deletion/privacy/scope-review flows
     - route shell/onboarding runtime: protected route shell, persona switching, onboarding guards, sequential browser navigation, route-map observability, and cache/session continuity
     - Kai finance/runtime analysis: market insight routes, ticker validation, portfolio import, chat state, chat response safety, and financial accuracy contracts
   - whether a specialist skill exists for that runtime family; if yes, use it only after this preflight and only to deepen the proof, not as the primary merge decision
   - whether the PR overlaps tasks already closed on the board
   - whether the change is product-semantic rather than purely code-local
   - whether an apparently isolated PR still changes a trust boundary, user-visible truth model, or external ingress surface
   - whether a voice-like UI change adds another microphone, speech, dictation, transcript, or command-input path while Kai realtime voice already exists; treat this as product-surface duplication unless the PR explicitly proves it is a deliberate accessibility fallback integrated with the same vault/voice availability state
   - whether the PR only says `dictation`, `fallback`, or `adapter` while still adding a user-visible voice/mic affordance; technical adapter status is not enough to merge if users see a second voice entry point
   - whether the helper found a concept-level overlap that requires `patch_then_merge` or `block` even when exact file overlap is zero
   - whether the PR adds or changes files under `consent-protocol/db/migrations/`, DB schema contracts, or `release_migration_manifest.json`; these require a DB release-contract review before merge and a live UAT schema guard before any UAT-ready claim
   - whether a migration PR updates all three DB release surfaces together when the live contract changes: SQL migration, release manifest ordering/grouping, and the checked-in schema contract for the affected environment
   - whether the migration is idempotent or narrowly safe to run against UAT, and whether the operator plan says exactly when to run `./bin/hushh db verify-release-contract`, live `./bin/hushh db verify-uat-schema`, and any required migration apply step
   - whether a PKM migration or service PR changes `pkm_index`, `domain_summaries`, `summary_projection`, or a PKM projection RPC; if yes, require explicit proof that this is cloud discovery/sync projection only, not the source of user memory truth
   - whether the PR preserves the on-device-first boundary: encrypted domain data, manifests, mutation events, and local cache write-through remain authoritative for user memory, while cloud `pkm_index` remains repairable discovery metadata
   - whether cache coherence stays aligned with PKM writes through `CacheSyncService`, `PkmDomainResourceService`, and secure device cache behavior; if not proven, do not classify the PR as `merge_now`
   - whether the PR is overbuilt relative to the core repo model: small contributor surface, consent-first access, BYOK/zero-knowledge boundaries, canonical routes, and meaningful tests
   - whether the PR blurs Hussh / One / Kai / Nav ownership by making Hussh speak as a character, treating Kai as the full platform identity, using One as a shipped-runtime claim without proof, or using `nav.*` for ordinary navigation
   - whether One/Kai runtime identity changed on a current app, voice, agent, shell, or prompt surface; this requires checking both the ontology docs and the current runtime docs before merge because One may be canonical direction while a specific surface can still be Kai-first today
   - whether founder-copy updates preserve the canonical ontology: Hussh as platform, One as personal agent, Kai as finance specialist, and Nav as privacy/consent guardian
   - whether the PR imports retired founder-draft wording such as `Hussh is your personal MCP server and AI agent`, `One has two faces`, or `Kai is the One who remembers`
   - whether `hu_ssh`, `SSH for humans`, or `Ask. Approve. Audit.` are mapped back to Human Secure Socket Host and the current Consent Protocol instead of replacing implementation truth
   - whether BYO AI, portable One memory, no platform-controlled recovery, or user-private receipt claims are supported by checked-in runtime docs and tests before being described as shipped
   - whether same-file overlap is true duplicate work or only a shared-file sequence; same file is not enough to close a PR as duplicate
   - whether two PRs have the same product/runtime outcome, not just the same edited file, before using `harvest_then_close` or public duplicate language
   - when two PRs solve the same product contract, whether the selected canonical PR is actually stronger on implementation quality, not merely smaller; for UI duplicates compare scope containment, design-system primitives, accessibility, layout safety, contract preservation, and type/test readiness before using diff size as a tie-breaker
   - whether a shared service-file batch should land as sequential runtime evolution, with each PR rebased onto the previous one, instead of treating later PRs as superseded
   - whether a backend PR adds a new agent, manifest, prompt, or LLM boundary without wiring it into a canonical route, service, planner, docs contract, consent-scope proof, and current product flow; green tests for the new agent alone are not enough to classify it as `merge_now`
   - whether a Kai finance/runtime PR adds an extra LLM call, mediator, retry, or timeout path inside analysis, debate, consensus, or route execution; this requires explicit latency, rate-limit, fallback, and financial-semantics review before merge
   - for voice, PKM/vault, consent/IAM, Kai market/analysis, RIA/marketplace, auth, onboarding, and route-shell changes, identify the existing canonical repo surfaces first and require the PR to either extend them directly or explain why a new surface is not a parallel architecture
   - for Kai finance, market, Renaissance, portfolio, or advisor-idea UI/content changes, inspect reachable user copy for direct trading-action language such as `Buy`, `Sell`, `Do not buy`, `before adding`, `higher returns`, or `faster growth`; user-facing surfaces should frame outputs as signals, evidence, confidence, and uncertainty unless a separate regulated-advice contract exists
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
   - PKM projection or `pkm_index` writes that imply cloud metadata is authoritative over local encrypted memory, manifests, or on-device cache
   - PKM/cloud-sync changes that omit a cache-coherence proof for `CacheSyncService`, secure device cache, or local write-through after vault unlock
   - commercial consent-token changes that add issuance/parsing gates only to `validate_token` while the DB-backed `validate_token_with_db` path cannot enforce the same `require_commercial` policy
   - consent audit/history UI that displays hardcoded grants, revokes, actors, timestamps, or permissions on authenticated app routes instead of using the canonical consent-center/history contract or an honest empty/loading state
   - a new agent, service, reducer, export path, ingestion path, or PKM write surface without explicit consent-scope and caller-contract proof
   - a standalone agent implementation whose only proof is tests against the new agent itself while the current app/service/runtime never calls it
   - Kai finance consensus, debate, or analysis changes that introduce an additional LLM call without proving rate-limit safety, timeout behavior, fallback behavior, and unchanged caller semantics
   - a public ingress surface that lacks explicit rollout, abuse-control, or authority-model proof
   - ordinary route navigation introduced under `nav.*` instead of `route.*`
   - One/Kai/Nav/KYC identity wording changed in prompts, manifests, route shells, or voice knowledge without proving current-state versus future-state alignment
   - browser SpeechRecognition, dictation, or microphone UI added outside the canonical Kai realtime voice surface without product approval, shared vault/voice availability gating, and current voice UX copy
   - Nav, consent, vault, deletion, privacy, or scope-review behavior without matching trust-boundary proof
   - voice or typed-search work that bypasses `.voice-action-contract.json`, generated Kai action gateway, voice manifest, current voice orchestrator, or shared dispatcher
   - any new browser, backend, or MCP input path for an existing capability that does not prove parity with the canonical route, service, generated contract, or user-state flow
   - any PR whose implementation creates a parallel runtime for an existing project capability while only proving the new path in isolation
   - frontend UI PRs that only modify an unused component while claiming a route-level or user-visible product improvement
   - Kai market UI or content that turns analysis signals into direct buy/sell instructions, performance promises, or personalized trading advice
   - any PR whose review depends on a specialist claim that was not reconciled against current `main` and the canonical runtime family listed above
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
18. Maintainer-authored repair PRs have a separate completion path. If the active maintainer account is also the PR author, GitHub will reject self-approval; do not treat that as a blocker when all of these are true:
   - the user explicitly asked to complete, merge, land, or resolve the PR
   - the PR is a narrow maintainer repair, follow-up, or governance/docs/runtime-boundary patch created by the maintainer
   - the current head SHA is locked and clean
   - required PR validation, DCO, secret scan, governance, freshness, and relevant targeted local checks are green
   - no blocker findings remain in the PR governance checklist
   - the admin merge path is available to the active maintainer account
   In that case, use `gh pr merge --admin` as the documented maintainer-repair path, monitor the resulting main checks, and post the normal post-merge closeout. Do not use admin merge for contributor PRs, broad feature PRs, failing checks, unreviewed security-sensitive runtime changes, or ambiguous product decisions.
19. Do not imply approval or recommend merge while blocker findings remain on the current merge candidate. A short acknowledgment of the contributor or the good direction is fine, but it must not soften or hide blocker findings.
20. Avoid noisy approval comments. For `merge_now`, `approve_then_merge`, and `patch_then_merge`, keep the contributor-facing note in the working report or turn output until the merge path reaches a terminal state. Do not post a separate approval comment or approval-body note unless the user explicitly asks for `comment_only` or the PR cannot proceed without contributor action.
21. Default GitHub write policy:
   - post before merge only for `block`, `changes_requested`, `comment_only`, or when a contributor must act before the PR can continue
   - after a PR merges and the required post-merge smoke reaches a terminal green state, post one concise completion record on the PR every time; this is the public closeout that confirms what landed, why it matters, and the resulting steady state
   - include `### Maintainer Patch`, `### Documentation Updated`, related-PR closure, or unusual verification context only when that actually happened; do not invent ceremony for a clean merge
   - prefer editing the latest maintainer-authored unresolved comment over adding another comment when the PR remains open and the decision changed
   - never post both an approval explanation and a post-merge explanation for the same ordinary merge; the post-merge record is the default public note for successful merge work
22. GitHub replies for state-changing PR work must use a compact head/body structure. The first line must be a markdown headline (`## <Decision>: <contract or outcome>`), not a loose status sentence. Body sections use `###` headings so the comment scans like a maintainer decision record, not a chat message.
23. Use these required reply sections by lane:
   - `merge_now`: headline `## Approved: <contract or outcome>`, then `### What Landed`, `### Why This Is Safe`, and `### Outcome`.
   - `patch_then_merge`: headline `## Approved With Maintainer Patch: <contract or outcome>`, then `### What Landed`, `### Maintainer Patch`, `### Why This Path`, and `### Outcome`.
   - `block` or `changes_requested`: headline `## Changes Requested: <blocker>`, then `### Direction`, `### Blocker`, `### Path To Merge`, and `### Proof Needed`.
   - superseded or opposite-decision close: headline `## Closed: <reason>`, then `### Decision`, `### What We Kept`, and `### Decision Basis`.
   - post-merge record without a maintainer patch: headline `## Merged: <contract or outcome>`, then `### What Landed`, `### Why It Matters`, and `### Outcome`.
   - post-merge record with a maintainer patch: headline `## Merged: <contract or outcome>`, then `### What Landed`, `### Why It Matters`, `### Maintainer Patch`, optional `### Documentation Updated`, and `### Outcome`.
24. Public duplicate language is allowed only for `exact_duplicate`, `semantic_duplicate`, or manually confirmed duplicate product outcomes. If PRs merely share files, describe the issue as sequencing, rebase, or maintainer integration work.
25. For every maintainer patch, the post-merge GitHub note must state who patched, what surface changed, why the patch was the smallest merge-safe path, and whether related PRs were merged, superseded, or left blocked. Do not bury patching inside a generic approval paragraph.
26. If durable docs changed, include `### Documentation Updated` in the post-merge note with direct Markdown links to the canonical docs or files changed. Omit this section when no durable docs changed.
27. Do not include a separate successful-merge evidence section such as `### Merge Confidence`, `### Proof`, or `### Verification` in public post-merge comments. GitHub already shows the merge checks; the public comment should explain what landed, why it matters, optional maintainer patch context, and outcome. Use `### Decision Basis` for superseded or closed PRs. Keep `### Proof Needed` for blocked PRs because that asks the contributor for concrete evidence before merge.
28. Do not use `### Verification` in new or edited PR comments except when preserving old quoted text.
29. Post-merge records should read like a maintainer closing the loop, not a bot transcript. Keep the headline specific, make `### What Landed` name the actual product/runtime change, use `### Why It Matters` for the product, architecture, or trust-boundary implication, and make `### Outcome` explain the new steady state.
30. `### Outcome` must explain the product, architecture, trust-boundary, or operational consequence of the landed change. It should not merely repeat that the PR merged. If a boundary remains intentionally partial, state that boundary plainly.
31. Keep GitHub sections external-facing. Do not publish maintainer-only bookkeeping such as `Next: this is canonical`, `future PRs should...`, batch sequencing, report status, CI receipt dumps, or internal governance reminders. Put that in the working report or final Codex response instead. The GitHub comment should explain the outcome, why it happened, and, only for open blocked PRs, what the contributor can change to get merged.
32. Keep sections short. Each section should add evidence or contributor-actionable context; omit ceremonial acknowledgments unless they clarify contributor ownership or why the landed path differs from the submitted branch.
33. After the merge path is monitored to the required terminal state, post or update one contributor-facing post-merge note for every merged PR. Do not treat the merge trigger or queue entry itself as the posting point.
34. Final handoffs for state-changing PR work must include direct links to the affected PRs and any maintainer-authored merge, patch, or closure comments. Do not make the user hunt for the GitHub record.
35. Monitoring is part of execution, not an optional follow-up. Once Codex triggers merge, auto-merge, or queue entry, it must stay attached to the workflow chain until the required terminal state is known. Stopping at queue placement, green PR checks, or "already queued" is workflow failure unless the user explicitly limited the task to queue placement only.
36. Before any maintainer patch push, merge repair push, or force-push to a PR branch, rerun the repo-operations DCO gate with `bash scripts/ci/check-dco-signoff.sh origin/main HEAD`. This is required after subtree sync, branch merge, rebase, signed squash, or queue repair because those operations can create new commits after the earlier pre-PR check.
37. After any PR state-changing action, update the active working report before final response when one exists, especially `tmp/pr-governance-live-report.md`. Reports named `live` must stay live-only:
   - update the timestamp and live query scope
   - live reports must query all open PRs, including drafts, not only green-gate or ready-for-review PRs; gate status, DCO, review decision, mergeability, and draft state are classifications inside the report
   - include a clickable `## Index` with anchors for the live summary, live risk matrix, actionable next queue, blocked/waiting register, recommended PR sets, operator batches, individual PR assessments, cross-PR overlaps, and each active PR assessment
   - keep `## Live Risk Matrix` first, `## Actionable Next Queue` second, `## Blocked / Waiting Register` third, `## Recommended PR Sets` fourth, `## Operator Batches` fifth, and `## Individual PR Assessments` sixth so high-volume review separates situational awareness from fresh work selection
   - keep PRs with active `CHANGES_REQUESTED`, draft state, failing required gates, or conflicting mergeability out of merge-oriented Actionable Next Queue entries unless the user explicitly asks to revisit that blocked PR
   - exception: `close_duplicate` and `harvest_then_close` PRs may stay actionable even when draft or conflicting, because the operator action is close/harvest, not merge
   - group recommended PR sets from actionable candidates by product/runtime contract first and annotate lane plus lean/core risk before applying author convenience; treat these as broad intake buckets, not automatically mergeable batches
   - derive operator batches from exact file overlap, duplicate groups, or narrow adjacent contract groups among actionable candidates; these are the merge/close planning units
   - add explicit `Do Not Batch Yet` operator warnings when PRs share a broad contract label but do not share files, risk shape, or a real implementation dependency
   - include one SOP-shaped assessment per live PR: head SHA, required gate status, review decision, mergeability, contract set, lane, lean/core risk, summary, findings, overlap, related surfaces, decision rationale, live-report action, public-comment policy, and next proof
   - update each affected per-PR register entry, not just the top summary
   - replace stale head SHA, gate, mergeability, lane, and patch-plan language
   - remove non-open or no-longer-green PRs from the live active list
   - keep terminal merge/smoke evidence in GitHub comments, final handoff, or a separate audit ledger, not in the live report
   - refresh the live PR list or explicitly mark the list as not refreshed when the task is comment-only
   - add newly green PRs and update both the recommended PR sets and the operator batches
   - record contributor pushes that changed head SHA or review decision after a maintainer comment
   - update batch counts and recommended next order
   - record terminal queue/smoke evidence only in GitHub comments, final handoff, or a separate non-live audit ledger
   - refresh the contributor impact dashboard when PR work changes merge, close, changes-requested, maintainer-patch, or revert state:
     `python3 .codex/skills/pr-governance-review/scripts/contributor_impact_report.py --repo hushh-labs/hushh-research --days 7 --text > tmp/contributor-impact-dashboard.md`
   - keep `tmp/contributor-impact-dashboard.md` historical and rolling: it may include merged, closed, reverted, and patched PRs, unlike the live report
   - use north-star weighted impact, not raw PR count, when summarizing weekly top-10, two-week top-10, monthly top-10, or contributor-impact movement
   - default topper windows must be rolling windows: weekly is 7 days, two-week is 14 days, and monthly is 30 days; use calendar month-to-date only when the operator explicitly requests a calendar-month report
   - keep the dashboard lean: KPI board first, rolling top-10 windows next, then only the highest-signal PRs, corrections, and contract clusters; avoid raw registers or duplicated leaderboards in the default markdown
   - when the operator needs a shareable artifact, export the dashboard PDF through the frontend-owned Playwright printer:
     `cd hushh-webapp && npm run report:contributor-impact:pdf`
   - final PR handoffs should include contributor-impact delta when a PR materially affects trust/security, consent/vault, One/Kai/Nav direction, PKM/memory, user utility, runtime quality, or proof/test posture
37. If a working report contains its own update checklist, treat that checklist as part of the action flow. Do not end the turn while the checklist is stale.
38. If the user asks for a batch, produce a comprehensive overview before recommending any merge order. The overview must make product/runtime purpose, overlap, duplication, domain boundaries, lean/core bloat risk, subagent-delegation decision, flow mode, isolation strategy, contract-set grouping, author-grouping decision, and maintainer-patch batching plan explicit enough that the merge plan is auditable.
39. For DB migration or schema-contract PRs, use this migration-release gate:
   - `merge_now` is allowed only when the SQL migration, release manifest, checked-in schema contract, and local release-contract verification move together
   - `patch_then_merge` is required when a migration exists but the manifest or contract evidence is incomplete
   - `block` is required when the SQL is unsafe for UAT, destructive without an explicit operator plan, or changes a live runtime contract without tests/proof
   - after merge, do not call UAT ready until live `./bin/hushh db verify-uat-schema` is green; if it fails, apply only the missing ordered migration and rerun the guard
   - GitHub comments should keep merge proof and UAT execution proof separate: a PR can be merged to `main` while UAT still needs the runtime DB migration step before deployment is complete
40. For PKM projection, local-first, or cloud-sync PRs, use this memory-authority gate:
   - `merge_now` is allowed only when the PR explicitly preserves the current memory truth model: encrypted domain data and manifests are authoritative, `pkm_index` is discovery-only, and cloud writes are sync/projection updates
   - `patch_then_merge` is required when the code direction is right but the PR lacks on-device/local-cache boundary wording, cache coherence proof, or a test/doc tying the change back to `CacheSyncService` and secure device cache behavior
   - `block` is required when a PR makes cloud metadata the source of truth for user memory, adds plaintext persistence, bypasses vault unlock for protected PKM data, or makes local-only/offline users fail because a cloud projection is unavailable
   - run `cd hushh-webapp && npm run verify:cache` whenever the PR changes PKM write projection, metadata refresh, or cache invalidation behavior, even if the code change is backend-heavy
41. For consent-token commerciality and consent-audit UI PRs, use this trust-visibility gate:
   - `merge_now` is allowed only when new token semantics are enforceable on the critical DB-backed validation path and user-visible audit history comes from existing consent-center/history APIs
   - `patch_then_merge` is required when a good consent direction lacks DB-backed enforcement, durable docs, real history data wiring, or correct placement under the consent/privacy surface
   - `block` is required when the PR ships fake audit records, implies monetized access is enforced without caller use of `require_commercial`, or places consent authority under Kai finance UI as if Kai owns the consent ledger
   - do not accept mock consent grants/revokes on authenticated routes; demo data belongs in tests/stories only and must be impossible to confuse with real consent history
42. Keep calibration deterministic. Historical PR numbers may be useful as examples, but live GitHub PR lifecycle state is not a stable regression test. Prefer local fixtures, checked-in schematic sources, and current generated contracts over hardcoded PR-number behavior.
43. Use the account-export/error-leakage fixture pattern for governance regression:
   - `#498` must classify as `frontend-error-safety` and `patch_then_merge` when `403` permission failures are categorized as authentication.
   - `#505` must classify as `account-export` and `patch_then_merge` when export SQL drifts from checked-in DB contracts, backend/proxy errors leak raw detail, or schema-happy-path tests are missing.
   - `#444` must classify as `account-export` and `harvest_then_close` or `close_duplicate` when `#505` is the smaller canonical base for the same route/service/proxy/frontend contract.
44. Use the same-file sequencing fixture pattern for governance regression:
   - `#531` must classify as `merge_now` for Kai chat startup performance unless current checks regress.
   - `#529` must classify as `patch_then_merge` when it schedules background attribute extraction without explicit exception logging.
   - `#435` must remain a sequential Kai chat safety PR, not a duplicate closure, unless the response-validation behavior already landed on `main`.
   - The operator batch title must explain the purpose as Kai chat service evolution, not a harvest cluster.
45. Use `#446` as the calibration case for voice product-surface duplication:
   - A browser SpeechRecognition/dictation mic in the command palette must classify as `block` while the canonical Kai realtime voice flow already exists.
   - Do not downgrade this to `patch_then_merge` merely because the code only fills a search box; the user-visible product surface still duplicates voice entry.
   - A future accessibility fallback can be considered only after explicit product approval and proof that it shares the canonical vault, voice availability, route eligibility, and copy boundaries.
46. If the PR is clear, say why it is safe in concrete terms: current head SHA, current gate result, current review decision, schematic provenance, blocker count, chosen lane, flow mode, lean/core risk, the result of both verification passes, report-update status, and any remaining residual risk.
47. When explaining this skill to the team in Discord or an internal channel, route the wording through `comms-community` and keep the explanation operator-facing:
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
python3 -m py_compile .codex/skills/pr-governance-review/scripts/build_runtime_schematics.py
python3 -m py_compile .codex/skills/agent-orchestration-governance/scripts/delegation_router.py
python3 .codex/skills/agent-orchestration-governance/scripts/delegation_router.py --workflow pr-governance-review --phase start --prompt "review a PR touching voice, vault, and CI" --paths "hushh-webapp/lib/voice/foo.ts,hushh-webapp/lib/vault/foo.ts,.github/workflows/ci.yml" --text
python3 .codex/skills/pr-governance-review/scripts/build_runtime_schematics.py --text
python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo hushh-labs/hushh-research --prs 498,505,444 --text
python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo hushh-labs/hushh-research --prs 531,529,435 --text
python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo hushh-labs/hushh-research --prs 488,489 --text
python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo hushh-labs/hushh-research --live-report --text
python3 -m py_compile .codex/skills/pr-governance-review/scripts/contributor_impact_report.py
python3 .codex/skills/pr-governance-review/scripts/contributor_impact_report.py --repo hushh-labs/hushh-research --days 7 --text
./bin/hushh codex audit --text
./bin/hushh docs verify
```
