# Operator Batch Output Contract

Use this when answering "next batch", "plan this batch", or any high-volume PR wave question.

## Required Chat Shape

1. `Batch`: one sentence naming the product/runtime purpose.
2. `Research Basis`: concise current truth, recommended path, and risk if accepted blindly.
3. `Input`: every PR with a direct Markdown link and current lane.
4. `Per-PR Assessment`: one compact but complete block per PR:
   - direct link
   - lane
   - lean/core risk
   - current head SHA prefix
   - what changed or which surface is touched
   - why it is in the batch
   - `Blind-merge risk`: likely failure mode if accepted blindly
   - planned action: merge, patch/rebase, harvest/close, request changes, or hold
   - `Smallest proof`: smallest authoritative check before that action
5. `Output`: intended end state if the batch is legitimate.
6. `Execution`: exact order, split by merge train, patch train, closure/request-changes wave, and hold/deep-review items.
7. `Decision Questions`: only unresolved user-owned choices, each with current truth, recommended path, risk if accepted blindly, and recommended option first.
8. `Stop Conditions`: what pauses, splits, or blocks the batch.
9. `Verification`: smallest authoritative local and GitHub checks.
10. `After-Merge Kickoff`: how the next independent train will be discovered after report refresh.

## Batch Selection Rules

1. Use `Recommended Operator Batches` before `Contract Intake Sets`.
2. Exact file overlap creates sequencing, not duplicate closure.
3. Same broad contract label is not enough to batch.
4. Same author is a convenience only after product/runtime contract grouping.
5. Batch can mean merge train, patch train, close wave, request-changes wave, or deep-review wave.
6. Do not mix independent high-risk runtime decisions just to increase throughput.
7. A merge train can proceed while the next independent batch is reviewed, but two dependent trains must not merge concurrently.
8. "Automatic next train" means automatic next-train discovery and review preparation; approval, merge, deploy, and close decisions remain explicit operator actions.

## Good Output Standard

The operator should understand:

1. what this batch is actually about
2. why each PR is present
3. what changed in each PR at the surface/contract level
4. how each PR will be tackled
5. what will be tested
6. what would make Codex stop
7. how the live report and contributor-impact dashboard will be updated
8. which next-train review can start while queue/smoke is running

Avoid generic phrasing such as "review these together" without per-PR roles.
Avoid one-line PR summaries that hide the actual review path.
Do not ask the operator to choose before showing the researched solution path.

## Train Throughput Standard

Use this rhythm for scale:

1. Mass classify open PRs through the live report.
2. Convert clear drifts into closure or changes-requested waves.
3. Queue only small proven merge trains.
4. While PR Validation, Queue Validation, or Main Post-Merge Smoke runs, review the next independent operator batch.
5. After smoke passes, refresh the live report and contributor-impact dashboard.
6. Select the next independent `Recommended Operator Batches` item and produce a fresh `Per-PR Assessment`.

Never let throughput hide dependency order. Shared files, shared runtime contracts, generated contracts, schema/migration surfaces, auth/consent/vault/PKM/voice, and deploy paths require sequential handling.
