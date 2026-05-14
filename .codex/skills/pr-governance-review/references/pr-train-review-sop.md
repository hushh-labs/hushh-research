# PR Train Review SOP

Use this SOP whenever a developer is reviewing more than one PR, deciding the
next merge batch, revisiting `changes_requested` PRs, or trying to increase PR
throughput without weakening merge quality.

The goal is not to merge more PRs blindly. The goal is to turn the open PR
backlog into a deterministic graph where independent work can move in parallel
and dependent work is sequenced only where the dependency is real.

## Operator Promise

Every trained reviewer should be able to:

1. inventory the open PR backlog quickly
2. identify queueable independent PRs
3. separate hard collisions from soft theme similarity
4. find maintainer-patch candidates with canonical attach points
5. issue changes-requested or closure waves without blocking merges
6. monitor queue and smoke asynchronously
7. refresh reports after every state change

## Preflight

Before scanning or acting:

1. Fetch current main.
2. Confirm the local worktree is clean or document every dirty file.
3. Confirm no local dirty file overlaps an open PR under review.
4. Use the latest live report only if it names scan scope and freshness.
5. If the report is stale, regenerate it before giving train advice.
6. For high-volume train work, start the read-only subagent taskforce before
   selecting batches. High-volume means any one of:
   - more than `20` PRs being scanned or discussed
   - more than `5` PRs being acted on in one operator session
   - any mixed frontend/backend/security/devex/observability train
   - any repass of previous `changes_requested`, close, or harvest decisions
   - any request to maximize throughput, scan the backlog, or run async trains

Commands:

```bash
git fetch origin main
git status --short --branch
python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo hushh-labs/hushh-research --live-report --scan-mode hybrid --limit 100 --candidate-limit 40 --text --output tmp/pr-governance-live-report.md
```

## Required Subagent Taskforce

Mass PR train work must use specialist read-only evidence lanes when the runtime
supports subagents. Do not treat subagents as optional for backlog-scale review.
The parent session remains the only authority for branch switching, commits,
GitHub comments, approvals, merges, queue decisions, deploys, report refreshes,
and final recommendations.

Start these default lanes before producing the operator dossier:

1. `frontend/UI reachability`: route/component callers, app-ui ownership,
   visible behavior, accessibility, Playwright-needed proof, and exact-file
   collisions.
2. `backend/runtime trust`: API routes, services, cache behavior, auth,
   consent, vault, PKM, finance, KYC, schema, generated contracts, and runtime
   collision groups.
3. `observability/security`: diagnostic logging, analytics payload boundaries,
   secret-scan risk, data minimization, and public-comment safety.
4. `devex/repo operations`: hooks, setup paths, CI, workflow files, lockfiles,
   docs verification, merge queue, and smoke/report refresh paths.
5. `decision-wave communications`: existing maintainer records, edit-vs-new
   comment posture, closure/request-changes headings, and public hyperlink
   completeness.

Add a sixth lane only when the batch has a real independent surface not covered
above, such as mobile/native parity or founder/north-star product direction.
Avoid one subagent per PR; the unit is an evidence family, not a ticket.

Default mapping: every async train gets its own read-only subagent lane. A
train can contain multiple PRs when they share the same product/runtime family.
Independent trains run at the same time; PRs inside a train are sequenced when
they share files, generated contracts, schema, lockfiles, sensitive runtime, or
queue/main dependencies. Do not collapse multiple independent trains into one
subagent if doing so would hide collisions, comment posture, or proof gaps.

Examples:

1. frontend/UI hold or patch train -> one frontend/UI reachability subagent
2. backend trust/cache train -> one backend/runtime trust subagent
3. observability redaction train -> one observability/security subagent
4. devex hook or dependency train -> one devex/repo-operations subagent
5. changes-requested/closure wave -> one decision-wave communications subagent

Each lane must return:

1. direct PR hyperlinks
2. head SHA and freshness
3. changed files and hard collisions
4. current canonical surface or explicit `no_attach_point`
5. accepted value, dropped/deferred pieces, and smallest proof
6. recommended lane: `queue_cohort`, `sequential_collision_train`,
   `parallel_patch_train`, `decision_wave`, or `hold_rebase`
7. public comment posture: edit existing maintainer record, new record, no
   comment yet, or post-merge closeout
8. unresolved risks and stop conditions

If subagents are unavailable, the operator dossier must state
`Subagent taskforce: unavailable` and manually cover the same lanes. If the work
is high-volume and subagents are available, skipping them is a process violation
unless the parent records a concrete blocker such as a runtime outage.

## Scan Modes

Use the smallest scan that answers the question.

