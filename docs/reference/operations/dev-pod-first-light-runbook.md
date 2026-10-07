# Dev BYOC pod updates and controlled direct access

## Visual Map

```mermaid
flowchart LR
  A["Reviewed dev release<br/>and predecessor compatibility"] --> B["Owner approves exact release<br/>for current pod"]
  B --> C["Authenticated durable handoff"]
  C --> D["Replace image on same service"]
  D --> E["Verify recovery and installed digest"]
  E --> F["Verify direct ingress and admission"]
  F --> G["Publish owner-bound endpoint"]
```

## Owner-project first-light checks (2026-08-11 rehearsal)

For a new `user_gcp` bootstrap, treat API enablement as asynchronous. Verify Cloud
Resource Manager is enabled and required API operations have completed before
using them. Verify that the Cloud Storage service agent can use the bucket's KMS
key and that the deployer has `iam.serviceAccounts.actAs` on the **exact** pod
service account. Read back the rendered service identity and live IAM; a correct
helper without a production caller does not establish custody. Keep opaque
billing identifiers separate from the owner's selected space name, and verify
the pod's machine-route wall before publishing direct readiness. These are
dated rehearsal findings to recheck per project, not fleet-wide acceptance.
Placement is explicit: no current placement or setup intent is `unplaced`, and Shared requires
the owner's recorded choice. Pending setup, failed placement reads and assigned
owner-cloud pods never receive a Shared fallback (`personal_agent_hosting.py`).
The [recovery guide](./pod-backup-and-recovery.md) owns the pod's conditional
first-boot key creation and encrypted recovery contract.

## Maintaining an existing owner's software release

This section governs upgrades; the dated first-light checks above and legacy
bootstrap exception below are historical.
Dev's control plane is `hushh-pda-dev`. A user-cloud deployment can live in a
different project: resolve the named owner's registry entry before inspecting its
service. Shared-project service inventory does not prove an owner has no pod.

Build `consent-protocol/Dockerfile.pod` for the deployment platform with generated
contracts staged by the existing build recipe. Set `POD_IMAGE_TAG=dev-<full-source-sha>`.
Record source commit, immutable source digest, copied owner-project digest,
Cloud Run revision and `/pod/info` imageTag separately. Never treat `latest`, an
image version variable, or Cloud Run Ready as proof of the serving application.
Keep the tombstone-compatible ancestry check and owner-local encrypted state.

Normal updates use the existing status, Feed approval, registry operation and
upgrade service. Publishing a release must not install it. Bind each approval to
the owner, service incarnation and immutable image digest. Later snoozes the Feed
reminder for 72 hours; Settings can still install a compatible release with no
active upgrade lease. Deferral does not approve or start an installation.
Wait for the authenticated handoff's durable idle receipt before replacement.
Verify the running release, readiness and memory/authority continuity before
reporting success. Keep the automatic sweep disabled until the deployed hub
enforces owner approval (`PERSONAL_AGENT_UPGRADE_APPROVAL_REQUIRED=true`).

### Release metadata and compatibility

The dev build reads the reviewed version, summary, changelog and supported
predecessor digests from `deploy/pod-release.json`. The existing build recipe
resolves the executable image digest and assembles metadata with the exact source
revision and workflow run through `scripts/deploy/assemble-pod-release.py`. It
archives that metadata with the build and configures `HUSSH_ONE_POD_RELEASE_B64`
alongside `HUSSH_ONE_POD_IMAGE`. This is governed deployment provenance, not an
independent cryptographic signature.

When recovery has qualified an already published dev image, the optional JSON
pin accepted by [the reuse verifier](../../../scripts/deploy/reuse-pod-release.py)
records its image, original source revision, original workflow run and
archived-release SHA-256. Create that reviewed pin only for the qualification
change; the existing build recipe owns its location. Dispatch the existing
main-owned workflow with `build_pod_image=true`; the candidate-owned build recipe
validates the archive and executable manifest, then publishes the new descriptor
without rebuilding the pod. `sourceRevision` retains the image's original source;
build provenance separately records the descriptor commit and new publisher run.
A mismatch aborts publication. Remove the reuse pin before the next application
image build. This path neither proves compatibility nor approves installation.

An empty `supportedUpgradeDigests` list offers no installation path for existing
pods. Add a predecessor only after proving its migration, encrypted recovery and
update continuity. Missing, mismatched or incompatible metadata refuses a new
upgrade before cloud access. A durable operation already in progress retains
its original approval and recovery path when a newer release is published.

Settings and Feed use the same status and approval contracts. Installed release
metadata follows the provider's recorded digest; publishing a new offer does not
erase the previous installation's verification. Shared accounts see their managed
service version without pod installation controls. The authored dev release and
its source tests do not establish a completed live update rehearsal or authorize
publication through the production stable channel.

