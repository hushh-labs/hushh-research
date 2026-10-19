# pr-governance-review — Anti-Rationalization Table

The excuses an agent makes to skip a review gate, each rebutted from this lane's own contract. Read at intake alongside the truth-first kernel: the kernel checks the CONTRIBUTOR's claims; this table checks YOUR shortcuts.

| Rationalization | Reality |
|---|---|
| "CI is green, so it is mergeable" | Green CI is the entry ticket, not the verdict. The blocker gates (north-star drift, duplicate architecture, trust-boundary regression, unreachable helpers, stacked diff, proof gaps) all pass a green gate silently. workflow.json names "treating green CI as sufficient proof for a sensitive contract change" as a known failure. |
| "The last run I looked at was green" | Stale-vs-current CI interpretation is this lane's core axis. Lock the current head SHA and current CI Status Gate before judging; "reviewing a stale failed run instead of the current head SHA" is failure #1 in workflow.json. |
| "The PR title and description explain what it does" | Titles are claims, not evidence. The governor contract rejects conclusions based on "PR title, memory, or green CI". Read the diff at the locked head. |
| "Only one side of the contract moved, so callers are fine" | "Missing backend-to-caller contract drift because only one side of the change moved" is a named failure. Cross-surface reads are mandatory when a contract file moves. |
| "It's directionally good — merge now, patch later" | The lane order is: direct merge, then maintainer_patch_then_merge, then harvest. "Merging a directionally good but currently unsafe contributor head" skips lane two for convenience. Later never comes on contributor heads. |
| "Approving is basically merging" | Approve-only is NOT implicit merge authority — named failure in workflow.json. Merge is a parent-session action behind the writer-lane gates. |
| "These trains are in one session, run them in sequence" | "Treating independent PR trains as sequential just because they are in the same review session" wastes the async train method. Non-touching trains run in parallel evidence lanes. |
| "This backlog is too big for evidence lanes, I'll skim" | Backlog scale is precisely when router-selected read-only lanes are required; skimming at scale is how malicious or low-signal degradation lands. |
| "I'll thank the contributor now and note issues after" | "Thanking or merging before blocker findings are explicitly cleared" reorders the contract: blockers first, acknowledgement after. |
| "The report can wait until the batch is done" | "Leaving the PR governance live report stale after merge, close, or supersede" breaks the decision record other agents route on. Refresh at each state change. |

## Red Flags

- A merge recommendation citing a run older than the locked head SHA
- A GO verdict with any blocker-gate finding still open in the same report
- A contributor-head merge where the patch-then-merge lane was never evaluated
- A multi-PR session with zero spawned evidence lanes and no recorded checkpoint justifying local-only
- Two or more independent trains executed strictly sequentially with no dependency edge between them
