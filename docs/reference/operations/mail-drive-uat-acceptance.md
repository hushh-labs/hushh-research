# Mail + Drive UAT acceptance

Status: incomplete draft; no feature enabled, merge or deployment authorized by this evidence alone.
Runtime remains in `hushh-pda-uat`; the isolated Drive OAuth project is `hushh-drive-uat`.
Mail/Calendar/Firebase clients and existing grants are unchanged.

## Visual Map

```text
Existing left drawer -> independent Mail / Drive connections
Drive OAuth + Picker -> explicitly selected files -> bounded REST reads
Selected files -> encrypted document catalog -> local ingestion / index
Owner retrieval -> document-specific request -> owner approval -> recipient grant
Automated acceptance -> protected merge -> green main SHA -> serialized UAT
```

The selected-file fast path supersedes the earlier hosted-MCP feasibility lane.
No hosted MCP preview or remote tool catalog is required. Google supplies source files;
parsing, embeddings and document access control remain outside Google AI services.

## Implemented checkpoints

- PR0: public reasoning removed from generation summaries, AG-UI events/snapshots, history,
  compatibility stream and frontend storage/rendering; internal continuation stays intact.
- PR1/PR2 foundation: additive migration 227, compatible encrypted v2 envelopes, atomic
  owner-bound PKCE claims, verified Google identity/scopes, refresh leases/version fences,
  safe disconnect, native pending credentials and owner finalization. Successful OAuth
  remains `verifying` until the authenticated Drive API/policy check before a Picker session.
- Selected-file backend checkpoint: exact web identity + `drive.file` scopes, fixed REST
  adapter, default-off Picker admission, owner-bound selection sessions and encrypted catalog
  in migration 228. Selection reports `queued`, not indexed. Scope upgrades, whole-Drive listing,
  remote MCP and provider writes are absent.
- The adapter caps metadata at 256 KiB, ingestion bytes at 4 MiB and each operation/selection
  at 20 seconds. It rejects compressed responses, policy denials, CSE and shortcuts; checks
  source metadata both before and after fetch. The local processing checkpoint below adds bounded PDF/DOCX parsing.
- Catalog concurrency tests cover single-use selection, wrong owner, expiry, policy drift,
  disconnect/account switch, removal during in-flight selection, and removal after reauth failure.
  Source metadata uses a separate server-processing key, not a vault key or OAuth key.
- Existing hosted feature config has independent default-off flags plus a strict
  internal owner cohort. No registry seed, grant, transport, or feature is enabled.
- Web checkpoint: existing left drawer has mounted Chats/Connections views and exactly
  Mail/Drive cards. Web OAuth uses retained popups, exact settlement checks and status
  reconciliation; blocked popups keep chat/drafts in place. The Google web Picker keeps its
  short-lived token out of storage and asks for explicit confirmation before catalog admission.
  Independent disconnect, truthful revocation outcomes, stale-result fencing, owner changes,
  keyboard focus and deactivated-connection recovery have focused automated coverage.
- Mounted Chromium/WebKit contracts exercise 320, 390, 768 and 1440px, real popup windows,
  synthetic external Google boundaries, file confirmation/removal and retained chat state.
  These are component-integration checks, not live-provider or native acceptance.
- Durable ingestion foundation: migration 229 adds owner/document-cascading encrypted
  chunks. Connection-first leases allow one job per owner, five bounded retries, expired
  crash recovery and generation/policy/lease checks before processing and publication.
  Publication switches complete versions atomically; text, source ranges and embeddings
  are encrypted together. Source denial purges the prior index; transient failures preserve it.
  The dedicated finite worker selects the scanner/parser/embedding implementation; no
  API startup hook or live scheduler is activated by this source checkpoint.
- Mail chat checkpoint: the registered typed-chat Email specialist now performs only
  metadata-only `list_needs_reply` / `search_inbox`, behind the default-off Mail flag,
  internal cohort and owner/task/call-bound invocation authority. It reuses Gmail grants,
  skips body/ICS enrichment, preserves One's conversation and does not persist an Email turn.
  The interpreter has no tools; One's tool gate closes before reading external data.
  Disconnect/credential changes suppress late answers. Existing receipts and reviewed Send
  are outside this new lane. Authenticated Gmail consent/read acceptance is still outstanding.
