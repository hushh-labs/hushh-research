# ADK consent and connector checkpoint — 2026-09-24

## Active continuation — release and user-journey closeout

The user authorized this sequence on the existing `feat/adk-orchestration-runtime`
worktree: reconcile the latest `main`, preserve both branches' intent, commit and
push the exact verified source, use the Admin release SOP and merge queue, deploy
the landed `main` SHA to UAT, then ship that UAT-backed SHA to TestFlight. These
are distinct gates; neither a local merge nor a green PR means deployment or
TestFlight is complete. Do not initiate Drive OAuth for the user.

### Plan

1. Finish source reconciliation and generated projections; prove the Professional
   root request remains one reviewed bundle and the Chat/Profile actions stay
   reachable. Keep current consent, owner and browser-decryption authorities.
2. Run changed-surface and canonical pre-PR checks, DCO and secret hygiene. Push
   the exact branch head and open a fresh PR (the former PR is already merged).
3. Require terminal-green checks, clean freshness/mergeability and resolved
   conversations. Enter the ordinary merge queue; use Admin PR landing only if
   review policy alone blocks queue entry and the SOP's exact-head gates pass.
4. Verify landed `main` SHA and its successful post-merge smoke. Deploy that
   exact SHA to UAT with automatic scope selection; inspect workflow artifacts,
   service provenance, health and the connector/consent surface.
5. Ship the same green, UAT-backed `main` SHA through the TestFlight workflow.
   Verify the run's terminal result and Apple processing/distribution state.

### Current evidence at this checkpoint

- **Main integration:** fetched and normally merged latest `origin/main`
  `a1b80dcc807126dd43480a79457d9f520fcb16cc` as `4ac22d155`. The merge retained
  branch-owned One/MCP policy while integrating main's Drive live-search/read
  implementation. Product-agent registry, capability graph, Location catalog,
  and runtime topology were regenerated from merged authored sources; their
  canonical checks pass. The regenerated revisions intentionally supersede
  main's previous generated digests because the combined authored sources differ.
  No branch switch, reset, or history rewrite occurred.
- **Automated:** 93 Drive/ADK backend tests and 126 web connection/Chat tests pass
  after the merge. The full web build, typecheck, lint, design-system, docs, and
  render-performance checks passed. Full Vitest reported 9,099 passed and one
  five-second timeout in an unchanged One Location test; that exact test passes
  alone in 2.8 seconds. Earlier connector assertion failures also passed in
  isolation. The local canonical pre-PR gate is therefore not yet green; require
  exact-head CI and continue classifying the load-sensitive baseline failure.
- **Browser/runtime:** frontend `3000` and backend `8000` are served from this
  worktree and return healthy responses. Canonical reviewer preflight and
  read-only same-session route plus cold re-unlock proof passed for
  `/one/profile/connectors`. This is not a consent mutation or Drive provider read.
- **Connector state:** the Settings catalog and Chat entry are implemented.
  Local reviewer configuration keeps Drive connect disabled; existing UAT
  rollout configuration is enabled. No rollout values were changed and no OAuth
  was started. A real Drive read still requires the user's normal authorization.
- **Native:** a paired physical iPhone is available. Native static/plugin checks
  passed before the latest Drive merge; rerun changed-surface native checks.
  No post-latest-merge native interaction or TestFlight build has been verified.
- **Still open:** fresh live root-scope submission/approval/readback, three-account
  Memory fixtures, the full 12-journey Chat/Profile matrix, real Drive provider
  read, and deployed UAT/TestFlight evidence. Existing grants and their impact
  boundaries must be inspected before any reviewer mutation; automated tests do
  not close those gates.

This active continuation supersedes the older status and plans below. Those
entries remain historical evidence with their original revisions and limits.

## Visual Context

Architecture owner: [One agent hierarchy](../one/one-agent-hierarchy.md).
Canonical visual index: [Architecture reference](../architecture/README.md).

| Boundary | Current evidence | Remaining acceptance |
| --- | --- | --- |
| Main → ADK branch | Latest fetched main merged locally at `4ac22d155` | Freshness, PR checks, queue/Admin SOP, landed-SHA smoke |
| Connector → One | Owner-bound Drive MCP read path and 93 backend/126 web tests pass | User OAuth, actual provider read, and native proof |
| Consent → Chat | Metadata-only receipt and restoration committed | Browser revisit and fresh encrypted readback |
| Sidebar → connection authority | Calendar/Plaid owning status, 11 tests | Real authenticated visual rehearsal |

## Historical implementation update — 2026-09-24 MCP integration

Concurrent documentation was preserved in `8efdd610b`. Main at `79ed54dd9`
was merged into the existing ADK branch in `493ef2c30`; the integration is no
longer blocked. Sidebar correction `2a2486177` uses the owning Calendar and
vault-backed Plaid status sources, removes duplicate rows and labels Drive's
selected-file mode. Its 11 tests pass; 78 cache tests and the service-boundary
check also pass. Workspace read-service checks pass 80 tests.