Verified completion projects into the existing Feed only after registry
publication succeeds, using the approved operation ID as the Feed source key.
The synchronous and reconciliation paths share this projection; a retry cannot
create another notice. Failed, pending, unchanged-image and lost-publication
results do not emit completion. A Feed failure cannot undo an installation;
status remains a pure reader and the registry remains authoritative.
If a deployed defect omitted a notice, repair only that verified operation's
presentation through the existing Feed writer after checking its owner,
incarnation, installed digest and ready acknowledgement. Read back one source-key
row and unchanged registry state; never reinstall to manufacture a notice.

### Request concurrency and responsive controls

Verify Cloud Run request concurrency separately from the pod's one-instance,
one-worker contract. A Cloud Tasks worker or open relay occupies a request slot.
With maximum instances one and request concurrency one, status and cancellation
requests can wait behind that work. The September 28 reviewer rehearsal observed
organization completing before its queued cancellation could execute.

New on-demand Files provisioning configures concurrency eight in
`pod_files/provisioning.py`. Existing image updates intentionally preserve the
owner's current concurrency through `pod_upgrade_configuration.py`; installing
a newer image does not select a new capacity configuration. Record an explicit
choice before changing an existing owner's setting. Preserve one instance, one
worker, the selected CPU/memory, encrypted storage and keys. A configuration
revision still needs the existing authenticated maintenance handoff, incarnation
checks, recovery readback and renewed direct admission. Do not add workers or
instances to work around a request-slot limit.

