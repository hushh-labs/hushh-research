# Operator Batch Output Contract

Use this when answering "next batch", "plan this batch", or any high-volume PR wave question.

## Required Chat Shape

1. `Batch`: one sentence naming the product/runtime purpose.
2. `Research Basis`: concise current truth, recommended path, and risk if accepted blindly.
3. `Input`: every PR with a direct Markdown link and current lane.
4. `Per-PR Role`: one compact line per PR:
   - direct link
   - lane
   - lean/core risk
   - current head SHA prefix
   - why it is in the batch
   - planned action: merge, patch/rebase, harvest/close, request changes, or hold
5. `Output`: intended end state if the batch is legitimate.
6. `Execution`: exact order, split by merge train, patch train, closure/request-changes wave, and hold/deep-review items.
7. `Decision Questions`: only unresolved user-owned choices, each with current truth, recommended path, risk if accepted blindly, and recommended option first.
8. `Stop Conditions`: what pauses, splits, or blocks the batch.
9. `Verification`: smallest authoritative local and GitHub checks.

## Batch Selection Rules

1. Use `Recommended Operator Batches` before `Contract Intake Sets`.
2. Exact file overlap creates sequencing, not duplicate closure.
3. Same broad contract label is not enough to batch.
4. Same author is a convenience only after product/runtime contract grouping.
5. Batch can mean merge train, patch train, close wave, request-changes wave, or deep-review wave.
6. Do not mix independent high-risk runtime decisions just to increase throughput.

## Good Output Standard

The operator should understand:

1. what this batch is actually about
2. why each PR is present
3. what will happen to each PR
4. what will be tested
5. what would make Codex stop
6. how the live report and contributor-impact dashboard will be updated

Avoid generic phrasing such as "review these together" without per-PR roles.
Do not ask the operator to choose before showing the researched solution path.