- Mail results render bounded source receipts and explicit connection recovery in the
  existing drawer, including history reload. Mail payloads are not retained in raw tool
  history or frontend result storage. Tests exercise the actual registered SDK dispatch
  with synthetic model/provider boundaries, invocation lockout and next-turn recovery,
  CAS persistence races, thought-signature/call correlation and single-receipt history.
- Privacy checkpoint: content-disabled One/specialist telemetry, sanitized SDK content/error
  logs, export-time exception redaction and suppressed provider HTTP tracing. Real local SDK
  span-export tests include a positive control for exception leakage; no cloud exporter
  or live mailbox is used. Mounted browser tests verify the Mail recovery button, immediate
  Escape/focus restoration and retained drafts without waits or test retries.
- Processing checkpoint: migration 230 defaults legacy selections to background-off.
  Selection is not consent. Per-file versioned disclosure, pause/resume, revision fencing,
  manual sync and six-hour due checks retain stale-worker suppression. A finite worker
  performs at most eight owner jobs within nine minutes; no Vault Owner session is retained.
  ClamAV must approve bytes before parsing. Credential-free leaf subprocesses bound PDF
  pages, DOCX archive/XML work, text, time and local pinned E5 embeddings. Synthetic real
  PDF/DOCX fixtures pass; scanner/image capacity and live processing are still unverified.
- Retrieval checkpoint: authored Documents specialist and tool-less interpreter use the
  owner's encrypted selected index only. Admission enforces task/owner/expiry, generation,
  policy and current Google eligibility before releasing excerpts and answers. Candidate
  count/ciphertext/context budgets fail closed with a narrowing directive. One retains its
  conversation, citations include bounded page numbers, and raw document tool results never
  enter durable history. Registered real-SDK dispatch tests use synthetic model boundaries;
  no authenticated Drive Q&A acceptance is claimed.
- Sharing-domain checkpoint (not yet exposed through Consent Center): encrypted
  requests, source-bound reviews, atomic one-use confirmation claims and per-file pending
  operations in migrations 231/232. Requests reveal no private suggestions to the recipient.
  The separate fixed Google permission adapter permits only individual Viewer creation and
  recorded-permission removal. Whole-batch invalidation prevents further dispatch after a
  known stale source; in-flight successes remain accurately recorded. Abandoned, proven
  undispatched claims terminate with aggregate outcomes instead of locking a file forever.
- Revocation-domain checkpoint: fresh owner review binds the current generation, exact
  recorded grants and original verified Google issuer/client. Disconnect and catalog removal
  do not delete encrypted management receipts. Reconnecting the same Google account can
  reconcile uncertain outcomes with GET only; neither POST nor DELETE is blindly retried.
  Existing/unattributed permissions are never automatically adopted. Revocation checks the
  current direct individual Viewer ACL and refuses observable role/recipient/inheritance drift.
  Google permission IDs identify grantees, not immutable grant instances: a fresh review must
  explicitly disclose removal of the current matching direct ACL, not promise detection of
  an indistinguishable external delete/recreate. Other inherited/group access may remain.
  Grant/revoke outcome events are independent; delivery into Feed/push remains unimplemented.
- Sharing-route checkpoint: authenticated request, private review, exact approval, decline,
  cancellation, delivery status and fresh revocation endpoints. B's request requires a recent
  verified Google Firebase identity matching the Vault Owner, not a Drive connection. All
  responses, including errors, are private/no-store. Validation never echoes private input;
  authority is freshly rechecked before release. Approval returns pending, not provider success.
- Background suggestion checkpoint: migration 233 adds bounded preparation retries and
  fair metadata-only worker scan cursors. Only selected, ready files with current background
  consent enter the tool-less authored suggestion stage. Every observed source, including
  unselected inputs, is version/consent-fenced under publication locks; lease expiry is checked
  again after lock waits. B sees no candidate names or coverage. Three failed attempts require
  explicit owner refresh. Empty/partial coverage is not a complete-coverage claim.
