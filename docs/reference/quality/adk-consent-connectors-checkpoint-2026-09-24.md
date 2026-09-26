# ADK consent and connector checkpoint — 2026-09-24

## Active continuation — release and user-journey closeout

The user authorized this sequence on the existing `feat/adk-orchestration-runtime`
worktree: reconcile the latest `main`, preserve both branches' intent, commit and
push the exact verified source, use the Admin release SOP and merge queue, deploy
the landed `main` SHA to UAT, then ship that UAT-backed SHA to TestFlight. These
are distinct gates; neither a local merge nor a green PR means deployment or
TestFlight is not complete. Do not initiate Drive OAuth for the user.

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

- **Main integration:** fetched live `origin/main`
  `75c3528bd499c99d6e8830e19e5c25a41db79e1d` (PR #7045) and normally merged it
  as `c45de6aa3` on the existing ADK branch. The merge added Drive live-query
  request/allow-deny flows and migration `242`; its only conflict was the
  generated runtime-topology index, regenerated from its authored contracts.
  The topology generator check passes. A fresh remote query confirmed this
  SHA at the last check. No branch switch, reset, or history rewrite occurred.
- **Security gate repair:** commit `30b8513e8` removes `--ancestry-path` from
  secret-scan ranges, adds a synthetic merge-graph regression, renames test-only
  idempotency sentinels, and adds only exact gitleaks fingerprints for the old
  synthetic values. The regression passes; the prior secret scan covered 24
  commits / about 287 KB with zero Gitleaks findings and zero GitHub secret
  alerts. Eighteen Dependabot alerts remain advisory in this release lane.
- **Automated:** before the latest main merge, the frontend full suite passed
  9,114 tests across 984 files (9 skipped); the Connect page-client suite was
  104/104. The Workspace MCP/Gmail route suite was 28/28, backend mypy passed
  across 160 source files, and changed-file Ruff passed. After merging PR #7045,
  Drive live-query backend service/route tests pass 44/44 and consent-card,
  request, and Drive-sharing frontend suites pass 76/76. On the integrated
  source, the full frontend suite first hit host `ENOSPC` under default worker
  parallelism (6,835 tests passed, 8 skipped; 308 files could not create temp
  files). A single retry at two workers passed 985 files / 9,155 tests, with 2
  files / 9 tests skipped. Governance, MCP package (7 tests plus packed-runtime
  check), PKM integration (87 frontend and 91 backend tests), docs verification,
  voice/capability generation, surface map, native static and native plugin
  parity all pass. Exact-range DCO (24 non-merge commits), Gitleaks (24 commits,
  zero findings), and GitHub secret-alert parity (zero open secret alerts) pass.
  The complete local protocol pytest lane was intentionally stopped after 549
  of 5,591 tests; mypy had passed across 160 files and the focused post-main
  Drive tests passed 44/44, but a full local backend-suite pass is not claimed.
  The web-targeted runner saw only this pending documentation edit and selected
  no feature test packs. The original `codex pre-pr --json` wrapper therefore
  remains non-green because its default-parallel frontend run hit `ENOSPC`; its
  later protocol/package/integration stages were checked separately as stated.
  The regenerated runtime topology check passes (139 routes, 19 agents, 73
  table families).
- **Browser/runtime:** frontend `3000` and backend `8000` returned HTTP 200 from
  this worktree. The read-only C→A reviewer trial unlocked separate contexts,
  selected the Professional root as one request, and confirmed the Send action
  is hit-testable in light/dark at phone/tablet/desktop sizes. Both dialogs were
  cancelled, so no consent request was submitted. Connector settings, same-
  session/cold-unlock preflight, Chat readback and notifications are not proven
  on this exact source/runtime pair.
- **Connector state:** the Settings catalog and Chat entry are implemented.
  Local reviewer configuration keeps Drive connect disabled; existing UAT
  rollout configuration is enabled. No rollout values were changed and no OAuth
  was started. A real Drive read still requires the user's normal authorization.
- **Native:** a physical iPhone is paired; installed apps are `com.hushh.app`
  1.4.0 (69) and `ai.hushh.app` 1.0.0 (232), not this branch's build. No app
  was installed, launched, or erased. The current branch's UAT-backed native
  export built successfully and passed the CSS freshness check, but current-
  source physical interaction remains unverified; TestFlight must build the
  exact landed main SHA and processing/distribution must be checked.
- **Release:** no open PR currently targets this branch; earlier PRs are merged.
  `main` branch protection was verified against the SOP before this integration.
  The ADK branch now includes latest fetched `main`, but this merge and checkpoint
  update have not been pushed as a new PR. DCO, secret hygiene, governance,
  full frontend, MCP package and integration checks pass on this source, but the
  canonical local PR wrapper did not pass because of the initial `ENOSPC` run
  and the full local protocol test lane was stopped early. Feature-specific CI,
  review resolution, queue/Admin SOP landing, post-merge smoke, exact-SHA UAT,
  and TestFlight remain pending.
  UAT/TestFlight dispatch is paused until the previously exposed environment
  credential is confirmed rotated or revoked.
- **Still open:** live root-scope submission/approval/readback in Chat, three-
  account Memory fixtures, the full 12-journey Chat/Profile matrix, Drive OAuth
  and a real provider read, current-source physical iOS interaction, deployed
  UAT, and TestFlight evidence. Do not promote automated tests or the cancelled
  dialog trial into live-consent acceptance.

This active continuation supersedes the older status and plans below. Those
entries remain historical evidence with their original revisions and limits.

## Visual Context

Architecture owner: [One agent hierarchy](../one/one-agent-hierarchy.md).
Canonical visual index: [Architecture reference](../architecture/README.md).

| Boundary | Current evidence | Remaining acceptance |
| --- | --- | --- |
| Main → ADK branch | Latest fetched main `75c3528bd` merged locally at `c45de6aa3` | New PR checks, queue/Admin SOP, landed-SHA smoke |
| Connector → One | Owner-bound Workspace MCP and Drive allow/deny contracts; 44 focused backend and 76 frontend tests pass | User OAuth, actual provider read, and native proof |
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
