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

## Maintainer Patch Preference

Before using the `Changes Requested` heading, Codex must check whether the
change can be resolved as a maintainer patch. If Codex can name the accepted
value, canonical attach point, patch files, dropped/deferred pieces, and
smallest proof command, prefer `maintainer_patch_then_merge` or
`maintainer_harvest` over asking the contributor to redo the branch.

## Required Headings

Every PR merged through this governance workflow must get one post-merge closeout after `Main Post-Merge Smoke` is green.
Every GitHub write must use the lane-specific heading contract below.
Edit the existing current-lane record when possible.
Final handoffs for state-changing PR work must include direct links to every affected PR and maintainer-authored record.

prefer `patch_then_merge` over contributor round trips when the maintainer can
name a safe accepted value, canonical attach point, write set, dropped/deferred
pieces, and proof.

Do not include a separate successful-merge evidence section such as `### Proof`
or `### Verification`; GitHub owns check evidence.

## Lane To Comment Map

Use this table before every GitHub write. It is the canonical mapping from the
internal lane/action to public comment timing and heading.

| Lane or action | Comment plan | Timing | Default write behavior | Required heading |
| --- | --- | --- | --- | --- |
| `merge_now` | `none_before_merge_then_post_merge_closeout` | after Main Post-Merge Smoke passes | post one closeout; do not post approval noise | `## Merged: <contract or outcome>` |
| `patch_then_merge` | `none_before_merge_then_post_merge_closeout` | after patched head merges and smoke passes | post one closeout with `### Maintainer Patch` | `## Merged: <contract or outcome>` |
| `maintainer_harvest` | `new_changes_requested_comment` or source closeout | before source PR is closed or left blocked | edit existing maintainer record first; explain what was harvested | `## Changes Requested: <blocker>` or `## Closed: <reason>` |
| `harvest_then_close` | `new_closed_superseded_comment` | before close | edit existing maintainer record first; name accepted value and landing link | `## Closed: <reason>` |
| `close_duplicate` | `new_closed_superseded_comment` | before close | edit existing maintainer record first; link the surviving PR/path | `## Closed: <reason>` |
| `block` | `new_changes_requested_comment` | before merge; no approval | edit existing maintainer record first; contributor path required | `## Changes Requested: <blocker>` |
| `comment_only` | lane-specific comment | when a public record is needed but no state changes | edit existing maintainer record first | one of the three required headings |
| `review_only` | `no_comment_review_only` | no GitHub write | no public comment | none |

`### Proof Needed` is allowed only inside `## Changes Requested`. Merge
closeouts must not add `### Proof` or `### Verification`; GitHub already owns
check evidence.

### Post-Merge Without Maintainer Patch

```markdown
## Merged: <contract or outcome>

### What Landed
...

### Why It Matters
...

### Outcome
...
```

### Post-Merge With Maintainer Patch

```markdown
## Merged: <contract or outcome>

### What Landed
...

### Why It Matters
...

### Maintainer Patch
...

### Outcome
...
```

Add `### Documentation Updated` only when durable docs changed.

For `### Maintainer Patch`, do not write only that maintainers "normalized" or "patched" the PR. Explain the conversion:

1. what useful original capability was kept
2. what moved into existing canonical docs, scripts, routes, packages, or runtime owners
3. what was dropped or deferred because it would create a parallel root, duplicate runtime, or unrelated product decision
4. why the maintainer patch was lower-friction than asking the contributor to redo the branch
5. where the accepted usage now lives

### Changes Requested

```markdown
## Changes Requested: <blocker>

### Direction
...

### Blocker
...

### Path To Merge
...

### Proof Needed
...
```

Use this shape when the right answer is contributor clarity, a split/rebase, proof the maintainer cannot supply, or direction correction. If the PR is aligned and maintainers can safely apply the bounded fix, prefer the maintainer-patch path instead.

Every `## Changes Requested` record must include exactly these public sections
in this order:

1. `### Direction`
2. `### Blocker`
3. `### Path To Merge`
4. `### Proof Needed`

For correction waves, existing maintainer records missing these sections must
be edited into this shape before the wave is considered complete.

### Closed / Superseded

```markdown
## Closed: <reason>

### Decision
...

### What We Kept
...

### Decision Basis
...
```

## Prohibited New Headings

Do not use these in new or edited PR comments:

1. `### Merge Confidence`
2. `### Proof`
3. `### Verification`
4. maintainer-only `### Next`

GitHub already shows merge checks. Public comments should explain what landed, why it matters, and the new steady state.

## Live Report Rules

`tmp/pr-governance-live-report.md` is live-only:

1. Include all open PRs, including drafts.
2. Remove merged and closed PRs.
3. Keep `Recommended Operator Batches` as the execution source for next-batch answers.
4. Include per-PR assessments: head SHA, required gate, review decision, mergeability, contract set, lane, lean/core risk, findings, overlap, related surfaces, decision rationale, live-report action, public-comment policy, and next proof.
5. Keep terminal queue/smoke evidence out of the live report.

## Handoff Link Rules

1. Every final handoff after merge, close, requested-changes, maintainer patch,
   or revert must hyperlink every affected PR.
2. Every posted or edited maintainer record must be linked when available.
3. Counts are useful only after the linked list is present. Do not replace a
   linked list with a count such as `49 reviews posted`.
4. For large waves, group links by action and keep each row compact; do not
   omit links for brevity.
5. After every state-changing wave, the chat handoff must include:
   affected PR links, public record links, what changed, what stayed held,
   why no merge/patch happened if applicable, refreshed report/dashboard status,
   and the recommended next async train.
6. For async train passes, the handoff must separate `reviewed`, `acted`,
   `terminal`, `blocked`, and `remaining` with direct PR links in every bucket.

## Contributor Impact Dashboard

Refresh after merge, close, requested-changes, maintainer patch, or revert:

```bash
python3 .codex/skills/pr-governance-review/scripts/contributor_impact_report.py --repo hushh-labs/hushh-research --days 14 --text > tmp/contributor-impact-dashboard.md
```

Use north-star weighted impact, not raw PR count. Keep the dashboard historical and rolling; it may include merged, closed, reverted, and patched PRs.
The primary leaderboard is a 14-day rolling window, the weekly top 10 remains visible, and the overall leaderboard covers all resolved PR history available from GitHub with an explicit coverage audit.
