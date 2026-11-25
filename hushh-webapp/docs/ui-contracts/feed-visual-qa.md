# One Feed visual verification

The [journey matrix](../../scripts/testing/feed-visual-journey.mjs) covers KYC,
documents, Finance and the legacy-history refresh. Its `uatCases` export also
includes the [Location journey](../../scripts/testing/location-feed-uat-journey.mjs).
It names the expected viewer,
exact destination, and authority for each checkpoint. There are two separate
outputs:

- **Design previews:** fixed synthetic identities and timestamps rendered with the
  shipped Feed row components, One page shell, and product font. Detail cards
  illustrate the intended state. At 393 × 852 CSS pixels and 3×, these are viewport
  previews, never native or UAT proof.
- **Native UAT evidence:** real app screenshots on a portrait iPhone 15 Pro
  simulator, paired with the exact record opened from Feed. Keep the private QA
  manifest and captures off Git. A row only passes after a receipt from its
  owning service supports the same role, operation ID and confirmed state.

From `hushh-webapp`, generate design previews with:

```sh
node scripts/testing/capture-feed-visual-previews.mjs /absolute/path/to/feed-design-previews
```

Open the resulting `index.html`. The generator runs against local fixture
components; it blocks remote requests and does not contact UAT.

## Before the live run

1. Record the actual frontend and backend UAT deployment revisions. Use the
   authorized scoped deployment workflow for the candidate under test. Confirm
   the native app shell uses that UAT origin with the appropriate build and
   simulator runtime. Do not run against a production host.
2. Use dedicated, vault-ready UAT test accounts and separate simulator sessions
   for the requester, owner, investor and verified advisor as appropriate. Use
   account aliases (for example, `qa_buyer`) in the manifest. Use synthetic
   inbox messages, statements and files with a unique run label. Do not mutate
   the shared reviewer's data or clear old activity on a real account.
3. Confirm Stripe **test mode** and Plaid **Sandbox** from the actual provider
   context before creating any payment or connection. Do not simulate a bank
   transfer by writing to Feed. The retired shared runtime has historical
   transfer receipts and no active transfer provider. If the selected sandbox
   cannot produce a return, mark that checkpoint unsupported with the reason.
4. Pre-create an older fixture run through the same normal flows and preserve
   its IDs. Enough newer activity must intervene that these records fall
   outside the first loaded Feed page. The old UAT history check is read-only;
   keep the viewer's auth and vault key in memory.

## Run the scenarios

Use the app for navigation, decisions and provider handoffs. Use the
authenticated domain reads listed in the matrix to reconcile what the screen
says. Log only a redacted receipt: request reference, workflow ID, viewer alias,
state, and UTC timestamp. Do not retain raw exchange content, account details,
test payment credentials, authorization headers, signed URLs, or decrypted
vault payloads.

| Journey | Action and verification |
| --- | --- |
| KYC review and reply | Send a synthetic information request from the test inbox, scan normally, and open the pending request from Feed. Use the normal review and send flow. Read the same workflow from `GET /api/one/email/information-requests/{id}` and capture the provider-confirmed reply. Keep the same workflow ID in both checkpoints. |
| Document request | Request two eligible test files in One. Capture requester and owner views with the same request ID. Start with Drive disconnected only on the dedicated owner account. Connect it through the offered OAuth handoff and verify the same request opens; read the request and authorized `/review` before and after. |
| Payment and delivery | Confirm a real test-mode checkout from the requester action. Record the verified payment result before checking files. Share one eligible test file first through the normal owner approval flow, then finish the second. Read `/delivery` and `/delivery/files` for both stages. Verify one current Feed row, meaningful dated milestones, and intact authorized file and receipt links. |
| Statement and correction | Import the known test brokerage statement in Finance. While it needs review, navigate out and tap the exact Feed action. If the real validator reports a blocked holding, verify the correct editor opens. Confirm Save using the app, read the encrypted vault snapshot and mutation receipt, then find the same saved snapshot from Feed without a second unread alert. Record the import run ID as the parent operation and the saved snapshot ID as the saved destination selector. |
| Analysis | Start a request and leave Finance before it settles. Check the exact run is present in saved owner history before accepting the Feed row. Start a second run for the same ticker and verify both exact routes. Open and refresh on the second device; verify no duplicate unread. |
| Transfer | In a sandbox that still supports it, create two equal-value transfers and exercise a real completion followed by a return, including a replay. Accept only the exact transfer history and real provider evidence. Where funding was retired, exercise a retained historical record read-only when one exists. |
| Advisor | From the investor send a real request to the dedicated verified advisor. Confirm both roles via the exact request API; capture the advisor's pending Review, act as the advisor, then capture the investor's actual response. The UI must not call acceptance a finished review. |
| Institution | Use a dedicated test Sandbox Item, trigger confirmed `ITEM_LOGIN_REQUIRED`, and confirm it through the normal snapshot sync. Verify one action for the sign-in across its accounts. Complete update-mode Link and verify the same Item and its accounts are active in the committed vault, then verify the action is gone. |
| Prior history | Search for the earlier request, file or receipt, statement, report, transfer, and advisor request from the same authorized test role. Tap each result. Separately, record how existing UAT rows fold on refresh and compare the unread state across two sessions. |