- Finite permission and suggestion worker entrypoints now exist. They use durable job authority,
  not stored owner tokens. Concurrent workers cannot redispatch an uncertain Google write;
  existing receipts are reconciled using reads. These workers are not deployed or scheduled.
- Account-lifecycle checkpoint: migration 234 separates owner-only removal contexts from
  private requests, including a migration-first compatibility trigger. Both account reset
  and deletion call transactional connector/Drive cleanup. B's request, app identity, review
  and full ACL snapshots are erased while A's minimal encrypted removal evidence remains
  discoverable. A's reset preserves revoked monotonic counters; full erasure removes credentials
  and receipts. An uncertain dispatched write leaves only an ownerless keyed-file safety fence,
  without automatic expiry or retry. It requires Google-side management, not a new automatic
  grant. File-lock-key rotation must preserve these fences. No Google permission is removed
  by account cleanup itself, and this mechanism is not a legal retention-policy claim.

Latest integrated local evidence (2026-09-23): 543 focused backend tests passed, including
real disposable PostgreSQL concurrency and synthetic Google/Firebase boundaries; 110 web
tests, typecheck, and 24 mounted Chromium/WebKit checks passed. These are not native artifacts,
live malware-scanner/model capacity evidence, authenticated A/B acceptance or a UAT release.
The subsequent route/suggestion/worker/account-cleanup checkpoint passed 282 focused tests,
including real PostgreSQL lease-expiry, queue-fairness and concurrent scan tests. Thirteen
erasure tests exercise the actual migration-201 identity guard, late results, revocation after
recipient erasure, migration-first writes and rollback. Canonical Mypy passed for
156 source files. The prior CI head passed web, native Xcode and integration gates but failed
two obsolete specialist/identity assertions; corrected focused tests pass locally and need
new-head CI. This is not evidence of native Drive feature completion.
Consent Center/notification delivery, native recovery, deployed worker isolation/configuration
and authenticated A/B acceptance remain required before exposing this domain.

Focused automated coverage includes a disposable socket-only PostgreSQL cluster (or the
existing explicitly test-only CI PostgreSQL service), real concurrent claim/refresh tests,
stale results, wrong owner, partial consent, rotation, native finalization, revocation fences,
legacy envelopes, cryptographically signed identity fixtures, bounded provider responses,
redacted errors, and route authentication. Synthetic consent is not live-provider proof.

## Required before enabling native authorization

The Google callback is fixed at
`https://api.uat.hushh.ai/api/connectors/oauth/native/callback`.
Its query contains a short-lived authorization code and signed state. Application filters
redact both; Cloud Run generates its own request logs outside those filters.

Inventory **all** applicable log sinks (project, ancestor and custom sinks) before consent.
Record approved routing exclusions for only the secret-bearing callback request records,
while retaining redacted outcome/security telemetry. A narrow filter to review is:

```text
resource.type="cloud_run_revision"
resource.labels.service_name="consent-protocol"
LOG_ID("run.googleapis.com/requests")
httpRequest.requestUrl =~ "^https://[^/]+/api/connectors/oauth/native/callback([?].*)?$"
```

