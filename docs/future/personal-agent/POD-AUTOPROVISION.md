# Firing a pod on phone verification — and how its key gets there

> **Historical snapshot — classified 2026-09-10.** Retained for design and evidence provenance, not current execution instructions. Claims below apply to their recorded revision/date. Start with the [active handoff](./OWNER-POD-DIRECT-RUNTIME-HANDOFF-2026-09-10.md) and [canonical north star](../../reference/architecture/private-agent-north-star.md) for current direction and qualified status.

> **Status:** built, flag-gated **OFF** (`PERSONAL_AGENT_AUTOPROVISION_ENABLED`).
> Companions: [`POD-HUB-DATA-PATH.md`](./POD-HUB-DATA-PATH.md) (how a pod reads),
> [`POD-FLEET-LIVE-2026-08-04.md`](./POD-FLEET-LIVE-2026-08-04.md) (the live fleet),
> [`BYOC-USER-GCP.md`](./BYOC-USER-GCP.md) (where this is going).

## Visual Context

Canonical visual owner: [personal-agent Visual Map](./README.md).

## What was actually missing

The phone-verify seam already existed and already fired
(`actor_identity_service.py` → `schedule_provision_personal_agent`). Two things
downstream meant it could never produce a pod:

1. **It resolved no compute backend.** `PersonalAgentProvisioningService` was
   constructed without one, which silently yields `NullBackend`. The path would
   have reported success while creating nothing — on the one path that runs for
   every signup, where no one reads a response body.
2. **It stopped at `register_pending`.** That writes a `pending` row and returns;
   nothing called `provision()`.

And separately: **nothing in the webapp calls `/provision` at all.** The
owner-authorized route exists and is correct, but no client invokes it, which is
why no real signup has ever produced a pod.

## The chicken-and-egg, and why the flow has two halves

`provision()` used to require a pod public key up front. But
`pod_connector_keypair_service` is explicit that **the pod generates its own
X25519 keypair inside its own runtime**, and the hub only ever receives the public
half — that is what leaves us structurally unable to decrypt the pod. So the key
cannot exist before the pod does, and a caller cannot supply one at phone-verify.

The flow therefore splits, and `connecting` — a status that was already declared
in `_STATE_BY_REGISTRY_STATUS` with nothing able to write it — is exactly the
state for the gap:

```
phone verified
    │
    ├─ register_pending ──────────────────────────▶  pending      (HusshID reserved)
    │
    ├─ provision(no key)  ── backend.provision() ──▶  connecting   (host EXISTS, no key yet)
    │
    │        hub PULLS  GET <pod url>/pod/public-key
    │
    └─ attach_pod_public_key ─────────────────────▶  provisioned  (key recorded, pkm.read minted)
```

`provision()` mints **nothing** on the deferred path. A standing `pkm.read` with
no pod to hold it is read authority granted to nobody, which is the ordering
SECURITY-REVIEW.md M3 exists to prevent.

## The hub pulls; the pod does not push

This is the load-bearing security decision, and the first design got it wrong.

The obvious shape is a pod POSTing its key to the hub. That forces the hub to
answer **"which pod is calling?"** — and it cannot. Every pod runs as the same
service account (precisely what lets that account hold no project roles), so a
Google ID token proves fleet membership and nothing more. The pod would have to
assert its own `hushh_id`, and an attacker-chosen identity on the one call that
mints read authority is privilege escalation, not information disclosure.

The first attempt closed that with a per-pod bearer token derived from the hub's
signing key, injected into each pod's environment. It was refused by
`test_rendered_config_carries_identity_but_no_secrets` — correctly. That put
secret material into a Cloud Run deploy artifact readable by anyone with
`run.services.get`, which is a broader audience than Secret Manager. The control
was right and the design was wrong.

**Inverting the direction removes the question instead of answering it.** The pod
merely *exposes* `GET /pod/public-key`; the hub fetches it from the URL the hub
itself wrote into `backend_metadata` when it created the service. That address
comes from the Cloud Run API response and is never supplied by a caller, so there
is no identity to assert and nothing to forge — whatever answers that URL is, by
construction, that user's pod.

No shared secret, nothing sensitive in the deploy artifact, and one less
authentication mechanism than the version it replaced.