After an authorized change, verify concurrent status/cancellation during bounded
work before the two- and four-operation stages. Observe memory and idle behavior;
configuration alone is not capacity acceptance. Cloud Run documents
[per-instance concurrency](https://docs.cloud.google.com/run/docs/about-concurrency)
and [WebSocket request behavior](https://docs.cloud.google.com/run/docs/triggering/websockets).

The HTTP startup probe allows up to 240 seconds for encrypted recovery before
accepting requests. Image-only BYOC updates preserve the observed HTTP health and
liveness probes; a TCP startup probe requires reconciliation before replacement.
A longer startup allowance does not qualify cold latency. Capture recovery phases
and replay work separately; the existing 150-second update observation window can
leave slower starts unconfirmed until reconciliation verifies the installed digest.

### Isolated image recovery rehearsal safeguards

When constructing a fixture `PodSpec`, retain its registry `billing_space_id`
explicitly. Normal owner update flow already carries that field. An omitted
fixture field can clear billing attribution during image replacement; it is not
permission to reconcile a real owner assignment implicitly. Compare runtime
settings by environment name and provider fields rather than provider ordering.

A failed candidate startup is a failed receipt even if the previous revision
continues serving. One bounded unchanged-configuration retry may distinguish a
transient failure, but does not establish its cause. Verify serving digest,
durable key/cursor, private IAM and unchanged service identity before recording
recovery. Isolated maintenance never substitutes for Settings owner approval.

### Recovering a denied Files queue creation

For a blocked Files activation, retain its existing approval, lease, successful
resource receipts and failed observation. A prior update's acknowledgement cannot
prove this operation. The maintenance-only `upgrade_pod` argument
`resume_files_queue_operation` admits one continuation of the exact recorded
queue-create HTTP 403 after fresh permission, queue-absence, worker-identity and
unchanged-service checks. Use the already approved immutable target and operation;
do not publish another approval, clear the lease or reset owner resources.

The registry claims continuation by strict comparison with the observed metadata.
Only the unfinished resource suffix runs, followed by the normal authenticated
drain and approved image/configuration installation. If the approved digest is
already installed, record this as a configuration restart, not an image upgrade. Configuration refusal remains visibly blocked and
retains the reservation. Unknown provider outcomes or a second denial require
investigation; they do not authorize replay. Queue permission checks allow a
bounded propagation wait before the durable pre-write authority checkpoint.
Verify installed digest, encrypted continuity and the exact completion receipt
before recording acceptance. This source recovery path does not itself prove a
successful live continuation. On 2026-10-01 the personal dev operation completed
this continuation on the same service and digest; that receipt does not qualify
other owners or production.

### Reconciling a legacy Files resource receipt

An untyped legacy bucket/key receipt requires original successful creation
records, the original bootstrap principal and current resource identities.
Current IAM alone does not prove creation ownership. Reconcile only the receipt
through a full-snapshot conditional write; preserve approvals, leases and unrelated
metadata. Missing creation evidence stops reconciliation.

If Files requires public-access prevention to be enforced, snapshot and read back
the bucket's retention, encryption, IAM and object inventory around that precise
change. Preserve recovery and PKM prefixes. Receipt correction grants no deletion
authority and does not replace the owner's exact Files-plan approval.

### Owner-direct access (dev source wiring; verify the serving revision)

The dev source wires widening and admission through the existing heartbeat.
The checks below describe what the deployed revision must prove. Do not widen
ingress or write readiness by hand to manufacture acceptance.

**A new Google own-cloud agent** (`user_gcp`) is created with Cloud Run ingress
`all` and an `allUsers` invoker behind the in-pod machine-route wall, and records
`ingress: external` (`owner_direct_ingress`). Azure Container Apps agents record
`external` from the start. The managed `gcp` tier stays dev-only.

**An existing hub-only Google agent** (`ingress: internal`) is widened by the hub on
the dev lane when its pod beats (`owner_direct_widen.schedule_widen_if_due`), using
the owner's bootstrap identity the hub already holds. Only a pod whose heartbeat
reports the `aiSelection` advert is widened: that image postdates the in-pod wall, and
an older image stays hub-only until an approved update. In order: the service UID must
match the row; the public invoker is granted **first**; only then is the service's
ingress annotation set to `all` with a revision nonce (a replace on the same service,
so the URL survives); the new revision must be Ready; the pod key is re-pulled; and
one compare-and-set (`promote_internal_to_external`) moves the row from `internal` to
`external` for that exact owner, HushhID, service UID and URL. It never writes
`direct`. Each attempt is claimed per row with a `directIngressWiden` marker and
backs off from 5 minutes to 6 hours. An approved update of such an agent also renders
ingress `all` but keeps recording `internal` until the widening promotes it. The
update does not grant the invoker first, so it can open ingress before a later grant
is refused; the service then stays IAM-gated (no `allUsers` invoker) and reachable by
the hub alone. `pod_heartbeat.py` now calls `schedule_widen_if_due`; source wiring
does not prove that the serving hub or pod has that implementation.

**Admission** (`pod_external_ingress_admission`) then promotes `external` to
`direct` together with the readiness receipt, on a live beat, only when all of
these hold: the key was recorded from that URL; anonymous `/pod/info` answers 404
with exactly the pod wall's body (`consent-protocol/hushh_mcp/services/pod_wall.py`), so a Cloud Run
IAM 403 or a provider 404 page is not mistaken for the wall; anonymous `/health`
answers 200; the app origin's CORS preflight is allowed with that origin echoed;
and, for Google, the live service read with the bootstrap identity is the same
incarnation, has ingress `all` and lists `allUsers` under `roles/run.invoker`. Any
failure leaves the row unchanged and the next beat retries. While a Google row is
`external` and not yet admitted, each live beat mints a bootstrap token and makes two
Cloud Run reads. In plan mode (localhost with no live Google access) the IAM check
reports `iam_unverifiable`, so a localhost Google row is never admitted to `direct`;
that is by design. The hub then publishes
the signed endpoint; the browser pins it only after its own admission succeeds.
Puppy access still requires the owner's explicit per-device choice in Trusted
devices.

Direct setup must bind the authenticated owner to this exact pod before issuing
its local app session. Connector/AI setup then uses that owner session with the
required scope and held incarnation; hub consent alone cannot open a credential
envelope (`pod_owner_door.py`). Test a foreign owner and an unwalled provider
response as negative controls before claiming direct setup accepted.

**Organisation policy.** If a policy refuses `allUsers` (for example Domain
Restricted Sharing), the row keeps `internal` and records
`directIngressBlocker.code = ORG_POLICY_REFUSES_PUBLIC_INVOKER`. On the widening
path ingress is not changed, because the grant comes first; an approved update may
already have set ingress `all` (see above), which stays IAM-gated. The blocker
survives heals, provisions and upgrades. Adoption of an existing service rewrites the
metadata whole and drops it, and the next widening attempt records it again. The
owner sees it in `GET /api/one/personal-agent/status` (`directIngressBlocker`). On
dev it is `retryable`, and after the policy is changed Retry calls
`POST /api/one/personal-agent/direct-ingress/retry` to clear the blocker and start
one attempt. On uat and production, where nothing widens, it is not `retryable` and
Retry keeps the blocker and does nothing. Never work around the policy.

**Outside dev** (uat, production) existing hub-only agents are not widened and an
update keeps `internal`; that waits for the dev proof. `record_direct_ingress_observed`
and `record_direct_readiness` remain for recovery only and are not part of setup.

### Google connector and notification acceptance

Private native authorization uses public-client PKCE and an owner-direct sealed
code/verifier envelope. A web QR carries connector intent only and must not carry
an owner, endpoint or credential. Confirm the signed-in provider account and
granted scopes at the pod, then read back owner-authenticated status. Google
revocation is project/account-wide. The source legacy-to-private transition now
fences existing credential rows, confirms the owner's choice and provider revocation
before opening fresh native authorization. The pod requires current transition
admission, drops affected token caches and validates the exact credential ID and
generation through provider refresh before redemption. Only `invalid_grant`
retires an old grant; provider outages block fresh redemption, and credential
timestamps are not revocation evidence. Completion clears unchanged legacy custody.
Verify provider refusal, changed snapshot/placement and incomplete cleanup with
the owning transition tests; live provider/native acceptance remains unproved.
Do not revoke an old project token after issuing a fresh sibling grant.

For notifications, verify the topic in `GOOGLE_CONNECTOR_OAUTH_PROJECT`, the
owner-project direct subscription and OIDC account, exact pod audience/endpoint,
DLQ forwarding IAM and retained DLQ subscription. An Azure pod additionally needs
an explicit Google notification-project adapter; Azure authority alone is insufficient.
The OAuth-project topic remains operator-owned and is outside automatic owner
resource erasure. Owner resources and grants require qualified retained receipts.

Parked migration 956 and its existing-operation checkpoint port must be validated
and deployed before accepting notification mutations. Without that port or the
other prerequisites, notifications remain unavailable while core chat/recovery
retain their independent status. Verify bounded retries/retention and operator
recovery status, failed listener retry with unchanged history cursor, and daily
authenticated HTTP maintenance renewal. No resident poller or per-ring model
invocation is an acceptance substitute. These are source-level contracts until
the exact deployed resource and serving revision have live receipts.

The checkpoint uses the existing owner registry operation, not another table or
job ledger. Its bounded metadata contains public resource coordinates,
configuration and qualified receipts; credentials and private content are
excluded. Current placement, standby and detached custody retain the exact
checkpoint and resource inventory until the owning cleanup contract permits
removal. Each subscription has its own qualified erasure receipt. A receipt for
one subscription cannot release a sibling, the topic or the encryption key.
Rollback must refuse retained obligations it cannot represent.

The disposable Azure native sandbox retry on 2026-10-06 reached the provider,
created the sandbox and then returned `AZURE_PROBE_EGRESS_REFUSED`. Sandbox and
outer resource-group deletion were confirmed. Browser readiness, owner-information
execution and a private bridge remain unproved; that retry does not admit them.

### Model project ownership

The production default is Vertex in the owner's cloud project through the pod's
native runtime identity. Dev also permits the explicitly approved personal Gemini
bridge. Bind that exception to the exact dev model project and runtime identity;
do not infer authorization from the hub configuration. Memory Bank, storage and
encryption remain owner-local. Files setup includes the selected processing
project in its frozen approval and shows the provider boundary before opt-in.

The dev hub's model project is selected by the governed build's
`_GENAI_PROJECT_ID` setting and cross-project allowlist in
`deploy/backend.cloudbuild.yaml`; the dev managed-AI default is `hushh-vertex-personal54`.
That setting alone does not redirect private-pod inference: the pod needs its own
verified configuration and prediction permission for that project.
Its native project and billing linkage remain separate. Verify the serving
revision's model routing and prediction access independently for hub and pod;
a configured bridge or enabled billing does not prove provider access.

### One-time legacy bootstrap exception

An installed release may predate the handoff protocol. Check with the configured
hub machine identity and a pod-audience ID token: the ingress wall returns 404
for an unauthorized human token even if the route exists. Require a successful
protected `/pod/info` control before interpreting upgrade-status 404 as absence.

A bootstrap requires explicit authorization for the named existing pod. It is a
maintenance transition and does not count as proof of the normal Feed upgrade.
Do not add a permanent bypass flag or silently bootstrap other owners.

1. Pause the dev upgrade sweep to avoid competing updates. Record service UID,
   traffic, image, configuration fingerprints, storage identity and recovery
   prerequisites without persisting credentials or decrypted information.
   Verify the flag on every serving revision, not only the service template:
   an environment update can create a retired revision while pinned traffic
   still serves the old revision with its sweep enabled. Explicitly promote the
   verified hold revision and confirm worker shutdown before image replacement.
2. Build and verify a versioned image with the handoff routes and their actual
   hub-to-pod authorization path. Preserve service identity, storage, KMS,
   secret bindings and single-writer settings. Do not recreate the service.
3. Use a deliberate maintenance handoff for this legacy image. Do not infer an
   authoritative drain receipt from quiet logs. Record any interruption and
   verify durable state before replacing the image.
4. Verify image/revision, protected route authentication, admission behavior,
   encrypted-state recovery and health after the transition. Reconcile registry
   provenance before enabling normal updates; never fabricate owner approval.
5. Re-enable the normal channel only after the deployed hub and Feed support
   owner approval and the next update can obtain a genuine handoff receipt.
   Preserve rollback ancestry and tombstones; unknown compatibility is a stop.

Record bootstrap results separately from the subsequent owner-approved update
acceptance. Do not repeat a bootstrap merely because later authentication fails.