### Location journey

Use separate dedicated owner, requester, sender, recipient, invitee and Circle
owner aliases. Reuse the same account when the role is the same, and the same
workflow ID across its checkpoints. Keep a request ID as the operation ID even
after approval; record its verified resulting grant as `sourceId` for the exact
share destination. Circle invitation and joined outcomes similarly retain the
verified invitation-to-membership relationship. Never infer it from a name.

| Checkpoints | Normal flow and authority |
| --- | --- |
| 28–32: request and share | Request one hour, capture both accounts, review the exact revision and allow normally. Read back the resulting grant on both accounts. Let that grant expire; its row opens recorded history. Re-submit a changed review from a second session and verify the stale first review cannot grant access. |
| 33: unanswered expiry | Create a separate unanswered request. After authoritative expiry it leaves Needs you and remains findable in the exact request's history, without a new prominent row. |
| 34–37: private Check-In | Select three eligible recipients. Use an approved test failure at the real share/envelope boundary to leave one unconfirmed. Capture 2 of 3, then retry only the remaining recipient. Reconcile operation targets with saved grants and ciphertext receipts. Capture the recipient's exact grant and the same ended operation. Do not inject a UI success or repeat the two confirmed sends. |
| 38: Nearby Check-In | Use Your Map's temporary presence flow and Check out. Capture Feed without a presence row, then the map. Read back zero activity search results for this presence. Do not retain coordinates or notes in QA evidence. |
| 39–40: Circle | Invite and join through Circle review. Capture the invitee and Circle owner. Confirm joining did not create a location grant. Separately remove a member with Circle-scoped access and check that membership and access outcomes remain distinct. SMS contact changes must identify whose emergency alerts are received. |
| 41–42: emergencies | Publish two independent confirmed incidents from the same sender. Capture both Live rows before and after Clear Feed and while search is open. Record both grant IDs plus the selected `feedItemId`. End one incident; it opens exact history while the other remains Live. Never use a draft share as proof that an alert was sent. |
| 43–44: older history | Find an older authorized request/share by person, Circle, Check-In, event and date with Location selected. Open its exact workflow/history. Compare two refreshes and sessions: one current representative, no duplicate unread. Also search a unique private note/place/coordinate marker and Nearby presence; none may match. |

Capture the same test journey on the deployed baseline and candidate. Keep the
normal source operations and their IDs in the private manifest; record visible
row counts before and after grouping, with the two active emergencies still
separate. A local SQL/component test is useful contract evidence but cannot
replace these fresh app flows or the native screenshots.

The collector requires `proof.readback.incidentIds` (two distinct IDs) and
`liveRowsAfterClear: 2` for checkpoint 41. For checkpoint 38 it requires
`feedRows: 0` and `searchResults: 0`. Checkpoint 44 uses the same two-session
duplicate/unread readback as checkpoint 27.

Location receipts also bind `proof.sourceId` to the selected source. For direct
request, invitation and Check-In routes the source selector is the operation
ID. Owner, recipient and expiry captures for an approved request must share
the same resulting grant ID. An in-place Feed detail records
`proof.openedFeedItemId` and its backend-confirmed `openedFeedGroupId`: request
history uses `location-request:<request ID>`; the old share and incident cases
use `location-grant:<grant ID>`. A terminal receipt may have a newer row ID in
that same group. Checkpoint 42 verifies the selected incident ended while the
other confirmed incident remains Live. Record the final settled app URL;
review uses `action=needs-review` and incoming shares use
`action=shared-with-me`, retaining their exact selectors.

Run the evidence validator's negative controls separately from app evidence:

```sh
node --test scripts/testing/feed-uat-evidence-contract.test.mjs
```

These disposable validator fixtures cannot pass the native capture gate.

For a checkpoint with no remaining Feed action, capture the absence on Feed and
the exact returned destination or search detail. Do not link a generic portfolio
or consent landing screen as evidence that the correct record opened.

## Collect and review

Initialize a new private directory **before** any fresh run activity. Launch the
normal app on the booted iPhone 15 Pro. Navigate between Feed and detail without
reloading the app or changing the vault session.

