# Private PLG frontend fixture qualification

This source operates only `hushh-webapp-plg-qual` in fixed Dev and UAT projects.
It has no shared `hushh-webapp`, production, customer-delivery or consent authority.
The release owner integrates, validates and runs it. Source tests are not native
provider qualification. Unused general frontend release prototypes are excluded from this candidate;
their unique local source remains preserved in prior commits.

## Finite hosted flow

Both Main-owned fixture workflows share the existing environment writer group:
`deploy-dev` and `deploy-uat`, with cancellation disabled. The caller authenticates
the exact workflow, job, actor, run, attempt and current step using fresh GitHub
reads and compares the complete Main authority closure. It publishes a digest-bound
build intent before Cloud Build and a separate service intent before native writes.

The build uses exact W4 application source and separately recorded Main helpers,
numeric environment-specific secrets and a fixture-only backend URL secret. Its
native build ID, source archive generation/hash, recipe, build principal, output
index and executable manifest are independently checked. The installer and recorder
use a pinned official Python image. The actual final COPY layer is reread by digest
and checked against the four exact helper/config hashes. Existing canonical W4
compiler/base-image trust remains; this is not an independent audit of every byte.

Before service writes, the producer rechecks private S acceptance, live backend
service/revision UIDs and tag/audience, minimal frontend workload allow policies,
secret pins, and canonical capacity. The fixed frontend has one instance maximum,
no SQL mount or database credential, and one numeric fixture backend URL binding.
The initial service request creates only the intended template. A second native
request selects its explicit revision/tag. Existing service updates preserve the
original UID/resourceVersion; conflicts and uncertain responses are never retried.

The native metadata preload is bundled server-side. It checks the dedicated runtime
principal, project/service/revision configuration and live fixed S provider metadata
before adding X-Serverless-Authorization. The owner's Authorization header stays
separate. Only health and One PLG preference GET/PUT can use the authenticated S
adapter. Other server fetches retain normal behavior; whole-app/native egress is
outside this proof.

## Interrupted states

The fixture history reader enumerates every workflow run and attempt, including
completed attempts of a queued rerun. Successful hosted acceptance closes a stage;
a successful hosted retained-recovery receipt can close an interrupted one. Those
receipts are authenticated from immutable GitHub artifacts and their reviewed
publication steps. A local file, missing file, callback or job outcome alone is
never closure.

Each CLI mutation phase also publishes its source-bound request-state receipt.
Only an authenticated false receipt from a failed phase proves that preflight
failed before any mutating provider call. A missing/true receipt remains uncertain.
A started build needs a terminal, uniquely tagged native build unless that genuine
zero-request receipt exists. No duplicate build is submitted to resolve uncertainty.

`recover` targets the sole unresolved stage by exact run/attempt. It independently
checks the published image/document, the reused service UID, current workload and
private policies, and original resourceVersion. It may finish only the known
post-template/pre-route state or observe the already completed intended route.
Foreign tags, templates, UIDs or semantic drift refuse recovery. A request whose
result cannot be discovered remains blocked for explicit provider reconciliation.
This source neither deletes resources nor claims that absence proves cancellation.

Policy reads and the service CAS affect separate provider resources; they are not
atomic. Policies are reread before and after route completion. Policy drift leaves
the attempt unresolved. The first fresh create has no previous UID; its first
authenticated native observation anchors that identity.

## Acceptance scope

The caller verifies private ingress and exact S/F proxy GET and PUT responses using
an intentionally invalid owner bearer. It requires backend HTTP 401, matching JSON,
and no-store headers; a Cloud Run 403 cannot stand in for that outcome. No real
owner token, positive preference change, customer email or campaign action is used.
The typed receipt explicitly keeps positiveOwnerPreferenceVerified,
customerSendingVerified and productionTrafficAuthorized false. UAT requires a
genuine Dev frontend predecessor and its own independently built image/private S
pair. The public consumer defaults to an additional current provider readback:

```
python deploy/plg/frontend_fixture_acceptance.py --environment dev --run-id RUN_ID
python deploy/plg/frontend_fixture_acceptance.py --environment uat --run-id RUN_ID
```

`--historical` explicitly returns historical evidence only. Hosted acceptance,
actual native CAS behavior, the final environment-specific image and runtime,
private identity calls, and then separate real-owner/production journey checks
must pass before the release owner reports the requested end-to-end rollout.

## Optional capacity-classifier interface

The isolation owner owns finite optional-F accounting. Use
`frontend_fixture_retained.read(environment, run_id, attempt, github=..., cloud=...)`
for its immutable typed binding. The reader authenticates the historical Main
run, attempt, job, upload, artifact digest and recorded Git blob closure. Only
explicit capacity-only helpers, the test manifest and the retained reader itself
may differ; producer/build/runtime changes refuse until a reviewed version extension.
No historical code is executed. Current native build, image layer and retained F
runtime rules are reapplied, without requiring the old S service or tag to survive.

The returned `service_document` is a fresh copy. `pin()` records zero direct Cloud
SQL connections and explicitly keeps release acceptance and production authority
false. It does not authorize promotion, rollback, cleanup, email or consent. F-to-S
HTTP workload belongs to S's worst-case pool/instance reservation. Unknown native
services, secret aliases, SQL mounts, volumes, sidecars and unresolved retained
revisions remain blocked. The source contract is the reader and service document,
not this prose.
