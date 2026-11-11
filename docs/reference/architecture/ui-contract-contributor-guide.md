# UI contracts: Back and Search contribution scaffold

Read this before editing a screen, route, layout, shared UI module or action.
Back and Search share the authored route and action contracts. Generated files
join these owners; they do not define another navigation or action router.

## Visual Map

```mermaid
flowchart TD
  edit[Screen or shared UI edit] --> back[Review Back parents and feature layers]
  edit --> search[Review Search actions and screen context]
  back --> generate[Generate Back then Search and mirrors]
  search --> generate
  generate --> fast[UI Contracts: structural coverage and mutation checks]
  fast --> behavior[Required frontend behavior tests]
  fast -->|Failure| repair[Repair the owning code or authored contract]
  repair --> generate
  behavior --> gate[CI Status Gate and maintainer review]
```

## Start before editing

From `hushh-webapp`, run `npm run ui:doctor`. It is read-only and prints all
structural, freshness and generated-mirror failures together. If app dependencies
are absent, install only the locked parser first:

```bash
cd hushh-webapp/scripts/architecture/ui-contract-tools
npm ci --ignore-scripts --no-audit --progress=false
cd ../../..
npm run ui:doctor
```

The execution target is 5–10 seconds. Dependency download, GitHub queue time,
checkout and runner startup are separate. The command prints its measured
execution time; it never trades correctness for a timing budget.

## Choose the owning edits

| Change | Authored edits | Evidence before generation |
| --- | --- | --- |
| New or renamed route | Route constants/builders and `lib/navigation/app-route-layout.contract.json`: shell verification, voice playbook and Back cases | Production parent resolution, direct entry, query state and eventual root reachability |
| Dialog, editor, map or nested feature state | Existing feature callback registered through `lib/navigation/back-layers.ts` | First Back unwinds the deepest local state; next Back reaches its parent; inactive/unmounted layers release ownership |
| Search action or screen context | Owning `*.voice-action-contract.json` plus route `voicePlaybook` | Correct screen, reachable control/action, query defaults, guards and platform boundaries |
| Shared UI or layout edit | Review affected Back states and Search actions even when behavior seems unchanged | Existing cases remain valid; add cases for changed interactions |
| Merge main into a feature branch | Preserve authored route cases and action meanings from both branches | Review the combined behavior, then regenerate all mirrors in dependency order |

## Back scaffold

The shared hierarchy is overlay, deepest active feature layer, authored route
parent, then native root handling. Shell Back, iOS edge gestures and Android
system Back use this hierarchy. Reuse the feature's existing cancel/reset
callback, including consent review cleanup and busy-state handling.

```tsx
// Import useBackLayer from "@/lib/navigation/back-layers".
const closeEditor = useCallback(() => {
  if (!editorOpen) return false;
  if (saving) return true; // Consume Back while the existing mutation settles.
  cancelEditor(); // The feature's existing cleanup owner.
  return true;
}, [editorOpen, saving, cancelEditor]);
useBackLayer(owningRoute, active && editorOpen ? 2 : 0, closeEditor);
```

Use the depth appropriate to the owning feature. An inactive pane must use zero
depth. Do not add `router.back()` or raw browser history to application route
Back. Do not extend reviewed history exceptions to avoid writing a parent.

Every physical route needs `backVerification.cases` in the existing layout
contract. Copy the nearest equivalent route's case shape and check its expected
target against production `resolveTopShellBackAction`; query parents and entry,
redirect or hidden boundaries need explicit cases/reasons. Extend the nearest
behavior test when changing nested state, query behavior or a cancel callback.

## Search scaffold

Extend the owning local action contract, not a separate Search catalog. Match
its existing schema and include action identity, meaning, control IDs,
reachability, execution target, guards and Search/context defaults. The route's
`voicePlaybook.screen` must describe the actual screen, including query-backed
tabs; its primary/happy-path actions must reference real declared actions.

For a newly exposed control, add its literal `data-voice-control-id` to the
owning action's `control_ids`. Preserve authentication, vault, consent and
platform/build guards. Declare only public query dimensions; private values and
the Search visibility marker must not leak into navigation targets. Test current
screen suggestions and same-screen filter changes through the existing action
runtime tests. A refreshed hash cannot prove a label or action's meaning.

## Finish the edit

```bash
cd hushh-webapp
npm run build:ui-contracts
npm run verify:ui-contracts
npm run test:ui-contracts
```

`build:ui-contracts` runs the existing Back behavior pack before stamping its
reviewed source, then runs Search generation, gateway, surface map, route index,
capability graph and runtime topology generation. Full app/backend tooling is
required for generation and behavioral tests; the tiny parser install is only
for fast validation. Review and commit authored changes and generated mirrors
together. Verification and the pre-push hook never stamp or repair files.