| Mode | Command Shape | Use When | Expected Output |
| --- | --- | --- | --- |
| Active | `--scan-mode active --limit 100` | latest-window triage or fast review | latest PRs only, no all-open inventory |
| Hybrid | `--scan-mode hybrid --limit 100 --candidate-limit 40` | default operator train planning | all-open inventory plus active deep review and older high-signal PRs |
| Wide Hybrid | `--scan-mode hybrid --limit 150 --candidate-limit 75 --per-pr-timeout-seconds 8` | backlog sweep when the operator asks for more trains | larger reviewed subset with bounded latency |
| Full Audit | `--scan-mode full --per-pr-timeout-seconds 5` | scheduled audit, not interactive chat | every open PR attempted, with explicit failures/timeouts |

If GitHub or a per-PR scan fails, the report must say:

1. total open PRs inventoried, if known
2. reviewed PRs
3. failed PRs
4. whether the result is complete, partial, or fallback-only

Do not imply the whole backlog was audited when only a subset was reviewed.

## Check Failure Intake Filter

Do not spend train-construction time on PRs whose current checks are not clean.
This is the first filter before queue, patch, collision, or decision-wave
planning.

A PR is excluded from executable trains when any of these are true:

1. required `CI Status Gate` is missing, pending, skipped, cancelled, failing, or unknown
2. required `CI Status Gate` is green but a current auxiliary check is failing
3. the PR is behind with failing checks and needs contributor rebase/regeneration
4. the only actionable work is to repair CI, and the operator did not ask for a CI-fix train

Excluded PRs go into `Check Failure Holds` or the blocked/waiting register. They
do not appear in `Queue Cohort`, `Sequential Collision Train`, `Parallel Patch
Trains`, `Decision Waves`, or `Recommended Operator Batches`. Revisit them only
after checks are clean or after the operator explicitly asks to debug/fix CI.

## Train Graph

Build trains from hard dependency edges, not vibes.

Hard edges force sequencing:

1. exact file overlap
2. lockfile overlap
3. schema, migration, or generated-contract overlap
4. same sensitive runtime family
5. same public route, backend route, auth, consent, vault, PKM, voice, finance, KYC, deploy, or CI authority surface
6. local dirty-file overlap
7. a PR that is stacked, conflicting, or stale against current main

Soft edges do not block parallelism by themselves:

1. same author
2. same broad theme
3. similar title wording
4. nearby UI area without file/runtime collision
5. both being test-only changes with disjoint files

## Lanes

Classify every reviewed PR into exactly one lane.

| Lane | Meaning | Can Run Async? |
| --- | --- | --- |
| Queue Cohort | independent `merge_now` PRs, max 4 at once | yes, as one cohort |
| Sequential Collision Train | PRs with hard edges | no, one at a time |
| Parallel Patch Train | maintainer patches with disjoint write sets and proven attach points | yes, up to 3 by default |
| Decision Wave | changes-requested or closure comments for blocked PRs | yes, while queue validation runs |
| Hold/Rebase | conflicts, stale branches, unclear product intent, or missing proof | no merge action |
| Check Failure Hold | non-green required gate or failing current auxiliary check | no train action |

## Queue Cohort Rules

A PR can enter a queue cohort only when all are true:

1. exact head SHA is locked
2. required `CI Status Gate` is green on that head
3. no current auxiliary check is failing
4. PR is non-draft
5. mergeability is clean
6. no hard collision edge with another cohort PR
7. no local dirty-file overlap
8. no active requested-changes state that still matters
9. no trust-boundary, generated-contract, schema, or reachability blocker

Queue cohorts are capped at 4. Do not wait for unrelated PRs just because one
cohort member is in queue validation. While queue checks run, prepare the next
independent cohort or a decision wave.

## Maintainer Patch Gate

Prefer maintainer patch over contributor round trip when the direction is
aligned and the patch is bounded.

Patch is allowed only when the reviewer can name:

1. accepted value
2. canonical attach point
3. exact maintainer write set
4. dropped or deferred pieces
5. smallest proof command

Patch is denied when:

1. code is standalone and only used by its own tests
2. the PR creates a parallel root for an existing capability
3. no current app, backend, package, route, generated contract, test contract,
   or documented devex entrypoint uses it
4. the maintainer would need to invent product intent to save it

Denied patch candidates become `changes_requested`, `hold`, or
`harvest_then_close`, depending on whether there is useful value to preserve.

## Contributor Attribution Gate

Maintainer harvests must enable contributors, not erase them.

Before opening or committing a maintainer-harvest PR:

1. Prefer direct contributor PR merge when the PR is clean, scoped, green,
   canonical, and safe.
2. For every harvested source PR, classify the reused material as:
   - `code_or_test_reused`: actual contributor implementation or test logic is
     materially copied, translated, or normalized into the landing patch
   - `idea_or_direction_used`: the PR helped identify the right fix, but the
     landing implementation is independently authored by the maintainer
   - `not_used`: reviewed but not part of the landing patch