The collection attempt is made from `GET /api/one/personal-agent/status`: the poll
that *asks* whether the agent is ready is also the poll that can *make* it ready,
so onboarding needs no separate timer and there is no window where the pod is up
but nothing has noticed.

## What the hub refuses

| Situation | Answer |
|---|---|
| Row not in `connecting` | no fetch at all — nothing to collect |
| Recorded URL is not `https://` | refused before any request leaves the process |
| Pod unreachable / non-200 / unparsable | row stays `connecting`, retried next poll |
| **Same** key re-presented | idempotent; returns current state, mints **once** |
| **Different** key presented | **refused** — never silently rebound |

The last row matters most. Rebinding would let anything that reached that path
take over the agent's identity, so a key change is a re-provision, not an update.

## Honest limitations

- **The pod's private key is process-local.** It lives in memory and nowhere else,
  so a restart generates a new keypair whose public half no longer matches what
  the hub recorded — and the hub correctly refuses the rebind. Nothing is broken
  by this today because nothing has yet been wrapped *to* the pod's key: it is
  recorded, not used. Persisting it needs somewhere a pod can keep a secret across
  restarts that the hub cannot read — a mounted per-pod secret, or the attested
  tier's sealed storage (roadmap M5). Generating an ephemeral key and calling it
  durable would be worse than the current state: it would make the registry's
  record of "this agent's key" quietly stop being true.
- **This is authentication by network position, not attestation.** It is sound
  because the hub chose the address, but it proves the hub reached the service it
  created — not that the code inside is what we shipped. Attestation is M5.
- **Not yet run end to end against a live pod.** Every hop is covered by tests
  including the refusals, but the claim "a real dev signup produced a pod that
  reached `provisioned`" is **not** yet made. That needs a dev deploy with the
  toggle on.

## Cost

`PERSONAL_AGENT_AUTOPROVISION_ENABLED` is separate from `PERSONAL_AGENT_ENABLED`
and defaults **off**, because the master flag opens the surface while this one
decides whether verifying a phone *spends money*. Every signup provisioning is
exactly the shape that turns a load test into a bill.

`PERSONAL_AGENT_MAX_PODS` (default 50) remains the ceiling underneath it and is
what actually bounds the spend. `connecting` was added to the cap's denominator
(`_ACTIVE_POD_STATUSES`) — a pod parked there is fully billable, so omitting it
would have let the fleet grow past the ceiling without the cap noticing.

## Also fixed here

**Transition timestamps.** `personal_agent_registry.updated_at` defaults to
`now()`, but a DEFAULT fires only on INSERT and there is no `ON UPDATE` trigger,
so every later upsert kept reporting the moment the row was created. Nothing could
honestly say how long a pod had been booting — which is precisely what an
onboarding progress surface has to answer, and why `health.py` had resorted to an
age heuristic. `upsert` now stamps `updated_at` on every write and `provisioned_at`
once, on first activation.

**`provisioning_failed` has a writer.** It was declared in the status map with
nothing able to produce it, so the UI could never show a failure. `provision()` now
records it on the error path — best-effort and swallowed, so a failed status write
can never replace the original exception with a less informative one.

## Managed hosting: selected design, qualification required

**Decision — 2026-10-13:** use project shards with multiple owner pods per project.
New Hussh Pods provisioning remains disabled. The existing configuration flags do
not qualify the renderer's development master-key derivation or shared identity.
BYOC, existing pods and their selected settings are unchanged.

Each managed owner needs a separate workload identity, storage boundary and
pod-generated recovery key wrapped by a per-pod KMS key. Qualification must prove
that a sibling pod cannot read objects, decrypt recovery or unwrap that key.
Hussh administers these projects; project isolation does not establish owner-cloud
sovereignty or remove Hussh's administrative control.

### Capacity worksheet and admission contract

Fill this worksheet for each approved project, region and residency. Unknown or
stale evidence refuses new placement. No fixed customer count is qualified yet.

