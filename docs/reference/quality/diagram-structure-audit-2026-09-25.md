# Diagram and Structure Audit — 2026-09-25

## Visual Context

The [quality index](./README.md) links this revision-bound review and the per-figure ledger; the [architecture view catalog](../architecture/architecture-view-catalog.md) points to the canonical system figures.

This review is bound to the integration candidate from `fb9614f34871e11a3702c80c8879dc2b0f8051cd` (existing pod branch), `3e248fc4bf04df28bf677bcc6402b64d9015098f` (frozen local ADK commit), and refreshed main through `b95ace9a0cc3624c243b56117af05d60582ccb14`. The ADK integration merge is `8abb5d2c72fdd5ba2b8f0116dcd7f79558b90324`; the later main refresh merge is `a2f75ffb2a2e9645ff274f4feb1a3a8ec607242f`. Corrections and structural extractions are part of this candidate. This is source evidence, not proof that the candidate serves in dev, UAT, or production.

## Figure disposition

The [per-figure ledger](./diagram-dispositions-2026-09-25.jsonl) identifies all **179** maintained Mermaid figures by path, line, local index, and content hash. It records each figure's status (`current`, `conditional`, `future`, or `historical`), evidence locator, visual render result, link destination, and disposition. `Current` means the maintained document presents that view as current at this source revision; it does **not** establish live deployment. A document or index is an evidence locator, not independent proof of every runtime edge. Runtime assertions require their cited source anchors and, for serving claims, live readback.

All 179 figures passed the pinned Mermaid 11.17.2 render in Playwright Chromium and were viewed in twelve contact sheets. The high-risk canonical topology and flow diagrams were compared with their cited code and contracts. Contact sheets establish legibility and absence of obvious clipping; they do not establish every small label's visual accessibility at all viewport sizes. The structural checker now includes the repository, backend, and frontend READMEs. The existing web CI lane runs the full render when maintained Markdown or the diagram checker changes.

Three generic duplicate diagrams were deleted from dated history and planning material after retaining their text and canonical pointers. Five canonical architecture view files now own the system, runtime, flow, deployment, and information-boundary figures. The former long catalog retains compatibility headings and points to those owners; inbound deep links were updated. The four mega-map SVGs match their generator byte for byte after a fresh generation in ignored `tmp/`.

## Corrections and source checks

- The container view places the Next.js API proxy within the frontend deployment and identifies a Cloud Run service, rather than one container, as the owner pod unit. The backend remains Consent Protocol. The deployment view distinguishes today's hub-routed browser turn from the pending direct browser and device paths; it no longer asserts that this integrated revision serves in dev without a dated live readback.
- One delegation distinguishes in-process AgentTool/dispatch from scoped cross-process A2A. Conditional specialist and pod paths have visible status labels. Portfolio Import depicts client review, unlock, encryption, and PKM write before an authorized Kai snapshot.
- Main's Drive migrations 245/246 retain their deployed numbers. Pod/private-MCP, ADK chat authority, and public-profile migrations were renumbered 247–249 with rollbacks and manifest references; generated schema and runtime projections were regenerated from their owners. Database ledger and environment deployment remain separate release evidence.
- The final main refresh brought in the bounded Drive live-metadata retry and its parity tests. The architecture-fitness baseline was remeasured after this import, so the ratchet blocks changes beyond this combined source state.
- The merged shared chat ingress preserves the selected Gmail workflow-ID context lookup after owner authorization. The frontend proxy preserves the `email/draft/save` timeout. Focused ingress and frontend checks cover these merge regressions.
- The location page now delegates pure spoken-name and error mapping, share-recipient state, and small controls to existing feature owners. OneLocationAgentService keeps its facade while pure recommendation and share-lifecycle decisions move behind it. RIAIAMService keeps its facade while pick-package projections move to a pure helper. These are bounded compatibility changes; no route, schema, or product API is intentionally changed by the extraction.

## Limits and owning follow-ups

- The browser's production chat call still enters the hub. A separate pod-chat client exists but has no production call site; direct browser-to-BYOC-pod access is **not** established by these diagrams or this source merge. The direct Puppy client and real two-device rehearsal also remain unverified. The pod/browser/device workflow owns their implementation and live acceptance.
- Dev, UAT, and production serving revisions, migration ledger, pod identities, and rollback targets were not read from their environments in this source-structure task. Deployment and rollout claims remain conditional until the release workflow records them.
- Two uncommitted ADK sidebar/shell styling edits appeared after the local ADK commit was frozen. They remain in the ADK worktree and are not part of this candidate; they need their own integration after their owner finishes them.
- The figure ledger is a review record. A future source change must update any affected figure and its status; the renderer and link checks detect mechanical drift, while semantic review remains an engineering responsibility.