Do not apply a broad service/logging disablement or claim an `_Default` sink change covers
ancestor/custom sinks. Routing exclusions act after ingestion; the accurate claim is
“not retained or routed by verified sinks,” not “never ingested.” Use synthetic callback
values for verification; never place a real code/token in logs or test evidence.
References: [Cloud Run logging](https://docs.cloud.google.com/run/docs/logging),
[Cloud Logging routing](https://docs.cloud.google.com/logging/docs/routing/overview).

The current cleanup is bounded and opportunistic: lifecycle traffic scrubs expired attempt
secrets and deletes workflow rows expired over 24 hours ago. Wire and prove the existing
maintenance/scheduler lane for a hard retention deadline before rollout. Cleanup must not
revoke a provider grant or mutate an active connection.

## Remaining delivery checklist

- [x] Dedicated Drive web client provisioned in `hushh-drive-uat`; UAT web origin and both
  exact callbacks verified. No Mail/Calendar client changes.
- [ ] Backend client-secret binding and browser-restricted Picker configuration verified
  without exposing secret values; approved synthetic-account consent exercised.
- [ ] Separate document-processing encryption key and fixed REST registry policy provisioned
  in UAT. No plaintext source metadata or key values in setup evidence.
- [ ] Selected-file `drive.file` consent and Google Picker; one fixed REST transport with
  capability checks, bounds and late-result suppression. No whole-Drive scan or mutations.
- [ ] Encrypted document catalog, durable ingestion/retry/deletion, local non-Google parsing
  and embeddings, owner-private retrieval and bounded source references.
- [ ] Verified scanner and isolated parser/embedding runtime. Passive PDF/DOCX parsing is
  not malware scanning; subprocess resource limits alone are not a security sandbox. Do not
  add a heavy scanner into the existing API memory budget without capacity proof. Binary
  processing must fail closed until these prerequisites pass; tests use synthetic processors.
- [ ] Specific-document requests, explicit owner decisions, recipient/version/mode/expiry
  grants, immediate revocation and metadata-only audit in the existing Consent Center.
- [ ] Mail metadata-only delegated reads with stable One conversation identity; unchanged
  receipts, Calendar, Firebase and reviewed Send. Implementation and focused regression
  coverage exist; this checkbox remains open until authenticated UAT acceptance.
- [x] Mounted left-drawer Chats/Connections UI with independent Mail/Drive cards; web popup
  settlement and in-place draft preservation. No permanent desktop sidebar.
- [ ] Encrypted one-use full-page recovery; currently blocked popups offer retry in chat.
- [ ] Native `connectDrive` bridges/coordinators, drive.file-only system-browser Picker,
  authenticated About identity and encrypted pending selection confirmation; real iOS/Android
  test/build artifacts. Existing staged OAuth completion is not native Picker proof.
- [x] Chromium/WebKit mounted web checkpoint at 320/390/768/desktop widths. Full end-to-end
  acceptance remains required after ingestion/retrieval/sharing and native parity are complete.
- [ ] Callback log-routing and scheduled retention proof before granting access.
- [ ] Required CI/review, final overlap reconciliation, protected merge, green containing main
  SHA with its own Main Post-Merge Smoke Gate, serialized immutable-SHA UAT deployment.
- [ ] Live serving SHA/image/revision/health and authenticated connector acceptance.
- [ ] Internal connection cohort first, reads only after acceptance; redacted monitoring and
  tested feature-disable/revision rollback. No destructive schema rollback.

Only exact-file owner-approved individual Google Viewer grants and removal of recorded
Hussh-created permissions enter the new sharing scope. General Drive writes, download UI,
voice execution and production deployment remain out of scope. Disconnect stops One, not
existing Google ACLs. Sharing originals exposes later edits until the grant is revoked.

## Latest read-only release preflight (2026-09-23 local)

The observed UAT backend served main SHA `8d132654a`, revision `consent-protocol-01340-noh`;
web served `09db752f`, revision `hushh-webapp-00884-87w`, each with 100% traffic. Neither
contains this branch. Runtime metadata did not contain direct bindings for `GOOGLE_DRIVE_OAUTH_CLIENT_ID`,
`GOOGLE_DRIVE_OAUTH_CLIENT_SECRET`, `GOOGLE_DRIVE_PICKER_API_KEY`, `DRIVE_DOCUMENT_KEY_V1`
`DRIVE_SHARING_KEY_V1` or `EXTERNAL_CONNECTOR_CREDENTIAL_KEY`; matching secrets were absent from the inspected
runtime-project metadata. No secret payload was read. Existing Gmail bindings were present.
The inspected Scheduler inventory had no connector cleanup or Drive ingestion job.
The dedicated Drive project's Secret Manager API was disabled; its OAuth client existing
does not prove runtime bindings. Main was freshly fetched at `09db752f65582011559f02ec053f9c6abd139777`.
No migration 230–232 collision was found in current main or the 56 inspected main-targeted
open PRs. Authentication/runtime, generated registry and schema-contract overlap remains
with other open work and must be rechecked at the final candidate.

Owner consent, cohort values, registry policy and applied migrations remain unverified,
not proven absent. Callback sink exclusions, a restricted Picker key, native artifacts and
isolated processor capacity also remain unproven. Recheck current state before rollout;
these observations do not authorize a production deployment or substitute for acceptance.