| Constraint | Observe | Reserve per owner / execution | Gate |
| --- | --- | --- | --- |
| Permanent resources | Service, identity, key, queue, storage and billing/project limits; actual usage | Pending, sleeping, active and unresolved resources; upgrade overlap | Tightest remaining constraint after reviewed headroom |
| Simultaneous wake | Granted regional CPU/RAM and instance quotas; existing allocation | Selected owner envelope plus temporary recovery/upgrade allocation | Separate concurrent wake budget; queue rather than overcommit |
| Control-plane rates | IAM, service creation, KMS, queue and provider API rate limits | Bounded create/update/delete tokens | Rate admission independent of resource count |
| Residency | Approved shard locations and owner's selection | Exact placement and storage/key region | No silent cross-region placement |
| Cleanup | Provider operation IDs, absence and retention receipts | Keep reservations for uncertain or retained resources | Release only after reconciled absence |

For each resource `r`, calculate
`max(0, floor((effective_limit[r] - observed_usage[r] - unobserved_reservations[r] - headroom[r]) / per_owner[r]))`.
Reconcile observed resources and reservations by immutable resource identity;
`unobserved_reservations` contains only commitments absent from observed usage.
Active resources are counted once, while pending and uncertain commitments
remain reserved until their cloud outcome is verified.
The minimum is the additional permanent-owner envelope. Derive the wake envelope
separately from granted CPU/RAM and selected configuration; a vCPU label is not a
performance benchmark. Missing dimensions yield no admissible placement.

Reserve transactionally in the existing provisioning authority before any cloud
create. A stable operation identifies the owner, incarnation, project, region,
resource vector and observed quota revision. Simultaneous requests cannot claim
the same remaining capacity. Pending and unknown provider outcomes retain their
reservation through retries; billing retry resumes the same operation. Existing
registry row counts are not a transactional shard reservation.

Prepare another **approved** shard before the limiting constraint reaches its
headroom. Failure leaves setup pending with an explanation, never silently Shared.
Preserve minimum zero, bounded instances, one worker, event-driven jobs and idle
socket closure. Existing owners approve configuration changes separately.

The historical 2026-08-06 Service Usage observation was 1,000 Cloud Run services in
`hushh-pda-dev`. It is dated evidence, not current capacity admission. Google's
[current Cloud Run limits](https://docs.cloud.google.com/run/quotas) list 1,000
services per project/region; [IAM quotas](https://docs.cloud.google.com/iam/quotas)
state service-account counts vary by project. Query each shard's effective quota
(`consumerQuotaMetrics` / current quota API), consumption and relevant rate limits.
Sleeping services still occupy permanent slots. Never wait until the published
service limit before preparing the next shard.

### Whole-package operating-cost worksheet

Use dated regional SKU rates and actual usage, excluding no component silently:

`monthly total = active compute + retained storage/versions + model usage + KMS
custody/operations + queues + network downloads + images/builds + logs + allocated
fleet/control-plane overhead`.

For compute, include useful work, startup, recovery and connected socket grace.
Do not multiply nominal chat hours alone or assume an open relay socket is free.
Minimum-zero hosting can avoid continuously allocated compute; retained resources
remain billable. Model input, cached input, output and reasoning are measured
separately. Local Puppy inference excludes cloud-model charges for that turn but
still incurs relay compute and network costs.

Illustration only: the [Cloud Run pricing table](https://cloud.google.com/run/pricing)
read on 2026-10-13 gives default-consumption active rates of $0.000024/vCPU-second
and $0.0000025/GiB-second for its displayed region. At **1 vCPU / 2 GiB RAM** this
is **$0.1044 per active hour**, before allowances and all other components.

| Billable active hours/month | Compute subtotal | Additional costs to populate |
| --- | ---: | --- |
| 10 | $1.044 | Storage, model, custody, jobs, network, images and fleet share |
| 60 | $6.264 | Same components, from usage rather than assumed requests |
| 180 | $18.792 | Same components; compare a matched VM with ingress, disk and maintenance |

This is a rate illustration, not a customer price or qualified monthly total.
Publish the total only after both the resource worksheet and billing observations
are reviewed. Shared overhead must have an explicit allocation method. Spending
thresholds warn without stopping service.

### Qualification sequence

1. Review the complete resource and cost worksheets; record missing quota evidence.
2. Implement authoritative reservations and per-pod custody behind existing owners.
3. Prove concurrent admission, exhaustion, sibling refusal, uncertain create/delete,
   recovery, upgrade and erasure in a bounded disposable dev pilot.
4. Expose provisioning only after source and live evidence pass. Production IAM,
   recovery and release-channel acceptance remain independent.
