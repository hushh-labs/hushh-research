# The deployment abstraction boundary

**Status:** decided, 2026-08-12 · **Scope:** hushh-managed (simulation), BYO GCP
(production), Anypoint (production), future BYO AWS / Azure · **Supersedes:** the
open question in the Terraform assessment of 2026-08-11

## Decision

**`ComputeBackend` remains the core infrastructure abstraction. Terraform is adopted,
but as an *applier* behind a second and narrower seam — never as the core abstraction.**

The boundary that matters is **not** provider-vs-provider and **not**
Terraform-vs-API-calls. It is **substrate vs instance**, and it is a split by
*lifecycle*. Everything else follows from getting that line in the right place.

## Why this is the boundary

The two halves of a per-person pod deployment have opposite operational
characteristics. Nothing that is good for one is good for the other.

| | **Substrate** (per tenant) | **Instance** (per person) |
|---|---|---|
| What | KMS key, bucket, service account, IAM, Pub/Sub topic + subscription, scheduler | the pod service itself |
| Cardinality | one per tenant | one per person, and it churns |
| Frequency | once at onboarding, then rare | constant — wake, reap, recreate |
| Latency budget | minutes to hours | ~150s, on the signup path |
| Concurrency | serial is fine | must be parallel (10 provisioned at once in the dev simulation) |
| Human review | wants a reviewable plan; an auditor will ask | must be unattended |
| Drift detection | matters — a mis-provisioned tenant is silent | irrelevant; the pod is cattle |
| Blast radius of failure | one tenant mis-provisioned | one person's pod, retried |

Terraform's actual value propositions — durable state, drift detection, a reviewable
`plan`, an explicit dependency graph — map precisely onto the **left** column. In the
right column each of them turns into a liability:

- **State locking serialises what must be concurrent.** The fleet simulation
  provisioned ten pods in 39s wall-clock because they ran in parallel. A single state
  lock makes that ten serial applies.
- **State for N people is a choice between two bad shapes**: one giant state file
  (lock contention on every signup) or one workspace per person (an operational
  explosion — thousands of workspaces to back up, migrate and reconcile).
- **`apply` needs a runner.** Signup cannot wait for CI to schedule a job.
- **Reap-and-recreate churn is permanent drift** against any state file. The economy
  tier scales to zero and pods are deliberately destroyed; a system whose job is to
  notice divergence will notice it constantly and correctly, and be useless.
- **The existing 409-tolerant idempotency is strictly better for cattle** than state
  reconciliation, because it needs no durable record at all.

So Terraform belongs to the substrate and must be kept off the instance path. That is
the whole decision; the structure below is what makes it hold.

## The three layers

```
┌────────────────────────────────────────────────────────────────────┐
│ LAYER 1 — common pod architecture            ZERO provider knowledge│
│ PodSpec · BackendHandle · BackendStatus · provisioning orchestrator │
│ lifecycle states (pending→provisioning→connecting→provisioned)     │
│ consent grants · standing pkm.read · journey observability          │
│                                                                     │
│ Owns: correctness, consent, state machine, traceability             │
│ Test of the boundary: adding a provider touches NOTHING here        │
└────────────────────────────────────────────────────────────────────┘
             │                                    │
             ▼ instance lifecycle                 ▼ substrate lifecycle
┌──────────────────────────────┐   ┌─────────────────────────────────┐
│ LAYER 2 — ComputeBackend     │   │ LAYER 3 — SubstrateProvisioner  │
│ 5 methods, one per provider  │   │ one per provider, per tenant    │
│                              │   │                                 │
│ provision / deprovision /    │   │ apply(render_bootstrap_plan())  │
│ get / render_deploy_config / │   │                                 │
│ health                       │   │ Appliers:                       │
│                              │   │  · Terraform module (GCP/AWS/   │
│ GcpBackend    → Cloud Run    │   │    Azure) — the default         │
│ UserGcpBackend→ BYOC         │   │  · non-Terraform applier for    │
│ AnypointBackend → CloudHub   │   │    Anypoint (different shape)   │
│ (future) AwsBackend, Azure   │   │  · the person's own Agent One   │
│                              │   │    over MCP (sovereign option)  │
│ Latency-bound · concurrent · │   │                                 │
│ no state file                │   │ Stateful · serial · reviewable  │
└──────────────────────────────┘   └─────────────────────────────────┘
```

Layer 3 does not exist yet. `UserGcpBackend.render_bootstrap_plan` already returns the
declarative resource graph it would consume — seven resources plus the IAM to match —
and its own docstring already describes itself as *"the contract a
Terraform/Deployment-Manager module — or the user's own device Agent One over MCP —
applies"*. The seam is the missing piece, not the plan.

**Introduce `SubstrateProvisioner` before the first Terraform module.** If the module
comes first, Terraform becomes the interface by default and the sovereign
apply-it-yourself path — which is the strongest expression of the product's own north
star — becomes a special case instead of a peer.

