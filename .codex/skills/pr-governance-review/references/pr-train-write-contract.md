# PR Train Write Contract

Use this reference after `pr-train-review-sop.md` has selected actionable
trains.

## Parent Writer Envelope

Allowed after operator approval, in the parent session only: edit or post
standardized maintainer reviews/comments, request changes, close superseded PRs,
acknowledge harvest, and queue exact-head PRs when green, clean, non-draft, and
edge-free. Evidence subagents are not writer lanes.

Drift, stale heads, new conflicts, failing checks, changed review state, or lost
attach points stop the write and return the PR to a repass lane.

Explicit operator language such as "go ahead", "run async PR trains", "resolve
end to end", or "do not wait on me" is standing approval for bounded
SOP-compliant writes inside the current confirmed scope. It does not authorize
scope expansion, destructive repository operations, secret exposure, deploys, or
ambiguous product/security decisions.

## Wave Means Checkpoint

`Wave` means the next operator-approved state-changing checkpoint across already
running trains, not "only work on this small batch."

1. `Train`: the full hard-edge PR sequence for one surface; one evidence lane.
2. `Parallel train set`: all non-touching trains running across lanes/subagents.
3. `Wave`: bounded writes, maintainer patches, queue actions, closes, or merges.

Approval applies to the reviewed train set, not just the first train.

## Scan Modes

1. `active`: latest window only.
2. `hybrid`: default; all-open inventory plus latest `100` and up to `40` older high-signal candidates.
3. `full`: audit mode only; attempt every open PR with timeout.

If scanning fails, state inventoried/reviewed/failed PRs and whether the result
is complete, partial, or fallback-only.

## Hundred-PR Active Pass Standard

For 400+ PR backlogs, the default pass is the oldest `100` reviewable PRs plus
hybrid high-signal candidates. A queue cohort is progress, not completion.
Report open/reviewed counts, trains, terminal PRs by action, and non-terminal
train/blocker/next action until all reviewed PRs are terminal or blocked.

For refill passes, preserve each tranche report and exclude prior reviewed
tranches with repeated `--exclude-prs-file` flags or a glob, for example
`--exclude-prs-file tmp/pr-governance-live-report.md --exclude-prs-file 'tmp/pr-governance-refill-*-report.md'`.

Do not overwrite the only copy of a previous tranche before the next refill has
used it as an exclusion source.

## Check Failure Intake Filter

Exclude PRs from executable trains when `CI Status Gate` is missing, pending,
skipped, cancelled, failing, unknown, or green while a current auxiliary check
fails. Show them only in `Check Failure Holds` unless this is CI repair.

## Post-Changes Repass Train

Contributor commits or non-maintainer comments newer than the latest maintainer
`changes_requested` record create a repass train. Re-enter only PRs with a
current green `CI Status Gate`; failing/missing gates stay in holds.

Do not re-review unchanged PRs just because they remain open with
`CHANGES_REQUESTED`. If there is no contributor activity or material state
change after the latest standardized maintainer record, keep the PR in
`Dormant Current Holds`.

## Train Graph

1. exact file overlap
2. lockfile overlap
3. schema, migration, or generated-contract overlap
4. same sensitive runtime family
5. same concrete public route, backend route file, auth/consent/vault/PKM/voice/finance/KYC module, deploy surface, or CI authority surface
6. local dirty-file overlap
7. stacked, conflicting, or stale branch state

Soft edges such as same author, broad sensitive-runtime family, broad theme,
similar title, or nearby UI area do not block parallelism by themselves.

## Lanes

1. `Queue Cohort`: independent `merge_now` PRs, default `4`.
2. `Sequential Collision Train`: hard-edge PRs, one at a time.
3. `Parallel Patch Train`: disjoint maintainer patches with proven attach points, max `3`.
4. `Decision Wave`: changes-requested or closure comments while queue validation runs.
5. `Hold/Rebase`: conflicts, stale branches, unclear intent, or missing proof.
6. `Check Failure Hold`: non-green required gate or failing auxiliary check.

## Pre-Wave Operator Question

Before every state-changing checkpoint, ask one researched operator question:

1. `Current truth`: scan freshness, reviewed/open counts, wave type, PR links, and excluded check-failure holds.
2. `Recommended path`: train set, checkpoint size, comment/edit posture, and expected artifact.
3. `Risk if accepted blindly`: stale heads, changed CI, unsafe edits, noisy comments, or unfair attribution.
4. `Decision needed`: approve the checkpoint, reduce/split it, or refresh first.

Do not ask the operator to find facts Codex can verify.

## Dynamic Decision Wave Sizing

1. `5` PRs for high-risk mixed runtime, security, consent, vault, PKM, voice, finance, or policy waves.
2. `10` PRs for mixed-topic acknowledgement/comment waves.
3. `20` PRs for normal homogeneous acknowledgement or changes-requested waves.
4. `40` PRs only for low-risk, same-template, same-surface acknowledgement waves with clean evidence.
5. `0` PRs when the live report is stale, incomplete, or current records cannot be edited safely.

## Maintainer Patch Gate

Prefer landing through the contributor PR when it is safe. Maintainer patch is
allowed only with accepted value, canonical attach point, exact write set,
dropped/deferred pieces, and smallest proof.

Use this order for useful aligned PRs:

1. `merge_now`: contributor head is green, current, clean, reachable, and safe.
2. `maintainer_patch_then_merge`: contributor PR is the right merge vehicle and a bounded patch can make it safe.
3. `maintainer_harvest`: exact PR head is not safe or practical, but a useful bounded slice can land separately.
4. `request_changes`: accepted value, attach point, proof, or trust boundary needs contributor work.

If generated reports still emit `patch_then_merge`, treat it as
`maintainer_patch_then_merge`.

Choosing `maintainer_harvest` over `maintainer_patch_then_merge` requires an
explicit reason in the dossier.

Before requesting changes, evaluate whether the useful contribution can be
harvested or patched into a current canonical surface.

## Attribution Gate

Prefer direct contributor PR merge when safe. For maintainer harvests, add
`Co-authored-by:` only when code or tests are materially reused in the landing
commit. Never rewrite `main` for retroactive co-author credit.

Harvest completion requires a linked landing PR/commit, co-author trailers when
material code/tests are reused, clear source PR state, dashboard credit, and a
final handoff linking the source PR, public record, and landing PR/commit.

## Contributor Feedback Loop

When repeated contributor-side blockers appear, tighten
`docs/reference/quality/pr-contributor-readiness.md` and mirror actionable
submission-time checklist items in `.github/pull_request_template.md`.
