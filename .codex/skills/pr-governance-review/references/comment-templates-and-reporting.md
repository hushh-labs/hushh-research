# Comment Templates And Reporting

Use this reference after `comment-and-report-contract.md` selects the public
write lane.

## Communication Personality (applies to every contributor-facing write)

Hussh PR governance speaks to contributors as a mentor, not a gatekeeper. Every
public comment — merge, changes-requested, or close — must leave the contributor
knowing exactly what happened, why, and what a great next step looks like. Hold
this voice on every record:

1. `Lead with genuine, specific appreciation.` Name the real value in their work
   ("the temporal-expiry guard is exactly the right instinct"), not a generic
   "thanks for the PR". If nothing is salvageable, still respect the effort.
2. `Be unambiguous about the decision.` The contributor must never wonder whether
   they are merged, need to act, or are closed. State it plainly in the heading
   and the first line.
3. `Explain the why from repo truth, not preference.` Tie the blocker to a
   concrete contract, file, trust boundary, or test — link it — so the feedback
   teaches the codebase, not just this PR.
4. `Make the next step concrete and achievable.` Give the smallest real path to
   merge: the exact file/contract to attach to, the guard to add, the test to
   evolve. Prefer "do X on file Y and assert Z" over "narrow the scope".
5. `Encourage continuation.` End change-requests and closures with a sincere
   invitation to keep contributing and, where true, point to which of their
   other PRs are landing well. Contributors should leave motivated, not deflated.
6. `Be honest and firm without being harsh.` When a boundary (regulated advice,
   consent, vault, security) is non-negotiable, say so clearly and kindly, and
   explain the principle so they internalize it for next time. Repeated
   submissions of the same boundary violation get firmer clarity, never sarcasm.
7. `Never leak internal governance.` No lane names, queue mechanics, scanner
   findings, CI dumps, or maintainer sequencing in public comments — translate
   them into plain contributor-facing language.
8. `Credit fairly.` When work is harvested or co-authored, say so and link the
   landing commit/PR; never let a contributor wonder if their work was used.

The headings and required sections below are fixed; this personality governs HOW
the prose inside them reads. Direction/Why-it-matters sections carry the warmth
and the teaching; Blocker/Path-To-Merge/Proof sections carry the precise,
actionable engineering guidance.

## Post-Merge Without Maintainer Patch

```markdown
## Merged: <contract or outcome>

### What Landed
...

### Why It Matters
...

### Outcome
...
```

## Post-Merge With Maintainer Patch

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

For `### Maintainer Patch`, explain:

1. what useful original capability was kept
2. what moved into existing canonical docs, scripts, routes, packages, or runtime owners
3. what was dropped or deferred because it would create a parallel root, duplicate runtime, or unrelated product decision
4. why the maintainer patch was lower-friction than asking the contributor to redo the branch
5. where the accepted usage now lives

## Changes Requested

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

Use this shape when the right answer is contributor clarity, a split/rebase,
proof the maintainer cannot supply, or direction correction. If the PR is
aligned and maintainers can safely apply the bounded fix, prefer the
maintainer-patch path instead.

Every `## Changes Requested` record must include exactly these public sections
in this order:

1. `### Direction`
2. `### Blocker`
3. `### Path To Merge`
4. `### Proof Needed`

For correction waves, edit current maintainer records missing these sections
into this shape before the wave is complete.

## Closed Or Superseded

```markdown
## Closed: <reason>

### Decision
...

### What We Kept
...

### Decision Basis
...
```

## Maintainer Harvest Still Open

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

For harvested PRs, `### Path To Merge` must link the maintainer landing PR or
commit when available. If the landing commit is not merged to `main` yet, keep
the source PR open and state that it remains open until the contributor updates
it or the co-authored maintainer landing reaches `main`.

## Prohibited New Headings

Do not use these in new or edited PR comments:

1. `### Merge Confidence`
2. `### Proof`
3. `### Verification`
4. maintainer-only `### Next`

GitHub already shows merge checks. Public comments should explain what landed,
why it matters, and the new steady state.

## Live Report Rules

`tmp/pr-governance-live-report.md` is live-only:

1. Include all open PRs, including drafts.
2. Remove merged and closed PRs.
3. Keep `Recommended Operator Batches` as the execution source for next-batch answers.
4. Include per-PR assessments: head SHA, required gate, review decision, mergeability, contract set, lane, risk, findings, overlap, related surfaces, decision rationale, live-report action, public-comment policy, and next proof.
5. Keep terminal queue/smoke evidence out of the live report.

## Handoff Link Rules

1. Every final handoff after merge, close, requested-changes, maintainer patch,
   or revert must hyperlink every affected PR.
2. Every posted or edited maintainer record must be linked when available.
3. Counts are useful only after the linked list is present.
4. For large waves, group links by action and keep each row compact.
5. After every state-changing wave, the chat handoff must include affected PR
   links, public record links, what changed, what stayed held, refreshed report
   links or explicit `not refreshed` reason, and the recommended next train.
6. For async train passes, separate `reviewed`, `acted`, `terminal`, `blocked`,
   and `remaining` with direct PR links in every bucket.

## Contributor Impact Dashboard

Refresh after merge, close, requested-changes, maintainer patch, or revert:

```bash
python3 .codex/skills/pr-governance-review/scripts/contributor_impact_report.py --repo hushh-labs/hushh-research --days 14 --text > tmp/contributor-impact-dashboard.md
```

Use north-star weighted impact, not raw PR count. Keep the dashboard historical
and rolling; it may include merged, closed, reverted, and patched PRs.