## Portability without artificial standardisation

This is the part the current design already gets right, and the part most at risk from
a well-intentioned "unify it" refactor.

`render_deploy_config` returns a **provider-shaped** artifact that Layer 1 never
interprets. Cloud Run's knative `Service` and Anypoint's AMC application descriptor
share no schema, and they do not need to. Parity is asserted instead by **capability
extractors** (`tests/test_compute_backend_parity.py`): each backend reduces its own
shape to the same small set of facts, and the assertions run against that reduction.
Its docstring states the property directly — *"Adding a fourth platform means writing
one extractor, not rewriting the assertions."*

That is the correct pattern: **standardise the questions, never the schema.**

The failure mode to avoid is a "universal pod descriptor" that renders to every
provider. It can only be one of two things — a lowest common denominator that cannot
express Confidential Space or CloudHub's private endpoint, or a leaky superset where
every field is conditional on provider anyway. Both are worse than three honest shapes
and one set of shared questions.

Evidence the abstraction already generalises: **Anypoint is not a container and not
GCP.** It is a Mule application on CloudHub 2.0, and it satisfies the identical
five-method protocol. The seam has already been tested across a genuinely different
execution model, which is the only test that means anything.

## Adding a provider

Adding AWS is exactly three artifacts and no Layer 1 change:

1. `AwsBackend(ComputeBackend)` — App Runner or ECS Fargate for the instance lifecycle.
2. One capability extractor in the parity test.
3. One Terraform substrate module behind `SubstrateProvisioner`.

**If a new provider requires a change in Layer 1, the boundary was wrong.** Treat that
as a design defect to be fixed in the boundary, not as a task to be completed in the
provider. This is falsifiable and should be guarded the way the pod architecture itself
is guarded.

## What must be fixed first, and why it gets harder later

Three items, all verified against the tree on 2026-08-12. All three are cheap now and
expensive once a second provider exists.

**1. `backend_metadata` is an untyped dict read by magic key in the common layer.**
`personal_agent_provisioning_service.py` reads
`(handle.backend_metadata or {}).get("livenessMode")` to decide how a pod's silence
should be interpreted. This is the one genuine leak of provider knowledge into Layer 1:
every new backend must know that key exists and spell it identically, and nothing
catches a miss — a provider that spells it `liveness_mode` gets `None` and its pods are
misread as a tier they are not. Promote the fields Layer 1 actually reads onto
`BackendHandle` as typed optionals; keep `backend_metadata` for genuinely
provider-specific extras that Layer 1 never inspects.

**2. There is no `SubstrateProvisioner` seam, and `render_bootstrap_plan` has no
production caller.** BYOC substrate would otherwise be applied ad hoc at the first
real customer, which is precisely when improvising is most expensive.

**3. Substrate resources that carry long-lived credentials cannot go under Terraform
as they stand.** `deploy/one-location/setup_retention_scheduler.sh` reads a token from
Secret Manager and bakes it into a Cloud Scheduler job's headers
(`X-Hushh-Maintenance-Token`). Under Terraform that value lands in **state** and in
**`plan` output** — and plan output in CI logs is credential disclosure. Move these to
OIDC before any credential-bearing resource is placed under Terraform management. This
is an argument about *which resources* Terraform may own, not about Terraform.

## What is NOT debt, contrary to earlier records

Two claims in the older planning notes are stale and should not be re-inherited:

- **Per-pod cryptographic identity already exists for BYOC.**
  `api/routes/one/pod_identity_auth.py` verifies the pod's audience-bound ID token and
  then falls through to `_bound_service_account(asserted)`, binding the per-person
  service account recorded on the registry row. Presenting user B's token cannot assert
  user A. It is the **managed** tier that is fleet-shared and can only prove "a hussh
  pod is calling", never which — and the code says so in place rather than implying
  otherwise. This inverts the usual assumption in favour of BYO GCP as the production
  path: the sovereign tier has the *stronger* identity story.
- **The protocol generalises.** It has been carried across a non-container provider
  already, so "will this abstraction survive AWS" is not an open question.

## Sequencing

| Phase | Work | Gate |
|---|---|---|
| **A** | Fix debt items 1 and 2. Add the boundary guard. | Nothing else starts until Layer 1 is provider-clean and the substrate seam exists. |
| **B** | Complete GCP BYOC: Terraform substrate module behind `SubstrateProvisioner`, first real state, first real `plan` review. | One provider, end to end, with the seam already in place. |
| **C** | AWS: one adapter, one extractor, one module. | Zero Layer 1 files change. If any do, stop and fix the boundary. |
| **D** | Azure (Container Apps), identically. | Same gate. |

Item 3 gates only the specific resources that carry credentials, and can run in
parallel with A.

## The one-line answer

Terraform is a good **applier** and a poor **abstraction**. Make the substrate
declarative and let Terraform apply it; keep the per-person instance lifecycle on the
typed `ComputeBackend` seam that already works, and hold the line between them.