Content-addressed Back/Search source snapshots are optional review diagnostics.
A new combined source hash alone does not block a merge or prove human approval.
Missing snapshots never cause checks to write a record; an existing altered or
malformed record still refuses. Route hierarchy, authored Back cases, raw-history
bypass detection, Search action/control coverage and generated contracts remain
required. Run the affected behavior tests when navigation or actions change.

Web browser history correction uses the authored Back owner only for a verified
backward traversal. Forward or unknown direction stays native; browsers without
Navigation API entry indices retain native browser history. Profile pane history
remains with its existing owner. Its confirmation overlay can consume a declined
Profile history depth when entry indices are unavailable; known Forward traversal
never dismisses that overlay or triggers route-parent correction. `npm run test:web-history-boundary` exercises
trusted Back and Forward in Chromium; pure synthetic events cannot prove this.

CI has one mandatory **UI Contracts** job running
`npm run verify:ui-back-contracts` for Back hierarchy, route coverage,
source freshness and Back validator mutation regressions. The check name stays
stable for required-check consumers. The default local command retains the
broader Search and generated-mirror checks; Web Core still runs that command.
These checks are outside the dedicated UI Contracts job. Required
Web Core runs validator mutation regressions. The required full Vitest suite
retains the Back and Search interaction tests. Both aggregate gates reject a
non-success UI job; frontend changes also require core and full-suite success.
This is repository contract verification, not deployed or physical-device proof.

## Resolve failures and conflicts

| Failure | Repair |
| --- | --- |
| New route lacks coverage | Add its shell/playbook and Back cases before regeneration |
| Back history bypass | Route through the shared hierarchy or register the feature layer |
| Search control lacks an action | Update the owning action and `control_ids`; do not add an exemption |
| Source revision or mirror is stale | Review semantics, run `build:ui-contracts`, inspect and commit outputs |
| Generated file conflicts after another PR lands | Merge main, reconcile authored fields, regenerate Back before Search, then verify |
| Validator/test failure | Fix the behavior or owning declaration; do not skip tests or stamp blindly |

Freshness evidence is **not committed as generated JSON files**. After reviewing
changed behavior, the existing owner build commands refresh only the bounded,
ignored `hushh-webapp/tmp/ui-review/back.json` and `search.json` cache records.
The tracked `commit-msg` hook records compact `UI-Review-Back` and
`UI-Review-Search` technical trailers: the source revision and SHA-256 of the
canonical receipt, including its route/module counts. These are freshness
fingerprints, not claims of human review or runtime acceptance. Keep
`core.hooksPath=.githooks`; a commit made without this hook must retain the exact
trailers printed by the owner build commands.

Read-only verification never creates evidence. Local verification can use the
exact current ignored cache; CI requires matching trailers reachable from the
candidate HEAD or verified unchanged-target inheritance. Unrelated branches,
reflogs, malformed or missing/shallow history cannot supply proof. Later local
commits carry forward existing trailers without minting a new source review.
Synthetic merge commits can reuse exact matching parent proof; changed combined
sources still require review. Squash merges must retain the technical trailers.
Back hashes the full UI source set and authored route cases; Search hashes the
complete route import graph. Authored behavior, action/control coverage and
tracked-input/verified-base checks remain mandatory.

CI pins the PR/merge-group base SHA; local inheritance uses an ancestor
`origin/main`. Missing history, invalid bases, untracked inputs, deleted/new UI
modules and changed imported information fail closed. Do not hand-edit a source
fingerprint, auto-review during verification, or treat a checksum as proof of
interaction meaning. Do not add generated review JSON, audit runs, screenshots,
traces or evaluation ledgers to Git. Keep local evidence ignored; use sanitized
CI artifacts when evidence must be handed off. Authored contracts, runtime
mirrors, dependency locks, fixtures and app assets remain source-controlled.

`app-route-layout.contract.json` and local action contracts are authored authority;
never resolve them wholesale as generated files. Keep generated gateway,
capability and topology copies consistent across their deployment contexts.

Canonical architecture: [route contracts](./route-contracts.md).
Agent owner: [frontend architecture skill](../../../.agents/skills/frontend-architecture/SKILL.md).
Connect product inventory: [Connect UI Contract](../../../hushh-webapp/docs/ui-contracts/connect.md).
Profile and Feed inventories, shared navigation and font usage:
[Product UI contracts](../../../hushh-webapp/docs/ui-contracts/README.md).
