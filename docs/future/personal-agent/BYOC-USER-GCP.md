# BYOC — the pod in the user's own GCP (Workload Identity Federation)

> **Historical snapshot — classified 2026-09-10.** Retained for design and evidence provenance, not current execution instructions. Claims below apply to their recorded revision/date. Start with the [active handoff](./OWNER-POD-DIRECT-RUNTIME-HANDOFF-2026-09-10.md) and [canonical north star](../../reference/architecture/private-agent-north-star.md) for current direction and qualified status.

> **Status:** in pursuit, dev-branch only. The **adapter seam is built and inert**
> (`user_gcp_backend.py`, `UserGcpBackend`, `PERSONAL_AGENT_BACKEND=user_gcp`);
> plan-mode renders the pod + a bootstrap plan but makes **no call into any user
> project**. Live is gated on `HUSSH_USER_GCP_LIVE` + a completed WIF bootstrap
> (external — a real user project + federation cannot be mocked). Companions:
> [`ARCHITECTURE.md`](./ARCHITECTURE.md) (design of record), [`ROADMAP.md`](./ROADMAP.md)
> (M6 tier), [`M4-LIVE-VALIDATION.md`](./M4-LIVE-VALIDATION.md) (the slim pod this builds on).

## Visual Context

Canonical visual owner: [personal-agent Visual Map](./README.md).

## What it is

The sovereignty flagship: instead of hussh hosting the per-user pod, the user runs
it in **their own GCP project** — so the compute *and* the storage are literally
theirs, and hussh never holds their data. It is the **same slim pod image** and the
**same `ComputeBackend` contract** as the hussh-hosted `GcpBackend`; only the
**target project** and the **credential model** differ.

## A tier, not the mass default (honest)

Most consumers do not have (or want to pay for) a GCP project, and "free for life for
every hussh One user" cannot require it. So BYOC is the **prosumer / enterprise /
"own your compute" tier**. The mass tier stays hussh-hosted (`GcpBackend`), and the
endgame is the user's own hardware (edge / Puppy One). All three sit on one seam
(`compute_backend.py`), selected by `PERSONAL_AGENT_BACKEND`.

## Keyless by construction (least privilege)

**hussh never holds standing credentials into the user's project.** The user
authorizes a **one-time, least-privilege bootstrap** that stands up, in *their*
project, everything the pod needs, plus a **Workload Identity Federation** trust so
hussh's consent-plane identity is *federated in* (no service-account key is ever
exported from the user's project). From then on:

- **Inbound:** the hussh A2A gateway reaches the pod because the user granted the
  hussh consent-plane SA **only** `roles/run.invoker` on **that one pod service** —
  no broad or standing grant.
- **Outbound:** the pod calls back to hussh's consent MCP with a **per-user HCT** to
  *enforce* consent (validate token + revocation + receipt) — enforcement, not
  issuance. The consent authority stays central; the pod holds only its own X25519
  key and sees plaintext only inside its isolated process.

## The bootstrap plan (rendered by `UserGcpBackend.render_bootstrap_plan`)

A declarative contract — the resource + IAM + federation + tunnel spec that a
Terraform/Deployment-Manager module (or the user's own device Agent One over MCP,
on hussh's signed instruction) applies. It carries **no key material**.

| Resource (in the user's project) | Purpose |
|---|---|
| **KMS key** `one-pod-<slug>-key` | per-user CMEK for the PKM cache + blobs |
| **GCS bucket** `one-pod-<slug>-blobs` (CMEK) | per-user-encrypted blob storage near the agent |
| **Service account** `one-pod-<slug>-sa` | least-privilege pod runtime identity |
| **Cloud Run service** `one-pod-<slug>` (slim image, internal ingress) | the sovereign per-user pod |

IAM (least privilege only):

| Member | Role | On |
|---|---|---|
| pod SA | `roles/cloudkms.cryptoKeyDecrypter` | the KMS key |
| pod SA | `roles/storage.objectAdmin` | the bucket |
| **hussh consent-plane SA** | `roles/run.invoker` | **only** the pod service |

Federation: `workload_identity_federation` (pool + provider) — keyless; no owner/editor
role is ever granted.

## Authorization paths

1. **User-run bootstrap** — a Terraform module or `gcloud` script the user executes in
   their project (a "deploy" button / marketplace flow), granting exactly the scoped
   roles above.
2. **Agent-driven (most sovereign)** — the user's **device Agent One applies the
   bootstrap locally over MCP** on hussh's signed instruction, so credentials never
   leave the user's control at all. Agent-to-agent, consent-first.

## Reference bootstrap sketch (illustrative — not yet wired)

```bash
# In the USER's project (they authorize this; hussh holds no key here):
gcloud kms keyrings create hussh --location "$REGION"
gcloud kms keys create "one-pod-$SLUG-key" --location "$REGION" --keyring hussh --purpose encryption
gsutil mb -p "$USER_PROJECT" -l "$REGION" "gs://one-pod-$SLUG-blobs"
gcloud iam service-accounts create "one-pod-$SLUG-sa"
# Keyless WIF: let hussh's consent-plane SA be federated in (no key export).
gcloud iam workload-identity-pools create hushh-pool --location global
# Deploy the slim pod, running as the least-privilege SA, internal ingress, min=1:
gcloud run deploy "one-pod-$SLUG" --image "$SLIM_POD_IMAGE" \
  --service-account "one-pod-$SLUG-sa@$USER_PROJECT.iam.gserviceaccount.com" \
  --ingress internal --min-instances 1 --no-allow-unauthenticated
# Grant ONLY the hussh gateway invoke on THIS service:
gcloud run services add-iam-policy-binding "one-pod-$SLUG" \
  --member "serviceAccount:$HUSHH_CONSENT_PLANE_SA" --role roles/run.invoker
```

## Built and owner-pilot evidence

- **Owner-pilot live (2026-09-10):** the authenticated owner account has a real
  dev pod in the verified owner project. The
  single-instance service `one-pod-ha1-7o6wt3s4mtydneyytqfswsxtafdlpjwz` is
  healthy on revision `...-00002-nh4`, uses the owner registry digest
  `sha256:ca2e53a6255cffd3870e6859e2f00192b02a3b966c452e92a0dc212f61844cf1`,
  and is bound to the dev consent hub and Puppy relay. The sanitized receipt is
  `tmp/coding-agent-audit/owner-pod-c03947d1-receipt.json`.
- **Still external-gated:** the reusable WIF/bootstrap and device-agent flow for
  arbitrary owners, plus an end-to-end real Puppy grant/inference receipt. The
  live owner pilot does not promote those source-wiring claims to general
  production readiness.

## Guardrails

Dev-branch only. Owner-cloud changes require the owner-authenticated project and an
  explicit bootstrap/rollout action. The pilot above used that owner path; it does not
  authorize the control plane to discover or mutate another person's project.