```sh
node scripts/testing/verify-feed-uat-evidence.mjs init "$qa_dir" "$deployed_sha" "$uat_origin"
node scripts/testing/verify-feed-uat-evidence.mjs capture "$qa_dir" 01-kyc-review feed "$sim_udid"
# Tap Review in One and confirm the exact request ID, then:
node scripts/testing/verify-feed-uat-evidence.mjs capture "$qa_dir" 01-kyc-review detail "$sim_udid"
node scripts/testing/verify-feed-uat-evidence.mjs record "$qa_dir" /private/path/checkpoint.json
node scripts/testing/verify-feed-uat-evidence.mjs report "$qa_dir"
```

The private checkpoint JSON contains `case`, `role`, `viewer`, `operationId`,
optional `sourceId` when the route uses a different selector, `feedItemId` for
the selected emergency's recorded receipt, `occurredAt` (UTC),
actual `state`, `copy`, `destination`, and `status`. For a pass, `proof` must also
contain `source`, `requestRef`, `at` (UTC), `operationId`, `viewer`, and `state`.
For payment/reconnect tests record `proof.providerMode` as `stripe-test` or
`plaid-sandbox`; a live transfer return requires `transfer-sandbox`. For a
legacy refresh pass, also supply `proof.readback`: `sessions` (2), `visibleRows`
(1), `selectedRowUnreadAfterRefresh` (false), and both `unreadBefore` and
`unreadAfter`. For a failure or limited provider support, retain the reason and first
failed observation. Never convert a preview into a passed checkpoint.

Open the resulting private `index.html` in journey order. A report with required
steps missing or failed exits nonzero.

## Cross-subagent policy verification

The design generator also renders all admitted event contracts from the shared
policy using synthetic records. Internal agents with no user-facing Feed events
do not receive invented rows. These images are layout/copy previews only.

Extend each private live run with these normal operations and matching sources:

| Source | Fresh operation and authority |
| --- | --- |
| Consent | Request, decision and revoke; participant bundle and consent audit. |
| Connections | Incoming request and response; actual request ID and participants. |
| Location / Circles | Checkpoints 28–44 above: revisioned review, per-grant incidents, durable Check-In receipts, independent membership/access outcomes, privacy-safe search. |
| Calendar | Confirmed event change and pending follow-up; provider result and exact follow-up ID. Repaired grant removes reconnect. |
| Email / KYC | Normal reviewed send; owner send ledger and uniquely bound workflow. Uncertain delivery never offers a blind resend. |
| Files / documents | Approved file action and request delivery; owner/participant receipts. Search/progress stays in detail. |
| Memory / public profile | Reviewable draft/job with exact owner ID. Superseded results must not open today's draft. |
| Private agent | Confirmed update operation, distinct from the offered release. |
| Cards | Real participant request and grant; recipient-bound request/message. |
| Connected systems | Current reconnect generation and repair; old generations stay hidden. |

Known source-destination gaps remain for Calendar mutation events, terminal
Email/KYC, superseded Memory/public-profile jobs, private-agent updates and legacy
Location/Consent outcomes. They currently open recorded Feed detail, without
pretending to open the original provider result. Keep exact-source destination
checks failed until the owning feature exposes a verified selector/read surface.

Live evidence requires configured dedicated roles, deployed candidate revisions,
a sandbox covering the provider flow, and a booted iPhone 15 Pro for native
captures. Shared account history, live money operations and design previews
cannot satisfy those checkpoints.

## Cross-agent search layout rehearsal

`e2e/feed-search.layout.spec.ts` mounts the production search, Feed rows and One
shell primitives against explicitly synthetic provider/session boundaries. It
checks All → Location → person → result → Back → clear → All, plus RIA → Advisor
→ authorized client. Both emergencies remain visible across scopes. It captures
393 × 852 and 1440 × 1000 layouts and rejects overflow or runtime errors. These
images are DESIGN PREVIEW evidence, not live UAT or native acceptance.

Run through the repository Playwright layout pack (or select this spec with the
existing Chromium configuration). `FEED_SEARCH_BEFORE_SOURCE` may point to a
preserved baseline component to capture the same synthetic layout before the
change. Keep output outside Git. Backend real-PostgreSQL tests separately cover
older-than-first-page search, ranking, Unicode names, scope/cursor owner binding,
current contact authorization, privacy negatives and unchanged unread counts.

For live acceptance, repeat the same journey in the dedicated UAT sessions and
record operation IDs and source readbacks. Include partial/misspelled and duplicate
names, confirmed aliases only if a durable source exists, current/revoked advisor
consent, disconnected historical agents, Drive/KYC grouped outcomes, pending
Location actions, pagination and two-session unread. Cloud authentication failure
is a blocked live run; synthetic fixtures cannot satisfy that gate.