3. For `code_or_test_reused`, add valid `Co-authored-by:` trailers to the
   actual landing commit before merge. Use public GitHub no-reply identities
   only after verifying the contributor's public GitHub user id; never expose
   private emails.
4. For `idea_or_direction_used`, do not add co-author trailers. Add the source
   PR to `## Contributor Acknowledgements` in the PR body and source-PR
   closeout.
5. For `not_used`, list the PR only under dropped/deferred/held work, not as a
   credited harvest source.

Maintainer-harvest PR bodies must include:

1. `## Contributor Acknowledgements`
2. direct source PR link
3. source author
4. accepted value
5. attribution class: `code_or_test_reused`, `idea_or_direction_used`, or
   `not_used`
6. whether official GitHub commit credit is expected
7. dropped or deferred pieces

Past maintainer harvests must not rewrite `main` to backfill GitHub graph
credit. The fair retroactive path is:

1. preserve or add public acknowledgement on the landing PR
2. keep source PR closeouts contributor-enabling
3. update the contributor-impact dashboard with `harvested_source` internal
   credit for source PRs whose value landed through a maintainer patch
4. if the operator explicitly requests external GitHub credit, add a
   transparent follow-up PR with a real, non-empty co-authored harvest replay or
   supplemental harvest patch plus an auditable ledger entry; do not claim this
   changes the original merge commit's authorship or additions/deletions

## Developer Operating Loop

Use this loop for every review session:

1. Refresh or generate the live report.
2. Convert the candidate batches into an async train map.
3. Start one read-only subagent lane per async train/evidence family for
   high-volume train work, or record why a lane is unavailable.
4. Read `Check Failure Holds` first, then ignore those PRs for train planning
   unless the session is explicitly a CI repair pass.
5. Read `Queue Cohort`, `Collision Groups`, `Parallel Patch Trains`, and
   `Decision Waves`.
6. If the report found no executable batches, manually inspect the top blocked
   PRs for possible maintainer-patch attach points.
7. Pick the next executable train with the highest value and lowest collision.
8. Produce the operator dossier from `operator-batch-output-contract.md`.
9. Ask only decision questions that cannot be answered from repo or GitHub
   truth.
10. Execute approved GitHub writes by editing existing maintainer records first.
11. For merges, enqueue with exact head SHA and monitor queue validation.
12. After merge, monitor Main Post-Merge Smoke.
13. Refresh the live report and contributor-impact dashboard.
14. Start the next independent train while checks for unrelated work are still
    running.

## Required Dossier For Chat Handoffs

Every developer-facing train recommendation must include:

1. scan scope and completeness
2. delegation router result, async train-to-subagent map, taskforce lanes
   used/skipped/unavailable, lane handoff summaries, fallback evidence if a
   lane was unavailable, and the parent-only authority statement
3. queue cohort, even if empty
4. collision groups and sequence
5. parallel patch trains and exact write sets
6. decision waves and comment posture
7. check-failure holds that were excluded from train planning
8. direct PR links for every PR mentioned
9. per-PR head SHA, mergeability, CI gate, changed files, and lane
10. accepted value, attach point, dropped/deferred pieces, and proof for every
   maintainer patch
11. stop conditions
12. report refresh commands

Do not give a train recommendation as only a list of PR numbers.

## GitHub Write Rules

1. Inspect existing maintainer-authored comments and reviews first.
2. Edit the existing current-lane maintainer record when possible.
3. Post a new comment only when no existing maintainer record exists, the old
   record cannot be edited, or the new record is for a distinct state.
4. Use direct PR hyperlinks in public and internal handoffs.
5. After a merge, post exactly one closeout comment after Main Post-Merge Smoke
   passes.

## Stop Conditions

Stop, split the train, or re-run the scan when:

1. any head SHA changes
2. CI Status Gate changes from green to pending/failing/stale
3. mergeability changes to dirty/conflicting
4. a new hard edge appears
5. a UI-visible change lacks required Playwright/browser evidence
6. a trust boundary, schema, migration, generated contract, auth, consent,
   vault, PKM, voice, finance, KYC, deploy, or CI surface is unclear
7. the scanner reports incomplete scope that affects the proposed train
8. the maintainer patch no longer has a canonical attach point

## Post-State-Change Refresh

After merge, close, request changes, maintainer patch, or revert:

```bash
python3 .codex/skills/pr-governance-review/scripts/pr_review_checklist.py --repo hushh-labs/hushh-research --live-report --scan-mode hybrid --limit 100 --candidate-limit 40 --text --output tmp/pr-governance-live-report.md
python3 .codex/skills/pr-governance-review/scripts/contributor_impact_report.py --repo hushh-labs/hushh-research --days 14 --text > tmp/contributor-impact-dashboard.md
```

If GitHub returns transient errors, retry once. If it still fails, run a bounded
fallback scan, preserve the previous complete report, and state the failure in
the handoff.
