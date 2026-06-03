# Comment And Report Contract

Use this reference for GitHub write actions, post-merge closeouts, live report updates, and contributor-impact updates.

## GitHub Comment Rules

1. First line must be a markdown headline: `## <Decision>: <contract or outcome>`.
2. Keep sections short and external-facing.
3. Do not publish maintainer-only sequencing, report status, CI dumps, or internal governance reminders.
4. Do not post noisy approval comments. Every PR merged through PR governance gets one post-merge record after `Main Post-Merge Smoke` is green.
5. Post before merge only for `block`, `changes_requested`, `comment_only`, or when contributor action is required.
6. Before posting, inspect existing maintainer-authored comments and reviews. Edit the current maintainer record when possible; do not create duplicate or contradictory comments.
7. Prefer low-friction maintainer patching when the PR is aligned, bounded, and maintainers can safely resolve it without changing product intent.
8. Use changes-requested when the PR needs contributor clarity, split/rebase, proof the maintainer cannot supply, or direction correction.
9. A maintainer harvest is not a merge approval. If the exact PR head should not land, use the `Changes Requested` or `Closed / Superseded` shape and say what was harvested or what should be resubmitted.
10. In a repass or correction wave, edit the existing maintainer-authored
    review/comment instead of posting a new record, unless the existing record
    is not editable or a distinct review-state action is required.
11. Repass/correction waves must normalize editable maintainer records to the
    current lane template. Do not leave older free-form requested-changes
    records in place when the wave is specifically correcting comment posture.
12. Edit maintainer records in this order: issue comments with
    `PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}`, then PR review
    summaries with `PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}`.
    If the edit returns `403`, `404`, or `422`, record `edit_unavailable` in
    the operator dossier and post exactly one lane-specific replacement comment
    or review. Do not retry into duplicate public records.
13. Treat `## Maintainer harvest staged` and `## Maintainer patch staged` as
    standardized maintainer records for actionable-intake filtering. A PR with
    one of these current records does not re-enter a merge lane until the head,
    checks, mergeability, or contributor activity changes after that record.

## Maintainer Patch Preference

Before using the `Changes Requested` heading, Codex must check whether the
change can be resolved as a maintainer patch. If Codex can name the accepted
value, canonical attach point, patch files, dropped/deferred pieces, and
smallest proof command, prefer `maintainer_patch_then_merge` or
`maintainer_harvest` over asking the contributor to redo the branch.

Prefer `maintainer_patch_then_merge` over `maintainer_harvest` when the source
PR can be safely used as the merge vehicle. Use `maintainer_harvest` only when
the source PR head should not land directly, or cannot practically be made safe
without turning it into a maintainer-owned rewrite.

For legacy generated reports, prefer `patch_then_merge` over contributor round trips
when a maintainer can safely name the accepted value, attach point, write set,
deferred pieces, and proof.

Every harvest public record must name:

1. what was accepted
2. where it landed or will land
3. whether the landing commit has `Co-authored-by:` credit
4. why the source PR is not being merged directly
5. whether the source PR remains open for contributor action or will be closed
   as superseded after the landing commit reaches `main`

## Required Headings

Every PR merged through this governance workflow must get one post-merge closeout after `Main Post-Merge Smoke` is green.
Every GitHub write must use the lane-specific heading contract below.
Edit the existing current-lane record when possible.
Final handoffs for state-changing PR work must include direct links to every affected PR and maintainer-authored record.

prefer `maintainer_patch_then_merge` over contributor round trips when the maintainer can
name a safe accepted value, canonical attach point, write set, dropped/deferred
pieces, and proof.

Do not include a separate successful-merge evidence section such as `### Proof`
or `### Verification`; GitHub owns check evidence.

Approval reviews that are required only to satisfy branch protection must be
short, parent-authored, and posted only by a configured maintainer after the
Exact-Head Queue Safety gate passes. Do not follow them with separate approval
comments. Treat an `APPROVED` review as current only for that head SHA, check
state, mergeability state, and contributor activity state.

## Lane To Comment Map

Use this table before every GitHub write. It is the canonical mapping from the
internal lane/action to public comment timing and heading.

| Lane or action | Comment plan | Timing | Default write behavior | Required heading |
| --- | --- | --- | --- | --- |
| `merge_now` | `none_before_merge_then_post_merge_closeout` | after Main Post-Merge Smoke passes | post one closeout; do not post approval noise | `## Merged: <contract or outcome>` |
| `maintainer_patch_then_merge` (`patch_then_merge` in legacy generated reports) | `none_before_merge_then_post_merge_closeout` | after patched head merges and smoke passes | post one closeout with `### Maintainer Patch` | `## Merged: <contract or outcome>` |
| `maintainer_harvest` | `new_changes_requested_comment` or source closeout | before source PR is closed or left blocked | edit existing maintainer record first; explain what was harvested | `## Changes Requested: <blocker>` or `## Closed: <reason>` |
| `harvest_then_close` | `new_closed_superseded_comment` | before close | edit existing maintainer record first; name accepted value and landing link | `## Closed: <reason>` |
| `close_duplicate` | `new_closed_superseded_comment` | before close | edit existing maintainer record first; link the surviving PR/path | `## Closed: <reason>` |
| `block` | `new_changes_requested_comment` | before merge; no approval | edit existing maintainer record first; contributor path required | `## Changes Requested: <blocker>` |
| `comment_only` | lane-specific comment | when a public record is needed but no state changes | edit existing maintainer record first | one of the three required headings |
| `review_only` | `no_comment_review_only` | no GitHub write | no public comment | none |

`### Proof Needed` is allowed only inside `## Changes Requested`. Merge
closeouts must not add `### Proof` or `### Verification`; GitHub already owns
check evidence.

## Templates, Reporting, And Handoff

Use `comment-templates-and-reporting.md` for lane templates, prohibited
headings, live-report rules, handoff-link rules, and contributor-impact
dashboard refreshes. Keep this file as the compact write-policy entrypoint.

Template markers retained for lint and operators: `## Merged: <contract or
outcome>` uses `### Why It Matters`; `## Changes Requested: <blocker>` uses
`### Proof Needed`; `## Closed: <reason>` uses the closed/superseded shape.
Every `## Changes Requested` record must include exactly these public sections:
Direction, Blocker, Path To Merge, and Proof Needed.

After every state-changing wave, the chat handoff must include affected PR
links, public record links, what changed, what stayed held, refreshed report
links or explicit `not refreshed` reason, and the recommended next train.