Workspace MCP Chat admission and inline consent-card restoration are committed
in `5ad438a65`, with structured MCP result preservation in `4949148`. Parent
integration passed 71 backend and 99 frontend tests, typecheck, surface-map,
service-boundary, design-system, docs and Ruff checks. This is source/automated
verification, not browser acceptance. Reviewer preflight on
the isolated `3007` frontend / `8003` backend passed without persisted credentials.
The old `3001` / `8001` processes are not claimed as this verified runtime.

Important integrated-source differences: legacy Drive OAuth was deliberately
retired by `4802f7b39`; the old Drive wrapper was not registered in the live One
roster. Existing selected-file access must not imply account-wide MCP permission.
Google's hosted Gmail MCP endpoint does not list send, although the separate
Google Workspace CLI MCP exposes the Gmail API send method. Gmail send remains
the app's separate reviewed action until its capability is specifically added;
the current MCP Chat lane is read-only. Calendar MCP does not document the
If-Match update contract used by the reviewed service. Preserve the current
reviewed-action authorities until equivalent adapter guarantees are established.
Consumer Plaid MCP, provider/native proof and the full sharing matrix remain open.

Provider references: [Gmail MCP catalog](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server),
[Workspace CLI MCP](https://github.com/googleworkspace/cli),
[Gmail send OAuth scopes](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send),
[Gmail thread formats](https://developers.google.com/workspace/gmail/api/reference/mcp/tools_list/get_thread),
and [Calendar update schema](https://developers.google.com/workspace/calendar/api/v3/reference/mcp/tools_list/update_event).
Gmail metadata-only enforcement must occur before retrieval as well as in the
returned projection; the provider's default thread format includes content.

The Workspace read security lane now passes 145 combined connector/admission/
privacy regressions. Grant observations live in the existing credential services;
provider descriptions are not forwarded as instructions; Gmail requests and
responses enforce metadata-only access. The current revision fence deliberately
rejects a read if a token refresh updates the credential row during the call.
This is safe but can require a retry; live availability/performance parity is not
established by these tests. The separate ADK agent suite passes 114 tests.

The submitted-card receipt is derived by the server from the owning request
ledger and stored as a content-less, idempotent encrypted ADK event. It is not
replayed to the model; readback still checks current authority. Actual browser
remount and encrypted readback are not yet proven.

The ordinary Gmail OAuth flow requests `openid`, `email`, `profile`,
`gmail.readonly`, and `gmail.send`. An explicit "Enable Gmail drafts" flow
requests `gmail.readonly` and `gmail.compose` on web, iOS and Android.
The Gmail API accepts either `gmail.send` or `gmail.compose` for
`users.messages.send`, but the app intentionally checks the narrower send
scope and owner setting. Per-account grants still require a live token/grant
check; configured scopes do not prove a reviewer has granted them. The
reviewed Chat editor now has a separate Save to Gmail Drafts action. It calls
Google's hosted MCP `create_draft` only after the person clicks, projects
only the draft ID from the provider response, and never auto-retries an
ambiguous write. Attachments are excluded because the hosted draft tool's
documented support is contradictory and the owner-bound Drive attachment
send path remains separate. This is source/automated proof, not live provider
or native-device acceptance. Final Send remains the existing reviewed Gmail
API action and is not represented as a hosted Gmail MCP capability.

Current draft checkpoint: 84 focused backend and 29 focused frontend tests pass;
native static parity and documentation checks pass. No authorized live Gmail
draft or native-device execution has been observed. The draft-save MCP tool is
non-idempotent: after an ambiguous acknowledgement, the UI blocks automatic
retry and asks the person to inspect Gmail Drafts. Sending remains separate.
Google's [hosted create-draft contract](https://developers.google.com/workspace/gmail/api/reference/mcp/tools_list/create_draft)
documents `gmail.compose` and currently describes attachment support
inconsistently, so this path omits attachments.

Drive account-read can use the existing
Google service-grant store separately from selected-file grants, but needs
explicit web/native mode routing. Current native `connectDrive` implementations
serve selected-file selection, not proof of account-read server-code support.

## Initial audit (historical)

This is a source audit, not browser, provider, native, or release acceptance. It records the fetched `origin/main` state and the ADK worktree state without altering concurrent work. The recipient-safe sharing completion ledger remains `tmp/recipient-safe-consent/MASTER-HANDOFF.md`.

## Source and integration state

- Worktree: `feat/adk-orchestration-runtime`, local `1006e6e2b5e9e546c115e7ce79822d69e82ce411` at audit; fetched `origin/main` `d91d7d72a8cc5fbf8755768fc2499a151788169f` (PR #7028). The local branch has three unpublished latency/checkpoint commits and is 28 commits behind `main`.
- The committed histories produce a clean merge tree, but uncommitted edits by another agent overlap incoming documentation (`api-contracts.md`, `route-contracts.md`, `one-agent-hierarchy.md`, `mail-drive-uat-acceptance.md`). Fetch completed; **merge into this worktree is pending preservation of those edits**. Do not stash, discard, or blanket-commit them.
- The latest-main Connectors panel and selected-file status tool are therefore audited from `origin/main`, not claimed to be served by the current worktree. Recheck HEAD, worktree, tests, and runtime pairing after integration.

## Connector truth versus what One can call

| Connector | Current One execution path | Latest-main Chat panel | Gap / required proof |
| --- | --- | --- | --- |
| Drive | Official Google Drive MCP client, with five allowlisted read tools, behind an owner-bound `drive.readonly` grant; separately, selected-file documents use the `drive.file` picker/index and document agent. | Shows selected-file Drive connection and picker; not the separate MCP account-read grant. | Surface the two access modes honestly and make the read-only MCP grant manageable in Chat/native. Prove discovery, grant, an authorized synthetic-file read, and denial after disconnect. Do not conflate picked files with account-wide MCP access. |
| Gmail | Owner-bound Gmail ADK tools and a reviewed draft/send flow; **not** an MCP server in this roster. | Live Gmail status and connection action. | Prove authorized read/draft and explicit send confirmation. Cross-tool composition is a model choice, while owner, recipient, attachment, and send authority stay deterministic. |
| Calendar | Owner-bound direct ADK calendar tools; **not** an MCP server in this roster. | Listed with `connected: false` and a route link regardless of actual connection. | Bind the row to actual calendar status and verify permission-required/connected behavior in Chat and native. |
| Plaid | Finance specialist and existing Plaid/portfolio contracts; **no consumer Plaid MCP tool** in One's roster. | Listed with `connected: false` and a route link regardless of actual state. | Reflect actual finance-source status and test authorized finance questions. Do not represent Plaid developer/diagnostic MCP servers as a connected consumer-finance tool. |

The generic external-connector A2A adapter is dormant, not automatically registered into One. A registry listing alone does not make a capability callable. The new panel may also duplicate Calendar/Plaid if they appear in the external registry, because it excludes only Drive and Gmail from registry rows. Its Calendar/Plaid connected state is hardcoded and needs an owning status source before the UI can claim connection truth.

Primary source anchors: `consent-protocol/hushh_mcp/one_adk/agent_tree.py`, `one_adk/drive_tools.py`, `services/google_drive_mcp_service.py`, `api/routes/one/drive.py`, `hushh-webapp/components/agent/connectors-panel.tsx`, and `api/routes/external_connectors.py`. Google documents dedicated Workspace MCP servers; this app has not yet adopted Gmail/Calendar MCP just because those servers exist. Plaid's documented MCP offerings serve Dashboard diagnostics and developer/Sandbox tooling, not arbitrary connected-bank information. See https://developers.google.com/workspace/guides/configure-mcp-servers and https://plaid.com/docs/resources/mcp/.

## Consent lifecycle checkpoint

- **Implemented, with focused tests present but not rerun in this audit:** Profile root Professional selection submits one root scope reference instead of expanding it into individual children; Chat root selection has a corresponding test. Request history groups by bundle and pages eight bundles at a time. Chat has browser-side encrypted-export readback and listens for consent-change notification events to refresh the card. The backend sends requester-targeted metadata notifications.
- **Not yet live-verified on this source/runtime pair:** a newly sent root request, owner approval, exact browser-decrypted Chat readback without a new tab, Profile parity, notification-triggered retrieval, revisit and cold re-unlock. These require authorized reviewer and synthetic information, with decrypted values kept only in browser memory. Source presence and mocked tests do not establish delivery or native parity.
- **Historical ledger remains open:** 3/3 encrypted Memory fixture journeys and 12/12 fresh six-direction Chat/Profile consent journeys. The B-owner Professional fixture has historical evidence; do not promote it to current three-account acceptance.
- **Latency checkpoint:** the three local commits add privacy-safe timing and harness fixes, but they are not on `main`. The previous eight-turn comparison was inconclusive; do not claim LOW or a model change improves latency without matched correctness and timings.

## Smallest next loop

1. Let the concurrent documentation edits be committed or otherwise safely preserved, then merge the fetched `main` into the same ADK branch. Recheck the resulting tree and focused connector/consent tests; do not infer running-server provenance from Git alone.
2. Fix the Chat connector status contract: distinguish selected-file Drive from account-read MCP Drive, use real Calendar/Plaid connection status, and prevent duplicate registry rows. Make the read-only Drive grant reachable on web/native without widening a picked-file grant.
3. Run one authorized synthetic Drive MCP read and one fresh root-scope consent journey through Chat and Profile. Record source/runtime identities, sanitized pass/fail states, and the first failing boundary. Expand the existing ledger only after these proofs; avoid an open-ended provider campaign.
