# Mail + Drive UAT acceptance

Status: historical post-merge UAT deployment verified; verify the current live rollout and two-account acceptance separately. Mail/Drive acceptance remains incomplete.
Runtime remains in `hushh-pda-uat`; the isolated Drive OAuth project is `hushh-drive-uat`.
Mail/Calendar/Firebase clients and existing grants are unchanged.

## Latest verified state

PR [#6967](https://github.com/hushh-labs/hushh-research/pull/6967) passed its
Main Post-Merge Smoke Gate and immutable-SHA UAT deployment. The backend and web
services serve that merged SHA at 100% traffic, and their health/root checks
succeeded. This proves deployment, not document-processing or authenticated
sharing acceptance. Connector feature flags and the internal-owner cohort remain
off; indexing remains fail-closed. The detailed evidence is in
[Post-merge UAT delivery record](#post-merge-uat-delivery-record-2026-09-23).

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
- Native One Picker backend checkpoint: a separate owner/generation/credential-version-bound,
  ten-minute PKCE attempt uses only `drive.file`, receives Google’s fixed HTTPS redirect, stages
  at most 25 encrypted candidates after callback-token and existing-grant metadata checks, and
  requires the original owner to confirm before catalog insertion. The callback token, OAuth
  code and selected Google IDs are transient; none are persisted or handed to the app.
- The adapter caps metadata at 256 KiB, ingestion bytes at 4 MiB and each operation/selection
  at 20 seconds. It rejects compressed responses, policy denials, CSE and shortcuts; checks
  source metadata both before and after fetch. The local processing checkpoint below adds bounded PDF/DOCX parsing.
- Catalog concurrency tests cover single-use selection, wrong owner, expiry, policy drift,
  disconnect/account switch, removal during in-flight selection, and removal after reauth failure.
  Source metadata uses a separate server-processing key, not a vault key or OAuth key.
- Hosted feature config has independent default-off flags. UAT admission requires
  either exact Firebase UIDs or the explicit all-signed-in-UAT-users mode.
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
  UAT rollout admission and owner/task/call-bound invocation authority. It reuses Gmail grants,
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
- Sharing-domain checkpoint: encrypted
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
  Grant/revoke outcome events are independent; live delivery into Feed remains unimplemented.
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
- Finite document, suggestion and permission workers use durable job authority, not stored owner
  tokens. Concurrent workers cannot redispatch an uncertain Google write; existing receipts are
  reconciled using reads. A default-off, OIDC-protected Drive work drain now sequences a small
  bounded UAT sweep (indexing -> suggestions -> permission work -> notifications); it has no API
  startup/background hook and remains inactive until explicit UAT runtime/scheduler configuration.
- Notification-outbox checkpoint: migration 235 gives the existing opaque Drive-share events a
  short lease, three bounded dispatch attempts, fair inspection and crash recovery. The finite
  worker sends only one of the six reviewed `document_share_*` event types plus opaque request,
  event and message IDs through the existing push adapter; its deterministic event-ID tag
  deduplicates client delivery. Web/native derives its fixed review target locally and ignores
  dynamic links for these event types. It never decrypts request/review/permission data or calls
  a provider under the request transaction. `delivered_at` and
  `notification_settled_at` mean the worker settled a dispatch attempt—not that a device showed
  it or a person read it. Unknown event types are terminally suppressed without dispatch. The
  worker is not live-notification accepted.
- Account-lifecycle checkpoint: migration 234 separates owner-only removal contexts from
  private requests, including a migration-first compatibility trigger. Both account reset
  and deletion call transactional connector/Drive cleanup. B's request, app identity, review
  and full ACL snapshots are erased while A's minimal encrypted removal evidence remains
  discoverable. A's reset preserves revoked monotonic counters; full erasure removes credentials
  and receipts. An uncertain dispatched write leaves only an ownerless keyed-file safety fence,
  without automatic expiry or retry. It requires Google-side management, not a new automatic
  grant. File-lock-key rotation must preserve these fences. No Google permission is removed
  by account cleanup itself, and this mechanism is not a legal retention-policy claim.
- Consent Center web checkpoint: metadata-only document rows use exact paginated counts,
  distinguish approval from recorded Google delivery, and remain manageable after disconnect.
  Opaque namespaced links from Feed open the owner-protected exact-file review, not generic
  PKM approval or voice execution. Explicit sharing/removal preserves partial coverage and
  recorded outcomes. Vault generation checks run at dispatch and between every chained read;
  a successful mutation followed by a failed refresh still reconciles the generic feed.
  Private details stay in component memory. Missing pre-rollout tables preserve ordinary
  consents without hiding real SQL failures. This does not prove live notification delivery,
  native recovery or authenticated Google acceptance.
- Request-creation web checkpoint: connected profiles provide purpose/period entry, fresh
  same-current-user Google verification and separate Firebase/Vault headers. Public person
  references resolve server-side; B needs no Drive connection. Memory-only unchanged retries
  reuse their request ID, dismissal/navigation is disabled during submission, and cancellation
  does not falsely deny an earlier uncertain submission. Sent documents in the existing
  Consent Center uses separate bounded counts/pages; no new inbox or incoming approval count.
  Native identity verification uses an additive same-user reauthentication bridge;
  it does not imply native Drive OAuth/Picker completion.

Latest integrated local evidence (2026-09-23): 543 focused backend tests passed, including
real disposable PostgreSQL concurrency and synthetic Google/Firebase boundaries; 110 web
tests, typecheck, and 24 mounted Chromium/WebKit checks passed. These are not native artifacts,
live malware-scanner/model capacity evidence, authenticated A/B acceptance or a UAT release.
The subsequent route/suggestion/worker/account-cleanup checkpoint passed 282 focused tests,
including real PostgreSQL lease-expiry, queue-fairness and concurrent scan tests. Thirteen
erasure tests exercise the actual migration-201 identity guard, late results, revocation after
recipient erasure, migration-first writes and rollback. Canonical Mypy passed for
156 source files. CI for `238a758d59a59fb34e861b7e2cf6b076276deff2` passed every required lane,
including the corrected specialist/identity assertions. The subsequent Consent Center web
checkpoint passed 110 focused backend checks, 61 web tests and eight mounted Chromium/WebKit
contracts at 320/390/768/1440px. These checks use synthetic provider boundaries and do not
prove native Drive feature completion.
The subsequent requester checkpoint passed 45 backend tests (including real PostgreSQL
61-row pagination/isolation with execution disabled), 144 focused web tests and 16 mounted
Chromium/WebKit cases across the same four widths. Bandit static-fragment false positives
are narrowly annotated; all caller values remain parameter-bound. Typecheck, changed-file
lint and canonical Mypy passed. These checks are synthetic at the Firebase/Google boundary.
The native identity checkpoint adds iOS/Android same-user reauthentication with main-thread
admission, callback/expiry/account fences, timeout quarantine and no replacement sign-in.
Local synthetic Capacitor export/sync and unsigned iOS `build-for-testing` passed; this is
compile evidence, not an XCTest execution or UAT artifact. Focused web service/component
tests include native proof, cancellation, lock, unmount and idempotent retry. A dedicated
path-filtered Android PR compile/JUnit lane uses a non-authorizing fixture, no signing or
deployment secrets, and is required by CI Status Gate when Android contracts change.
Its execution and the new native tests must pass on the exact candidate SHA before merge.
This checkpoint passed 102 focused web tests, 75 backend projection/legacy-sharing tests,
14 native-CI contract tests, TypeScript, native static/plugin contracts, changed-file lint,
canonical Mypy and governance. The prior CI's person-profile vault mock and offline SQLite
projection failures are covered by those regression suites; real PostgreSQL errors still
propagate. Android compilation and XCTest execution are delegated to the exact-head CI run.
Notification delivery, native recovery, deployed worker isolation/configuration
and authenticated A/B acceptance remain required before exposing this domain.

Focused automated coverage includes a disposable socket-only PostgreSQL cluster (or the
existing explicitly test-only CI PostgreSQL service), real concurrent claim/refresh tests,
stale results, wrong owner, partial consent, rotation, native finalization, revocation fences,
legacy envelopes, cryptographically signed identity fixtures, bounded provider responses,
redacted errors, and route authentication. Synthetic consent is not live-provider proof.

## Required before enabling native Google authorization or Picker

The normal native OAuth callback is fixed at
`https://api.uat.hushh.ai/api/connectors/oauth/native/callback`; the native One Picker callback
is fixed at
`https://api.uat.hushh.ai/api/connectors/google_drive/picker/native/callback`.
Both callback queries contain a short-lived authorization code and signed state; the Picker
callback also contains selected Google file IDs. Application filters redact them, but Cloud Run
generates its own request logs outside those filters.

Inventory **all** applicable log sinks (project, ancestor and custom sinks) before consent.
Record approved routing exclusions for only the secret-bearing callback request records,
while retaining redacted outcome/security telemetry. A narrow filter to review is:

```text
resource.type="cloud_run_revision"
resource.labels.service_name="consent-protocol"
LOG_ID("run.googleapis.com/requests")
httpRequest.requestUrl =~ "^https://[^/]+/api/connectors/(oauth/native/callback|google_drive/picker/native/callback)([?].*)?$"
```

Do not apply a broad service/logging disablement or claim an `_Default` sink change covers
ancestor/custom sinks. Routing exclusions act after ingestion; the accurate claim is
“not retained or routed by verified sinks,” not “never ingested.” Use synthetic callback
values for verification; never place a real code, token, selected file ID, or filename in logs
or test evidence. Sink inventory plus exclusion verification for **both** fixed callback paths
is a release prerequisite before either native flow is enabled.
References: [Cloud Run logging](https://docs.cloud.google.com/run/docs/logging),
[Cloud Logging routing](https://docs.cloud.google.com/logging/docs/routing/overview).

The current cleanup is bounded and opportunistic: lifecycle traffic scrubs expired attempt
secrets and deletes workflow rows expired over 24 hours ago. Wire and prove the existing
maintenance/scheduler lane for a hard retention deadline before rollout. Cleanup must not
revoke a provider grant or mutate an active connection.

## Required UAT Drive registry provisioning

The `google_drive` catalog row is operator configuration, not a schema seed and
not a generic external-MCP descriptor. After the exact UAT migration target is
attested and before enabling any Drive cohort, use the fixed, no-secret
provisioner from the UAT runner with its existing Cloud SQL proxy and `DB_*`
environment:

```bash
cd consent-protocol
ENVIRONMENT=uat HUSSH_RELEASE_ENVIRONMENT=uat GCP_PROJECT_ID=hushh-pda-uat \
  CLOUDSQL_INSTANCE_CONNECTION_NAME=hushh-pda-uat:us-central1:hushh-uat-pg \
  python scripts/ops/reconcile_google_drive_uat_connector.py --activate
ENVIRONMENT=uat HUSSH_RELEASE_ENVIRONMENT=uat GCP_PROJECT_ID=hushh-pda-uat \
  CLOUDSQL_INSTANCE_CONNECTION_NAME=hushh-pda-uat:us-central1:hushh-uat-pg \
  python scripts/ops/reconcile_google_drive_uat_connector.py
```

The first command can create or reactivate only the reviewed UAT row; the
second is read-only verification. Both require the canonical UAT environment,
project, Cloud SQL instance and server-derived database identity. They accept
no endpoint, scope, redirect, OAuth client or secret argument, serialize on a
connector-specific advisory lock, and refuse registry drift rather than
rewriting it. Their output contains only connector ID, transport, policy hash
and redirect count. Registry activation does not enable Drive: the independent
feature flags and UAT admission mode remain default-off.

## Required UAT Drive work-drain configuration

The source route is intentionally default-off. After the governed backend candidate containing
migration 235 is deployed, the UAT operator must configure these non-secret runtime values on
that exact revision:

```text
ENVIRONMENT=uat
DRIVE_WORK_DRAIN_ENABLED=true
DRIVE_WORK_DRAIN_SCHEDULER_PROJECT_ID=hushh-pda-uat
DRIVE_WORK_DRAIN_SCHEDULER_SERVICE_ACCOUNT_EMAIL=drive-work-drain-sched@hushh-pda-uat.iam.gserviceaccount.com
DRIVE_WORK_DRAIN_SCHEDULER_AUDIENCE=https://<exact-backend-origin>
```

The feature flags remain independently default-off: `GOOGLE_DRIVE_CONNECTION`,
`DRIVE_DOCUMENT_INDEXING`, and `DRIVE_DOCUMENT_SHARING` each require explicit activation.
UAT admission can use exact Firebase UIDs in `CONNECTOR_INTERNAL_OWNER_COHORT` or
`CONNECTOR_UAT_ALL_USERS=true` for every signed-in UAT user. These modes are mutually exclusive;
`*` and `all` remain invalid cohort values, and production cannot enable either mode.
Google's OAuth app audience must independently allow the intended Google accounts.
The Scheduler identity must be the exact same-project address above;
the route rejects missing/non-OIDC tokens, a non-Google issuer, another project, a mismatched
audience or an unverified service-account email.

Run [`deploy/drive/setup_work_drain_scheduler.sh`](../../../deploy/drive/setup_work_drain_scheduler.sh)
through the infrastructure/release owner with `BACKEND_URL` and the matching `OIDC_AUDIENCE`.
The helper creates or updates only `drive-work-drain-uat`, posts to the fixed drain route every
two minutes, and verifies its OIDC target. If Cloud Run ingress requires IAM invocation, grant
only that scheduler account `roles/run.invoker` through the approved infrastructure path before
running the helper; do not weaken the route or make a direct Cloud Run deployment. A successful
Scheduler attempt means a bounded work dispatch occurred—not that Firebase delivered a push,
someone opened a review, or Google shared a file.

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
- [ ] Unified Drive work drain scheduled with verified Firebase push configuration, registered
  synthetic-device token, normal notification cue and authenticated notification-tap proof.
  Source-level outbox/lease/retry and Scheduler configuration do not prove device delivery or
  receipt.
- [ ] Verified callback log-routing for both native OAuth and native Picker fixed paths, plus
  scheduled retention proof, before granting access.
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

## Post-merge UAT delivery record (2026-09-23)

This is a later observation than the preflight above; it does not close the unchecked
acceptance items. PR [#6967](https://github.com/hushh-labs/hushh-research/pull/6967)
merged at `04d80bb07d17946ff8260033b2a01dd467796957`. Its own Main Post-Merge Smoke Gate
[succeeded](https://github.com/hushh-labs/hushh-research/actions/runs/35812159104), and the
immutable-SHA UAT [deployment](https://github.com/hushh-labs/hushh-research/actions/runs/35812326471)
completed successfully. Backend `consent-protocol-01343-pag` and web
`hushh-webapp-00886-z5n` each serve that SHA at 100% traffic; the backend health endpoint
and web root responded successfully. Their image digests were
`sha256:69494f74b4f6a3093fdaf825de74899ccbc70bd806da6e664f4905f1fc4dbadf` and
`sha256:2a4fce17aa85b0f811a9d4aab38fe598c975462e21ee290d08299c4c2f4d6fc3`,
respectively. The fixed UAT Drive REST registry was activated and
read-only rechecked with policy hash `7d82cda74ab72a36d5b39d211a6991df456e247f894cde25b6e54c0256383da4`.
The OIDC-protected `drive-work-drain-uat` scheduler is enabled every two minutes, and one
explicit invocation returned HTTP 200.

These checks establish deployment and dispatch, not document-processing success or
end-to-end A/B sharing. The serving backend has one 1 GiB container, no ClamAV daemon,
and no baked offline embedding model. Document indexing remains fail-closed; all connector
feature flags and the internal-owner cohort remain off. The governed UAT runtime sync also
defaults those flags to off on each deployment. A separately verified processor runtime,
durable named-cohort rollout configuration, authenticated synthetic A/B consent, and native
device acceptance are required before claiming the journey works. GCP administration does
not replace A's and B's Google file grants or a registered notification device.
