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

## Required Headings

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

## Contributor Impact Dashboard

Refresh after merge, close, requested-changes, maintainer patch, or revert:

```bash
python3 .codex/skills/pr-governance-review/scripts/contributor_impact_report.py --repo hushh-labs/hushh-research --days 7 --text > tmp/contributor-impact-dashboard.md
```

Use north-star weighted impact, not raw PR count. Keep the dashboard historical and rolling; it may include merged, closed, reverted, and patched PRs.
